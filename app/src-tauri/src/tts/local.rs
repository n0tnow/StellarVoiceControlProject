//! Local macOS speech backend (step A3, mandatory fallback).
//!
//! The free Fish Audio tier is time-limited and has no SLA, so Polaris must
//! always be able to speak. This backend drives macOS's built-in `say` command,
//! which is free, instant, offline, and needs no key. It is the fallback for
//! every Fish failure and the explicit choice when `POLARIS_TTS_BACKEND=local`.
//!
//! `say` both synthesizes **and** plays, so unlike the Fish backend there is no
//! separate playback step. The voice is held fixed with `POLARIS_TTS_LOCAL_VOICE`
//! (default `Yelda`, a Turkish voice, matching the MVP plan in
//! `docs/architecture.md` §4.1) so the local utterances do not drift either.
//! `--` separates the voice options from the text, so text that begins with a
//! dash is spoken literally instead of being parsed as a flag.

use std::process::Command;

use crate::env;
use crate::tts::{PlaybackStart, Speaker, TtsError};

/// Fixed local voice when `POLARIS_TTS_LOCAL_VOICE` is not set. `Yelda` is the
/// Turkish voice shipped with macOS and the MVP choice recorded in the
/// architecture doc.
pub const DEFAULT_VOICE: &str = "Yelda";

/// `POLARIS_TTS_LOCAL_VOICE` — overrides the local voice.
pub const VOICE_ENV: &str = "POLARIS_TTS_LOCAL_VOICE";

/// Resolves the local voice. Blank or missing means [`DEFAULT_VOICE`].
///
/// The local voice is deliberately fixed too: the owner requires that every
/// utterance sound the same, and a stable local voice keeps the fallback
/// predictable even though it cannot match the Fish voice.
pub fn resolve_voice(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| Some(DEFAULT_VOICE.to_string()))
}

/// The exact `say` argument vector. Pure, so the option-injection guard is
/// pinned by a test: the text always follows a literal `--`.
pub fn command_args(voice: Option<&str>, text: &str) -> Vec<String> {
    let mut args = Vec::new();
    if let Some(voice) = voice {
        args.push("-v".to_string());
        args.push(voice.to_string());
    }
    args.push("--".to_string());
    args.push(text.to_string());
    args
}

/// The local backend.
pub struct LocalSpeaker {
    voice: Option<String>,
}

impl LocalSpeaker {
    pub fn from_env() -> Self {
        Self::new(resolve_voice(env::var(VOICE_ENV)))
    }

    pub fn new(voice: Option<String>) -> Self {
        Self { voice }
    }

    /// The configured voice; `None` means the macOS system default.
    pub fn voice(&self) -> Option<&str> {
        self.voice.as_deref()
    }
}

impl Speaker for LocalSpeaker {
    fn speak(&self, text: &str, on_playback_start: &PlaybackStart<'_>) -> Result<(), TtsError> {
        let args = command_args(self.voice.as_deref(), text);
        // `say` synthesizes and plays in one step, so the process starting *is*
        // playback beginning. Announce after a successful spawn, never before: a
        // `say` that could not be started must not read as "Speaking".
        let mut child = Command::new("say")
            .args(&args)
            .spawn()
            .map_err(|error| TtsError::Local(format!("could not run `say`: {error}")))?;
        on_playback_start();
        let status = child
            .wait()
            .map_err(|error| TtsError::Local(format!("could not wait for `say`: {error}")))?;
        if !status.success() {
            return Err(TtsError::Local(format!("`say` exited with {status}")));
        }
        Ok(())
    }

    fn name(&self) -> &'static str {
        "local"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_voice_defaults_to_yelda_and_accepts_an_override() {
        assert_eq!(resolve_voice(None).as_deref(), Some(DEFAULT_VOICE));
        assert_eq!(
            resolve_voice(Some("   ".to_string())).as_deref(),
            Some(DEFAULT_VOICE)
        );
        assert_eq!(
            resolve_voice(Some(" Mehmet ".to_string())).as_deref(),
            Some("Mehmet")
        );
    }

    #[test]
    fn command_args_put_the_text_after_the_option_terminator() {
        assert_eq!(
            command_args(Some("Yelda"), "Merhaba"),
            vec!["-v", "Yelda", "--", "Merhaba"]
        );
    }

    #[test]
    fn command_args_without_a_voice_still_terminate_options() {
        assert_eq!(command_args(None, "hi"), vec!["--", "hi"]);
    }

    #[test]
    fn text_that_looks_like_a_flag_is_not_an_option() {
        // Without `--`, `say` would try to parse `-v` as a voice flag.
        assert_eq!(
            command_args(Some("Yelda"), "-v Evil --output /tmp/x.aiff"),
            vec!["-v", "Yelda", "--", "-v Evil --output /tmp/x.aiff"]
        );
    }

    #[test]
    fn the_speaker_keeps_its_voice_and_reports_its_name() {
        let speaker = LocalSpeaker::new(Some("Yelda".to_string()));
        assert_eq!(speaker.voice(), Some("Yelda"));
        assert_eq!(speaker.name(), "local");
        assert_eq!(LocalSpeaker::new(None).voice(), None);
    }
}
