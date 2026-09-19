//! Text-to-speech (step A3).
//!
//! Polaris speaks back: a short confirmation or answer is turned into audible
//! speech. The provider decision is made by the owner and is not revisited here:
//! **Fish Audio** with the `s2.1-pro-free` model is primary (free tier, Turkish
//! supported, no card), and **local macOS speech** (`say`) is the mandatory
//! fallback. The free tier is time-limited and has **no SLA**, so an empty or
//! invalid key, a missing voice id, or any network failure must still produce
//! audio rather than silence.
//!
//! This mirrors step A1's `stt` module deliberately: a [`Speaker`] trait, one
//! cloud backend ([`fish`]), one on-device backend ([`local`]), and
//! [`build_backend`] selecting between them from `POLARIS_TTS_BACKEND`. The
//! worker-independent shape is the same; only the interface is inverted (text in,
//! audio out).
//!
//! ## One fixed voice, always
//!
//! In Fish Audio the `model` header selects the **engine**, not the voice. The
//! voice is chosen by the `reference_id` field in the request body (a voice-model
//! id). Omitting it makes the voice drift between requests, so a configured
//! `POLARIS_TTS_REFERENCE_ID` is **required** for the Fish backend: when it is
//! missing the backend does not make a request at all and the local backend is
//! used instead. The same stability idea applies locally via
//! `POLARIS_TTS_LOCAL_VOICE` (default `Yelda`).
//!
//! ## Two invariants carried over from A0/A1
//!
//! * Speaking never runs on the Tauri main thread. [`Speaker::speak`] is
//!   blocking; the `speak` command runs it on Tauri's blocking pool and the
//!   agent loop will call it from its own worker.
//! * A failure is a short user-facing label plus a full terminal line (`tts in
//!   <ms> ms` on success), never a panic and never silence when local speech is
//!   available.

pub mod fish;
pub mod local;
pub mod player;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

use crate::env;

/// The language base (`en-US` -> `en`) used to key the per-language voice
/// overrides. Returns `None` for anything that is not plausibly a language base,
/// so a malformed env key can never become a lookup entry.
pub fn normalize_language_base(value: &str) -> Option<String> {
    let normalized = value.trim().to_lowercase().replace('_', "-");
    let base = normalized.split('-').next().unwrap_or_default();
    if base.len() >= 2 && base.chars().all(|character| character.is_ascii_alphabetic()) {
        Some(base.to_string())
    } else {
        None
    }
}

/// Collects `<prefix><LANG>` environment entries into a language -> value map.
///
/// Takes key/value pairs rather than reading the process environment, so the
/// parsing is unit-tested deterministically. Blank values, empty suffixes and
/// non-language suffixes are ignored — a pinned default is always the fallback.
pub fn language_overrides_from<I>(pairs: I, prefix: &str) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    let mut overrides = HashMap::new();
    for (key, value) in pairs {
        let Some(suffix) = key.strip_prefix(prefix) else {
            continue;
        };
        let value = value.trim();
        if suffix.is_empty() || value.is_empty() {
            continue;
        }
        if let Some(base) = normalize_language_base(suffix) {
            overrides.insert(base, value.to_string());
        }
    }
    overrides
}

/// Everything that can go wrong between "there is text to speak" and "the audio
/// finished playing".
///
/// The split between [`Self::label`] and [`Self::detail`] matches [`crate::stt`]:
/// the UI gets a hand-shortened label, the Rust terminal gets the full story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TtsError {
    /// There is nothing to say (all-whitespace text).
    EmptyText,
    /// `FISH_AUDIO_API_KEY` is not set.
    MissingKey,
    /// `POLARIS_TTS_REFERENCE_ID` is not set. Sending without it would drift the
    /// voice between requests, so the request is never made.
    MissingReferenceId,
    /// Could not reach the provider (DNS, TLS, timeout, connection reset).
    Network(String),
    /// The provider answered with a non-2xx status.
    Http { status: u16, detail: String },
    /// The provider answered 2xx but the body was empty or otherwise unusable.
    Malformed(String),
    /// Writing or playing the synthesized audio failed (`afplay`, temp file).
    Playback(String),
    /// The local backend could not run `say`.
    Local(String),
}

