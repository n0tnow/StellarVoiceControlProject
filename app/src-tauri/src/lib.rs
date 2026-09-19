//! Polaris shell — Rust core.
//!
//! Step A0 scope: the notch overlay window, the global push-to-talk hotkey, and
//! microphone capture into a WAV plus the typed event stream that drives the
//! overlay. Steps A1–A5 add STT, the agent bridge, speech output, screen capture
//! and the Touch ID signing gate; each one grows this crate, never the seam
//! (`docs/interfaces.md`).

mod capture;
mod commands;
mod events;
mod hotkey;
mod notch;
mod types;

use tauri::Manager;

pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, POLARIS_EVENT_NAME};
pub use notch::NotchGeometry;
pub use types::CaptureStatus;

/// Starts the desktop shell. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::capture_start,
            commands::capture_stop,
            commands::capture_status,
            notch::notch_geometry,
        ])
        .setup(|app| {
            // Captures live under the app data dir so they never land in the repo.
            let recordings_dir = app.path().app_data_dir()?.join("recordings");
            app.manage(capture::Capture::new(recordings_dir));

            app.handle().plugin(
                tauri_plugin_global_shortcut::Builder::new()
                    .with_shortcut(hotkey::shortcut())?
                    .with_handler(|app, _shortcut, event| hotkey::handle(app, event.state))
                    .build(),
            )?;

            // Configures AppKit geometry, then reveals the (initially hidden) window.
            notch::setup(app)?;

            println!(
                "polaris: notch overlay ready — hold Control+Option+Space to record; \
                 listen on `{POLARIS_EVENT_NAME}`, network={NETWORK}"
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Polaris");
}
