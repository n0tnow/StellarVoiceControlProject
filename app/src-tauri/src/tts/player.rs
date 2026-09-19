//! Audio playback for the Fish Audio backend (step A3).
//!
//! The Fish response is raw audio bytes (an MP3 for the default `format`), not a
//! stream we own a player for. Rather than pull in an audio crate, the bytes are
//! written to a unique file under the OS temp directory and handed to macOS's
//! built-in `afplay`, which supports MP3 and WAV natively. This is the simplest
//! approach that actually plays the provider's output from Rust, and it keeps the
//! dependency surface at zero. The local backend does not use this module: `say`
//! synthesizes and plays in one step.
//!
//! Playback is blocking — `afplay` is waited on — so the caller returns only once
//! the utterance has finished. That matches [`crate::tts::Speaker::speak`]'s
//! contract and keeps the `tts in <ms> ms` latency line meaningful.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::tts::TtsError;

/// Writes `bytes` to a unique temp file whose extension comes from `format`.
///
/// Unique per process and per call so two overlapping utterances cannot clobber
/// each other. The name is never derived from provider data.
pub fn write_temp_audio(bytes: &[u8], format: &str) -> Result<PathBuf, TtsError> {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "polaris-tts-{}-{count}{}",
        std::process::id(),
        extension(format)
    ));
    std::fs::write(&path, bytes).map_err(|error| {
        TtsError::Playback(format!("could not write {}: {error}", path.display()))
    })?;
    Ok(path)
}

/// The file extension for a documented Fish `format` value.
///
/// Sanitised to alphanumerics so an unexpected value can never introduce a path
/// separator; an empty result falls back to `.bin`.
pub fn extension(format: &str) -> String {
    let cleaned: String = format
        .trim()
        .trim_start_matches('.')
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .collect();
    if cleaned.is_empty() {
        ".bin".to_string()
    } else {
        format!(".{cleaned}")
    }
}

/// Plays an audio file with `afplay`, blocking until it finishes.
pub fn play_file(path: &Path) -> Result<(), TtsError> {
    let status = Command::new("afplay")
        .arg(path)
        .status()
        .map_err(|error| TtsError::Playback(format!("could not run `afplay`: {error}")))?;
    if !status.success() {
        return Err(TtsError::Playback(format!(
            "`afplay` exited with {status} for {}",
            path.display()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_sanitised() {
        assert_eq!(extension("mp3"), ".mp3");
        assert_eq!(extension(".wav"), ".wav");
        assert_eq!(extension("  opus "), ".opus");
        // A path separator must never survive into the file name.
        assert_eq!(extension("../evil"), ".evil");
        assert_eq!(extension(""), ".bin");
        assert_eq!(extension("..."), ".bin");
    }

    #[test]
    fn temp_audio_is_written_verbatim_and_uniquely() {
        let first = write_temp_audio(&[0x49, 0x44, 0x33], "mp3").unwrap();
        let second = write_temp_audio(&[0x52, 0x49, 0x46, 0x46], "wav").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&first).unwrap(), vec![0x49, 0x44, 0x33]);
        assert_eq!(first.extension().unwrap(), "mp3");
        assert_eq!(second.extension().unwrap(), "wav");
        let _ = std::fs::remove_file(&first);
        let _ = std::fs::remove_file(&second);
    }

    #[test]
    fn playing_a_missing_file_is_an_error_not_a_panic() {
        let missing = std::env::temp_dir().join("polaris-tts-does-not-exist.mp3");
        let _ = std::fs::remove_file(&missing);
        assert!(matches!(play_file(&missing), Err(TtsError::Playback(_))));
    }
}
