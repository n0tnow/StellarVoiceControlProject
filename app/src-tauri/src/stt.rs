//! Speech-to-text (step A1).
//!
//! A finished capture (step A0) is handed to a background worker, which turns the
//! WAV into a transcript and pushes it onto the `polaris-event` stream. The
//! product decision for this step is **cloud first**: Groq's OpenAI-compatible
//! transcription API ([`groq`]) is the only backend wired today, behind the
//! [`Transcriber`] trait so a local whisper.cpp backend can be added later
//! without touching this worker or any call site.
//!
//! Two invariants from A0 carry forward:
//!
//! * Transcription never runs on the Tauri main thread or the audio path. The
//!   worker owns its own thread; the capture thread only drops a message on a
//!   channel and moves on.
//! * A failure is a short overlay label plus a full terminal line, never a panic
//!   and never a wedged engine. The next hold must always work.
//!
//! Retention (raised as MAJOR-3 in the A0 review) also lives here: a recording is
//! deleted once it has been transcribed successfully, and the directory is capped
//! so failed or unattended captures cannot grow without bound. A WAV whose
//! transcription **failed is never deleted** — it is the only copy of the audio.

pub mod groq;
pub mod wav;

use std::path::{Path, PathBuf};
use std::sync::mpsc::Receiver;
use std::sync::Arc;
use std::time::Instant;

use tauri::AppHandle;

use crate::capture::Capture;
use crate::events::{self, PolarisEvent};
use crate::types::CaptureRecording;

/// One recognized utterance. `text` is already trimmed; an all-whitespace
/// result is treated as silence, not as an empty transcript.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transcription {
    pub text: String,
}

/// Everything that can go wrong between "a WAV exists" and "a transcript
/// exists".
///
/// The split between [`Self::label`] and [`Self::detail`] is deliberate: the
/// overlay ear is ~92 pt wide, so it gets a hand-shortened label, while the Rust
/// terminal gets the full explanation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SttError {
    /// `GROQ_API_KEY` is missing. Capture is unaffected; transcription is off.
    MissingKey,
    /// The file could not be read or is not the 16-bit PCM we expect.
    Wav(String),
    /// Zero frames were written.
    Empty,
    /// The recording is long enough but contains no audible signal.
    Silent,
    /// Shorter than [`wav::MIN_DURATION_MS`].
    TooShort { duration_ms: u64 },
    /// Could not reach the provider (DNS, TLS, timeout, connection reset).
    Network(String),
    /// The provider answered with a non-2xx status.
    Http { status: u16, detail: String },
    /// The provider answered 2xx but the body was not the documented shape.
    Malformed(String),
}

impl SttError {
    /// Short, overlay-safe copy. Kept to a handful of characters so it fits the
    /// ear; the label is ellipsised if it ever does not.
    pub fn label(&self) -> &'static str {
        match self {
            Self::MissingKey => "No STT key",
            Self::Wav(_) | Self::Empty => "Bad audio",
            Self::Silent => "No speech",
            Self::TooShort { .. } => "Too short",
            Self::Network(_) => "Net error",
            Self::Http { .. } => "STT error",
            Self::Malformed(_) => "Bad response",
        }
    }

    /// Full terminal message. It must never contain the API key — nothing here
    /// has access to it, which is the point of keeping `MissingKey` a unit-like
    /// variant.
    pub fn detail(&self) -> String {
        match self {
            Self::MissingKey => "GROQ_API_KEY is not set. Set it in the environment \
                 or a gitignored .env at the repo root (see .env.example); capture \
                 still works, but nothing will be transcribed."
                .to_string(),
            Self::Wav(message) => message.clone(),
            Self::Empty => "the recording contains no audio frames".to_string(),
            Self::Silent => "the recording is silent (no signal above the noise floor)".to_string(),
            Self::TooShort { duration_ms } => format!(
                "the recording is only {duration_ms} ms; at least {} ms is required",
                wav::MIN_DURATION_MS
            ),
            Self::Network(message) => format!("could not reach the transcription service: {message}"),
            Self::Http { status, detail } => {
                format!("the transcription service returned HTTP {status}: {detail}")
            }
            Self::Malformed(message) => format!("could not read the transcription response: {message}"),
        }
    }
}

/// The backend seam.
///
/// Implementations must be blocking and self-contained; the worker runs them on a
/// dedicated thread. Adding a local whisper.cpp backend means implementing this
/// trait and constructing it in `lib.rs` — no call site changes.
pub trait Transcriber: Send + Sync {
    fn transcribe(&self, wav: &Path) -> Result<Transcription, SttError>;
}

/// Pre-flight validation plus the backend call.
///
/// The WAV checks are backend-independent (a local model wants 300 ms of signal
/// just as much as the cloud does), so they live here rather than inside one
/// provider. Keeping this a free function over an injected backend is what makes
/// the contract testable without a network.
pub fn transcribe_verified(
    backend: &dyn Transcriber,
    wav: &Path,
) -> Result<Transcription, SttError> {
    wav::validate(wav)?;
    backend.transcribe(wav)
}

/// Starts the STT worker. Returns immediately; all work happens on the new
/// thread. A failure to spawn is logged, not fatal — capture keeps working and
/// the overlay simply never leaves `ready`.
pub fn start(
    app: AppHandle,
    recordings_dir: PathBuf,
    captures: Receiver<CaptureRecording>,
    backend: Arc<dyn Transcriber>,
    capture: Capture,
) {
    let spawned = std::thread::Builder::new()
        .name("polaris-stt".into())
        .spawn(move || {
            for recording in captures {
                handle(&app, &recordings_dir, backend.as_ref(), &capture, recording);
            }
        });
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the STT worker: {error}");
    }
}

