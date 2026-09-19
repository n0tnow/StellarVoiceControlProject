//! Speech-to-text (step A1).
//!
//! A finished capture (step A0) is handed to a background worker, which turns the
//! WAV into a transcript and pushes it onto the `polaris-event` stream. The
//! product decision for this step is **on-device first**: Polaris is a wallet and
//! the audio is financial intent, so the default backend is Apple's on-device
//! `SFSpeechRecognizer` ([`ondevice`], macOS-only) with
//! `requiresOnDeviceRecognition` forced on. Groq's OpenAI-compatible API
//! ([`groq`]) stays available as an explicit opt-in and as a fallback that fires
//! only when on-device is unavailable *and* a key is configured — never silently.
//! Both sit behind the [`Transcriber`] trait, so the worker and every call site
//! are unchanged.
//!
//! Two invariants from A0 carry forward:
//!
//! * Transcription never runs on the Tauri main thread or the audio path. The
//!   worker owns its own thread; the capture thread only drops a message on a
//!   channel and moves on.
//! * A failure is a short overlay label plus a full terminal line, never a panic
//!   and never a wedged engine. The next hold must always work.
//!
//! Retention (raised as MAJOR-3 in the A0 review) also lives here: a recording is
//! deleted once it has been transcribed successfully, and the directory is capped
//! so failed or unattended captures cannot grow without bound. A WAV whose
//! transcription **failed is never deleted** — it is the only copy of the audio.

pub mod groq;
#[cfg(target_os = "macos")]
pub mod ondevice;
pub mod wav;

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Instant;

use tauri::AppHandle;

use crate::capture::Capture;
use crate::env;
use crate::events::{self, PolarisEvent};
use crate::types::CaptureRecording;

/// One recognized utterance. `text` is already trimmed; an all-whitespace
/// result is treated as silence, not as an empty transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcription {
    pub text: String,
}

/// Everything that can go wrong between "a WAV exists" and "a transcript
/// exists".
///
/// The split between [`Self::label`] and [`Self::detail`] is deliberate: the
/// overlay ear is ~92 pt wide, so it gets a hand-shortened label, while the Rust
/// terminal gets the full explanation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    /// `GROQ_API_KEY` is missing. Capture is unaffected; transcription is off.
    MissingKey,
    /// The file could not be read or is not the 16-bit PCM we expect.
    Wav(String),
    /// Zero frames were written.
    Empty,
    /// The recording is long enough but contains no audible signal.
    Silent,
    /// Shorter than [`wav::MIN_DURATION_MS`].
    TooShort { duration_ms: u64 },
    /// Could not reach the provider (DNS, TLS, timeout, connection reset).
    Network(String),
    /// The provider answered with a non-2xx status.
    Http { status: u16, detail: String },
    /// The provider answered 2xx but the body was not the documented shape.
    Malformed(String),
    /// On-device only: the user has not granted Speech Recognition, or denied it.
    /// Capture keeps working; the overlay shows a short label.
    PermissionDenied,
    /// On-device only: the recognizer cannot run for the configured locale
    /// (unsupported locale, no on-device support, or the locale's assets are not
    /// installed). This is the *only* error an on-device backend may fall back to
    /// Groq on, because it is raised before any audio is recognized.
    Unavailable { locale: String },
    /// On-device only: recognition started but did not finish within the budget
    /// (a wedged task, or a first-run asset download that never completed).
    Timeout,
    /// On-device only: the Speech framework itself reported an error. The string
    /// is the framework's domain/code and localized description.
    Speech(String),
}

