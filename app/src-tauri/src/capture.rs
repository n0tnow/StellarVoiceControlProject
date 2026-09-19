//! Push-to-talk microphone capture (step A0).
//!
//! Design constraints that shape this module:
//!
//! * `cpal::Stream` is created, played and dropped on one dedicated thread. That
//!   keeps the realtime callback off the UI/main thread and sidesteps `Stream`'s
//!   per-platform `Send` guarantees instead of relying on them.
//! * The state machine is the single source of truth for the overlay: every
//!   transition is pushed as a `PolarisEvent::CaptureStatus`, and `stop` waits
//!   (briefly) for the worker so the released hotkey yields a final `ready`.
//! * Release never sends anything: `ready` only means a WAV is on disk.
//! * Failures are values (`Inner::Error`), never panics: a denied microphone
//!   permission must show up in the overlay, not crash the shell.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::AppHandle;

use crate::events::{self, PolarisEvent};
use crate::types::{CaptureRecording, CaptureState, CaptureStatus};

/// How long `stop` waits for the worker to finalize the WAV before returning the
/// in-flight snapshot. Finalization is normally milliseconds; the cap only
/// exists so a wedged audio driver cannot block the hotkey handler.
const STOP_TIMEOUT: Duration = Duration::from_millis(1500);

/// The `recordings/` directory is created at startup and lives under the app's
/// data dir, so captures never land in the repository.
pub struct Capture {
    shared: Arc<Shared>,
}

struct Shared {
    inner: Mutex<Inner>,
    /// Signalled by the worker once the WAV is finalized (or failed).
    finished: Condvar,
    recordings_dir: PathBuf,
    sequence: AtomicU64,
}

enum Inner {
    Idle,
    Recording(Active),
    Ready(CaptureRecording),
    Error(String),
}

struct Active {
    /// Sending on this channel is what ends the recording.
    stop: std::sync::mpsc::Sender<()>,
}

impl Capture {
    pub fn new(recordings_dir: PathBuf) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner::Idle),
                finished: Condvar::new(),
                recordings_dir,
                sequence: AtomicU64::new(0),
            }),
        }
    }

    /// Current snapshot. Cheap and lock-guarded; safe from any thread.
    pub fn status(&self) -> CaptureStatus {
        let guard = self.shared.inner.lock().unwrap_or_else(|error| error.into_inner());
        snapshot(&guard)
    }

    /// Starts a capture. Idempotent while already recording (the push-to-talk
    /// handler may fire repeat presses). Emits the `recording` snapshot.
    pub fn start(&self, app: &AppHandle) -> CaptureStatus {
        let mut guard = self.shared.inner.lock().unwrap_or_else(|error| error.into_inner());
        if matches!(*guard, Inner::Recording(_)) {
            return snapshot(&guard);
        }

        let path = self.next_path();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel();
        *guard = Inner::Recording(Active { stop: stop_tx });
        let status = snapshot(&guard);
        drop(guard);

        events::emit(app, PolarisEvent::CaptureStatus { status: status.clone() });

        let shared = Arc::clone(&self.shared);
        let app = app.clone();
        std::thread::spawn(move || finish_capture(shared, app, path, stop_rx));
        status
    }

    /// Ends the current capture and returns the final snapshot. A no-op when not
    /// recording. Emitting is left to the worker so callers can be synchronous.
    pub fn stop(&self) -> CaptureStatus {
        {
            let guard = self.shared.inner.lock().unwrap_or_else(|error| error.into_inner());
            match &*guard {
                Inner::Recording(active) => {
                    let _ = active.stop.send(());
                }
                _ => return snapshot(&guard),
            }
        }

        let deadline = Instant::now() + STOP_TIMEOUT;
        let mut guard = self.shared.inner.lock().unwrap_or_else(|error| error.into_inner());
        while matches!(*guard, Inner::Recording(_)) {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let (next, _) = self
                .shared
                .finished
                .wait_timeout(guard, deadline - now)
                .unwrap_or_else(|error| error.into_inner());
            guard = next;
        }
        snapshot(&guard)
    }

    fn next_path(&self) -> PathBuf {
        let sequence = self.shared.sequence.fetch_add(1, Ordering::Relaxed);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis())
            .unwrap_or_default();
        self.shared
            .recordings_dir
            .join(format!("polaris-{stamp}-{sequence}.wav"))
    }
}

fn snapshot(inner: &Inner) -> CaptureStatus {
    match inner {
        Inner::Idle => CaptureStatus {
            state: CaptureState::Idle,
            recording: None,
            error: None,
        },
        Inner::Recording(_) => CaptureStatus {
            state: CaptureState::Recording,
            recording: None,
            error: None,
        },
        Inner::Ready(recording) => CaptureStatus {
            state: CaptureState::Ready,
            recording: Some(recording.clone()),
            error: None,
        },
        Inner::Error(error) => CaptureStatus {
            state: CaptureState::Error,
            recording: None,
            error: Some(error.clone()),
        },
    }
}

/// Runs on the capture thread: opens the microphone, records until `stop`
/// fires, finalizes the WAV, then updates the shared state and emits events.
fn finish_capture(
    shared: Arc<Shared>,
    app: AppHandle,
    path: PathBuf,
    stop: std::sync::mpsc::Receiver<()>,
) {
    let outcome = record_to_wav(&path, stop);

    let status = {
        let mut guard = shared.inner.lock().unwrap_or_else(|error| error.into_inner());
        *guard = match outcome {
            Ok(duration_ms) => Inner::Ready(CaptureRecording {
                path: path.to_string_lossy().into_owned(),
                duration_ms,
            }),
            Err(error) => {
                eprintln!("polaris: capture failed: {error}");
                // Do not leave a truncated WAV behind for step A1 to trip over.
                let _ = std::fs::remove_file(&path);
                Inner::Error(error)
            }
        };
        snapshot(&guard)
    };
    shared.finished.notify_all();

    if let Some(recording) = &status.recording {
        events::emit(
            &app,
            PolarisEvent::AudioCaptured {
                path: recording.path.clone(),
                duration_ms: recording.duration_ms,
            },
        );
    }
    events::emit(&app, PolarisEvent::CaptureStatus { status });
}