impl TtsError {
    /// Short, UI-safe copy. Kept to a handful of characters.
    pub fn label(&self) -> &'static str {
        match self {
            Self::EmptyText => "Nothing to say",
            Self::MissingKey => "No TTS key",
            Self::MissingReferenceId => "No voice id",
            Self::Network(_) => "Net error",
            Self::Http { .. } => "TTS error",
            Self::Malformed(_) => "Bad audio",
            Self::Playback(_) => "Playback",
            Self::Local(_) => "Local TTS off",
        }
    }

    /// Full terminal message. It must never contain the API key — nothing here
    /// has access to it, which is the point of keeping the key a unit-like state.
    pub fn detail(&self) -> String {
        match self {
            Self::EmptyText => "the text to speak is empty".to_string(),
            Self::MissingKey => "FISH_AUDIO_API_KEY is not set. Set it in the environment or a \
                 gitignored .env at the repo root; the local macOS voice is used instead."
                .to_string(),
            Self::MissingReferenceId => "POLARIS_TTS_REFERENCE_ID is not set. Fish Audio selects \
                 the voice with `reference_id`, so omitting it would drift the voice between \
                 requests; the local macOS voice is used instead."
                .to_string(),
            Self::Network(message) => format!("could not reach the speech service: {message}"),
            Self::Http { status, detail } => {
                format!("the speech service returned HTTP {status}: {detail}")
            }
            Self::Malformed(message) => format!("could not use the speech response: {message}"),
            Self::Playback(message) => format!("could not play the synthesized audio: {message}"),
            Self::Local(message) => format!("local macOS speech failed: {message}"),
        }
    }
}

/// A one-shot notification that audio playback has **actually begun**, as opposed
/// to synthesis having been requested (step A9).
///
/// The `speak` command used to announce "Speaking" the moment it dispatched the
/// request, so the notch lied for the whole Fish synthesis wait (~2–3 s before
/// the first sample). Backends now call this exactly when the player starts, and
/// the command emits `speech_status: speaking` from here — the stage can only be
/// entered once there is real audio.
pub type PlaybackStart<'a> = dyn Fn() + Send + Sync + 'a;

/// The backend seam.
///
/// Implementations must be blocking and self-contained. Adding a backend means
/// implementing this trait and constructing it in [`build_backend`]; the `speak`
/// command and every future call site stay unchanged.
pub trait Speaker: Send + Sync {
    /// Synthesizes `text` and plays it, invoking `on_playback_start` at the
    /// moment audio playback begins — never during synthesis — and returning once
    /// the audio has finished.
    ///
    /// `language` is the model-reported BCP-47 tag for this utterance (step A11).
    /// A backend may use it to pick a per-language voice; `None` means the
    /// configured default voice, and a language without an override must fall
    /// back to that default (never silently switch the pinned voice).
    fn speak(
        &self,
        text: &str,
        language: Option<&str>,
        on_playback_start: &PlaybackStart<'_>,
    ) -> Result<(), TtsError>;

    /// Short backend name for the terminal latency line, so the Fish and local
    /// numbers can be told apart on the same scale.
    fn name(&self) -> &'static str {
        "tts"
    }
}

/// Wraps the Fish primary and the mandatory local fallback.
///
/// Unlike step A1's `FallbackTranscriber` — which falls back only on a narrow
/// pre-recognition error — this falls back on **any** primary failure. That is
/// the explicit A3 requirement: the free tier has no SLA, so a network or HTTP
/// failure must not leave the assistant silent. The fallback changes the voice
/// for that utterance (it cannot clone the Fish voice), which is logged loudly
/// and is the accepted cost of never failing the demo.
pub struct FallbackSpeaker {
    primary: Option<Arc<dyn Speaker>>,
    fallback: Arc<dyn Speaker>,
    /// Set once the fallback has actually run, so [`Speaker::name`] reports the
    /// backend that produced the last utterance rather than the configured
    /// primary. Keeps the terminal latency line honest.
    used_fallback: AtomicBool,
}

impl FallbackSpeaker {
    pub fn new(primary: Option<Arc<dyn Speaker>>, fallback: Arc<dyn Speaker>) -> Self {
        Self {
            primary,
            fallback,
            used_fallback: AtomicBool::new(false),
        }
    }
}

