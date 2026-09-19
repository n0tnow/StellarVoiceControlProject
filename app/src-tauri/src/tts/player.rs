//! Audio playback for the Fish Audio backend (steps A3/A5).
//!
//! The Fish response is a streaming audio body (an MP3 for the default
//! `format`). Step A5's requirement is that the user hears the first word at
//! roughly the provider's time-to-first-byte, not after the whole download: a
//! ~2.7 s synthesis used to cost 3–6 s before any sound because the body was
//! buffered to a temp file first.
//!
//! Two players are used, in order:
//!
//! * **`ffplay`** (from the Homebrew ffmpeg that is already installed on the
//!   development machine) reads the audio container straight from its **stdin**,
//!   so the network body is piped through as it arrives and playback starts at
//!   the first decoded frame. Only the `mp3` and `wav` containers get an
//!   explicit `-f` hint; anything else is left to ffplay's own probe.
//! * **`afplay`** is the fallback when no `ffplay` can be found: it needs a real
//!   file, so the body is buffered to a unique temp file first (the pre-A5
//!   behaviour). This keeps the app working on a machine without ffmpeg, at the
//!   cost of the original time-to-audio.
//!
//! Playback is blocking — the player is waited on — so the caller returns only
//! once the utterance has finished. That matches
//! [`crate::tts::Speaker::speak`]'s contract and is what makes the
//! `speech_status: idle` event fire at the true end of audio. The local `say`
//! backend does not use this module: `say` synthesizes and plays in one step.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use crate::timing;
use crate::tts::{PlaybackStart, TtsError};

/// Writes `bytes` to a unique temp file whose extension comes from `format`.
///
/// Unique per process and per call so two overlapping utterances cannot clobber
/// each other. The name is never derived from provider data. Used only by the
/// `afplay` fallback; the streaming path never writes to disk.
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
///
/// `on_playback_start` fires only once `afplay` has actually started, so a spawn
/// failure never reads as playback (step A9). `afplay` begins as soon as the
/// process is up, which is the honest definition of "audio has started" here.
pub fn play_file(path: &Path, on_playback_start: &PlaybackStart<'_>) -> Result<(), TtsError> {
    let mut child = Command::new("afplay")
        .arg(path)
        .spawn()
        .map_err(|error| TtsError::Playback(format!("could not run `afplay`: {error}")))?;
    on_playback_start();
    let status = child
        .wait()
        .map_err(|error| TtsError::Playback(format!("could not wait for `afplay`: {error}")))?;
    if !status.success() {
        return Err(TtsError::Playback(format!(
            "`afplay` exited with {status} for {}",
            path.display()
        )));
    }
    Ok(())
}

/// The `ffplay` input container name for a documented Fish `format`, if known.
///
/// Only containers ffplay can be told about unambiguously are mapped; an unknown
/// format returns `None` and ffplay probes the stream itself (the safe default).
pub fn input_format(format: &str) -> Option<&'static str> {
    match format.trim().to_ascii_lowercase().as_str() {
        "mp3" => Some("mp3"),
        "wav" => Some("wav"),
        _ => None,
    }
}

/// The exact `ffplay` argument vector for one streaming utterance.
///
/// Pure and pinned by a test: `-autoexit` is what makes the process quit at end
/// of stream (otherwise it would idle forever and `speak` would never return),
/// `-nodisp` keeps a window from appearing, and `pipe:0` names stdin.
pub fn ffplay_args(format: &str) -> Vec<String> {
    let mut args = vec![
        "-autoexit".to_string(),
        "-nodisp".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-nostats".to_string(),
    ];
    if let Some(name) = input_format(format) {
        args.push("-f".to_string());
        args.push(name.to_string());
    }
    args.push("-i".to_string());
    args.push("pipe:0".to_string());
    args
}

/// Resolves an `ffplay` binary, cached for the process lifetime.
///
/// PATH is checked first; the two Homebrew prefixes are tried explicitly because
/// a GUI-launched app does not inherit the shell's PATH. Returns `None` when no
/// working `ffplay` exists, in which case playback falls back to `afplay`.
fn ffplay_binary() -> Option<&'static str> {
    static RESOLVED: OnceLock<Option<String>> = OnceLock::new();
    RESOLVED
        .get_or_init(|| {
            const CANDIDATES: [&str; 3] = [
                "ffplay",
                "/opt/homebrew/bin/ffplay",
                "/usr/local/bin/ffplay",
            ];
            CANDIDATES
                .iter()
                .copied()
                .find(|candidate| {
                    Command::new(candidate)
                        .arg("-version")
                        .stdin(Stdio::null())
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map(|status| status.success())
                        .unwrap_or(false)
                })
                .map(str::to_string)
        })
        .as_deref()
}

/// Streams `reader` into a player and blocks until playback finishes.
///
/// Pipes the bytes into `ffplay`'s stdin when available, so audio starts at the
/// first decoded frame instead of after the full download. Falls back to
/// buffering the body and using `afplay` when no `ffplay` can be started.
pub fn play_stream<R: Read>(
    mut reader: R,
    format: &str,
    on_playback_start: &PlaybackStart<'_>,
) -> Result<(), TtsError> {
    if let Some(binary) = ffplay_binary() {
        match spawn_ffplay(binary, format) {
            Ok(child) => return finish_ffplay(child, &mut reader, binary, on_playback_start),
            // The cached binary disappeared (or a PATH entry went stale); fall
            // through to the buffered path rather than failing the utterance.
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(TtsError::Playback(format!(
                    "could not start `{binary}`: {error}"
                )));
            }
        }
    }

    let mut bytes = Vec::new();
    reader
        .read_to_end(&mut bytes)
        .map_err(|error| TtsError::Network(error.to_string()))?;
    // Buffered path: the first audio byte is only available once the whole body
    // has been read — that gap is exactly the pre-A5 latency the streaming path
    // removes, and the A11 trace makes it visible when ffplay is missing.
    timing::mark("tts first audio byte");
    if bytes.is_empty() {
        return Err(TtsError::Malformed(
            "the service returned a 2xx with no audio".to_string(),
        ));
    }
    let path = write_temp_audio(&bytes, format)?;
    let played = play_file(&path, on_playback_start);
    // Best-effort cleanup: a leftover temp file must never mask a playback
    // result, and the OS temp dir is pruned by the system anyway.
    let _ = std::fs::remove_file(&path);
    played
}

