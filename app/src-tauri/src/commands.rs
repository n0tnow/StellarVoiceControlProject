//! Tauri commands — the webview's entry points into the Rust core.

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::capture::Capture;
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
#[tauri::command]
pub fn capture_stop(capture: State<'_, Capture>) -> CaptureStatus {
    capture.stop()
}

/// Snapshot of the capture engine, used by the overlay on startup before the
/// first `capture_status` event arrives.
#[tauri::command]
pub fn capture_status(capture: State<'_, Capture>) -> CaptureStatus {
    capture.status()
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
