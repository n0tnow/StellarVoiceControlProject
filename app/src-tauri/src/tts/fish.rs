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

use std::time::Duration;

use serde::Serialize;

use crate::env;
use crate::tts::{player, Speaker, TtsError};

/// Default model; override with `POLARIS_TTS_MODEL`.
pub const DEFAULT_MODEL: &str = "s2.1-pro-free";

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
    reference_id: Option<String>,
    format: String,
    latency: String,
    client: reqwest::blocking::Client,
}

impl FishSpeaker {
    /// Reads the key, model, voice id and output knobs from the environment.
    pub fn from_env() -> Self {
        Self::new(
            env::var("FISH_AUDIO_API_KEY"),
            env::var("POLARIS_TTS_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_string()),
            env::var("POLARIS_TTS_REFERENCE_ID"),
            env::var("POLARIS_TTS_FORMAT").unwrap_or_else(|| DEFAULT_FORMAT.to_string()),
            env::var("POLARIS_TTS_LATENCY").unwrap_or_else(|| DEFAULT_LATENCY.to_string()),
        )
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
            format,
            latency,
            client,
        }
    }

    /// The engine id sent in the `model` header.
    pub fn model(&self) -> &str {
        &self.model
    }

    /// The voice id sent in the body, if configured. Not secret; useful in the
    /// startup line so the fixed voice can be verified.
    pub fn voice_id(&self) -> Option<&str> {
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
    /// Split out of [`Self::speak`] so the network step and the playback step can
    /// be exercised independently — in particular, the `#[ignore]`d live test in
    /// `tts::tests` asserts on the returned payload (non-empty MPEG) before any
    /// audio is played. Public only for that sibling test; the app always speaks
    /// through [`Speaker::speak`].
    pub fn synthesize(&self, text: &str) -> Result<Vec<u8>, TtsError> {
        let key = self.api_key.as_deref().ok_or(TtsError::MissingKey)?;
        self.synthesize_with_key(text, key)
    }

    fn synthesize_with_key(&self, text: &str, key: &str) -> Result<Vec<u8>, TtsError> {
        let reference_id = self
            .reference_id
            .as_deref()
            .ok_or(TtsError::MissingReferenceId)?;
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

    /// Writes `bytes` to a temp file, plays them with `afplay`, then removes the
    /// file. The bytes are an audio container macOS plays directly; `format` is
    /// the container the request asked for.
    fn play(&self, bytes: &[u8]) -> Result<(), TtsError> {
        let path = player::write_temp_audio(bytes, &self.format)?;
        let played = player::play_file(&path);
        // Best-effort cleanup: a leftover temp file must never mask a playback
        // result, and the OS temp dir is pruned by the system anyway.
        let _ = std::fs::remove_file(&path);
        played
    }
}

impl Speaker for FishSpeaker {
    fn speak(&self, text: &str) -> Result<(), TtsError> {
        // Missing config short-circuits before any network work.
        let bytes = self.synthesize(text)?;
        self.play(&bytes)
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
        assert_eq!(speaker.speak("hello"), Err(TtsError::MissingKey));
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
        assert_eq!(speaker.speak("hello"), Err(TtsError::MissingReferenceId));
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
    fn error_bodies_are_truncated() {
        let long = "x".repeat(MAX_ERROR_BODY + 50);
        let truncated = truncate(&long, MAX_ERROR_BODY);
        assert_eq!(truncated.chars().count(), MAX_ERROR_BODY + 1);
        assert!(truncated.ends_with('…'));
    }
}