impl SttError {
    /// Short, overlay-safe copy. Kept to a handful of characters so it fits the
    /// ear; the label is ellipsised if it ever does not.
    pub fn label(&self) -> &'static str {
        match self {
            Self::MissingKey => "No STT key",
            Self::Wav(_) | Self::Empty => "Bad audio",
            Self::Silent => "No speech",
            Self::TooShort { .. } => "Too short",
            Self::Network(_) => "Net error",
            Self::Http { .. } => "STT error",
            Self::Malformed(_) => "Bad response",
            Self::PermissionDenied => "Allow speech",
            Self::Unavailable { .. } => "Local STT off",
            Self::Timeout => "STT timeout",
            Self::Speech(_) => "STT error",
        }
    }

    /// Full terminal message. It must never contain the API key — nothing here
    /// has access to it, which is the point of keeping `MissingKey` a unit-like
    /// variant.
    pub fn detail(&self) -> String {
        match self {
            Self::MissingKey => "GROQ_API_KEY is not set. Set it in the environment \
                 or a gitignored .env at the repo root (see .env.example); capture \
                 still works, but nothing will be transcribed."
                .to_string(),
            Self::Wav(message) => message.clone(),
            Self::Empty => "the recording contains no audio frames".to_string(),
            Self::Silent => "the recording is silent (no signal above the noise floor)".to_string(),
            Self::TooShort { duration_ms } => format!(
                "the recording is only {duration_ms} ms; at least {} ms is required",
                wav::MIN_DURATION_MS
            ),
            Self::Network(message) => format!("could not reach the transcription service: {message}"),
            Self::Http { status, detail } => {
                format!("the transcription service returned HTTP {status}: {detail}")
            }
            Self::Malformed(message) => format!("could not read the transcription response: {message}"),
            Self::PermissionDenied => "Speech Recognition permission was not granted. Answer the \
                 macOS prompt, or enable Polaris under System Settings › Privacy & Security › \
                 Speech Recognition. Capture keeps working."
                .to_string(),
            Self::Unavailable { locale } => format!(
                "on-device speech recognition is unavailable for locale {locale}. The locale or \
                 device may not support it, or macOS may not have downloaded the dictation assets \
                 for it yet; capture still works and the recording is kept."
            ),
            Self::Timeout => format!(
                "on-device speech recognition did not finish within {} s",
                ON_DEVICE_RECOGNITION_TIMEOUT.as_secs()
            ),
            Self::Speech(message) => format!("the Speech framework failed: {message}"),
        }
    }
}

/// How long the on-device backend waits for a final result before giving up.
/// Defined here so the user-facing error detail and the actual backstop cannot
/// drift apart; `ondevice` consumes it.
pub const ON_DEVICE_RECOGNITION_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The backend seam.
///
/// Implementations must be blocking and self-contained; the worker runs them on a
/// dedicated thread. Adding a backend means implementing this trait and
/// constructing it in [`build_backend`] — no call site changes.
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, wav: &Path) -> Result<Transcription, SttError>;

    /// Short backend name for the terminal latency line, so the on-device and
    /// cloud numbers can be told apart on the same scale. Defaulted on purpose:
    /// this is a logging aid, not a capability, and giving it a default meant no
    /// existing implementation or call site had to change.
    fn name(&self) -> &'static str {
        "stt"
    }
}

/// Wraps the on-device primary and an optional cloud fallback.
///
/// The fallback fires **only** on [`SttError::Unavailable`] — the on-device
/// recognizer reporting that it cannot run for the locale *before* any audio was
/// recognized. A recognition that starts and then fails (a framework error,
/// silence, a timeout) is never retried in the cloud: the user chose on-device,
/// so a mid-flight failure is surfaced instead of silently uploading the audio.
/// When it does fire it is logged loudly, and it can only exist when a
/// `GROQ_API_KEY` was configured.
pub struct FallbackTranscriber {
    primary: Arc<dyn Transcriber>,
    fallback: Option<Arc<dyn Transcriber>>,
    /// Set once the fallback has actually run, so [`Transcriber::name`] reports
    /// the backend that produced the last transcript rather than the configured
    /// primary. Keeps the terminal latency line honest when a fallback fires.
    used_fallback: std::sync::atomic::AtomicBool,
}

impl FallbackTranscriber {
    pub fn new(primary: Arc<dyn Transcriber>, fallback: Option<Arc<dyn Transcriber>>) -> Self {
        Self {
            primary,
            fallback,
            used_fallback: std::sync::atomic::AtomicBool::new(false),
        }
    }
}

impl Transcriber for FallbackTranscriber {
    fn transcribe(&self, wav: &Path) -> Result<Transcription, SttError> {
        match self.primary.transcribe(wav) {
            Err(SttError::Unavailable { locale }) if self.fallback.is_some() => {
                println!(
                    "polaris: on-device STT is unavailable for {locale} — falling back to the \
                     configured cloud backend; the audio now leaves this machine"
                );
                self.used_fallback
                    .store(true, std::sync::atomic::Ordering::Relaxed);
                self.fallback
                    .as_ref()
                    .expect("the guard checked that a fallback exists")
                    .transcribe(wav)
            }
            other => other,
        }
    }

    fn name(&self) -> &'static str {
        if self.used_fallback.load(std::sync::atomic::Ordering::Relaxed) {
            self.fallback
                .as_ref()
                .map(|backend| backend.name())
                .unwrap_or("stt")
        } else {
            self.primary.name()
        }
    }
}

