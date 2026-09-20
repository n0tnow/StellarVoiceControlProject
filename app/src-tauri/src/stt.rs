//! Speech-to-text (step A1).
//!
//! A finished capture (step A0) is handed to a background worker, which turns the
//! WAV into a transcript and pushes it onto the `polaris-event` stream. The
//! product decision for this step is **cloud-first for correctness** (revised in
//! step A12): Groq's multilingual `whisper-large-v3-turbo` ([`groq`]) detects the
//! spoken language itself and reports it, so an English command cannot be
//! phoneticised as Turkish and poison everything downstream. Apple's on-device
//! `SFSpeechRecognizer` ([`ondevice`], macOS-only) stays available (and is
//! strictly better on privacy and latency) via `POLARIS_STT_BACKEND=ondevice`,
//! but it is **single-locale**: it can never identify the language. Both sit
//! behind the [`Transcriber`] trait, so the worker and every call site are
//! unchanged.
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
use crate::timing;
use crate::types::CaptureRecording;

/// One recognized utterance. `text` is already trimmed; an all-whitespace
/// result is treated as silence, not as an empty transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcription {
    pub text: String,
    /// The language the audio was recognized as, normalised to a BCP-47 tag
    /// (step A12). Groq's multilingual model returns its own detection; the
    /// on-device recognizer can only report the locale it was pinned to. `None`
    /// means "unknown" — it is never guessed here.
    ///
    /// Since A14 this is a **hint**, not the decision: the model's judgement of
    /// the transcript text decides the reply language and the TTS voice, because
    /// Whisper's audio-level label was observed labelling correct English text
    /// `tr`. The value is still worth carrying — it is passed to the model as a
    /// hint and is the fallback when the model reports nothing.
    pub language: Option<String>,
}

/// Maps a backend's language report to a lowercase BCP-47 tag (step A12).
///
/// The backends do not speak one vocabulary: Groq's Whisper returns a language
/// *name* (`"Turkish"`, `"English"`), while Apple's recognizer is pinned to a
/// *locale* (`"tr-TR"`). Both are normalised here so the agent and the
/// per-language TTS voice lookup see exactly one shape. An unrecognised name is
/// `None` rather than a raw guess: an unknown language must never silently pick
/// a voice (the pinned voice is the fallback).
pub fn normalize_detected_language(raw: &str) -> Option<String> {
    let value = raw.trim().to_lowercase().replace('_', "-");
    if value.is_empty() {
        return None;
    }
    // An already-coded tag (`tr`, `en-us`, `zh-hans`) passes through unchanged.
    let base = value.split('-').next().unwrap_or_default();
    if (2..=3).contains(&base.len()) && base.chars().all(|character| character.is_ascii_alphabetic())
    {
        return Some(value);
    }
    language_name_to_code(&value).map(str::to_string)
}

/// Maps a full English language name (as Groq returns it) to an ISO-639-1 code.
///
/// Deliberately a short, explicit table rather than a dependency: only the names
/// the product can actually hear need to resolve, and anything else stays
/// `None` so an unknown language cannot silently change the voice.
fn language_name_to_code(value: &str) -> Option<&'static str> {
    let code = match value {
        "english" => "en",
        "turkish" => "tr",
        "german" => "de",
        "french" => "fr",
        "spanish" => "es",
        "italian" => "it",
        "portuguese" => "pt",
        "dutch" => "nl",
        "russian" => "ru",
        "arabic" => "ar",
        "hindi" => "hi",
        "japanese" => "ja",
        "korean" => "ko",
        "chinese" => "zh",
        "polish" => "pl",
        "swedish" => "sv",
        "greek" => "el",
        "hebrew" => "he",
        "azerbaijani" => "az",
        _ => return None,
    };
    Some(code)
}

/// `POLARIS_STT_PROMPT` — overrides or disables the vocabulary hint.
pub const PROMPT_ENV: &str = "POLARIS_STT_PROMPT";

/// `POLARIS_STT_ALLOWED_LANGS` — the languages a detection may keep without a retry.
pub const ALLOWED_LANGS_ENV: &str = "POLARIS_STT_ALLOWED_LANGS";

/// `POLARIS_ALIASES` — only the alias **names** are read, for the vocabulary hint.
pub const ALIASES_ENV: &str = "POLARIS_ALIASES";

/// The English-only vocabulary hint, used when the language is forced to `en`.
///
/// Written as ONE natural sentence rather than a bare word list: Whisper echoes
/// a comma-separated vocabulary back on short clips (F3-fix), but a sentence is
/// read as context. Kept well under the ~200-token guidance.
pub const DEFAULT_PROMPT_EN: &str = "Send 10 XLM from acc1 to acc2.";

