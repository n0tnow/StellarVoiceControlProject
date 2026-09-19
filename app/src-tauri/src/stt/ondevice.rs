//! On-device macOS Speech backend (step A1, on-device-first decision).
//!
//! Polaris is a **wallet**. When the user says "send 10 USDC to Ada" the audio is
//! financial intent, not a search query, so the architecturally correct default
//! is to keep it on the machine. This backend drives Apple's
//! `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`, which stops
//! the audio from reaching *Apple's* servers as well as anyone else's. It is also
//! free forever, works offline and needs no API key.
//!
//! The cost of that choice is real and structural: `SFSpeechRecognizer` is
//! **single-locale per recognizer**, unlike Whisper's language auto-detection. A
//! recognizer listening for Turkish cannot simultaneously listen for English, and
//! Apple's on-device models are smaller than `whisper-large-v3`. [`resolve_locale`]
//! and the A1 on-device report record the trade-off that was made.
//!
//! Threading. The Speech objects are `!Send`, so this module creates them *inside*
//! [`OnDeviceTranscriber::transcribe`], which the STT worker already runs on its
//! own thread; nothing `!Send` ever crosses a thread boundary. The result handler
//! is a block that the framework calls on the recognizer's queue (the main queue
//! by default), and it hands the finished text back over an `mpsc` channel. The
//! worker — never the Tauri main thread and never the audio path — blocks on that
//! channel with a bounded timeout, so a missing locale asset or a wedged task
//! cannot hang the engine.
//!
//! Permission. `SFSpeechRecognizer.requestAuthorization` is asynchronous. It is
//! requested here on first use (on the worker thread), and the worker waits —
//! bounded — for the answer. Denied or restricted access degrades to the short
//! `Allow speech` overlay label and leaves capture fully working; it never blocks
//! the main thread and never panics.

use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

use block2::StackBlock;
use objc2::rc::Retained;
use objc2::AllocAnyThread;
use objc2_foundation::{NSArray, NSError, NSLocale, NSString, NSURL};
use objc2_speech::{
    SFSpeechRecognitionResult, SFSpeechRecognitionTaskHint, SFSpeechRecognizer,
    SFSpeechRecognizerAuthorizationStatus, SFSpeechURLRecognitionRequest,
};

use crate::stt::{
    SttError, Transcriber, Transcription, ON_DEVICE_RECOGNITION_TIMEOUT,
};

/// Terms this product actually hears, fed to the recognizer as
/// `contextualStrings` so Apple's small on-device model does not turn `USDC`
/// into "you-ess-dee-see" or `Soroban` into "sorban". Keeping them in one named
/// constant is deliberate: when the alias book lands it grows here. Apple asks
/// for short phrases (one or two words) and caps the list at 100 entries, which
/// the test below pins.
pub const DOMAIN_VOCABULARY: [&str; 7] = [
    "USDC", "XLM", "Stellar", "Soroban", "lumen", "testnet", "Polaris",
];

/// Locale used when `POLARIS_STT_LOCALE` is not set. See [`resolve_locale`].
pub const DEFAULT_LOCALE: &str = "tr-TR";

/// How long the worker waits for the user to answer the macOS "allow Speech
/// Recognition" prompt. Long enough for a human to read and click, short enough
/// that an ignored prompt cannot pin the STT worker forever.
const AUTHORIZATION_TIMEOUT: Duration = Duration::from_secs(30);

/// Resolves the recognizer locale.
///
/// `POLARIS_STT_LOCALE` wins; otherwise [`DEFAULT_LOCALE`] (`tr-TR`), fixed.
/// Justification: `SFSpeechRecognizer` is single-locale, so a choice must be
/// made. The user speaks Turkish even when the command mixes an English
/// vocabulary ("send 10 USDC to ada"). Following the *system* locale would
/// quietly pick the UI language — often `en-US` on a Turkish user's Mac that is
/// set to English — and lose the user's actual language, while a fixed,
/// overridable `tr-TR` is predictable; `contextualStrings` then keeps the English
/// entities English. The known cost: an English-only utterance may be rendered
/// with Turkish phonetics. Groq can fall back on auto-detection, but on-device
/// cannot, so the locale is a conscious product decision rather than a default.
pub fn resolve_locale(value: Option<String>) -> String {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT_LOCALE.to_string())
}

/// Turns a framework transcript into the shared [`Transcription`] shape, applying
/// the same "blank means silence" rule the Groq backend uses so both backends
/// speak one language to the overlay.
pub fn finish_transcript(text: &str) -> Result<Transcription, SttError> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(SttError::Silent);
    }
    Ok(Transcription { text })
}