impl Speaker for FallbackSpeaker {
    fn speak(
        &self,
        text: &str,
        language: Option<&str>,
        on_playback_start: &PlaybackStart<'_>,
    ) -> Result<(), TtsError> {
        // A single utterance may cross the primary/fallback boundary (the primary
        // can fail mid-flight), so the playback-start notification is latched: it
        // fires at most once per utterance no matter which backend actually plays.
        let announced = AtomicBool::new(false);
        let on_start = || {
            if !announced.swap(true, Ordering::SeqCst) {
                on_playback_start();
            }
        };
        let Some(primary) = &self.primary else {
            // No primary at all (Fish was not configured): speak locally and
            // skip the fallback banner, which would be misleading.
            return self.fallback.speak(text, language, &on_start);
        };
        match primary.speak(text, language, &on_start) {
            Ok(()) => Ok(()),
            Err(error) => {
                eprintln!(
                    "polaris: Fish Audio TTS failed [{}] — falling back to local macOS speech; \
                     this utterance uses a different voice: {}",
                    error.label(),
                    error.detail()
                );
                self.used_fallback.store(true, Ordering::Relaxed);
                self.fallback.speak(text, language, &on_start)
            }
        }
    }

    fn name(&self) -> &'static str {
        if self.used_fallback.load(Ordering::Relaxed) {
            self.fallback.name()
        } else {
            self.primary
                .as_ref()
                .map(|backend| backend.name())
                .unwrap_or_else(|| self.fallback.name())
        }
    }
}

/// Which backend the environment asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Fish Audio cloud TTS. The default; local speech is attached as fallback.
    Fish,
    /// Local macOS `say`. Explicit opt-in, or the fallback.
    Local,
}

/// `POLARIS_TTS_BACKEND` — the only knob that selects a backend.
pub const BACKEND_ENV: &str = "POLARIS_TTS_BACKEND";

/// Parses `POLARIS_TTS_BACKEND`.
///
/// Returns the backend and whether the value was recognized, so the caller can
/// warn about a typo without the parse silently choosing a different backend.
/// Missing or blank means Fish; an unknown value also means Fish, with
/// `recognized = false`.
pub fn parse_backend(value: Option<&str>) -> (Backend, bool) {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => (Backend::Fish, true),
        Some(value) if value.eq_ignore_ascii_case("fish") => (Backend::Fish, true),
        Some(value) if value.eq_ignore_ascii_case("local") => (Backend::Local, true),
        Some(_) => (Backend::Fish, false),
    }
}

/// Chooses and constructs the TTS backend from the environment.
///
/// Default is Fish with the mandatory local fallback. `POLARIS_TTS_BACKEND=local`
/// opts into local-only. When Fish is requested but its required config
/// (`POLARIS_TTS_REFERENCE_ID`, `FISH_AUDIO_API_KEY`) is missing, it is never
/// called: the reason is logged and local speech is used for every utterance.
pub fn build_backend() -> Arc<dyn Speaker> {
    let (requested, recognized) = parse_backend(env::var(BACKEND_ENV).as_deref());
    if !recognized {
        eprintln!(
            "polaris: unknown {BACKEND_ENV} value — using the Fish Audio default \
             (accepted values are `fish` and `local`)"
        );
    }
    match requested {
        Backend::Local => {
            println!(
                "polaris: TTS backend local macOS speech (voice {})",
                local::LocalSpeaker::from_env()
                    .voice()
                    .unwrap_or("system default")
            );
            local_speaker()
        }
        Backend::Fish => {
            let fish = fish::FishSpeaker::from_env();
            if let Some(problem) = fish.missing_config() {
                println!(
                    "polaris: {BACKEND_ENV}=fish but {problem} — speaking with local macOS speech \
                     instead"
                );
                return local_speaker();
            }
            println!(
                "polaris: TTS backend Fish Audio ({} — voice {}) with local macOS speech as fallback",
                fish.model(),
                fish.voice_id().unwrap_or("?")
            );
            // Per-language overrides are the owner's values; printing which ones
            // are in effect is the only way to confirm the lookup on a real run.
            if !fish.voice_overrides().is_empty() {
                let mut overrides: Vec<(&String, &String)> = fish.voice_overrides().iter().collect();
                overrides.sort_by_key(|(language, _)| language.as_str());
                let rendered: Vec<String> = overrides
                    .into_iter()
                    .map(|(language, voice)| format!("{language}={voice}"))
                    .collect();
                println!(
                    "polaris: TTS per-language voice overrides: {}",
                    rendered.join(", ")
                );
            }
            Arc::new(FallbackSpeaker::new(Some(Arc::new(fish)), local_speaker()))
        }
    }
}

