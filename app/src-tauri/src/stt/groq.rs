//! Groq speech-to-text (step A1, cloud-first decision).
//!
//! Groq exposes an OpenAI-compatible transcription endpoint
//! (`POST https://api.groq.com/openai/v1/audio/transcriptions`) that takes a
//! multipart upload. With `response_format=verbose_json` it also reports the
//! **detected language** of the audio, which is the whole point of this backend
//! (step A12): the on-device recognizer is pinned to one locale, so it cannot
//! tell English from Turkish, and the reply language and TTS voice would be
//! poisoned by a wrong guess. The request shape implemented here was re-read
//! from <https://console.groq.com/docs/speech-to-text> while writing this module:
//!
//! * `file` — the audio bytes; 16-bit PCM WAV is supported.
//! * `model` — required; `whisper-large-v3-turbo` is the fast/cheap default.
//! * `language` — optional ISO-639-1 hint. Omitted by default so mixed
//!   Turkish/English commands can be auto-detected (see the A1 report). The
//!   detected language is still returned when a hint is supplied.
//! * `response_format` — `verbose_json`, the only format that carries the
//!   `language` field alongside `text` (a plain `json` response does not).
//!
//! The multipart body is built by hand rather than through a library so the
//! exact bytes are unit-testable and the request never depends on a client's
//! form encoder. The API key is only ever placed in the `Authorization` header;
//! it is never logged, never written to disk and never included in an error.

use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;

use crate::env;
use crate::stt::{SttError, Transcriber, Transcription};

/// Default model; override with `POLARIS_STT_MODEL`.
pub const DEFAULT_MODEL: &str = "whisper-large-v3-turbo";

/// The only response format that returns the detected `language` field.
pub const RESPONSE_FORMAT: &str = "verbose_json";

/// The OpenAI-compatible transcription endpoint.
pub const ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";

/// Whole-request budget. The target is well under 2 s; this only stops a stalled
/// connection from pinning the STT worker forever.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

/// How long to wait for the TCP/TLS handshake before giving up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Cap on how much of a provider error body reaches the terminal.
const MAX_ERROR_BODY: usize = 400;

/// One file part of a multipart form.
pub struct MultipartFile<'a> {
    pub field: &'a str,
    pub filename: &'a str,
    pub content_type: &'a str,
    pub bytes: &'a [u8],
}

/// The Groq backend. Construction never fails: a missing key is a runtime
/// [`SttError::MissingKey`], not a startup error, so capture keeps working.
pub struct GroqTranscriber {
    api_key: Option<String>,
    model: String,
    language: Option<String>,
    client: reqwest::blocking::Client,
}

impl GroqTranscriber {
    /// Reads the key, model and optional language from the environment.
    pub fn from_env() -> Self {
        let model = env::var("POLARIS_STT_MODEL").unwrap_or_else(|| DEFAULT_MODEL.to_string());
        Self::new(env::var("GROQ_API_KEY"), model, env::var("POLARIS_STT_LANGUAGE"))
    }

    pub fn new(api_key: Option<String>, model: String, language: Option<String>) -> Self {
        let client = reqwest::blocking::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            api_key,
            model,
            language,
            client,
        }
    }

    /// Whether a key was supplied. Used only for the startup hint; it never
    /// exposes the value.
    pub fn has_key(&self) -> bool {
        self.api_key.is_some()
    }

    /// The model id, for the startup line only. Not secret.
    pub fn model(&self) -> &str {
        &self.model
    }

    fn transcribe_with_key(&self, wav: &Path, key: &str) -> Result<Transcription, SttError> {
        let bytes = std::fs::read(wav)
            .map_err(|error| SttError::Wav(format!("could not read {}: {error}", wav.display())))?;
        let filename = wav
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("audio.wav");

        let mut fields: Vec<(&str, String)> = vec![
            ("model", self.model.clone()),
            ("response_format", RESPONSE_FORMAT.to_string()),
        ];
        if let Some(language) = &self.language {
            fields.push(("language", language.clone()));
        }

        let boundary = boundary();
        let content_type = format!("multipart/form-data; boundary={boundary}");
        let body = multipart_body(
            &boundary,
            &fields,
            MultipartFile {
                field: "file",
                filename,
                content_type: "audio/wav",
                bytes: &bytes,
            },
        );

        let response = self
            .client
            .post(ENDPOINT)
            .header(reqwest::header::CONTENT_TYPE, content_type)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {key}"))
            .body(body)
            .send()
            .map_err(|error| SttError::Network(error.to_string()))?;

        let status = response.status();
        let text = response
            .text()
            .map_err(|error| SttError::Network(error.to_string()))?;
        if !status.is_success() {
            return Err(SttError::Http {
                status: status.as_u16(),
                detail: truncate(&text, MAX_ERROR_BODY),
            });
        }
        parse_response(&text)
    }
}

