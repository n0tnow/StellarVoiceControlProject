//! Fish Audio text-to-speech (step A3, provider chosen by the owner).
//!
//! The exact request shape implemented here was re-read from
//! <https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech>
//! while writing this module:
//!
//! * `POST https://api.fish.audio/v1/tts`
//! * `Authorization: Bearer <key>`
//! * `model: s2.1-pro-free` — selects the **engine**, not the voice.
//! * JSON body `{ "text", "reference_id", "format": "mp3", "latency": "normal" }`
//!   — `reference_id` selects the **voice**; omitting it makes the voice drift.
//! * On success the response body is the raw audio bytes with
//!   `Content-Type: audio/mpeg` (for `format: mp3`).
//!
//! The JSON body is built by serde from a small struct with a pure
//! [`request_body`] helper rather than assembled by hand, so the exact wire shape
//! — in particular the required `reference_id` — is pinned by a unit test. The
//! API key is only ever placed in the `Authorization` header; it is never logged,
//! never written to disk, and never included in an error.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;

use crate::env;
use crate::tts::{player, PlaybackStart, Speaker, TtsError};

/// Default model; override with `POLARIS_TTS_MODEL`.
pub const DEFAULT_MODEL: &str = "s2.1-pro-free";

/// The pinned voice every utterance falls back to.
pub const REFERENCE_ID_ENV: &str = "POLARIS_TTS_REFERENCE_ID";

/// Optional per-language voice override, e.g. `POLARIS_TTS_REFERENCE_ID_TR`.
/// The suffix is a BCP-47 language base; the value is a Fish `reference_id`.
pub const REFERENCE_ID_OVERRIDE_PREFIX: &str = "POLARIS_TTS_REFERENCE_ID_";

/// Collects `POLARIS_TTS_REFERENCE_ID_<LANG>` entries into a language -> voice
/// map. Thin wrapper over the shared parser in `tts`.
pub fn voice_overrides_from<I>(pairs: I) -> HashMap<String, String>
where
    I: IntoIterator<Item = (String, String)>,
{
    crate::tts::language_overrides_from(pairs, REFERENCE_ID_OVERRIDE_PREFIX)
}

/// Default audio container; override with `POLARIS_TTS_FORMAT`.
pub const DEFAULT_FORMAT: &str = "mp3";

/// Default latency/quality trade-off; override with `POLARIS_TTS_LATENCY`.
pub const DEFAULT_LATENCY: &str = "normal";

/// The TTS endpoint.
pub const ENDPOINT: &str = "https://api.fish.audio/v1/tts";

/// Whole-request budget. Synthesis of a short confirmation is well under this;
/// the timeout only stops a stalled connection from pinning the caller forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// How long to wait for the TCP/TLS handshake before giving up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Cap on how much of a provider error body reaches the terminal.
const MAX_ERROR_BODY: usize = 400;

/// The exact JSON request body Fish Audio documents.
///
/// Split out and pure so the wire shape — above all that `reference_id` is
/// present — is pinned by a test instead of trusted to a call site.
pub fn request_body(text: &str, reference_id: &str, format: &str, latency: &str) -> String {
    #[derive(Serialize)]
    struct TtsRequest<'a> {
        text: &'a str,
        reference_id: &'a str,
        format: &'a str,
        latency: &'a str,
    }
    serde_json::to_string(&TtsRequest {
        text,
        reference_id,
        format,
        latency,
    })
    .expect("a TtsRequest of plain string slices always serialises")
}

/// The Fish backend. Construction never fails: missing config is a runtime
/// state, reported by [`Self::missing_config`], not a startup error.
pub struct FishSpeaker {
    api_key: Option<String>,
    model: String,
    /// The pinned voice: the fallback for every language without an override.
    reference_id: Option<String>,
    /// Optional `POLARIS_TTS_REFERENCE_ID_<LANG>` overrides, keyed by language base.
    voices: HashMap<String, String>,
    format: String,
    latency: String,
    client: reqwest::blocking::Client,
}