/// The Turkish-only vocabulary hint, used when the language is forced to `tr`.
pub const DEFAULT_PROMPT_TR: &str = "acc1'den acc2'ye 10 XLM gönder.";

/// The short bilingual hint used when no language is forced.
///
/// A forced language must never see the other language's words (that is exactly
/// what leaked Turkish into the owner's English clip); auto-detection gets both.
pub const DEFAULT_PROMPT: &str =
    "Send 10 XLM from acc1 to acc2. acc1'den acc2'ye 10 XLM gönder.";

/// The languages a built-in vocabulary hint can be written in (F3-fix).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptLanguage {
    English,
    Turkish,
    Bilingual,
}

/// Chooses the hint language from the forced `POLARIS_STT_LANGUAGE`.
///
/// `en`/`tr` (any region suffix) pick that language only; anything else —
/// including auto-detection (`None`) — keeps the short bilingual hint.
pub fn prompt_language(forced_language: Option<&str>) -> PromptLanguage {
    let Some(value) = forced_language.map(str::trim).filter(|value| !value.is_empty()) else {
        return PromptLanguage::Bilingual;
    };
    match value.split('-').next().unwrap_or(value).to_lowercase().as_str() {
        "en" => PromptLanguage::English,
        "tr" => PromptLanguage::Turkish,
        _ => PromptLanguage::Bilingual,
    }
}

/// Builds the vocabulary hint in the language actually in use, plus the
/// recipient alias names. Aids the decoder with the exact words; contains no
/// address or secret.
pub fn build_prompt(aliases: &[String], forced_language: Option<&str>) -> String {
    let language = prompt_language(forced_language);
    let base = match language {
        PromptLanguage::English => DEFAULT_PROMPT_EN,
        PromptLanguage::Turkish => DEFAULT_PROMPT_TR,
        PromptLanguage::Bilingual => DEFAULT_PROMPT,
    };
    if aliases.is_empty() {
        return base.to_string();
    }
    let recipients = match language {
        PromptLanguage::Turkish => format!("Alıcılar {}.", join_names(aliases, "ve")),
        PromptLanguage::English | PromptLanguage::Bilingual => {
            format!("Recipients are {}.", join_names(aliases, "and"))
        }
    };
    format!("{base} {recipients}")
}

/// Joins recipient names the way the sentence needs (`a and b`, `a ve b`).
fn join_names(names: &[String], conjunction: &str) -> String {
    match names {
        [] => String::new(),
        [only] => only.clone(),
        [rest @ .., last] => format!("{} {conjunction} {last}", rest.join(", ")),
    }
}

/// Alias **names** from a `POLARIS_ALIASES` value (`alias=G...` pairs).
///
/// Only the left-hand side of each pair is read, so an address can never leak
/// into a request body through the vocabulary hint. Blank names are dropped and
/// a repeated name is kept once.
pub fn alias_names(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else {
        return Vec::new();
    };
    let mut names: Vec<String> = Vec::new();
    for entry in raw.split(',') {
        let Some((name, _address)) = entry.split_once('=') else {
            continue;
        };
        let name = name.trim();
        if !name.is_empty() && !names.iter().any(|seen| seen == name) {
            names.push(name.to_string());
        }
    }
    names
}

/// Resolves the transcription prompt from [`PROMPT_ENV`].
///
/// `off` disables the hint entirely; any other non-empty value replaces the
/// built-in vocabulary verbatim; unset/blank builds the language-appropriate
/// [`DEFAULT_PROMPT_EN`]/[`DEFAULT_PROMPT_TR`]/[`DEFAULT_PROMPT`] plus the alias
/// names seen in the environment.
pub fn resolve_prompt(
    raw: Option<&str>,
    aliases: &[String],
    forced_language: Option<&str>,
) -> Option<String> {
    match raw.map(str::trim).filter(|value| !value.is_empty()) {
        None => Some(build_prompt(aliases, forced_language)),
        Some(value) if value.eq_ignore_ascii_case("off") => None,
        Some(value) => Some(value.to_string()),
    }
}

/// The languages a detection may keep without a retry (F3).
///
/// `POLARIS_STT_ALLOWED_LANGS` is a comma-separated list of ISO-639-1 codes;
/// unset/blank defaults to Turkish and English, the two languages commands are
/// spoken in. The first entry is also the forced-retry language.
pub fn parse_allowed_languages(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return vec!["tr".to_string(), "en".to_string()];
    };
    raw.split(',')
        .map(|entry| entry.trim().to_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

/// What to do with the first response's detected language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LanguageDecision {
    /// Trust the result as returned.
    Accept,
    /// Re-run the same audio once with this forced language.
    Retry(String),
}