/// Spawns `ffplay` with stdin piped (the audio body) and its window suppressed.
fn spawn_ffplay(binary: &str, format: &str) -> std::io::Result<Child> {
    Command::new(binary)
        .args(ffplay_args(format))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
}

/// Feeds the audio body to an already-spawned player and waits for it to exit.
///
/// A broken pipe means the player stopped reading (e.g. it hit an error); the
/// exit status is then the authoritative result, so the feed stops quietly and
/// the status check below reports the failure.
///
/// `on_playback_start` fires after the first decoded chunk has been handed to the
/// player — the earliest point at which ffplay can actually emit sound — and
/// never when the body was empty or the feed failed first (step A9).
fn finish_ffplay<R: Read>(
    mut child: Child,
    reader: &mut R,
    binary: &str,
    on_playback_start: &PlaybackStart<'_>,
) -> Result<(), TtsError> {
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| TtsError::Playback(format!("`{binary}` did not expose stdin")))?;
    let mut buffer = [0u8; 16 * 1024];
    let mut announced = false;
    let mut first_byte = false;
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) => return Err(TtsError::Network(error.to_string())),
        };
        if !first_byte {
            // Streaming path: the first chunk that leaves the provider is the
            // first audio byte the player can decode.
            first_byte = true;
            timing::mark("tts first audio byte");
        }
        if let Err(error) = stdin.write_all(&buffer[..read]) {
            if error.kind() == std::io::ErrorKind::BrokenPipe {
                break;
            }
            return Err(TtsError::Playback(format!(
                "could not stream audio to `{binary}`: {error}"
            )));
        }
        if !announced {
            announced = true;
            on_playback_start();
        }
    }
    drop(stdin);
    let status = child
        .wait()
        .map_err(|error| TtsError::Playback(format!("could not wait for `{binary}`: {error}")))?;
    if !status.success() {
        return Err(TtsError::Playback(format!("`{binary}` exited with {status}")));
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
    fn streamed_formats_are_mapped_only_when_known() {
        assert_eq!(input_format("mp3"), Some("mp3"));
        assert_eq!(input_format("  WAV "), Some("wav"));
        // opus/pcm have no unambiguous pipe container: let ffplay probe.
        assert_eq!(input_format("opus"), None);
        assert_eq!(input_format("pcm"), None);
        assert_eq!(input_format(""), None);
    }

    #[test]
    fn ffplay_args_read_stdin_and_quit_at_end_of_stream() {
        let args = ffplay_args("mp3");
        // stdin is the audio body, and the window must stay hidden.
        assert!(args.contains(&"pipe:0".to_string()));
        assert!(args.contains(&"-nodisp".to_string()));
        // Without `-autoexit` ffplay would idle and `speak` would never return.
        assert!(args.contains(&"-autoexit".to_string()));
        // The `-f` hint precedes `-i`, and both precede the input name.
        let f_index = args.iter().position(|arg| arg == "-f").unwrap();
        let i_index = args.iter().position(|arg| arg == "-i").unwrap();
        assert_eq!(args[f_index + 1], "mp3");
        assert!(f_index < i_index && i_index < args.len() - 1);
    }

    #[test]
    fn ffplay_args_omit_the_format_hint_when_the_container_is_unknown() {
        let args = ffplay_args("opus");
        assert!(!args.contains(&"-f".to_string()));
        assert!(args.contains(&"pipe:0".to_string()));
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
        let noop = || {};
        assert!(matches!(
            play_file(&missing, &noop),
            Err(TtsError::Playback(_))
        ));
    }

    /// `play_file` must announce playback only once `afplay` has actually
    /// started — a silent WAV is enough to prove the callback fires. It spawns a
    /// real player, so it is `#[ignore]`d to keep the default `cargo test` silent
    /// and offline (the neighbouring live-audio tests in `tts.rs` are too). Run
    /// it manually with `--ignored`.
    #[test]
    #[ignore = "plays real audio through afplay; run manually with --ignored"]
    fn playback_start_fires_when_the_player_really_starts() {
        // A minimal, valid, silent 16-bit PCM WAV written with the same crate the
        // capture layer uses. 8 kHz, 1 channel, 80 ms of silence.
        let path = std::env::temp_dir().join(format!("polaris-tts-silent-{}.wav", std::process::id()));
        {
            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: 8_000,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = hound::WavWriter::create(&path, spec).unwrap();
            for _ in 0..640 {
                writer.write_sample(0i16).unwrap();
            }
            writer.finalize().unwrap();
        }

        let announced = std::sync::atomic::AtomicUsize::new(0);
        let on_start = || {
            announced.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        };
        let result = play_file(&path, &on_start);
        let _ = std::fs::remove_file(&path);

        result.expect("afplay must play a valid silent WAV");
        assert_eq!(announced.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
