//! Tauri commands — the webview's entry points into the Rust core.

use serde::Serialize;
use tauri::AppHandle;

use crate::audio::{self, CapturedRecording};

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

/// Starts microphone capture. Mirrors what the global hotkey's key-down does,
/// so the on-screen button is a first-class fallback for the hotkey.
#[tauri::command]
pub fn capture_start(app: AppHandle) -> Result<(), String> {
    audio::begin_capture(&app)
}

/// Stops microphone capture and returns the written WAV file.
#[tauri::command]
pub fn capture_stop(app: AppHandle) -> Result<CapturedRecording, String> {
    audio::finish_capture(&app)
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