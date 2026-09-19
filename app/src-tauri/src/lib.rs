//! Polaris shell — Rust core.
//!
//! Step A0 scope: the notch overlay window, the global push-to-talk gesture,
//! and microphone capture into a WAV plus the typed event stream that drives the
//! overlay. Steps A1–A5 add STT, the agent bridge, speech output, screen capture
//! and the Touch ID signing gate; each one grows this crate, never the seam
//! (`docs/interfaces.md`).

mod capture;
mod commands;
mod env;
mod events;
mod gesture;
mod hotkey;
mod hotkey_flags;
mod notch;
mod stt;
mod types;

use tauri::Manager;

pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, POLARIS_EVENT_NAME};
pub use notch::NotchGeometry;
pub use types::CaptureStatus;

/// Starts the desktop shell. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Local development convenience: a gitignored `.env` at the repo root fills
    // any missing variable. Real environment variables always win, and nothing
    // here is logged beyond the file path.
    env::load();

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::capture_start,
            commands::capture_stop,
            commands::capture_status,
            notch::notch_geometry,
            hotkey::hotkey_permission,
        ])
        .setup(|app| {
            // Captures live under the app data dir so they never land in the repo.
            let recordings_dir = app.path().app_data_dir()?.join("recordings");

            // Step A1: finished captures are queued to a dedicated STT worker.
            // The capture engine only needs the sender; the worker holds a
            // `Capture` clone so it can drive the transcribing/idle/error
            // transitions without blocking the hotkey driver.
            let (ready_tx, ready_rx) = std::sync::mpsc::channel();
            let capture = capture::Capture::new(recordings_dir.clone(), ready_tx);
            let backend = stt::groq::GroqTranscriber::from_env();
            if !backend.has_key() {
                println!(
                    "polaris: GROQ_API_KEY is not set — capture still works, but the overlay \
                     will show \"No STT key\" instead of a transcript. Set it in the environment \
                     or a gitignored .env at the repo root (see .env.example)."
                );
            }
            stt::start(
                app.handle().clone(),
                recordings_dir,
                ready_rx,
                std::sync::Arc::new(backend),
                capture.clone(),
            );
            app.manage(capture);

            // Registers the Control+Option monitor and the Control+Option+Space
            // fallback; both feed the same capture latch.
            hotkey::setup(app)?;

            // Configures AppKit geometry, then reveals the (initially hidden) window.
            notch::setup(app)?;

            println!(
                "polaris: notch overlay ready — hold Control+Option (or Control+Option+Space) \
                 to record; listen on `{POLARIS_EVENT_NAME}`, network={NETWORK}"
            );
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Polaris");

    app.run(|app_handle, event| {
        // The monitors are process-global AppKit objects; unregister them on
        // the main thread before the process goes away.
        if matches!(event, tauri::RunEvent::Exit) {
            hotkey::teardown(app_handle);
        }
    });
}