/// Handles one finished capture: validate, transcribe, report, then clean up.
fn handle(
    app: &AppHandle,
    recordings_dir: &Path,
    backend: &dyn Transcriber,
    capture: &Capture,
    recording: CaptureRecording,
) {
    // Latency is measured from the moment the capture finished (the worker
    // receives it as soon as the capture thread has written the WAV) to the
    // moment the transcript is about to be emitted.
    let started = Instant::now();
    capture.mark_transcribing(app, &recording);

    let outcome = transcribe_verified(backend, Path::new(&recording.path));
    let elapsed_ms = started.elapsed().as_millis();

    match outcome {
        Ok(transcription) => {
            println!(
                "polaris: transcript in {elapsed_ms} ms (audio {} ms): {}",
                recording.duration_ms, transcription.text
            );
            capture.mark_transcribed(app);
            events::emit(
                app,
                PolarisEvent::Transcript {
                    text: transcription.text,
                    r#final: true,
                },
            );
            // Success is the only path that deletes the WAV: once the text is
            // out, the audio has served its purpose.
            if let Err(error) = std::fs::remove_file(&recording.path) {
                eprintln!(
                    "polaris: could not delete the transcribed recording {}: {error}",
                    recording.path
                );
            }
        }
        Err(error) => {
            eprintln!(
                "polaris: transcription failed [{}] after {elapsed_ms} ms: {}",
                error.label(),
                error.detail()
            );
            // The WAV is kept: it is the only copy of audio the user cannot
            // recreate, and a retry (today, a manual one) may still need it.
            capture.mark_transcription_failed(app, error.label(), &error.detail());
        }
    }

    // Cap unattended/failed recordings. The just-failed file is the newest, so a
    // cap >= 1 always keeps it.
    wav::prune_recordings(recordings_dir, wav::MAX_RECORDINGS);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A backend whose answer is scripted, so the pre-flight + backend contract
    /// is testable with no network.
    struct FakeTranscriber {
        result: Mutex<Option<Result<Transcription, SttError>>>,
        calls: Mutex<usize>,
    }

    impl FakeTranscriber {
        fn returning(result: Result<Transcription, SttError>) -> Self {
            Self {
                result: Mutex::new(Some(result)),
                calls: Mutex::new(0),
            }
        }
    }

    impl Transcriber for FakeTranscriber {
        fn transcribe(&self, _wav: &Path) -> Result<Transcription, SttError> {
            *self.calls.lock().unwrap() += 1;
            self.result
                .lock()
                .unwrap()
                .take()
                .expect("the fake transcriber was called twice")
        }
    }

    fn write_wav(path: &Path, peak: i16, frames: u32, sample_rate: u32) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(path, spec).unwrap();
        for frame in 0..frames {
            // A non-silent tone whose peak is controlled by `peak`.
            let sample = if frame % 2 == 0 { peak } else { -peak };
            writer.write_sample(sample).unwrap();
        }
        writer.finalize().unwrap();
    }

    fn scratch(label: &str) -> PathBuf {
        crate::env::temp_dir(label)
    }

    #[test]
    fn silent_audio_is_rejected_before_the_backend_is_called() {
        let dir = scratch("stt-silent");
        let wav = dir.join("silent.wav");
        write_wav(&wav, 0, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "should not be reached".into(),
        }));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::Silent)
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_short_recording_is_rejected_before_the_backend_is_called() {
        let dir = scratch("stt-short");
        let wav = dir.join("short.wav");
        // 100 ms of loud audio: long enough to be audible, too short to trust.
        write_wav(&wav, 8_000, 1_600, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription { text: "hi".into() }));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::TooShort { duration_ms: 100 })
        );
        assert_eq!(*backend.calls.lock().unwrap(), 0);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn valid_audio_reaches_the_backend_and_its_result_is_returned() {
        let dir = scratch("stt-ok");
        let wav = dir.join("ok.wav");
        write_wav(&wav, 8_000, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Ok(Transcription {
            text: "send 10 usdc to ada".into(),
        }));
        let result = transcribe_verified(&backend, &wav).unwrap();
        assert_eq!(result.text, "send 10 usdc to ada");
        assert_eq!(*backend.calls.lock().unwrap(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_backend_failure_is_propagated_unchanged() {
        let dir = scratch("stt-fail");
        let wav = dir.join("ok.wav");
        write_wav(&wav, 8_000, 16_000, 16_000);

        let backend = FakeTranscriber::returning(Err(SttError::MissingKey));
        assert_eq!(
            transcribe_verified(&backend, &wav),
            Err(SttError::MissingKey)
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn every_error_has_a_short_label_and_a_self_contained_detail() {
        let errors = [
            SttError::MissingKey,
            SttError::Wav("unreadable".into()),
            SttError::Empty,
            SttError::Silent,
            SttError::TooShort { duration_ms: 12 },
            SttError::Network("timeout".into()),
            SttError::Http {
                status: 401,
                detail: "unauthorized".into(),
            },
            SttError::Malformed("no text field".into()),
        ];
        for error in errors {
            let label = error.label();
            assert!(!label.is_empty() && label.len() <= 16, "label: {label}");
            assert!(!error.detail().is_empty());
        }
    }
}