impl Transcriber for GroqTranscriber {
    fn transcribe(&self, wav: &Path) -> Result<Transcription, SttError> {
        // Missing key short-circuits before any file or network work.
        let key = self.api_key.as_deref().ok_or(SttError::MissingKey)?;
        self.transcribe_with_key(wav, key)
    }
}

/// Builds a `multipart/form-data` body. Pure and byte-exact, so the wire shape
/// is pinned by a test rather than trusted to a client library.
pub fn multipart_body(
    boundary: &str,
    fields: &[(&str, String)],
    file: MultipartFile<'_>,
) -> Vec<u8> {
    let mut preamble = String::new();
    for (name, value) in fields {
        preamble.push_str(&format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n"
        ));
    }
    preamble.push_str(&format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {}\r\n\r\n",
        file.field, file.filename, file.content_type
    ));

    let mut body = preamble.into_bytes();
    body.extend_from_slice(file.bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// A boundary unique enough for one process. The value never needs to be secret;
/// it only has to not occur inside the audio bytes, which the timestamp and
/// counter make overwhelmingly unlikely.
fn boundary() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!("polaris-{nanos:032x}{count:08x}")
}

/// The documented `verbose_json` response shape. Extra fields (Groq returns
/// `duration`, `segments`, `x_groq` metadata) are ignored on purpose.
#[derive(Debug, Deserialize)]
struct GroqResponse {
    #[serde(default)]
    text: Option<String>,
    /// Present only for `response_format=verbose_json`; a full language name
    /// such as `"Turkish"` or `"English"`.
    #[serde(default)]
    language: Option<String>,
}