/// Which backend the environment asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Apple's on-device `SFSpeechRecognizer`. The default; audio stays local.
    OnDevice,
    /// Groq's OpenAI-compatible cloud API. Explicit opt-in, or the fallback.
    Groq,
}

/// `POLARIS_STT_BACKEND` — the only knob that selects a backend.
pub const BACKEND_ENV: &str = "POLARIS_STT_BACKEND";

/// `POLARIS_STT_LOCALE` — overrides the on-device recognizer locale.
pub const LOCALE_ENV: &str = "POLARIS_STT_LOCALE";

/// Parses `POLARIS_STT_BACKEND`.
///
/// Returns the backend and whether the value was recognized, so the caller can
/// warn about a typo *without* the parse silently flipping the privacy default.
/// Missing or blank means on-device; an unknown value also means on-device, with
/// `recognized = false`.
pub fn parse_backend(value: Option<&str>) -> (Backend, bool) {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => (Backend::OnDevice, true),
        Some(value) if value.eq_ignore_ascii_case("ondevice") => (Backend::OnDevice, true),
        Some(value) if value.eq_ignore_ascii_case("groq") => (Backend::Groq, true),
        Some(_) => (Backend::OnDevice, false),
    }
}

/// Chooses and constructs the STT backend from the environment.
///
/// The default is on-device. `POLARIS_STT_BACKEND=groq` opts into the cloud.
/// When on-device is requested, Groq is attached as a fallback **only** if
/// `GROQ_API_KEY` is configured; the audio then leaves the machine only if the
/// recognizer turns out to be unavailable, and that event is logged.
pub fn build_backend() -> Arc<dyn Transcriber> {
    let (requested, recognized) = parse_backend(env::var(BACKEND_ENV).as_deref());
    if !recognized {
        eprintln!(
            "polaris: unknown {BACKEND_ENV} value — using the on-device default \
             (accepted values are `ondevice` and `groq`)"
        );
    }
    match requested {
        Backend::Groq => {
            let groq = groq::GroqTranscriber::from_env();
            if !groq.has_key() {
                println!(
                    "polaris: {BACKEND_ENV}=groq but GROQ_API_KEY is not set — the overlay will \
                     show \"No STT key\" while capture keeps working"
                );
            }
            Arc::new(groq)
        }
        Backend::OnDevice => ondevice_backend(groq_fallback()),
    }
}

/// The cloud backend, constructed only when a key is actually present. A missing
/// key is not a fallback: it would just add a second failure path and no privacy
/// benefit.
fn groq_fallback() -> Option<Arc<dyn Transcriber>> {
    let groq = groq::GroqTranscriber::from_env();
    groq.has_key()
        .then(|| Arc::new(groq) as Arc<dyn Transcriber>)
}

#[cfg(target_os = "macos")]
fn ondevice_backend(fallback: Option<Arc<dyn Transcriber>>) -> Arc<dyn Transcriber> {
    let locale = ondevice::resolve_locale(env::var(LOCALE_ENV));
    if fallback.is_none() {
        if ondevice::supports_on_device(&locale) {
            println!("polaris: STT backend on-device ({locale}); audio never leaves this Mac");
        } else {
            println!(
                "polaris: on-device STT is unavailable for {locale} and no GROQ_API_KEY is set — \
                 transcription will report \"Local STT off\""
            );
        }
    } else {
        println!(
            "polaris: STT backend on-device ({locale}); Groq is the fallback only if on-device is \
             unavailable"
        );
    }
    Arc::new(FallbackTranscriber::new(
        Arc::new(ondevice::OnDeviceTranscriber::new(locale)),
        fallback,
    ))
}

#[cfg(not(target_os = "macos"))]
fn ondevice_backend(fallback: Option<Arc<dyn Transcriber>>) -> Arc<dyn Transcriber> {
    // The on-device backend is macOS-only, so the only backend is Groq. A
    // missing key still degrades to the "No STT key" label rather than a crash.
    fallback.unwrap_or_else(|| Arc::new(groq::GroqTranscriber::from_env()))
}

/// Pre-flight validation plus the backend call.
///
/// The WAV checks are backend-independent (a local model wants 300 ms of signal
/// just as much as the cloud does), so they live here rather than inside one
/// provider. Keeping this a free function over an injected backend is what makes
/// the contract testable without a network.
pub fn transcribe_verified(
    backend: &dyn Transcriber,
    wav: &Path,
) -> Result<Transcription, SttError> {
    wav::validate(wav)?;
    backend.transcribe(wav)
}