impl FishSpeaker {
    /// Reads the key, model, voice id, per-language overrides and output knobs
    /// from the environment.
    pub fn from_env() -> Self {
        Self::new(
            env::var("FISH_AUDIO_API_KEY"),
            env::var("POLARIS_TTS_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            env::var(REFERENCE_ID_ENV),
            env::var("POLARIS_TTS_FORMAT").unwrap_or_else(|| DEFAULT_FORMAT.to_string()),
            env::var("POLARIS_TTS_LATENCY").unwrap_or_else(|| DEFAULT_LATENCY.to_string()),
        )
        .with_voice_overrides(voice_overrides_from(std::env::vars()))
    }

    pub fn new(
        api_key: Option<String>,
        model: String,
        reference_id: Option<String>,
        format: String,
        latency: String,
    ) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            api_key,
            model,
            reference_id,
            voices: HashMap::new(),
            format,
            latency,
            client,
        }
    }

    /// Attaches the per-language voice overrides read from the environment.
    pub fn with_voice_overrides(mut self, voices: HashMap<String, String>) -> Self {
        self.voices = voices;
        self
    }

    /// The engine id sent in the `model` header.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The pinned voice id, if configured. Not secret; useful in the startup
    /// line so the fixed default voice can be verified. This is the **fallback**
    /// voice, never changed silently by a language override.
    pub fn voice_id(&self) -> Option<&str> {
        self.reference_id.as_deref()
    }

    /// The per-language overrides in effect (language base -> voice id).
    pub fn voice_overrides(&self) -> &HashMap<String, String> {
        &self.voices
    }

    /// The voice for one utterance: the language override when one is
    /// configured, otherwise the pinned voice.
    ///
    /// This is the whole of the A11 "per-language voice" mechanism. The owner
    /// owns the values (`POLARIS_TTS_REFERENCE_ID_<LANG>`); code only decides the
    /// precedence, so an unset or unknown language can never silently change the
    /// pinned voice.
    pub fn reference_for(&self, language: Option<&str>) -> Option<&str> {
        if let Some(base) = language.and_then(crate::tts::normalize_language_base) {
            if let Some(voice) = self.voices.get(&base) {
                if !voice.trim().is_empty() {
                    return Some(voice);
                }
            }
        }
        self.reference_id.as_deref()
    }

    /// Whether a key was supplied. Used only for the startup hint; it never
    /// exposes the value.
    pub fn has_key(&self) -> bool {
        self.api_key.is_some()
    }

    /// Why the Fish backend must not be called, if anything is missing.
    ///
    /// The voice id is checked **first**: sending a request without it would
    /// silently drift the voice, which the owner forbids, regardless of whether a
    /// key is present.
    pub fn missing_config(&self) -> Option<&'static str> {
        if self
            .reference_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_none()
        {
            return Some(
                "POLARIS_TTS_REFERENCE_ID is not set (the Fish voice would drift between requests)",
            );
        }
        if !self.has_key() {
            return Some("FISH_AUDIO_API_KEY is not set");
        }
        None
    }

    /// Performs the live request and returns the provider's raw audio bytes.
    ///
    /// Buffers the whole body, so it is **not** the production playback path
    /// (that is [`Speaker::speak`], which streams). It exists so the `#[ignore]`d
    /// live test in `tts::tests` can assert on the payload (non-empty MPEG)
    /// independently of playback; `#[cfg(test)]` keeps it out of the shipping
    /// binary.
    #[cfg(test)]
    pub fn synthesize(&self, text: &str) -> Result<Vec<u8>, TtsError> {
        let key = self.api_key.as_deref().ok_or(TtsError::MissingKey)?;
        self.synthesize_with_key(text, key)
    }

    #[cfg(test)]
    fn synthesize_with_key(&self, text: &str, key: &str) -> Result<Vec<u8>, TtsError> {
        // The live payload test always uses the pinned voice (`None`).
        let response = self.request_with_key(text, key, None)?;
        let bytes = response
            .bytes()
            .map_err(|error| TtsError::Network(error.to_string()))?;
        if bytes.is_empty() {
            return Err(TtsError::Malformed(
                "the service returned a 2xx with no audio".to_string(),
            ));
        }

        Ok(bytes.to_vec())
    }

    /// Performs the live request and returns the still-streaming response.
    ///
    /// Shared by [`Self::synthesize`] (buffers for inspection/tests) and
    /// [`Speaker::speak`] (pipes the body straight into the player), so the wire
    /// shape and the status handling exist exactly once. The body is only read by
    /// the caller.
    fn request_with_key(
        &self,
        text: &str,
        key: &str,
        language: Option<&str>,
    ) -> Result<reqwest::blocking::Response, TtsError> {
        // The language picks a voice override when one is configured, and the
        // pinned voice otherwise. Requesting with no voice at all would drift the
        // voice, so a missing reference is still an error.
        let reference_id = self.reference_for(language).ok_or(TtsError::MissingReferenceId)?;
        let body = request_body(text, reference_id, &self.format, &self.latency);

        let response = self
            .client
            .post(ENDPOINT)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
            .header("model", self.model.as_str())
            .body(body)
            .send()
            .map_err(|error| TtsError::Network(error.to_string()))?;

        let status = response.status();
        if !status.is_success() {
            let detail = response.text().unwrap_or_default();
            return Err(TtsError::Http {
                status: status.as_u16(),
                detail: truncate(&detail, MAX_ERROR_BODY),
            });
        }

        Ok(response)
    }
}