/// The local backend, always available as a fallback or as the explicit choice.
fn local_speaker() -> Arc<dyn Speaker> {
    Arc::new(local::LocalSpeaker::from_env())
}

/// Validates the text and calls the backend.
///
/// The "nothing to say" check is backend-independent, so it lives here rather
/// than inside one provider. Keeping this a free function over an injected
/// backend is what makes the contract testable without audio or a network.
pub fn speak_verified(
    backend: &dyn Speaker,
    text: &str,
    language: Option<&str>,
    on_playback_start: &PlaybackStart<'_>,
) -> Result<(), TtsError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(TtsError::EmptyText);
    }
    backend.speak(text, language, on_playback_start)
}

/// Speaks `text` and prints the terminal lines the `speak` command relies on:
/// `tts in <ms> ms via <backend>` on success, or the short label plus full detail
/// on failure. Kept here (rather than inline in the command) so the manual
/// fallback demonstration runs the exact same path the app does.
pub fn speak_and_log(
    backend: &dyn Speaker,
    text: &str,
    language: Option<&str>,
    on_playback_start: &PlaybackStart<'_>,
) -> Result<(), TtsError> {
    let started = Instant::now();
    match speak_verified(backend, text, language, on_playback_start) {
        Ok(()) => {
            println!(
                "polaris: tts in {} ms via {} ({} chars, lang {})",
                started.elapsed().as_millis(),
                backend.name(),
                text.trim().chars().count(),
                language.unwrap_or("-")
            );
            Ok(())
        }
        Err(error) => {
            eprintln!(
                "polaris: tts failed [{}] after {} ms: {}",
                error.label(),
                started.elapsed().as_millis(),
                error.detail()
            );
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A backend whose answer is scripted, so the contract is testable with no
    /// network and no audio.
    struct FakeSpeaker {
        result: Mutex<Option<Result<(), TtsError>>>,
        calls: Mutex<usize>,
        name: &'static str,
    }

    impl FakeSpeaker {
        fn returning(result: Result<(), TtsError>) -> Self {
            Self {
                result: Mutex::new(Some(result)),
                calls: Mutex::new(0),
                name: "tts",
            }
        }

        fn named(mut self, name: &'static str) -> Self {
            self.name = name;
            self
        }
    }

    impl Speaker for FakeSpeaker {
        fn speak(
            &self,
            _text: &str,
            _language: Option<&str>,
            _on_playback_start: &PlaybackStart<'_>,
        ) -> Result<(), TtsError> {
            *self.calls.lock().unwrap() += 1;
            self.result
                .lock()
                .unwrap()
                .take()
                .expect("the fake speaker was called twice")
        }

        fn name(&self) -> &'static str {
            self.name
        }
    }

    #[test]
    fn empty_text_is_rejected_before_the_backend_is_called() {
        let backend = FakeSpeaker::returning(Ok(()));
        let noop = || {};
        assert_eq!(
            speak_verified(&backend, "   ", None, &noop),
            Err(TtsError::EmptyText)
        );
        assert_eq!(speak_verified(&backend, "", None, &noop), Err(TtsError::EmptyText));
        assert_eq!(*backend.calls.lock().unwrap(), 0);
    }

    #[test]
    fn valid_text_reaches_the_backend_trimmed() {
        struct RecordingSpeaker {
            seen: Mutex<Vec<String>>,
        }
        impl Speaker for RecordingSpeaker {
            fn speak(
                &self,
                text: &str,
                _language: Option<&str>,
                _on_playback_start: &PlaybackStart<'_>,
            ) -> Result<(), TtsError> {
                self.seen.lock().unwrap().push(text.to_string());
                Ok(())
            }
        }
        let backend = RecordingSpeaker {
            seen: Mutex::new(Vec::new()),
        };
        let noop = || {};
        speak_verified(&backend, "  Sending 5 USDC to Ahmet — confirm?  ", None, &noop).unwrap();
        assert_eq!(
            backend.seen.lock().unwrap().as_slice(),
            &["Sending 5 USDC to Ahmet — confirm?"]
        );
    }

    #[test]
    fn a_backend_failure_is_propagated_unchanged() {
        let backend = FakeSpeaker::returning(Err(TtsError::MissingKey));
        let noop = || {};
        assert_eq!(
            speak_verified(&backend, "hi", None, &noop),
            Err(TtsError::MissingKey)
        );
    }

    /// A backend that announces playback and then returns a scripted result, so
    /// the once-only latch in [`FallbackSpeaker`] can be exercised.
    struct NotifySpeaker {
        result: Result<(), TtsError>,
        name: &'static str,
    }

    impl Speaker for NotifySpeaker {
        fn speak(
            &self,
            _text: &str,
            _language: Option<&str>,
            on_playback_start: &PlaybackStart<'_>,
        ) -> Result<(), TtsError> {
            on_playback_start();
            self.result.clone()
        }

        fn name(&self) -> &'static str {
            self.name
        }
    }

    #[test]
    fn playback_start_fires_only_when_a_backend_reports_it() {
        let announced = std::sync::atomic::AtomicUsize::new(0);
        let on_start = || {
            announced.fetch_add(1, Ordering::SeqCst);
        };

        // A backend that fails before playback must never announce it.
        let failing = FakeSpeaker::returning(Err(TtsError::Network("dns".into())));
        assert!(speak_verified(&failing, "hi", None, &on_start).is_err());
        assert_eq!(announced.load(Ordering::SeqCst), 0);

        // A backend that really starts playing announces exactly once.
        let playing = NotifySpeaker {
            result: Ok(()),
            name: "fake",
        };
        speak_verified(&playing, "hi", None, &on_start).unwrap();
        assert_eq!(announced.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn the_fallback_announces_playback_at_most_once_across_the_handoff() {
        let announced = std::sync::atomic::AtomicUsize::new(0);
        let on_start = || {
            announced.fetch_add(1, Ordering::SeqCst);
        };

        // The primary announces playback and *then* fails; the fallback announces
        // again. The utterance is still a single playback event.
        let primary = Arc::new(NotifySpeaker {
            result: Err(TtsError::Network("mid-flight".into())),
            name: "fish",
        });
        let fallback = Arc::new(NotifySpeaker {
            result: Ok(()),
            name: "local",
        });
        let backend = FallbackSpeaker::new(Some(primary), fallback);

        backend.speak("merhaba", None, &on_start).unwrap();
        assert_eq!(announced.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn every_error_has_a_short_label_and_a_self_contained_detail() {
        let errors = [
            TtsError::EmptyText,
            TtsError::MissingKey,
            TtsError::MissingReferenceId,
            TtsError::Network("timeout".into()),
            TtsError::Http {
                status: 401,
                detail: "unauthorized".into(),
            },
            TtsError::Malformed("no audio".into()),
            TtsError::Playback("afplay exited 1".into()),
            TtsError::Local("say exited 1".into()),
        ];
        for error in errors {
            let label = error.label();
            assert!(!label.is_empty() && label.len() <= 16, "label: {label}");
            assert!(!error.detail().is_empty());
        }
    }

    #[test]
    fn backend_selection_defaults_to_fish_and_never_hides_a_typo() {
        assert_eq!(parse_backend(None), (Backend::Fish, true));
        assert_eq!(parse_backend(Some("")), (Backend::Fish, true));
        assert_eq!(parse_backend(Some("   ")), (Backend::Fish, true));
        assert_eq!(parse_backend(Some("fish")), (Backend::Fish, true));
        assert_eq!(parse_backend(Some("FISH")), (Backend::Fish, true));
        assert_eq!(parse_backend(Some(" local ")), (Backend::Local, true));
        // A typo must fall back to the Fish default *and* be reported as
        // unrecognized, so the caller warns instead of silently changing backend.
        assert_eq!(parse_backend(Some("cloud")), (Backend::Fish, false));
    }

    #[test]
    fn the_fallback_speaks_when_the_primary_fails() {
        let primary = Arc::new(FakeSpeaker::returning(Err(TtsError::Network("dns".into()))));
        let fallback = Arc::new(FakeSpeaker::returning(Ok(())));
        let backend = FallbackSpeaker::new(Some(primary), fallback);
        let noop = || {};

        assert!(backend.speak("merhaba", None, &noop).is_ok());
    }

    #[test]
    fn a_primary_failure_that_the_fallback_also_cannot_save_is_surfaced() {
        let primary = Arc::new(FakeSpeaker::returning(Err(TtsError::Http {
            status: 503,
            detail: "high load".into(),
        })));
        let fallback = Arc::new(FakeSpeaker::returning(Err(TtsError::Local(
            "say not found".into(),
        ))));
        let backend = FallbackSpeaker::new(Some(primary), fallback);
        let noop = || {};

        assert_eq!(
            backend.speak("merhaba", None, &noop),
            Err(TtsError::Local("say not found".into()))
        );
    }

    #[test]
    fn the_fallback_reports_the_backend_that_actually_ran() {
        let primary =
            Arc::new(FakeSpeaker::returning(Err(TtsError::MissingReferenceId)).named("fish"));
        let fallback = Arc::new(FakeSpeaker::returning(Ok(())).named("local"));
        let backend = FallbackSpeaker::new(Some(primary), fallback);
        let noop = || {};

        assert_eq!(backend.name(), "fish", "nothing has run yet");
        backend.speak("merhaba", None, &noop).unwrap();
        assert_eq!(backend.name(), "local");
    }

    #[test]
    fn a_primary_that_succeeds_never_touches_the_fallback() {
        let primary = Arc::new(FakeSpeaker::returning(Ok(())).named("fish"));
        let fallback = Arc::new(FakeSpeaker::returning(Ok(())).named("local"));
        let backend = FallbackSpeaker::new(Some(primary.clone()), fallback.clone());
        let noop = || {};

        backend.speak("merhaba", None, &noop).unwrap();
        assert_eq!(*primary.calls.lock().unwrap(), 1);
        assert_eq!(*fallback.calls.lock().unwrap(), 0);
        assert_eq!(backend.name(), "fish");
    }

    #[test]
    fn a_local_only_backend_speaks_without_a_primary() {
        let fallback = Arc::new(FakeSpeaker::returning(Ok(())).named("local"));
        let backend = FallbackSpeaker::new(None, fallback);
        let noop = || {};

        assert!(backend.speak("merhaba", None, &noop).is_ok());
        assert_eq!(backend.name(), "local");
    }

    /// Manual verification, not part of the default suite: it makes `say` speak
    /// aloud. Run it to prove the unprovisioned-key path end to end:
    ///
    /// ```text
    /// caffeinate -i cargo test manual_local_fallback_speaks_when_fish_key_is_missing \
    ///   -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "speaks aloud; run manually with --ignored --nocapture"]
    fn manual_local_fallback_speaks_when_fish_key_is_missing() {
        // The state the task describes: Fish requested, no key provisioned.
        // `env::var` treats an empty value as unset, so this is the same path a
        // missing key takes.
        std::env::set_var(BACKEND_ENV, "fish");
        std::env::set_var("FISH_AUDIO_API_KEY", "");
        std::env::set_var(
            "POLARIS_TTS_REFERENCE_ID",
            "63d02a65c5324343ad082bbae8ab0337",
        );

        let backend = build_backend();
        assert_eq!(
            backend.name(),
            "local",
            "missing key must select local speech"
        );
        let noop = || {};
        speak_and_log(
            backend.as_ref(),
            "Polaris hazır. Yerel ses çalışıyor.",
            None,
            &noop,
        )
        .expect("local macOS speech must succeed");
    }

    /// Whether `bytes` look like an MPEG audio payload: either an ID3v2 tag or
    /// an MPEG frame sync (`11111111 111`). Used by the live test below.
    fn looks_like_mpeg(bytes: &[u8]) -> bool {
        bytes.starts_with(b"ID3")
            || (bytes.len() >= 2 && bytes[0] == 0xFF && (bytes[1] & 0xE0) == 0xE0)
    }

    /// Live verification of the REAL Fish Audio backend, not the fallback. It
    /// makes a paid/free-tier network call and speaks aloud, so it is `#[ignore]`d
    /// to keep the default `cargo test` offline and deterministic. Run it with the
    /// repo `.env` present (the test also self-loads it):
    ///
    /// ```text
    /// caffeinate -i cargo test manual_live_fish -- --ignored --nocapture
    /// ```
    ///
    /// It proves two things in sequence: the HTTP response carries a non-empty
    /// MPEG payload, and the exact production `speak_and_log` path streams that
    /// payload into the player (ffplay stdin when available, buffered `afplay`
    /// otherwise) and prints `polaris: tts in <ms> ms via fish`.
    ///
    /// Passing `POLARIS_E2E_TEXT` makes it speak a caller-supplied sentence — the
    /// A4 end-to-end check uses this to speak the confirmation the TypeScript
    /// formatter produced for a real intent (`npm run e2e:speak -w @polaris/agent`).
    #[test]
    #[ignore = "calls the live Fish Audio API and speaks aloud; run manually with --ignored --nocapture"]
    fn manual_live_fish_synthesises_mpeg_and_speaks() {
        // Real environment variables win; this only fills gaps from the
        // gitignored `.env`, so a sourced shell still takes precedence.
        crate::env::load();

        // Built from the environment, exactly as `build_backend()` does it.
        let speaker = fish::FishSpeaker::from_env();
        assert_eq!(
            speaker.missing_config(),
            None,
            "the live test needs FISH_AUDIO_API_KEY and POLARIS_TTS_REFERENCE_ID"
        );

        // The sentence the app would speak. A driver (the A4 `e2e:speak` script)
        // passes the real intent confirmation in `POLARIS_E2E_TEXT`; without it
        // the fixed sentence below is used, so the test still runs standalone.
        let sentence = crate::env::var("POLARIS_E2E_TEXT")
            .unwrap_or_else(|| "Merhaba, this is Polaris. Onaylıyor musun?".to_string());
        println!(
            "polaris: live Fish voice reference_id={} sentence={sentence:?}",
            speaker.voice_id().unwrap_or("?")
        );

        // 1. The raw payload: non-empty and genuinely MPEG.
        let audio = speaker
            .synthesize(&sentence)
            .expect("live Fish synthesis must succeed");
        assert!(
            !audio.is_empty(),
            "Fish answered 2xx with an empty audio body"
        );
        assert!(
            looks_like_mpeg(&audio),
            "expected an MPEG payload, got {} bytes starting {:02X?}",
            audio.len(),
            &audio[..audio.len().min(4)]
        );

        // 2. The production path: streamed into the player -> `tts in <ms> ms via fish`.
        // The playback-start notification (the A9 "Speaking" trigger) must fire
        // exactly once, and only after real audio has begun.
        //
        // Step A11: this is also the headless TTS timing harness. `POLARIS_E2E_LANG`
        // (a BCP-47 tag) exercises the per-language voice path; `POLARIS_TIMING`
        // (on by default) makes `speak_and_log` print one phase block, so the
        // synthesis split can be read without a human at the microphone.
        let language = crate::env::var("POLARIS_E2E_LANG");
        println!(
            "polaris: live Fish voice for lang {} => {} (overrides: {})",
            language.as_deref().unwrap_or("-"),
            speaker.reference_for(language.as_deref()).unwrap_or("?"),
            speaker
                .voice_overrides()
                .iter()
                .map(|(lang, voice)| format!("{lang}={voice}"))
                .collect::<Vec<_>>()
                .join(", ")
        );
        crate::timing::begin_turn();
        crate::timing::mark("hotkey release");
        crate::timing::mark("tts request sent");
        let announced = std::sync::atomic::AtomicUsize::new(0);
        let on_start = || {
            crate::timing::mark("playback start");
            announced.fetch_add(1, Ordering::SeqCst);
        };
        speak_and_log(&speaker, &sentence, language.as_deref(), &on_start)
            .expect("live Fish playback must succeed");
        crate::timing::mark("playback end");
        crate::timing::finish_turn();
        assert_eq!(announced.load(Ordering::SeqCst), 1);
    }
}
