//! Microphone capture (step A0) — cpal stream in, WAV file out.
//!
//! Design notes:
//! * Samples are buffered in memory and written to a WAV file **when the push
//!   ends**, which keeps the callback dead simple and avoids partial files. A
//!   hard sample cap guards against a stuck "recording" state filling memory.
//! * `begin_capture` is idempotent so the hotkey and the on-screen button can
//!   race without double-starting a stream.
//! * Files land in the OS app-data dir (`recordings/`), never in the repository;
//!   the absolute path travels to the UI inside an `audio_captured` event and
//!   becomes step A1's STT input.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::WavSpec;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::events::{self, PolarisEvent};

/// Default push-to-talk hotkey: Control + Option (= Alt) + Space.
/// Product decision (notes.md 2026-09-19): fully user-configurable later; this
/// constant is the default until the settings UI exists.
pub const DEFAULT_HOTKEY: &str = "ctrl+alt+space";

/// Safety cap: ~2 minutes at 48 kHz stereo. Prevents a stuck recording state
/// from eating memory; the UI shows the duration so a truncated recording is
/// visible immediately.
const MAX_CAPTURE_SECONDS: f64 = 120.0;

/// Shared sample buffer handed to the cpal callback.
type SampleBuffer = Arc<Mutex<Vec<i16>>>;

pub struct CaptureState {
    session: Mutex<Option<CaptureSession>>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            session: Mutex::new(None),
        }
    }
}

struct CaptureSession {
    /// Kept alive while recording; dropping the stream stops the capture.
    stream: cpal::Stream,
    spec: WavSpec,
    buffer: SampleBuffer,
}

/// What the shell reports back after a recording ends.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapturedRecording {
    pub path: String,
    pub duration_ms: u64,
}

/// Starts recording from the default input device. Idempotent.
pub fn begin_capture(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<CaptureState>();
    let mut guard = state
        .session
        .lock()
        .map_err(|_| "capture state poisoned")?;
    if guard.is_some() {
        return Ok(()); // already recording (hotkey + button race)
    }

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no microphone found".to_string())?;
    let supported = device
        .default_input_config()
        .map_err(|error| format!("could not read microphone config: {error}"))?;
    let config: cpal::StreamConfig = supported.into();

    let buffer: SampleBuffer = Arc::new(Mutex::new(Vec::new()));
    let max_samples =
        (MAX_CAPTURE_SECONDS * f64::from(config.sample_rate) * f64::from(config.channels.max(1)))
            as usize;

    let stream = record_stream(
        &device,
        config.clone(),
        supported.sample_format(),
        Arc::clone(&buffer),
        max_samples,
    )?;
    stream
        .play()
        .map_err(|error| format!("could not start audio stream: {error}"))?;

    *guard = Some(CaptureSession {
        stream,
        spec: WavSpec {
            channels: config.channels,
            sample_rate: config.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        },
        buffer,
    });
    Ok(())
}

/// Stops the active recording, writes the WAV and returns its descriptor.
pub fn finish_capture(app: &AppHandle) -> Result<CapturedRecording, String> {
    let state = app.state::<CaptureState>();
    let session = state
        .session
        .lock()
        .map_err(|_| "capture state poisoned")?
        .take();

    let Some(session) = session else {
        return Err("not recording".to_string());
    };

    // Dropping the stream stops the OS capture; do it before the file write so
    // no samples arrive after we snapshot the buffer.
    drop(session.stream);

    let samples = session
        .buffer
        .lock()
        .map_err(|_| "sample buffer poisoned")?
        .clone();

    let path = recording_path(app)?;
    write_wav(&path, &samples, session.spec)?;

    let recording = CapturedRecording {
        path: path.display().to_string(),
        duration_ms: duration_ms(
            samples.len(),
            session.spec.channels,
            session.spec.sample_rate,
        ),
    };
    events::emit(
        app,
        PolarisEvent::AudioCaptured {
            path: recording.path.clone(),
            duration_ms: recording.duration_ms,
        },
    );
    Ok(recording)
}