/// Maps the framework's authorization status to our error. Split out so the
/// mapping is unit-tested without the framework: only `Authorized` succeeds.
pub fn map_authorization(code: i64) -> Result<(), SttError> {
    if code == SFSpeechRecognizerAuthorizationStatus::Authorized.0 as i64 {
        Ok(())
    } else {
        Err(SttError::PermissionDenied)
    }
}

/// Whether this Mac can recognize speech for `locale` fully on-device.
///
/// Used at startup to decide whether Groq may be offered as a fallback, and to
/// print an honest line when nothing is configured. Safe to call before
/// authorization: it only inspects the recognizer's capabilities.
pub fn supports_on_device(locale: &str) -> bool {
    // SAFETY: `alloc`/`initWithLocale` and the two property reads are safe from
    // any thread for this class, and the recognizer never leaves this function.
    unsafe {
        let identifier = NSString::from_str(locale);
        let ns_locale = NSLocale::localeWithLocaleIdentifier(&identifier);
        let Some(recognizer) =
            SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale)
        else {
            return false;
        };
        recognizer.supportsOnDeviceRecognition() && recognizer.isAvailable()
    }
}

/// Requests Speech Recognition permission on first use.
///
/// Called from the STT worker, never the main thread. The first call with an
/// undetermined status shows the macOS prompt (its text comes from
/// `NSSpeechRecognitionUsageDescription` in `Info.plist`); the worker waits,
/// bounded, for the answer. Denied/restricted degrade to a short overlay label.
fn ensure_authorized() -> Result<(), SttError> {
    // SAFETY: class methods, safe from any thread.
    unsafe {
        let status = SFSpeechRecognizer::authorizationStatus();
        if status == SFSpeechRecognizerAuthorizationStatus::Authorized {
            return Ok(());
        }
        if status != SFSpeechRecognizerAuthorizationStatus::NotDetermined {
            // Denied or restricted: asking again does nothing, so fail fast.
            return Err(SttError::PermissionDenied);
        }

        let (tx, rx) = mpsc::channel();
        // The docs do not promise the handler runs on the main queue, so the
        // block only forwards the status over the channel; all mapping happens
        // on the worker after the receive.
        let handler = StackBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
            let _ = tx.send(status.0 as i64);
        });
        SFSpeechRecognizer::requestAuthorization(&handler);

        match rx.recv_timeout(AUTHORIZATION_TIMEOUT) {
            Ok(code) => map_authorization(code),
            // No answer in time. Treat it as "not granted" rather than a hang:
            // the WAV is kept, the overlay gets a short label, and the next hold
            // still works.
            Err(_) => Err(SttError::PermissionDenied),
        }
    }
}

/// The on-device backend.
///
/// Holds only plain data so it stays `Send + Sync`; the `!Send` Speech objects
/// are created inside [`Transcriber::transcribe`], on the worker thread.
pub struct OnDeviceTranscriber {
    locale: String,
    vocabulary: Vec<String>,
}

impl OnDeviceTranscriber {
    pub fn new(locale: String) -> Self {
        Self {
            locale,
            vocabulary: DOMAIN_VOCABULARY.iter().map(|term| term.to_string()).collect(),
        }
    }

