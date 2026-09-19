//! Polaris shell — Rust core.
//!
//! Skeleton scope: the window, the typed event stream to the UI, and app
//! metadata. Steps A0–A5 add audio capture, STT, the agent bridge, screen capture
//! and the Touch ID signing gate; each one grows this crate, never the seam
//! (`docs/interfaces.md`).

mod commands;
mod events;
mod types;

pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, POLARIS_EVENT_NAME};

/// Starts the desktop shell. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::dev_self_test
        ])
        .setup(|_app| {
            println!(
                "polaris: shell ready (skeleton) — listen for `{POLARIS_EVENT_NAME}` in the UI, network={NETWORK}"
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Polaris");
}