/// Builds the input stream, converting every supported sample format to i16.
fn record_stream(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    sample_format: cpal::SampleFormat,
    buffer: SampleBuffer,
    max_samples: usize,
) -> Result<cpal::Stream, String> {
    let on_error = |error| eprintln!("polaris: audio stream error: {error}");

    macro_rules! arm {
        ($format:ty, $convert:expr) => {
            device
                .build_input_stream(
                    config.clone(),
                    move |data: &[$format], _: &cpal::InputCallbackInfo| {
                        let mut guard = match buffer.lock() {
                            Ok(guard) => guard,
                            Err(_) => return,
                        };
                        if guard.len() >= max_samples {
                            return; // cap reached, drop further samples
                        }
                        guard.extend(data.iter().map($convert));
                    },
                    on_error,
                    None,
                )
                .map_err(|error| format!("could not build audio stream: {error}"))
        };
    }

    match sample_format {
        cpal::SampleFormat::I16 => arm!(i16, |s: &i16| *s),
        cpal::SampleFormat::F32 => {
            arm!(f32, |s: &f32| (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16)
        }
        cpal::SampleFormat::U16 => arm!(u16, |s: &u16| (*s as i32 - 32_768) as i16),
        other => Err(format!("unsupported sample format: {other:?}")),
    }
}

/// `recordings/` inside the OS app-data dir; created on demand.
fn recording_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("could not resolve app data dir: {error}"))?
        .join("recordings");
    std::fs::create_dir_all(&dir).map_err(|error| format!("could not create {dir:?}: {error}"))?;
    Ok(dir)
}

fn recording_path(app: &AppHandle) -> Result<PathBuf, String> {
    let unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    Ok(recording_dir(app)?.join(format!("polaris-{unix_ms}.wav")))
}

/// Writes 16-bit PCM samples as a WAV file. Separated from `finish_capture`
/// so it can be unit tested without an audio device.
fn write_wav(path: &Path, samples: &[i16], spec: WavSpec) -> Result<(), String> {
    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|error| format!("could not create {path:?}: {error}"))?;
    for sample in samples {
        writer
            .write_sample(*sample)
            .map_err(|error| format!("could not write sample: {error}"))?;
    }
    writer
        .finalize()
        .map_err(|error| format!("could not finalize {path:?}: {error}"))?;
    Ok(())
}

fn duration_ms(samples: usize, channels: u16, sample_rate: u32) -> u64 {
    if channels == 0 || sample_rate == 0 {
        return 0;
    }
    let frames = (samples / usize::from(channels)) as u64;
    frames * 1000 / u64::from(sample_rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(channels: u16, sample_rate: u32) -> WavSpec {
        WavSpec {
            channels,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        }
    }

    #[test]
    fn wav_round_trip() {
        let path = std::env::temp_dir().join(format!("polaris-wav-test-{}.wav", std::process::id()));
        let samples: Vec<i16> = (0..1000).map(|i| (i % 327) as i16).collect();

        write_wav(&path, &samples, spec(1, 16_000)).expect("write wav");

        let mut reader = hound::WavReader::open(&path).expect("read wav back");
        assert_eq!(reader.spec().channels, 1);
        assert_eq!(reader.spec().sample_rate, 16_000);
        assert_eq!(reader.spec().bits_per_sample, 16);
        let round_tripped: Vec<i16> = reader.samples::<i16>().map(Result::unwrap).collect();
        assert_eq!(round_tripped, samples);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn duration_math() {
        assert_eq!(duration_ms(16_000, 1, 16_000), 1_000);
        assert_eq!(duration_ms(96_000, 2, 48_000), 1_000);
        assert_eq!(duration_ms(0, 1, 48_000), 0);
        // Degenerate specs must not panic or divide by zero.
        assert_eq!(duration_ms(100, 0, 0), 0);
    }

    #[test]
    fn captured_recording_serializes_camel_case() {
        let json = serde_json::to_string(&CapturedRecording {
            path: "/tmp/x.wav".into(),
            duration_ms: 1500,
        })
        .unwrap();
        assert_eq!(json, r#"{"path":"/tmp/x.wav","durationMs":1500}"#);
    }
}