    /// Builds and runs the recognition request. Every Speech object is created
    /// and dropped inside this function, on the calling (worker) thread.
    fn recognize(&self, wav: &Path) -> Result<Transcription, SttError> {
        // SAFETY: every call is an Objective-C message to Speech/Foundation
        // objects that are created and dropped inside this function on the
        // worker thread. The `!Send` Speech objects never cross a thread
        // boundary; only the finished `String` does, over the channel below.
        unsafe {
            let identifier = NSString::from_str(&self.locale);
            let ns_locale = NSLocale::localeWithLocaleIdentifier(&identifier);
            let recognizer =
                SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &ns_locale)
                    .ok_or_else(|| SttError::Unavailable {
                        locale: self.locale.clone(),
                    })?;
            // `requiresOnDeviceRecognition` is only honored when this is true; if
            // it is false there is no privacy-safe way to run, so fail instead of
            // silently letting the framework use the network.
            if !recognizer.supportsOnDeviceRecognition() || !recognizer.isAvailable() {
                return Err(SttError::Unavailable {
                    locale: self.locale.clone(),
                });
            }

            let path = NSString::from_str(&wav.to_string_lossy());
            let url = NSURL::fileURLWithPath(&path);
            let request = SFSpeechURLRecognitionRequest::initWithURL(
                SFSpeechURLRecognitionRequest::alloc(),
                &url,
            );

            // We already have the whole file, so only the final transcript
            // matters; partials would just add round-trips through the channel.
            request.setShouldReportPartialResults(false);
            // The whole point of this backend: no audio leaves the machine, not
            // even to Apple. Only reachable because `supportsOnDeviceRecognition`
            // was checked above.
            request.setRequiresOnDeviceRecognition(true);
            // Commands are short, spoken instructions; dictation is the closest
            // task hint Apple documents.
            request.setTaskHint(SFSpeechRecognitionTaskHint::Dictation);
            let words: Vec<Retained<NSString>> = self
                .vocabulary
                .iter()
                .map(|word| NSString::from_str(word))
                .collect();
            request.setContextualStrings(&NSArray::from_retained_slice(&words));

            let (tx, rx) = mpsc::channel();
            let handler = StackBlock::new(
                move |result: *mut SFSpeechRecognitionResult, error: *mut NSError| {
                    if !error.is_null() {
                        let error = &*error;
                        let _ = tx.send(Err(SttError::Speech(format!(
                            "{} ({}, code {})",
                            error.localizedDescription(),
                            error.domain(),
                            error.code(),
                        ))));
                        return;
                    }
                    if result.is_null() {
                        let _ = tx.send(Err(SttError::Speech(
                            "the Speech framework returned neither a result nor an error"
                                .to_string(),
                        )));
                        return;
                    }
                    // `isFinal` guards against a partial slipping through despite
                    // `shouldReportPartialResults = false`.
                    let result = &*result;
                    if result.isFinal() {
                        let text = result.bestTranscription().formattedString();
                        let _ = tx.send(finish_transcript(&text.to_string()));
                    }
                },
            );
            let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);

            match rx.recv_timeout(ON_DEVICE_RECOGNITION_TIMEOUT) {
                Ok(outcome) => outcome,
                Err(_) => {
                    // A wedged task, or a first-run asset download that never
                    // finished. Cancel so the framework stops working, then
                    // surface a short label instead of hanging.
                    task.cancel();
                    Err(SttError::Timeout)
                }
            }
        }
    }
}

impl Transcriber for OnDeviceTranscriber {
    fn transcribe(&self, wav: &Path) -> Result<Transcription, SttError> {
        ensure_authorized()?;
        self.recognize(wav)
    }

    fn name(&self) -> &'static str {
        "ondevice"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_defaults_to_turkish_and_accepts_an_override() {
        assert_eq!(resolve_locale(None), "tr-TR");
        assert_eq!(resolve_locale(Some("   ".to_string())), "tr-TR");
        assert_eq!(resolve_locale(Some(" en-US ".to_string())), "en-US");
    }

    #[test]
    fn domain_vocabulary_covers_the_wallet_entities() {
        for term in [
            "USDC", "XLM", "Stellar", "Soroban", "lumen", "testnet", "Polaris",
        ] {
            assert!(DOMAIN_VOCABULARY.contains(&term), "missing {term}");
        }
        // Apple's rules for `contextualStrings`: <= 100 phrases, 1-2 words each.
        assert!(DOMAIN_VOCABULARY.len() <= 100);
        for phrase in DOMAIN_VOCABULARY {
            assert!(
                phrase.split_whitespace().count() <= 2,
                "contextual phrase is too long: {phrase}"
            );
        }
    }

    #[test]
    fn blank_transcripts_are_silence() {
        assert_eq!(finish_transcript("   "), Err(SttError::Silent));
        assert_eq!(finish_transcript("").unwrap_err(), SttError::Silent);
    }

    #[test]
    fn transcripts_are_trimmed() {
        assert_eq!(
            finish_transcript("  send 10 USDC  ").unwrap().text,
            "send 10 USDC"
        );
    }

    #[test]
    fn only_the_authorized_status_succeeds() {
        // 3 = authorized; 0 = not determined, 1 = denied, 2 = restricted.
        assert!(map_authorization(3).is_ok());
        for code in [0, 1, 2] {
            assert_eq!(map_authorization(code), Err(SttError::PermissionDenied));
        }
    }

    #[test]
    fn the_transcriber_keeps_the_locale_it_was_given() {
        let transcriber = OnDeviceTranscriber::new("tr-TR".to_string());
        assert_eq!(transcriber.name(), "ondevice");
        assert_eq!(transcriber.locale, "tr-TR");
    }
}
