//! Non-secret voice-pipeline configuration report for the Debug panel (step W0b).
//!
//! The Debug panel needs one live answer to "is the voice pipeline configured?",
//! and the only safe way to give it one is to report **presence**, never a value:
//! which STT backend, TTS backend and agent provider the environment selected,
//! plus a boolean per required key. A key, a key prefix or a source line must
//! never cross the Tauri boundary or reach `detail` — the webview is the least
//! trusted part of the app (`docs/notch-ui.md`).
//!
//! The mapping from these facts to `ok`/`warn`/`fail` lives in the frontend
//! (`app/src/debug/checks/voice.ts`), so a copy change does not need a rebuild of
//! the shell. Backend selection reuses the same parsers the pipeline itself uses
//! ([`crate::stt::parse_backend`], [`crate::tts::parse_backend`],
//! [`crate::agent::parse_provider`]), so this report cannot drift from what
//! actually runs.

use serde::Serialize;

use crate::agent;
use crate::env;
use crate::stt;
use crate::tts;

/// Groq's key. Not re-exported by `stt` because only its presence matters here.
pub const GROQ_KEY_ENV: &str = "GROQ_API_KEY";
/// Fish Audio's key. Not re-exported by `tts` because only its presence matters.
pub const FISH_KEY_ENV: &str = "FISH_AUDIO_API_KEY";

/// Configuration facts the Debug panel renders. Camel-case on the wire to match
/// the TypeScript `VoiceHealth` in `app/src/debug/commands.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHealth {
    /// `"groq"` or `"ondevice"` — the *configured* STT backend, not the runtime
    /// fallback that may fire per utterance.
    pub stt_backend: String,
    /// `"fish"` or `"local"`.
    pub tts_backend: String,
    /// `"openai"` (OpenAI-compatible) or `"anthropic"`.
    pub agent_provider: String,
    /// Whether each key the pipeline can require is present and non-blank.
    pub groq_key: bool,
    pub fish_key: bool,
    pub anthropic_key: bool,
    pub openai_compat_key: bool,
}

/// Whether a key is set to something non-blank. The value is read and dropped
/// immediately; it is never stored or formatted.
fn key_present<F>(read: &F, name: &str) -> bool
where
    F: Fn(&str) -> Option<String>,
{
    read(name)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

/// Builds the report from an injected environment reader.
///
/// Injecting the reader is what lets the tests pin the mapping and assert that no
/// secret can appear in the serialized output without touching the real process
/// environment (which would race other tests).
pub fn health<F>(read: F) -> VoiceHealth
where
    F: Fn(&str) -> Option<String>,
{
    let stt_backend = match stt::parse_backend(read(stt::BACKEND_ENV).as_deref()).0 {
        stt::Backend::Groq => "groq",
        stt::Backend::OnDevice => "ondevice",
    };
    let tts_backend = match tts::parse_backend(read(tts::BACKEND_ENV).as_deref()).0 {
        tts::Backend::Fish => "fish",
        tts::Backend::Local => "local",
    };
    let agent_provider = match agent::parse_provider(read(agent::AGENT_PROVIDER_ENV).as_deref()).0 {
        agent::Provider::OpenAi => "openai",
        agent::Provider::Anthropic => "anthropic",
    };
    VoiceHealth {
        stt_backend: stt_backend.to_string(),
        tts_backend: tts_backend.to_string(),
        agent_provider: agent_provider.to_string(),
        groq_key: key_present(&read, GROQ_KEY_ENV),
        fish_key: key_present(&read, FISH_KEY_ENV),
        anthropic_key: key_present(&read, agent::ANTHROPIC_API_KEY_ENV),
        openai_compat_key: key_present(&read, agent::AGENT_API_KEY_ENV),
    }
}

/// The `voice_health` command. Reads the live process environment — which
/// `env::load` has already filled from the gitignored `.env` — and returns only
/// the booleans above.
#[tauri::command]
pub fn voice_health() -> VoiceHealth {
    health(env::var)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An environment reader backed by a fixed map, so no test touches the real
    /// process environment.
    fn reader<'a>(
        entries: &'a [(&'a str, &'a str)],
    ) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            entries
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| (*value).to_string())
        }
    }

    #[test]
    fn reports_the_configured_backends_and_provider() {
        let health = health(reader(&[
            (stt::BACKEND_ENV, "ondevice"),
            (tts::BACKEND_ENV, "local"),
            (agent::AGENT_PROVIDER_ENV, "anthropic"),
        ]));
        assert_eq!(health.stt_backend, "ondevice");
        assert_eq!(health.tts_backend, "local");
        assert_eq!(health.agent_provider, "anthropic");
        assert!(!health.groq_key);
        assert!(!health.fish_key);
        assert!(!health.anthropic_key);
        assert!(!health.openai_compat_key);
    }

    #[test]
    fn defaults_match_the_pipeline_when_nothing_is_configured() {
        // An empty environment must report the same defaults `build_backend`
        // picks: Groq STT, Fish TTS, OpenAI-compatible agent.
        let health = health(reader(&[]));
        assert_eq!(health.stt_backend, "groq");
        assert_eq!(health.tts_backend, "fish");
        assert_eq!(health.agent_provider, "openai");
    }

    #[test]
    fn key_presence_is_by_name_and_blank_values_count_as_absent() {
        let health = health(reader(&[
            (GROQ_KEY_ENV, "  "),
            (FISH_KEY_ENV, "present"),
            (agent::ANTHROPIC_API_KEY_ENV, "present"),
            (agent::AGENT_API_KEY_ENV, ""),
        ]));
        assert!(!health.groq_key, "a blank value must count as missing");
        assert!(health.fish_key);
        assert!(health.anthropic_key);
        assert!(!health.openai_compat_key);
    }

    /// The security invariant: the report carries presence booleans, so a secret
    /// in the environment can never reach the serialized payload — not the value,
    /// not a prefix.
    #[test]
    fn serialized_output_never_contains_a_key_value() {
        let health = health(reader(&[
            (GROQ_KEY_ENV, "gsk_super-secret-groq"),
            (FISH_KEY_ENV, "fish-super-secret"),
            (agent::ANTHROPIC_API_KEY_ENV, "sk-ant-super-secret"),
            (agent::AGENT_API_KEY_ENV, "opencode-super-secret"),
        ]));

        assert!(health.groq_key && health.fish_key && health.anthropic_key && health.openai_compat_key);
        let json = serde_json::to_string(&health).unwrap();
        for secret in [
            "super-secret",
            "sk-ant",
            "gsk_",
            "fish-super",
            "opencode-super",
        ] {
            assert!(
                !json.contains(secret),
                "serialized voice health leaked {secret:?}: {json}"
            );
        }
        // And the field set is exactly the non-secret facts.
        assert!(json.contains(r#""sttBackend":"groq""#));
        assert!(json.contains(r#""openaiCompatKey":true"#));
    }
}