impl Speaker for FishSpeaker {
    /// Streams Fish's audio body straight into the player (step A5).
    ///
    /// The previous buffered path (`synthesize` into a temp file, then `afplay`)
    /// meant a ~2.7 s synthesis cost 3–6 s before anything was heard. Piping the
    /// live response through lets playback begin at roughly the provider's
    /// time-to-first-byte. `synthesize` is retained for the live test's payload
    /// assertion; the app always streams.
    fn speak(
        &self,
        text: &str,
        language: Option<&str>,
        on_playback_start: &PlaybackStart<'_>,
    ) -> Result<(), TtsError> {
        let key = self.api_key.as_deref().ok_or(TtsError::MissingKey)?;
        let response = self.request_with_key(text, key, language)?;
        player::play_stream(response, &self.format, on_playback_start)
    }

    fn name(&self) -> &'static str {
        "fish"
    }
}

/// Truncates a string to at most `max` characters, appending an ellipsis marker.
fn truncate(value: &str, max: usize) -> String {
    let trimmed = value.trim();
    if trimmed.chars().count() <= max {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(max).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const VOICE: &str = "63d02a65c5324343ad082bbae8ab0337";

    #[test]
    fn the_serialised_body_carries_the_reference_id() {
        let body = request_body("Sending 5 USDC to Ahmet — confirm?", VOICE, "mp3", "normal");
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["reference_id"], VOICE);
        assert_eq!(value["format"], "mp3");
        assert_eq!(value["latency"], "normal");
        assert_eq!(value["text"], "Sending 5 USDC to Ahmet — confirm?");
        // Pin the raw bytes too: a rename of the field would pass the lookup
        // above while breaking the provider contract.
        assert!(body.contains(&format!("\"reference_id\":\"{VOICE}\"")));
    }

    #[test]
    fn the_documented_request_shape_is_used() {
        let body = request_body("hello", VOICE, DEFAULT_FORMAT, DEFAULT_LATENCY);
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        // Exactly the four documented fields, no accidental additions.
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 4);
        for field in ["text", "reference_id", "format", "latency"] {
            assert!(object.contains_key(field), "missing {field}");
        }
    }

    #[test]
    fn turkish_text_survives_serialisation() {
        let body = request_body(
            "Gönderiyorum: 5 USDC, onaylıyor musun?",
            VOICE,
            "mp3",
            "normal",
        );
        let value: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(value["text"], "Gönderiyorum: 5 USDC, onaylıyor musun?");
    }

    #[test]
    fn a_missing_key_fails_before_any_io() {
        let speaker = FishSpeaker::new(
            None,
            DEFAULT_MODEL.to_string(),
            Some(VOICE.to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        assert!(!speaker.has_key());
        let noop = || {};
        assert_eq!(speaker.speak("hello", None, &noop), Err(TtsError::MissingKey));
    }

    #[test]
    fn a_missing_reference_id_fails_before_any_io_even_with_a_key() {
        let speaker = FishSpeaker::new(
            Some("sk-test".to_string()),
            DEFAULT_MODEL.to_string(),
            None,
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        // The key path would reach the network; the voice-id guard must fire
        // first because sending without it drifts the voice.
        let noop = || {};
        assert_eq!(
            speaker.speak("hello", None, &noop),
            Err(TtsError::MissingReferenceId)
        );
    }

    #[test]
    fn missing_config_reports_the_voice_id_before_the_key() {
        let speaker = FishSpeaker::new(
            None,
            DEFAULT_MODEL.to_string(),
            None,
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        let problem = speaker.missing_config().unwrap();
        assert!(problem.contains("POLARIS_TTS_REFERENCE_ID"));

        // With a voice id but no key, the key is reported.
        let speaker = FishSpeaker::new(
            None,
            DEFAULT_MODEL.to_string(),
            Some(VOICE.to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        assert!(speaker
            .missing_config()
            .unwrap()
            .contains("FISH_AUDIO_API_KEY"));
    }

    #[test]
    fn a_blank_reference_id_counts_as_missing() {
        let speaker = FishSpeaker::new(
            Some("sk-test".to_string()),
            DEFAULT_MODEL.to_string(),
            Some("   ".to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        assert!(speaker.missing_config().is_some());
    }

    #[test]
    fn a_fully_configured_speaker_has_no_config_problem() {
        let speaker = FishSpeaker::new(
            Some("sk-test".to_string()),
            DEFAULT_MODEL.to_string(),
            Some(VOICE.to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        );
        assert!(speaker.missing_config().is_none());
        assert_eq!(speaker.model(), "s2.1-pro-free");
        assert_eq!(speaker.voice_id(), Some(VOICE));
        assert_eq!(speaker.name(), "fish");
    }

    #[test]
    fn a_language_override_wins_and_unknown_languages_fall_back_to_the_pinned_voice() {
        let voices = voice_overrides_from([
            ("POLARIS_TTS_REFERENCE_ID_TR".to_string(), "tr-voice".to_string()),
            ("POLARIS_TTS_REFERENCE_ID_EN_US".to_string(), "en-voice".to_string()),
            // Not an override: the base var and a non-voice var are ignored.
            ("POLARIS_TTS_REFERENCE_ID".to_string(), "ignored".to_string()),
            ("POLARIS_TTS_MODEL".to_string(), "ignored".to_string()),
        ]);
        let speaker = FishSpeaker::new(
            Some("sk-test".to_string()),
            DEFAULT_MODEL.to_string(),
            Some(VOICE.to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        )
        .with_voice_overrides(voices);

        // The base (`en-US` -> `en`) is what keys the override.
        assert_eq!(speaker.reference_for(Some("tr")), Some("tr-voice"));
        assert_eq!(speaker.reference_for(Some("tr-TR")), Some("tr-voice"));
        assert_eq!(speaker.reference_for(Some("EN_us")), Some("en-voice"));
        // A language with no override, and no language at all, use the pinned voice.
        assert_eq!(speaker.reference_for(Some("de")), Some(VOICE));
        assert_eq!(speaker.reference_for(None), Some(VOICE));
        // The pinned voice is never silently changed.
        assert_eq!(speaker.voice_id(), Some(VOICE));
        assert_eq!(speaker.voice_overrides().len(), 2);
    }

    #[test]
    fn voice_override_parsing_ignores_blank_and_malformed_entries() {
        let voices = voice_overrides_from([
            // Blank value: nothing to switch to.
            ("POLARIS_TTS_REFERENCE_ID_TR".to_string(), "  ".to_string()),
            // A numeric "language" is not a language base.
            ("POLARIS_TTS_REFERENCE_ID_12".to_string(), "x".to_string()),
            // A trailing underscore means an empty suffix.
            ("POLARIS_TTS_REFERENCE_ID_".to_string(), "y".to_string()),
            ("POLARIS_TTS_REFERENCE_ID_XX".to_string(), "de-voice".to_string()),
        ]);
        assert_eq!(voices.len(), 1);
        assert_eq!(voices.get("xx").map(String::as_str), Some("de-voice"));

        // A blank override can never shadow the pinned voice at lookup time.
        let speaker = FishSpeaker::new(
            Some("sk-test".to_string()),
            DEFAULT_MODEL.to_string(),
            Some(VOICE.to_string()),
            DEFAULT_FORMAT.to_string(),
            DEFAULT_LATENCY.to_string(),
        )
        .with_voice_overrides(HashMap::from([("tr".to_string(), "   ".to_string())]));
        assert_eq!(speaker.reference_for(Some("tr")), Some(VOICE));
    }

    #[test]
    fn a_language_base_is_normalized_or_rejected() {
        assert_eq!(
            crate::tts::normalize_language_base("TR"),
            Some("tr".to_string())
        );
        assert_eq!(
            crate::tts::normalize_language_base(" en-US "),
            Some("en".to_string())
        );
        assert_eq!(
            crate::tts::normalize_language_base("zh_Hans"),
            Some("zh".to_string())
        );
        assert_eq!(crate::tts::normalize_language_base(""), None);
        assert_eq!(crate::tts::normalize_language_base("12"), None);
        assert_eq!(crate::tts::normalize_language_base("t"), None);
    }

    #[test]
    fn error_bodies_are_truncated() {
        let long = "x".repeat(MAX_ERROR_BODY + 50);
        let truncated = truncate(&long, MAX_ERROR_BODY);
        assert_eq!(truncated.chars().count(), MAX_ERROR_BODY + 1);
        assert!(truncated.ends_with('…'));
    }
}
