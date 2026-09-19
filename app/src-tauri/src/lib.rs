//! Polaris shell — Rust core.
//!
//! Step A0 scope: the notch overlay window, the global push-to-talk gesture,
//! and microphone capture into a WAV plus the typed event stream that drives the
//! overlay. Steps A1–A5 add STT, the agent bridge, speech output, screen capture
//! and the Touch ID signing gate; each one grows this crate, never the seam
//! (`docs/interfaces.md`).

mod agent;
mod capture;
mod commands;
mod env;
mod events;
mod gesture;
mod hotkey;
mod hotkey_flags;
mod notch;
mod stt;
mod timing;
mod tts;
mod types;

use tauri::Manager;

pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, SpeechState, POLARIS_EVENT_NAME};
pub use notch::{NotchActivationPolicy, NotchGeometry, NotchWindowFlags};
pub use types::CaptureStatus;

/// Starts the desktop shell. Called from `main.rs`.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Local development convenience: a gitignored `.env` at the repo root fills
    // any missing variable. Real environment variables always win, and nothing
    // here is logged beyond the file path.
    env::load();

    let mut app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::capture_start,
            commands::capture_stop,
            commands::capture_status,
            commands::speak,
            agent::agent_chat,
            timing::polaris_phase,
            notch::notch_geometry,
            notch::notch_window_flags,
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
            // Backend selection lives in `stt`: on-device by default, Groq only
            // when explicitly requested or as a configured fallback. It logs the
            // choice (and any missing key) itself.
            let backend = stt::build_backend();
            stt::start(
                app.handle().clone(),
                recordings_dir,
                ready_rx,
                backend,
                capture.clone(),
            );
            app.manage(capture);

            // Step A3: text-to-speech. The backend is selected once at startup
            // (Fish Audio with a mandatory local macOS fallback) and shared with
            // the `speak` command through managed state; it logs its choice and
            // any missing config itself.
            app.manage(tts::build_backend());

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

    // Step A15: make Polaris an accessory (agent) app **before the run loop opens
    // the overlay window**. This is the gate that actually lets the overlay float
    // over *another* app's fullscreen Space; the window level and collection
    // behaviour A14 set are necessary but not sufficient (see `notch.rs`).
    apply_activation_policy(&mut app);

    app.run(|app_handle, event| {
        // The monitors are process-global AppKit objects; unregister them on
        // the main thread before the process goes away.
        if matches!(event, tauri::RunEvent::Exit) {
            hotkey::teardown(app_handle);
        }
    });
}

/// macOS: makes Polaris an accessory (`LSUIElement`) app.
///
/// A regular-policy application's windows are **not** layered over another
/// app's fullscreen Space, regardless of window level or collection behaviour —
/// that is what A14's flag-level fix missed. Accessory policy is the documented
/// mechanism overlay utilities use; it also removes the Dock icon and the app
/// menu bar, which a notch companion has no use for.
///
/// The policy must be set here — on the `App` and before `run()` — rather than
/// in the `setup` closure: Tauri creates the config window *before* `setup`
/// runs, and the WindowServer binds the window's Space behaviour when it is
/// created. Setting it in `setup` (as the Tauri docs suggest) would be too late.
/// This path goes through tao's activation-policy state, which is applied at
/// `applicationDidFinishLaunching`, i.e. before the config window is built.
///
/// No-op off macOS, where the crate must still compile.
#[cfg(target_os = "macos")]
fn apply_activation_policy(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}

/// Non-macOS: there is no AppKit activation policy; kept so `run` is identical
/// on every platform.
#[cfg(not(target_os = "macos"))]
fn apply_activation_policy(_app: &mut tauri::App) {}
