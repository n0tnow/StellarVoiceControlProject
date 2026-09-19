//! Polaris shell — Rust core.
//!
//! Step A0 scope: window, typed event stream, **global push-to-talk hotkey** and
//! **microphone capture to WAV**. Steps A1–A5 add STT, the agent bridge, screen
//! capture and the Touch ID signing gate; each grows this crate, never the seam
//! (`docs/interfaces.md`).

mod audio;
mod commands;
mod events;
mod types;

pub use audio::{CaptureState, DEFAULT_HOTKEY};
pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, POLARIS_EVENT_NAME};

use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// Starts the desktop shell. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::capture_start,
            commands::capture_stop
        ])
        .setup(|app| {
            // Push-to-talk: key down starts the recording, key up stops it and
            // writes the WAV (emitting `hotkey` + `audio_captured` events).
            app.handle().global_shortcut().on_shortcut(
                DEFAULT_HOTKEY,
                |app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        events::emit(app, PolarisEvent::Hotkey { state: HotkeyState::Down });
                        if let Err(error) = audio::begin_capture(app) {
                            events::emit(app, PolarisEvent::Error { message: error });
                        }
                    } else {
                        events::emit(app, PolarisEvent::Hotkey { state: HotkeyState::Up });
                        if let Err(error) = audio::finish_capture(app) {
                            // A quick tap can release without a recording; that is
                            // not an error worth surfacing in the UI.
                            if !error.contains("not recording") {
                                events::emit(app, PolarisEvent::Error { message: error });
                            }
                        }
                    }
                },
            )?;

            println!(
                "polaris: shell ready — hotkey `{DEFAULT_HOTKEY}` (hold to talk), \
                 events on `{POLARIS_EVENT_NAME}`, network={NETWORK}"
            );
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Polaris");
}