/// Applies the language policy to a first detection (F3).
///
/// A forced `POLARIS_STT_LANGUAGE` is already in force, so its result is
/// accepted unchanged. Otherwise a detection whose base
/// tag is in `allowed` is accepted; anything else — including an unknown
/// detection, which is exactly what a hallucinated short clip produces — is
/// retried once in the first allowed language. An empty allowed list has nothing
/// to retry into, so it accepts.
pub fn decide_language(
    forced: Option<&str>,
    detected: Option<&str>,
    allowed: &[String],
) -> LanguageDecision {
    if forced.is_some() {
        return LanguageDecision::Accept;
    }
    let Some(retry_language) = allowed.first() else {
        return LanguageDecision::Accept;
    };
    let allowed_detection = detected.is_some_and(|tag| {
        let base = tag.split('-').next().unwrap_or(tag);
        allowed.iter().any(|language| language == base)
    });
    if allowed_detection {
        LanguageDecision::Accept
    } else {
        LanguageDecision::Retry(retry_language.clone())
    }
}

/// Short clips are where Whisper's decoder invents text. Both the known-phrase
/// and the prompt-echo filters only distrust transcripts below this length.
pub const SHORT_CLIP_MS: u64 = 3_000;

/// Phrases Whisper emits from noise rather than speech, matched after trimming,
/// lowercasing and stripping surrounding punctuation.
const HALLUCINATION_PHRASES: &[&str] = &[
    "you",
    "thank you",
    "thanks",
    "thanks for watching",
    "please subscribe",
    "bye",
    "okay",
    "ok",
    "hmm",
    "uh",
    "um",
    "yeah",
];

/// Whether `text` is junk that must not become a command (F3).
///
/// Blank text is always junk. A known hallucination phrase only counts for a
/// short clip, where there is too little signal to trust the decoder; the same
/// words in a longer utterance are a real (if useless) sentence.
pub fn is_hallucination(text: &str, duration_ms: u64) -> bool {
    let normalized = text
        .trim()
        .trim_matches(|character: char| character.is_ascii_punctuation() || character == '…')
        .to_lowercase();
    if normalized.is_empty() {
        return true;
    }
    duration_ms < SHORT_CLIP_MS && HALLUCINATION_PHRASES.contains(&normalized.as_str())
}