/// Opens the default input device and blocks until `stop` receives a value.
/// Returns the capture duration in milliseconds, measured in written frames.
fn record_to_wav(path: &Path, stop: std::sync::mpsc::Receiver<()>) -> Result<u64, String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "no default input device is available".to_string())?;
    let supported = device.default_input_config().map_err(|error| {
        format!("the default input device has no usable configuration: {error}")
    })?;

    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.config();
    let channels = u64::from(config.channels).max(1);
    let sample_rate = u64::from(config.sample_rate).max(1);

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }

    let spec = hound::WavSpec {
        channels: config.channels,
        sample_rate: config.sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let writer = hound::WavWriter::create(path, spec)
        .map_err(|error| format!("could not create {}: {error}", path.display()))?;

    let writer = Arc::new(Mutex::new(Some(writer)));
    let samples = Arc::new(AtomicU64::new(0));
    let failure = Arc::new(Mutex::new(None));

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            build_stream::<f32>(&device, config, writer.clone(), samples.clone(), failure.clone())
        }
        cpal::SampleFormat::I16 => {
            build_stream::<i16>(&device, config, writer.clone(), samples.clone(), failure.clone())
        }
        cpal::SampleFormat::U16 => {
            build_stream::<u16>(&device, config, writer.clone(), samples.clone(), failure.clone())
        }
        other => Err(format!("unsupported microphone sample format: {other:?}")),
    }?;

    stream
        .play()
        .map_err(|error| format!("could not start the microphone stream: {error}"))?;

    // Block the capture thread until the hotkey is released. `recv` also returns
    // early if the sender is dropped (the recording was replaced), so the thread
    // can never leak.
    let _ = stop.recv();
    // Dropping the stream stops the callbacks before we touch the writer.
    drop(stream);

    let writer = writer.lock().unwrap_or_else(|error| error.into_inner()).take();
    if let Some(writer) = writer {
        writer
            .finalize()
            .map_err(|error| format!("could not finalize {}: {error}", path.display()))?;
    }

    if let Some(error) = failure.lock().unwrap_or_else(|error| error.into_inner()).take() {
        return Err(error);
    }

    let frames = samples.load(Ordering::Relaxed) / channels;
    Ok(frames * 1000 / sample_rate)
}

/// Builds the input stream for one cpal sample type, normalizing everything to
/// 16-bit PCM — the format every later STT step (A1, whisper.cpp) expects.
fn build_stream<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    writer: Arc<Mutex<Option<hound::WavWriter<std::io::BufWriter<std::fs::File>>>>>,
    samples: Arc<AtomicU64>,
    failure: Arc<Mutex<Option<String>>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample,
    i16: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;
    // `from_sample` comes from the re-exported `Sample` trait.
    use cpal::Sample;

    let data_failure = Arc::clone(&failure);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                samples.fetch_add(data.len() as u64, Ordering::Relaxed);
                let mut guard = writer.lock().unwrap_or_else(|error| error.into_inner());
                if let Some(writer) = guard.as_mut() {
                    for &sample in data {
                        let value = i16::from_sample(sample);
                        if let Err(error) = writer.write_sample(value) {
                            *data_failure.lock().unwrap_or_else(|e| e.into_inner()) =
                                Some(format!("could not write audio samples: {error}"));
                            guard.take();
                            return;
                        }
                    }
                }
            },
            move |error| {
                *failure.lock().unwrap_or_else(|e| e.into_inner()) =
                    Some(format!("audio stream error: {error}"));
            },
            None,
        )
        .map_err(|error| format!("could not start the microphone stream: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_capture_reports_idle_and_stop_is_a_noop() {
        let capture = Capture::new(PathBuf::from("/tmp/polaris-tests"));
        assert_eq!(
            capture.status(),
            CaptureStatus {
                state: CaptureState::Idle,
                recording: None,
                error: None,
            }
        );
        // Stopping while idle must not deadlock or change the state.
        assert_eq!(capture.stop().state, CaptureState::Idle);
    }

    #[test]
    fn snapshot_maps_every_state_to_the_wire_shape() {
        let ready = CaptureRecording {
            path: "/tmp/polaris.wav".into(),
            duration_ms: 42,
        };
        assert_eq!(
            snapshot(&Inner::Ready(ready.clone())).recording,
            Some(ready)
        );
        assert_eq!(
            snapshot(&Inner::Error("denied".into())).error.as_deref(),
            Some("denied")
        );
        assert_eq!(
            snapshot(&Inner::Recording(Active {
                stop: std::sync::mpsc::channel().0,
            }))
            .state,
            CaptureState::Recording
        );
    }

    #[test]
    fn generated_paths_are_unique_and_under_the_recordings_dir() {
        let capture = Capture::new(PathBuf::from("/tmp/polaris-tests"));
        let first = capture.next_path();
        let second = capture.next_path();
        assert_ne!(first, second);
        assert_eq!(first.parent(), Some(Path::new("/tmp/polaris-tests")));
        assert_eq!(first.extension().and_then(|ext| ext.to_str()), Some("wav"));
    }
}
