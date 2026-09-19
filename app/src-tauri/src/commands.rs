//! Tauri commands — the webview's entry points into the Rust core.

use serde::Serialize;
use tauri::AppHandle;

use crate::events::{self, AgentStage, HotkeyState, PolarisEvent};

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

/// TEMPORARY (step A0 replacement target): stands in for the push-to-talk path so
/// the event stream can be exercised by hand before audio capture exists. Emits a
/// realistic `hotkey -> transcript -> agent_status` sequence and returns it, so a
/// caller can assert on the same data the UI received.
///
/// Delete this command when the global hotkey and microphone are wired.
#[tauri::command]
pub fn dev_self_test(app: AppHandle) -> Vec<PolarisEvent> {
    let events = vec![
        PolarisEvent::Hotkey {
            state: HotkeyState::Down,
        },
        PolarisEvent::Transcript {
            text: "polaris, self test: one two three".to_string(),
            r#final: true,
        },
        PolarisEvent::AgentStatus {
            stage: AgentStage::Thinking,
        },
        PolarisEvent::AgentStatus {
            stage: AgentStage::ToolCall,
        },
        PolarisEvent::AgentStatus {
            stage: AgentStage::Done,
        },
        PolarisEvent::Hotkey {
            state: HotkeyState::Up,
        },
    ];

    for event in &events {
        events::emit(&app, event.clone());
    }
    events
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