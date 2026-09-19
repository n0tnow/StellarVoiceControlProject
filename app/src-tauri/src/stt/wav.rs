//! WAV pre-flight and recording retention (step A1).
//!
//! A cloud round-trip is not free, so obvious non-speech is rejected locally
//! before the provider is called. The checks are also the honest place to define
//! what "empty" means for the overlay:
//!
//! * **Too short** — under [`MIN_DURATION_MS`] the clip is a tap, not speech.
//! * **Silent** — a real recording whose peak never rises above the noise floor,
//!   e.g. a muted or wrong input device. It is long enough to be plausible, so
//!   only the signal can tell.
//!
//! Retention lives here too because it is a property of the recordings
//! directory, not of any one provider.

use std::path::{Path, PathBuf};

use crate::stt::SttError;

/// Clips shorter than this are rejected without a network call. 300 ms is below
/// any real command but above a modifier slip.
pub const MIN_DURATION_MS: u64 = 300;

/// Peak amplitude (of i16 full scale) treated as silence. ~1% is far above the
/// idle noise of laptop microphones and far below normal speech, which peaks in
/// the thousands.
pub const SILENCE_PEAK_THRESHOLD: i32 = i16::MAX as i32 / 100;

/// How many recordings may remain on disk. Failed captures are what fill this
/// up; a successful one is deleted outright. Small enough that a forgotten
/// session cannot grow the app data dir meaningfully.
pub const MAX_RECORDINGS: usize = 10;

/// What the pre-flight learned about a usable recording.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WavInfo {
    pub duration_ms: u64,
    pub peak: i32,
}

/// Reads a WAV and applies the rejection rules.
pub fn validate(path: &Path) -> Result<WavInfo, SttError> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| SttError::Wav(format!("could not open {}: {error}", path.display())))?;
    let spec = reader.spec();
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return Err(SttError::Wav(format!(
            "unsupported audio format: {} bit {:?} (16-bit PCM is required)",
            spec.bits_per_sample, spec.sample_format
        )));
    }

    let channels = u64::from(spec.channels.max(1));
    let sample_rate = u64::from(spec.sample_rate.max(1));
    let samples = reader
        .into_samples::<i16>()
        .collect::<Result<Vec<i16>, _>>()
        .map_err(|error| SttError::Wav(format!("could not read {}: {error}", path.display())))?;

    if samples.is_empty() {
        return Err(SttError::Empty);
    }

    let frames = samples.len() as u64 / channels;
    let duration_ms = frames * 1000 / sample_rate;
    let peak = samples
        .iter()
        .map(|sample| i32::from(*sample).abs())
        .max()
        .unwrap_or(0);

    analyze(duration_ms, peak)
}

/// The pure rejection rules, split out so they are testable without a file.
pub fn analyze(duration_ms: u64, peak: i32) -> Result<WavInfo, SttError> {
    if duration_ms < MIN_DURATION_MS {
        return Err(SttError::TooShort { duration_ms });
    }
    if peak <= SILENCE_PEAK_THRESHOLD {
        return Err(SttError::Silent);
    }
    Ok(WavInfo { duration_ms, peak })
}

/// Deletes the oldest `polaris-*.wav` recordings once more than `cap` remain.
/// Returns how many files were removed.
///
/// Best-effort by design: retention must never turn a successful transcription
/// into a failure, so filesystem errors are swallowed (the next run retries).
/// Names embed a millisecond timestamp before the per-launch sequence, so a
/// lexicographic sort is oldest-first for any realistic session.
pub fn prune_recordings(dir: &Path, cap: usize) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut recordings: Vec<PathBuf> = entries
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().and_then(|ext| ext.to_str()) == Some("wav")
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("polaris-"))
        })
        .collect();
    if recordings.len() <= cap {
        return 0;
    }
    recordings.sort();
    let remove = recordings.len() - cap;
    recordings
        .into_iter()
        .take(remove)
        .filter(|path| std::fs::remove_file(path).is_ok())
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::temp_dir;

    fn write_wav(path: &Path, peak: i16, frames: u32, sample_rate: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for frame in 0..frames {
            writer
                .write_sample(if frame % 2 == 0 { peak } else { -peak })
                .unwrap();
        }
        writer.finalize().unwrap();
    }

    #[test]
    fn a_clip_under_the_minimum_is_too_short() {
        assert_eq!(
            analyze(MIN_DURATION_MS - 1, 10_000),
            Err(SttError::TooShort {
                duration_ms: MIN_DURATION_MS - 1
            })
        );
        assert!(analyze(MIN_DURATION_MS, 10_000).is_ok());
    }

    #[test]
    fn a_long_but_flat_recording_is_silent() {
        assert_eq!(analyze(2_000, 0), Err(SttError::Silent));
        assert_eq!(analyze(2_000, SILENCE_PEAK_THRESHOLD), Err(SttError::Silent));
        assert!(analyze(2_000, SILENCE_PEAK_THRESHOLD + 1).is_ok());
    }

    #[test]
    fn duration_is_derived_from_frames_and_rate() {
        // 24 kHz mono, 24 000 frames = 1000 ms. The rate must come from the
        // header, not a hardcoded 48 kHz (which would report 500 ms).
        let dir = temp_dir("wav-duration");
        let path = dir.join("clip.wav");
        write_wav(&path, 5_000, 24_000, 24_000);
        let info = validate(&path).unwrap();
        assert_eq!(info.duration_ms, 1000);
        assert_eq!(info.peak, 5_000);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_silent_file_is_rejected_by_validate() {
        let dir = temp_dir("wav-silent");
        let path = dir.join("silent.wav");
        write_wav(&path, 0, 32_000, 16_000);
        assert_eq!(validate(&path), Err(SttError::Silent));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_unreadable_file_is_a_wav_error_not_a_panic() {
        let dir = temp_dir("wav-missing");
        let path = dir.join("nope.wav");
        assert!(matches!(validate(&path), Err(SttError::Wav(_))));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pruning_keeps_the_newest_recordings_and_ignores_other_files() {
        let dir = temp_dir("wav-prune");
        // Deliberately written out of order: the sort must be by name.
        for name in [
            "polaris-0000000000003-0.wav",
            "polaris-0000000000001-0.wav",
            "polaris-0000000000005-0.wav",
            "polaris-0000000000002-0.wav",
            "polaris-0000000000004-0.wav",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        // A non-recording file must never be touched by retention.
        std::fs::write(dir.join("notes.txt"), b"keep me").unwrap();

        let removed = prune_recordings(&dir, 3);
        assert_eq!(removed, 2);
        assert!(dir.join("notes.txt").exists(), "unrelated files are left alone");
        for name in [
            "polaris-0000000000003-0.wav",
            "polaris-0000000000004-0.wav",
            "polaris-0000000000005-0.wav",
        ] {
            assert!(dir.join(name).exists(), "{name} should survive");
        }
        for name in [
            "polaris-0000000000001-0.wav",
            "polaris-0000000000002-0.wav",
        ] {
            assert!(!dir.join(name).exists(), "{name} should be pruned");
        }
        assert_eq!(prune_recordings(&dir, 10), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn pruning_a_missing_directory_is_a_noop() {
        assert_eq!(prune_recordings(Path::new("/nonexistent/polaris-dir"), 1), 0);
    }
}