/// Lowercase alphanumeric words, so punctuation and spacing never defeat a
/// comparison between a transcript and the prompt.
fn words(text: &str) -> Vec<String> {
    text.split(|character: char| !character.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(|word| word.to_lowercase())
        .collect()
}

/// The shortest literal run of the prompt that counts as an echo.
const MIN_ECHO_RUN: usize = 12;

/// Whether the transcript contains a literal run of at least [`MIN_ECHO_RUN`]
/// characters from the prompt, ignoring punctuation and spacing.
fn contains_prompt_run(text: &str, prompt: &str) -> bool {
    let transcript = words(text).join(" ");
    let prompt = words(prompt).join(" ");
    if transcript.len() < MIN_ECHO_RUN || prompt.len() < MIN_ECHO_RUN {
        return false;
    }
    (0..=prompt.len() - MIN_ECHO_RUN).any(|start| {
        let end = start + MIN_ECHO_RUN;
        // Multi-byte windows are skipped; the prompt is Latin/ASCII in practice.
        prompt.is_char_boundary(start)
            && prompt.is_char_boundary(end)
            && transcript.contains(&prompt[start..end])
    })
}

/// Whether `text` is the vocabulary prompt echoed back rather than speech
/// (F3-fix).
///
/// On a short clip Whisper sometimes decodes the `prompt` itself, which the
/// owner saw as `Recipients, cüzdan, hizmet, bakiye.` for an English clip. The
/// tells are that most of the transcript's words come from the prompt, or the
/// transcript contains a long literal run of it. A transcript that states an
/// amount is a real command and is never filtered this way — the prompt is an
/// example command, so it shares its opening words with genuine ones. An amount
/// is a word that starts with a digit (`10`, `10xlm`), not an alias like `acc1`.
pub fn is_prompt_echo(text: &str, prompt: Option<&str>, duration_ms: u64) -> bool {
    let Some(prompt) = prompt else {
        return false;
    };
    if duration_ms >= SHORT_CLIP_MS {
        return false;
    }
    let transcript = words(text);
    if transcript.is_empty() {
        return false;
    }
    if transcript
        .iter()
        .any(|word| word.chars().next().is_some_and(|character| character.is_ascii_digit()))
    {
        return false;
    }
    if contains_prompt_run(text, prompt) {
        return true;
    }
    let prompt_words = words(prompt);
    if prompt_words.is_empty() {
        return false;
    }
    let echoed = transcript
        .iter()
        .filter(|word| prompt_words.contains(word))
        .count();
    // 60% in integer arithmetic: echoed / total >= 3 / 5.
    echoed * 5 >= transcript.len() * 3
}

/// Whether a transcript the provider labelled in one language contradicts a
/// forced language (F3-fix).
///
/// Only meaningful when a language is forced and the provider reported one: an
/// unknown detection cannot prove a mismatch, so it is not rejected here. This
/// is what catches the owner's Turkish vocabulary on an English-forced clip.
pub fn language_mismatch(forced: Option<&str>, detected: Option<&str>) -> bool {
    let Some(forced) = forced.map(str::trim).filter(|value| !value.is_empty()) else {
        return false;
    };
    let Some(detected) = detected else {
        return false;
    };
    let base = |tag: &str| tag.split('-').next().unwrap_or(tag).to_lowercase();
    base(forced) != base(detected)
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
    /// A very short clip produced a known hallucination phrase (F3). Junk must
    /// become a short overlay label, never an agent turn.
    Hallucination { text: String },
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
            Self::Silent | Self::Hallucination { .. } => "No speech",
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
            Self::Hallucination { text } => format!(
                "the clip is too short to contain speech, but the provider returned {text:?}; \
                 treated as a hallucination and not forwarded"
            ),
            Self::Network(message) => format!("could not reach the transcription service: {message}"),
            Self::Http { status, detail } => {
                format!("the transcription service returned HTTP {status}: {detail}")
            }
            Self::Malformed(message) => format!("could not read the transcription response: {message}"),
            Self::PermissionDenied => "Speech Recognition permission was not granted. Answer the \
                 macOS prompt, or enable Autonomy under System Settings › Privacy & Security › \
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

    /// The vocabulary prompt sent to the provider, if any (F3-fix). The
    /// prompt-echo filter compares the transcript against exactly this text;
    /// a backend without a prompt (on-device) is never filtered this way.
    fn prompt(&self) -> Option<&str> {
        None
    }

    /// The language forced for this backend, if any (F3-fix). A transcript the
    /// provider labelled in another language is rejected. `None` means
    /// auto-detect, where no such check is possible.
    fn forced_language(&self) -> Option<&str> {
        None
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

    fn prompt(&self) -> Option<&str> {
        if self.used_fallback.load(std::sync::atomic::Ordering::Relaxed) {
            self.fallback.as_ref().and_then(|backend| backend.prompt())
        } else {
            self.primary.prompt()
        }
    }

    fn forced_language(&self) -> Option<&str> {
        if self.used_fallback.load(std::sync::atomic::Ordering::Relaxed) {
            self.fallback
                .as_ref()
                .and_then(|backend| backend.forced_language())
        } else {
            self.primary.forced_language()
        }
    }
}

/// Which backend the environment asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Backend {
    /// Groq's OpenAI-compatible cloud API. The **default** since step A12:
    /// multilingual and self-detecting, but the audio leaves the machine.
    Groq,
    /// Apple's on-device `SFSpeechRecognizer`. Explicit opt-in; audio stays
    /// local but the recognizer is single-locale, so it cannot detect language.
    OnDevice,
}

/// `POLARIS_STT_BACKEND` — the only knob that selects a backend.
pub const BACKEND_ENV: &str = "POLARIS_STT_BACKEND";

/// `POLARIS_STT_LOCALE` — overrides the on-device recognizer locale.
pub const LOCALE_ENV: &str = "POLARIS_STT_LOCALE";

/// Parses `POLARIS_STT_BACKEND`.
///
/// Returns the backend and whether the value was recognized, so the caller can
/// warn about a typo *without* the parse silently flipping the default. Missing
/// or blank means Groq; an unknown value also means Groq, with
/// `recognized = false`.
pub fn parse_backend(value: Option<&str>) -> (Backend, bool) {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => (Backend::Groq, true),
        Some(value) if value.eq_ignore_ascii_case("groq") => (Backend::Groq, true),
        Some(value) if value.eq_ignore_ascii_case("ondevice") => (Backend::OnDevice, true),
        Some(_) => (Backend::Groq, false),
    }
}