/// Starts the STT worker. Returns immediately; all work happens on the new
/// thread. A failure to spawn is logged, not fatal — capture keeps working and
/// the overlay simply never leaves `ready`.
pub fn start(
    app: AppHandle,
    recordings_dir: PathBuf,
    captures: Receiver<CaptureRecording>,
    backend: Arc<dyn Transcriber>,
    capture: Capture,
) {
    let spawned = std::thread::Builder::new()
        .name("polaris-stt".into())
        .spawn(move || {
            for recording in captures {
                handle(&app, &recordings_dir, backend.as_ref(), &capture, recording);
            }
        });
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the STT worker: {error}");
    }
}

/// Handles one finished capture: validate, transcribe, report, then clean up.
fn handle(
    app: &AppHandle,
    recordings_dir: &Path,
    backend: &dyn Transcriber,
    capture: &Capture,
    recording: CaptureRecording,
) {
    // Latency is measured from the moment the capture finished (the worker
    // receives it as soon as the capture thread has written the WAV) to the
    // moment the transcript is about to be emitted.
    let started = Instant::now();
    capture.mark_transcribing(app, &recording);

    let outcome = transcribe_verified(backend, Path::new(&recording.path));
    let elapsed_ms = started.elapsed().as_millis();

    match outcome {
        Ok(transcription) => {
            println!(
                "polaris: transcript in {elapsed_ms} ms (audio {} ms) via {}: {}",
                recording.duration_ms,
                backend.name(),
                transcription.text
            );
            capture.mark_transcribed(app);
            events::emit(
                app,
                PolarisEvent::Transcript {
                    text: transcription.text,
                    r#final: true,
                },
            );
            // Success is the only path that deletes the WAV: once the text is
            // out, the audio has served its purpose.
            if let Err(error) = std::fs::remove_file(&recording.path) {
                eprintln!(
                    "polaris: could not delete the transcribed recording {}: {error}",
                    recording.path
                );
            }
        }
        Err(error) => {
            eprintln!(
                "polaris: transcription failed [{}] after {elapsed_ms} ms: {}",
                error.label(),
                error.detail()
            );
            // The WAV is kept: it is the only copy of audio the user cannot
            // recreate, and a retry (today, a manual one) may still need it.
            capture.mark_transcription_failed(app, error.label(), &error.detail());
        }
    }

    // Cap unattended/failed recordings. The just-failed file is the newest, so a
    // cap >= 1 always keeps it.
    wav::prune_recordings(recordings_dir, wav::MAX_RECORDINGS);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A backend whose answer is scripted, so the pre-flight + backend contract
    /// is testable with no network.
    struct FakeTranscriber {
        result: Mutex<Option<Result<Transcription, SttError>>>,
        calls: Mutex<usize>,
        name: &'static str,
    }

    impl FakeTranscriber {
        fn returning(result: Result<Transcription, SttError>) -> Self {
            Self {
                result: Mutex::new(Some(result)),
                calls: Mutex::new(0),
                name: "stt",
            }
        }

        fn named(mut self, name: &'static str) -> Self {
            self.name = name;
            self
        }
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe(&self, _wav: &Path) -> Result<Transcription, SttError> {
            *self.calls.lock().unwrap() += 1;
            self.result
                .lock()
                .unwrap()
                .take()
                .expect("the fake transcriber was called twice")
        }

        fn name(&self) -> &'static str {
            self.name
        }
    }

    fn write_wav(path: &Path, peak: i16, frames: u32, sample_rate: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for frame in 0..frames {
            // A non-silent tone whose peak is controlled by `peak`.
            let sample = if frame % 2 == 0 { peak } else { -peak };
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn scratch(label: &str) -> PathBuf {
        crate::env::temp_dir(label)
    }

    #[test]
    fn silent_audio_is_rejected_before_the_backend_is_called() {
        let dir = scratch("stt-silent");
        let wav = dir.join("silent.wav");
        write_wav(&wav, 0, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "should not be reached".into(),
        }));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::Silent)
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_short_recording_is_rejected_before_the_backend_is_called() {
        let dir = scratch("stt-short");
        let wav = dir.join("short.wav");
        // 100 ms of loud audio: long enough to be audible, too short to trust.
        write_wav(&wav, 8_000, 1_600, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription { text: "hi".into() }));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::TooShort { duration_ms: 100 })
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn valid_audio_reaches_the_backend_and_its_result_is_returned() {
        let dir = scratch("stt-ok");
        let wav = dir.join("ok.wav");
        write_wav(&wav, 8_000, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "send 10 usdc to ada".into(),
        }));
        let result = transcribe_verified(&backend, &wav).unwrap();
        assert_eq!(result.text, "send 10 usdc to ada");
        assert_eq!(*backend.calls.lock().unwrap(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_backend_failure_is_propagated_unchanged() {
        let dir = scratch("stt-fail");
        let wav = dir.join("ok.wav");
        write_wav(&wav, 8_000, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Err(SttError::MissingKey));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::MissingKey)
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_error_has_a_short_label_and_a_self_contained_detail() {
        let errors = [
            SttError::MissingKey,
            SttError::Wav("unreadable".into()),
            SttError::Empty,
            SttError::Silent,
            SttError::TooShort { duration_ms: 12 },
            SttError::Network("timeout".into()),
            SttError::Http {
                status: 401,
                detail: "unauthorized".into(),
            },
            SttError::Malformed("no text field".into()),
            SttError::PermissionDenied,
            SttError::Unavailable {
                locale: "tr-TR".into(),
            },
            SttError::Timeout,
            SttError::Speech("kAFAssistantErrorDomain, code 1101".into()),
        ];
        for error in errors {
            let label = error.label();
            assert!(!label.is_empty() && label.len() <= 16, "label: {label}");
            assert!(!error.detail().is_empty());
        }
    }

    #[test]
    fn backend_selection_defaults_to_ondevice_and_never_hides_a_typo() {
        // Missing or blank: the privacy-preserving default, no warning.
        assert_eq!(parse_backend(None), (Backend::OnDevice, true));
        assert_eq!(parse_backend(Some("")), (Backend::OnDevice, true));
        assert_eq!(parse_backend(Some("   ")), (Backend::OnDevice, true));
        // Explicit values are case-insensitive.
        assert_eq!(parse_backend(Some("ondevice")), (Backend::OnDevice, true));
        assert_eq!(parse_backend(Some("ONDEVICE")), (Backend::OnDevice, true));
        assert_eq!(parse_backend(Some(" groq ")), (Backend::Groq, true));
        // A typo must fall back to on-device *and* be reported as unrecognized,
        // so the caller warns instead of silently changing where audio goes.
        assert_eq!(parse_backend(Some("cloud")), (Backend::OnDevice, false));
    }

    #[test]
    fn the_fallback_fires_only_for_an_unavailable_ondevice_backend() {
        let primary = Arc::new(FakeTranscriber::returning(Err(SttError::Unavailable {
            locale: "tr-TR".into(),
        })));
        let fallback = Arc::new(FakeTranscriber::returning(Ok(Transcription {
            text: "from groq".into(),
        })));
        let backend = FallbackTranscriber::new(primary, Some(fallback));

        assert_eq!(backend.transcribe(Path::new("x.wav")).unwrap().text, "from groq");
    }

    #[test]
    fn a_mid_flight_failure_is_not_silently_sent_to_the_cloud() {
        for failure in [
            SttError::Speech("kAFAssistantErrorDomain".into()),
            SttError::Timeout,
            SttError::Silent,
        ] {
            let primary = Arc::new(FakeTranscriber::returning(Err(failure.clone())));
            let fallback = Arc::new(FakeTranscriber::returning(Ok(Transcription {
                text: "should never run".into(),
            })));
            let backend = FallbackTranscriber::new(primary, Some(fallback));

            assert_eq!(backend.transcribe(Path::new("x.wav")), Err(failure));
        }
    }

    #[test]
    fn an_unavailable_backend_without_a_fallback_is_surfaced() {
        let primary = Arc::new(FakeTranscriber::returning(Err(SttError::Unavailable {
            locale: "tr-TR".into(),
        })));
        let backend = FallbackTranscriber::new(primary, None);

        assert_eq!(
            backend.transcribe(Path::new("x.wav")),
            Err(SttError::Unavailable {
                locale: "tr-TR".into()
            })
        );
    }

    #[test]
    fn the_fallback_reports_the_backend_that_actually_ran() {
        let primary = Arc::new(
            FakeTranscriber::returning(Err(SttError::Unavailable {
                locale: "tr-TR".into(),
            }))
            .named("ondevice"),
        );
        let fallback = Arc::new(
            FakeTranscriber::returning(Ok(Transcription {
                text: "from groq".into(),
            }))
            .named("groq"),
        );
        let backend = FallbackTranscriber::new(primary, Some(fallback));

        assert_eq!(backend.name(), "ondevice", "nothing has run yet");
        backend.transcribe(Path::new("x.wav")).unwrap();
        // The terminal latency line must name the backend that produced the
        // transcript, not the one that was merely configured.
        assert_eq!(backend.name(), "groq");
    }
}