/// Parses the provider's `verbose_json` response.
///
/// A 2xx with no `text`, or with blank text, is not a usable transcript: the
/// former is a contract drift ([`SttError::Malformed`]), the latter is the
/// provider telling us it heard nothing ([`SttError::Silent`]). The detected
/// language is normalised to a BCP-47 tag; a missing or unrecognised language
/// is `None` (unknown), never a guess.
pub fn parse_response(body: &str) -> Result<Transcription, SttError> {
    let parsed: GroqResponse = serde_json::from_str(body).map_err(|error| {
        SttError::Malformed(format!("the body was not valid JSON: {error}"))
    })?;
    let text = parsed
        .text
        .ok_or_else(|| SttError::Malformed("the response had no `text` field".to_string()))?
        .trim()
        .to_string();
    if text.is_empty() {
        return Err(SttError::Silent);
    }
    let language = parsed
        .language
        .as_deref()
        .and_then(crate::stt::normalize_detected_language);
    Ok(Transcription { text, language })
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

    #[test]
    fn multipart_body_has_the_exact_wire_shape() {
        let body = multipart_body(
            "BOUNDARY",
            &[
                ("model", "whisper-large-v3-turbo".to_string()),
                ("response_format", RESPONSE_FORMAT.to_string()),
            ],
            MultipartFile {
                field: "file",
                filename: "polaris-1.wav",
                content_type: "audio/wav",
                bytes: &[0x52, 0x49, 0x46, 0x46],
            },
        );
        let body = String::from_utf8(body).unwrap();
        assert_eq!(
            body,
            "--BOUNDARY\r\n\
             Content-Disposition: form-data; name=\"model\"\r\n\r\n\
             whisper-large-v3-turbo\r\n\
             --BOUNDARY\r\n\
             Content-Disposition: form-data; name=\"response_format\"\r\n\r\n\
             verbose_json\r\n\
             --BOUNDARY\r\n\
             Content-Disposition: form-data; name=\"file\"; filename=\"polaris-1.wav\"\r\n\
             Content-Type: audio/wav\r\n\r\n\
             RIFF\r\n--BOUNDARY--\r\n"
        );
    }

    #[test]
    fn multipart_body_keeps_arbitrary_audio_bytes_intact() {
        // Binary that contains CRLF and a `--` sequence must survive verbatim.
        let bytes: Vec<u8> = vec![0, 1, 13, 10, b'-', b'-', 255, 0, 42];
        let body = multipart_body(
            "XYZ",
            &[],
            MultipartFile {
                field: "file",
                filename: "a.wav",
                content_type: "audio/wav",
                bytes: &bytes,
            },
        );
        let start = body
            .windows(bytes.len())
            .position(|window| window == bytes.as_slice())
            .expect("file bytes must appear verbatim in the body");
        // Exactly once, and followed by the closing delimiter.
        assert_eq!(
            body.windows(bytes.len())
                .filter(|window| *window == bytes.as_slice())
                .count(),
            1
        );
        assert_eq!(
            &body[start + bytes.len()..],
            b"\r\n--XYZ--\r\n"
        );
    }

    #[test]
    fn parses_the_documented_response() {
        // A recorded sample payload, `response_format=verbose_json`. The
        // `language` field is the A12 addition and is what makes the downstream
        // reply/voice follow the audio instead of a guess.
        let transcription = parse_response(
            r#"{"text":"send 10 USDC to ada","language":"English","duration":2.4}"#,
        )
        .unwrap();
        assert_eq!(transcription.text, "send 10 USDC to ada");
        assert_eq!(transcription.language.as_deref(), Some("en"));
    }

    #[test]
    fn the_detected_language_name_is_normalized_to_a_tag() {
        for (reported, expected) in [("Turkish", "tr"), ("English", "en"), ("en-US", "en-us")] {
            let body = format!(r#"{{"text":"merhaba","language":"{reported}"}}"#);
            assert_eq!(
                parse_response(&body).unwrap().language.as_deref(),
                Some(expected),
                "{reported}"
            );
        }
        // An unmapped name is unknown rather than a wrong voice selection.
        assert_eq!(
            parse_response(r#"{"text":"hello","language":"Klingon"}"#)
                .unwrap()
                .language,
            None
        );
    }

    #[test]
    fn parses_turkish_and_trims_surrounding_whitespace() {
        let transcription =
            parse_response(r#"{"text":"  ADA'ya 10 USDC gönder  "}"#).unwrap();
        assert_eq!(transcription.text, "ADA'ya 10 USDC gönder");
        // A plain (non-verbose) body has no language: unknown, not guessed.
        assert_eq!(transcription.language, None);
    }

    #[test]
    fn ignores_extra_fields_such_as_x_groq() {
        let transcription = parse_response(
            r#"{"text":"hello","x_groq":{"id":"req_1","model":"whisper-large-v3-turbo"}}"#,
        )
        .unwrap();
        assert_eq!(transcription.text, "hello");
    }

    #[test]
    fn blank_text_is_reported_as_silence() {
        assert_eq!(parse_response(r#"{"text":"   "}"#), Err(SttError::Silent));
        assert_eq!(parse_response(r#"{"text":""}"#), Err(SttError::Silent));
    }

    #[test]
    fn malformed_bodies_are_rejected() {
        assert!(matches!(
            parse_response("not json"),
            Err(SttError::Malformed(_))
        ));
        assert!(matches!(
            parse_response(r#"{"error":"nope"}"#),
            Err(SttError::Malformed(_))
        ));
    }

    #[test]
    fn a_missing_key_fails_before_any_io() {
        let transcriber = GroqTranscriber::new(None, DEFAULT_MODEL.to_string(), None);
        assert!(!transcriber.has_key());
        // The path does not exist; if the key check did not short-circuit, this
        // would be a `Wav` error instead of `MissingKey`.
        assert_eq!(
            transcriber.transcribe(Path::new("/nonexistent/polaris.wav")),
            Err(SttError::MissingKey)
        );
    }

    #[test]
    fn error_bodies_are_truncated() {
        let long = "x".repeat(MAX_ERROR_BODY + 50);
        let truncated = truncate(&long, MAX_ERROR_BODY);
        assert_eq!(truncated.chars().count(), MAX_ERROR_BODY + 1);
        assert!(truncated.ends_with('…'));
    }

    #[test]
    fn boundaries_are_unique_across_calls() {
        assert_ne!(boundary(), boundary());
    }
}