/// Chooses and constructs the STT backend from the environment.
///
/// The default is Groq (multilingual, self-detecting) because it is the backend
/// that makes the demo correct for both languages; the audio leaves the machine
/// and the startup line says so. `POLARIS_STT_BACKEND=ondevice` opts into the
/// private, single-locale on-device recognizer; when it is requested, Groq is
/// attached as a fallback **only** if `GROQ_API_KEY` is configured, and the
/// audio then leaves the machine only if the recognizer turns out to be
/// unavailable, which is logged.
pub fn build_backend() -> Arc<dyn Transcriber> {
    let (requested, recognized) = parse_backend(env::var(BACKEND_ENV).as_deref());
    if !recognized {
        eprintln!(
            "polaris: unknown {BACKEND_ENV} value — using the Groq default \
             (accepted values are `groq` and `ondevice`)"
        );
    }
    match requested {
        Backend::Groq => {
            let groq = groq::GroqTranscriber::from_env();
            if groq.has_key() {
                println!(
                    "polaris: STT backend Groq {} (cloud, multilingual, self-detecting); \
                     audio leaves this Mac for transcription — set {BACKEND_ENV}=ondevice to keep \
                     it local",
                    groq.model()
                );
            } else {
                println!(
                    "polaris: STT backend Groq (cloud) but GROQ_API_KEY is not set — the overlay \
                     will show \"No STT key\" while capture keeps working"
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
            println!(
                "polaris: STT backend on-device ({locale}, single-locale); audio never leaves \
                 this Mac — set {BACKEND_ENV}=groq for multilingual auto-detection"
            );
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
    let info = wav::validate(wav)?;
    let transcription = backend.transcribe(wav)?;
    // F3-fix: a short clip whose "transcript" is a decoder hallucination or the
    // vocabulary prompt echoed back is silence in disguise, not a command; and a
    // transcript the provider labelled in another language contradicts a forced
    // language. Reject all of them after the backend (which is where the text
    // first exists) but before the agent ever sees it.
    if is_hallucination(&transcription.text, info.duration_ms)
        || is_prompt_echo(&transcription.text, backend.prompt(), info.duration_ms)
        || language_mismatch(backend.forced_language(), transcription.language.as_deref())
    {
        return Err(SttError::Hallucination {
            text: transcription.text,
        });
    }
    Ok(transcription)
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
            // M3: a take superseded by a newer push-to-talk session must not
            // emit its transcript — that would spawn an agent turn for stale
            // audio. The supersede can happen while this worker is blocked on
            // the backend, so re-check now, after transcription.
            if capture.is_current(&recording) {
                // A14: `[lang …]` is the recogniser's audio-level GUESS and is
                // only a hint — short, code-switched English is often tagged
                // `tr`. The model's judgement of the text decides the reply
                // language; the agent logs when the two disagree.
                println!(
                    "polaris: transcript in {elapsed_ms} ms (audio {} ms) via {} [stt-lang hint {}]: {}",
                    recording.duration_ms,
                    backend.name(),
                    transcription.language.as_deref().unwrap_or("-"),
                    transcription.text
                );
                capture.mark_transcribed(app);
                // Step A11: the transcript is the third measured phase; it is
                // marked just before the event so the mark and the event are the
                // same instant the agent will act on.
                timing::mark("transcript");
                events::emit(
                    app,
                    PolarisEvent::Transcript {
                        text: transcription.text,
                        r#final: true,
                        language: transcription.language,
                    },
                );
            } else {
                println!(
                    "polaris: discarding the transcript for superseded recording {}",
                    recording.path
                );
            }
            // The audio served its purpose either way: it was transcribed, it is
            // just no longer the current take. A superseded WAV must not linger.
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
        prompt: Option<String>,
        forced_language: Option<String>,
    }

    impl FakeTranscriber {
        fn returning(result: Result<Transcription, SttError>) -> Self {
            Self {
                result: Mutex::new(Some(result)),
                calls: Mutex::new(0),
                name: "stt",
                prompt: None,
                forced_language: None,
            }
        }

        fn named(mut self, name: &'static str) -> Self {
            self.name = name;
            self
        }

        fn with_prompt(mut self, prompt: &str) -> Self {
            self.prompt = Some(prompt.to_string());
            self
        }

        fn with_forced_language(mut self, language: &str) -> Self {
            self.forced_language = Some(language.to_string());
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

        fn prompt(&self) -> Option<&str> {
            self.prompt.as_deref()
        }

        fn forced_language(&self) -> Option<&str> {
            self.forced_language.as_deref()
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
            language: None,
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

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "hi".into(),
            language: None,
        }));
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
            language: Some("en".into()),
        }));
        let result = transcribe_verified(&backend, &wav).unwrap();
        assert_eq!(result.text, "send 10 usdc to ada");
        assert_eq!(result.language.as_deref(), Some("en"));
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
            SttError::Hallucination {
                text: "Thank you".into(),
            },
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
    fn detected_languages_are_normalized_from_names_and_locales() {
        // Groq's Whisper answers with a name; Apple is pinned to a locale.
        assert_eq!(normalize_detected_language("Turkish"), Some("tr".to_string()));
        assert_eq!(normalize_detected_language(" English "), Some("en".to_string()));
        assert_eq!(normalize_detected_language("tr-TR"), Some("tr-tr".to_string()));
        assert_eq!(normalize_detected_language("EN_us"), Some("en-us".to_string()));
        assert_eq!(normalize_detected_language("tr"), Some("tr".to_string()));
        // A language with no mapping is unknown, never a guess.
        assert_eq!(normalize_detected_language("klingon"), None);
        assert_eq!(normalize_detected_language("   "), None);
    }

    #[test]
    fn the_prompt_language_follows_the_forced_language() {
        // Auto/unset keeps the short bilingual hint.
        assert_eq!(build_prompt(&[], None), DEFAULT_PROMPT);
        assert_eq!(build_prompt(&[], Some("")), DEFAULT_PROMPT);
        // A forced language gets ONLY its own words: the leak that echoed
        // Turkish into an English clip must be impossible.
        assert_eq!(build_prompt(&[], Some("en")), DEFAULT_PROMPT_EN);
        assert_eq!(build_prompt(&[], Some("en-US")), DEFAULT_PROMPT_EN);
        assert_eq!(build_prompt(&[], Some("tr")), DEFAULT_PROMPT_TR);
        assert!(!DEFAULT_PROMPT_EN.contains("cüzdan"));
        assert!(!DEFAULT_PROMPT_EN.contains("gönder"));
        assert!(!DEFAULT_PROMPT_TR.contains("Send"));
        // An unknown forced language falls back to the bilingual hint.
        assert_eq!(build_prompt(&[], Some("de")), DEFAULT_PROMPT);
    }

    #[test]
    fn the_prompt_names_the_recipients_in_a_sentence() {
        let aliases = vec!["acc1".to_string(), "acc2".to_string()];
        let english = build_prompt(&aliases, Some("en"));
        assert_eq!(english, "Send 10 XLM from acc1 to acc2. Recipients are acc1 and acc2.");
        let turkish = build_prompt(&aliases, Some("tr"));
        assert!(turkish.contains("Alıcılar acc1 ve acc2."), "{turkish}");
        let bilingual = build_prompt(&aliases, None);
        assert!(bilingual.contains("Recipients are acc1 and acc2."), "{bilingual}");
        // A single name is not joined with a conjunction.
        assert!(build_prompt(&["acc1".to_string()], Some("en")).ends_with("Recipients are acc1."));
    }

    #[test]
    fn alias_names_reads_only_the_left_hand_side() {
        let aliases = alias_names(Some("acc1=GAAA, acc2=GBBB,broken, =GCCC,acc1=GDDD"));
        assert_eq!(aliases, vec!["acc1".to_string(), "acc2".to_string()]);
        assert!(alias_names(None).is_empty());
    }

    #[test]
    fn the_prompt_can_be_overridden_or_disabled() {
        let aliases = vec!["acc1".to_string()];
        // Unset: the language-appropriate built-in hint plus the aliases.
        assert_eq!(
            resolve_prompt(None, &aliases, Some("en")),
            Some(build_prompt(&aliases, Some("en")))
        );
        // `off` disables the hint entirely (case-insensitive, trimmed).
        assert_eq!(resolve_prompt(Some(" off "), &aliases, None), None);
        // Any other value is used verbatim.
        assert_eq!(
            resolve_prompt(Some("only xlm"), &aliases, Some("en")),
            Some("only xlm".to_string())
        );
    }

    #[test]
    fn allowed_languages_default_to_turkish_then_english() {
        assert_eq!(parse_allowed_languages(None), vec!["tr", "en"]);
        assert_eq!(parse_allowed_languages(Some("  ")), vec!["tr", "en"]);
        assert_eq!(
            parse_allowed_languages(Some(" TR , en-US ,")),
            vec!["tr", "en-us"]
        );
        // A list of separators only has nothing to retry into.
        assert!(parse_allowed_languages(Some(",,")).is_empty());
    }

    #[test]
    fn a_disallowed_detection_retries_once_in_the_first_allowed_language() {
        let allowed = parse_allowed_languages(None);
        // Russian is exactly the false detection from the owner's log.
        assert_eq!(
            decide_language(None, Some("ru"), &allowed),
            LanguageDecision::Retry("tr".to_string())
        );
        // English (including a locale tag) is allowed as-is.
        assert_eq!(decide_language(None, Some("en"), &allowed), LanguageDecision::Accept);
        assert_eq!(
            decide_language(None, Some("en-us"), &allowed),
            LanguageDecision::Accept
        );
        // An unknown detection is the hallmark of a hallucinated short clip.
        assert_eq!(
            decide_language(None, None, &allowed),
            LanguageDecision::Retry("tr".to_string())
        );
        // A forced language is already in force: never retried.
        assert_eq!(
            decide_language(Some("de"), Some("ru"), &allowed),
            LanguageDecision::Accept
        );
        // Nothing to retry into: accept.
        assert_eq!(decide_language(None, Some("ru"), &[]), LanguageDecision::Accept);
    }

    #[test]
    fn a_short_clip_that_decoded_to_a_hallucination_is_not_a_command() {
        // Known noise phrases on a short clip.
        assert!(is_hallucination("Thank you.", 400));
        assert!(is_hallucination("  YOU  ", 200));
        assert!(is_hallucination("Thank you", 1_500));
        // Blank text is junk at any length.
        assert!(is_hallucination("", 5_000));
        // A real command is never filtered by the phrase list.
        assert!(!is_hallucination("iptal et", 2_500));
    }

    #[test]
    fn the_vocabulary_prompt_echoed_back_is_rejected() {
        let prompt = "Send 10 XLM from acc1 to acc2. Recipients are acc1 and acc2.";
        // The shape the owner saw: a bare word list with no amount. The same
        // mechanism catches it whatever the exact prompt text is.
        assert!(is_prompt_echo(
            "Recipients, cüzdan, hizmet, bakiye.",
            Some("Recipients cüzdan hizmet bakiye"),
            1_280
        ));
        // Most words drawn from the bilingual hint, and no amount.
        assert!(is_prompt_echo("acc1'den acc2'ye XLM gönder", Some(DEFAULT_PROMPT), 1_000));
        assert!(is_prompt_echo("Recipients are acc1 and acc2.", Some(prompt), 1_000));
        // A long literal run of the prompt is enough on its own.
        assert!(is_prompt_echo("acc1 to acc2 something", Some(prompt), 1_000));
        // A real command with an amount is never an echo, however many prompt
        // words it shares (the prompt is itself an example command).
        assert!(!is_prompt_echo("send 10 XLM to acc2", Some(prompt), 1_000));
        // A short real command without an amount but no prompt words is kept.
        assert!(!is_prompt_echo("iptal et", Some(DEFAULT_PROMPT), 1_000));
        // Longer clips are trusted: the filter only distrusts short ones.
        assert!(!is_prompt_echo("Recipients are acc1 and acc2.", Some(prompt), 4_000));
        // No prompt means nothing to echo.
        assert!(!is_prompt_echo("Recipients are acc1 and acc2.", None, 1_000));
    }

    #[test]
    fn a_transcript_in_another_language_than_forced_is_rejected() {
        // The owner's English-forced clip came back labelled Turkish.
        assert!(language_mismatch(Some("en"), Some("tr")));
        assert!(language_mismatch(Some("en-US"), Some("tr")));
        assert!(!language_mismatch(Some("en"), Some("en")));
        assert!(!language_mismatch(Some("tr"), Some("tr-TR")));
        // Auto-detect has no forced language to contradict.
        assert!(!language_mismatch(None, Some("tr")));
        // An unknown detection cannot prove a mismatch.
        assert!(!language_mismatch(Some("en"), None));
    }

    #[test]
    fn a_hallucination_is_rejected_before_the_transcript_reaches_the_agent() {
        let dir = scratch("stt-hallucination");
        let wav = dir.join("short.wav");
        // 800 ms: past the pre-flight minimum, short enough to distrust.
        write_wav(&wav, 8_000, 12_800, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "Thank you.".into(),
            language: None,
        }));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::Hallucination {
                text: "Thank you.".into()
            })
        );
        assert_eq!(*backend.calls.lock().unwrap(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_prompt_echo_or_forced_language_mismatch_never_reaches_the_agent() {
        let dir = scratch("stt-echo");
        let wav = dir.join("clip.wav");
        write_wav(&wav, 8_000, 16_000, 16_000); // 1 s
        let prompt = build_prompt(&["acc1".to_string(), "acc2".to_string()], Some("en"));

        // The prompt echoed back on an English-forced clip (digit-free, so the
        // amount exemption does not apply).
        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "Recipients are acc1 and acc2.".into(),
            language: Some("en".into()),
        }))
        .with_prompt(&prompt)
        .with_forced_language("en");
        assert!(matches!(
            transcribe_verified(&backend, &wav),
            Err(SttError::Hallucination { .. })
        ));

        // A correct English transcript but a Turkish label.
        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "send 10 XLM to acc2".into(),
            language: Some("tr".into()),
        }))
        .with_prompt(&prompt)
        .with_forced_language("en");
        assert!(matches!(
            transcribe_verified(&backend, &wav),
            Err(SttError::Hallucination { .. })
        ));

        // The same words with the right label and no echo pass.
        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "send 10 XLM to acc2".into(),
            language: Some("en".into()),
        }))
        .with_prompt(&prompt)
        .with_forced_language("en");
        assert_eq!(
            transcribe_verified(&backend, &wav).unwrap().text,
            "send 10 XLM to acc2"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn backend_selection_defaults_to_groq_and_never_hides_a_typo() {
        // Missing or blank: the self-detecting cloud default, no warning.
        assert_eq!(parse_backend(None), (Backend::Groq, true));
        assert_eq!(parse_backend(Some("")), (Backend::Groq, true));
        assert_eq!(parse_backend(Some("   ")), (Backend::Groq, true));
        // Explicit values are case-insensitive.
        assert_eq!(parse_backend(Some("groq")), (Backend::Groq, true));
        assert_eq!(parse_backend(Some("GROQ")), (Backend::Groq, true));
        assert_eq!(parse_backend(Some(" ondevice ")), (Backend::OnDevice, true));
        // A typo must fall back to the default *and* be reported as unrecognized,
        // so the caller warns instead of silently changing where audio goes.
        assert_eq!(parse_backend(Some("cloud")), (Backend::Groq, false));
        assert_eq!(parse_backend(Some("local")), (Backend::Groq, false));
    }

    #[test]
    fn the_fallback_fires_only_for_an_unavailable_ondevice_backend() {
        let primary = Arc::new(FakeTranscriber::returning(Err(SttError::Unavailable {
            locale: "tr-TR".into(),
        })));
        let fallback = Arc::new(FakeTranscriber::returning(Ok(Transcription {
            text: "from groq".into(),
            language: Some("tr".into()),
        })));
        let backend = FallbackTranscriber::new(primary, Some(fallback));

        let transcription = backend.transcribe(Path::new("x.wav")).unwrap();
        assert_eq!(transcription.text, "from groq");
        // The detected language must survive the primary→fallback handoff.
        assert_eq!(transcription.language.as_deref(), Some("tr"));
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
                language: None,
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
                language: None,
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

    /// Live first half of the A12 end-to-end check: the REAL Groq backend over a
    /// real WAV, printing one machine-readable line the Node driver parses, so
    /// the audio → transcript → detected-language path is exercised without a
    /// microphone. Run it with:
    ///
    /// ```text
    /// POLARIS_E2E_WAV=/path/clip.wav caffeinate -i cargo test \
    ///   manual_live_groq_transcribes_a_wav -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "calls the live Groq API; needs GROQ_API_KEY and POLARIS_E2E_WAV"]
    fn manual_live_groq_transcribes_a_wav() {
        crate::env::load();
        let Some(path) = crate::env::var("POLARIS_E2E_WAV") else {
            eprintln!("polaris: set POLARIS_E2E_WAV to a 16-bit PCM WAV to run the live STT check");
            return;
        };
        let backend = groq::GroqTranscriber::from_env();
        assert!(backend.has_key(), "the live test needs GROQ_API_KEY");

        let started = std::time::Instant::now();
        let transcription = transcribe_verified(&backend, Path::new(&path))
            .expect("live Groq transcription must succeed");
        let elapsed_ms = started.elapsed().as_millis();
        let language = transcription
            .language
            .as_deref()
            .map(|value| serde_json::to_string(value).expect("a language string serialises"))
            .unwrap_or_else(|| "null".to_string());
        // One JSON line so the Node driver can parse it; everything else on
        // stdout is for a human.
        println!(
            "polaris: e2e-stt {{\"text\":{},\"language\":{language},\"ms\":{elapsed_ms}}}",
            serde_json::to_string(&transcription.text).expect("a transcript string serialises")
        );
    }
}
