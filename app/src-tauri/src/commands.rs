//! Tauri commands — the webview's entry points into the Rust core.

use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::capture::Capture;
use crate::events::{self, PolarisEvent, SpeechState};
use crate::timing;
use crate::tts::{self, Speaker};
use crate::types::CaptureStatus;

/// Testnet only — mainnet is an explicit non-goal (`docs/architecture.md` §1).
pub const NETWORK: &str = "testnet";

/// Metadata rendered in the panel header. Mirrors `AppInfo` in `@polaris/interfaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub network: String,
    pub tauri_version: String,
}

/// Returns build/network metadata for the UI.
#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    AppInfo {
        name: app.package_info().name.clone(),
        version: app.package_info().version.to_string(),
        network: NETWORK.to_string(),
        tauri_version: tauri::VERSION.to_string(),
    }
}

/// Starts a capture on demand (step A0). The global hotkey uses the same engine;
/// this command is the programmatic entry point for the UI and for tests.
#[tauri::command]
pub fn capture_start(app: AppHandle, capture: State<'_, Capture>) -> CaptureStatus {
    capture.start(&app)
}

/// Stops the current capture and returns its final snapshot. Never sends or
/// submits anything — `ready` only means the WAV is on disk.
///
/// Step A11: the programmatic stop opens the same per-turn timing trace the
/// hotkey release does, so a UI-driven capture reports the same breakdown.
#[tauri::command]
pub fn capture_stop(capture: State<'_, Capture>) -> CaptureStatus {
    crate::timing::begin_turn();
    crate::timing::mark("hotkey release");
    capture.stop()
}

/// Snapshot of the capture engine, used by the overlay on startup before the
/// first `capture_status` event arrives.
#[tauri::command]
pub fn capture_status(capture: State<'_, Capture>) -> CaptureStatus {
    capture.status()
}

/// What a successful utterance looked like. Mirrors the latency log line so the
/// UI can show which backend actually spoke (Fish, or local after a fallback).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechOutcome {
    pub backend: String,
    pub latency_ms: u64,
    pub characters: usize,
}

/// A failed utterance. `label` is the short UI-safe copy; `detail` is the full
/// explanation for the log, matching step A1's error split.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechFailure {
    pub label: String,
    pub detail: String,
}

/// Speaks `text` aloud (step A3). Blocking playback can take seconds, so the
/// work is moved to the blocking pool — never the Tauri main thread and never an
/// async worker. The returned latency covers synthesis *and* playback. Failures
/// are also pushed on the event stream as a short `error` label, with the full
/// detail printed to the Rust terminal.
///
/// Step A5: the command brackets the playback with `speech_status` events, so the
/// overlay can show a "Speaking" state for exactly as long as audio is being
/// produced. `Idle` is emitted on **both** the success and the failure path, so a
/// TTS failure can never leave the notch stuck on "Speaking".
///
/// Step A9: `Speaking` is emitted from the backend's **real playback-start**
/// callback, not when the command is dispatched. The Fish synthesis wait (~2–3 s)
/// therefore stays on the previous stage instead of lying about speaking; and if
/// synthesis fails before any audio exists, `Speaking` is never emitted at all.
#[tauri::command]
pub async fn speak(
    app: AppHandle,
    speaker: State<'_, Arc<dyn Speaker>>,
    text: String,
    language: Option<String>,
) -> Result<SpeechOutcome, SpeechFailure> {
    let characters = text.trim().chars().count();
    let language = language
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let backend = Arc::clone(speaker.inner());
    let task_backend = Arc::clone(&backend);
    let started = Instant::now();
    // Step A11: the TTS half of the turn. `tts request sent` is the moment the
    // backend is handed the sentence; `playback start` is emitted from the
    // backend's real playback-start callback (so synthesis time is visible as
    // the gap between them); the block is closed when playback actually ends.
    timing::mark("tts request sent");
    let start_app = app.clone();
    let on_playback_start = move || {
        timing::mark("playback start");
        events::emit(
            &start_app,
            PolarisEvent::SpeechStatus {
                state: SpeechState::Speaking,
            },
        );
    };
    let joined = tauri::async_runtime::spawn_blocking(move || {
        tts::speak_and_log(
            task_backend.as_ref(),
            &text,
            language.as_deref(),
            &on_playback_start,
        )
    })
    .await;
    timing::mark("playback end");
    timing::finish_turn();
    // Playback has ended (or never started): release the overlay before doing
    // anything else, so an unexpected error path still clears the state.
    events::emit(
        &app,
        PolarisEvent::SpeechStatus {
            state: SpeechState::Idle,
        },
    );
    let result = match joined {
        Ok(result) => result,
        Err(error) => Err(tts::TtsError::Local(format!(
            "the speech task did not finish: {error}"
        ))),
    };

    match result {
        Ok(()) => Ok(SpeechOutcome {
            backend: backend.name().to_string(),
            latency_ms: started.elapsed().as_millis() as u64,
            characters,
        }),
        Err(error) => {
            events::emit(
                &app,
                PolarisEvent::Error {
                    message: format!("TTS: {}", error.label()),
                },
            );
            Err(SpeechFailure {
                label: error.label().to_string(),
                detail: error.detail(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_serializes_camel_case() {
        let info = AppInfo {
            name: "Polaris".into(),
            version: "0.1.0".into(),
            network: NETWORK.into(),
            tauri_version: "2.x".into(),
        };
        let json = serde_json::to_string(&info).unwrap();
        assert!(json.contains(r#""tauriVersion":"2.x""#));
    }
}
