//! Polaris shell — Rust core.
//!
//! Step A0 scope: the notch overlay window, the global push-to-talk gesture,
//! and microphone capture into a WAV plus the typed event stream that drives the
//! overlay. Steps A1–A5 add STT, the agent bridge, speech output, screen capture
//! and the Touch ID signing gate; each one grows this crate, never the seam
//! (`docs/interfaces.md`).

mod agent;
mod approval;
mod biometric;
mod bridge;
mod capture;
mod commands;
mod ctrl_tap;
mod env;
mod events;
mod gesture;
mod health;
mod hotkey;
mod hotkey_flags;
mod notch;
mod onboarding;
mod panels;
mod stellar_config;
mod stt;
mod timing;
mod tts;
mod tx_events;
mod types;
mod voice_health;
mod weblog;

use tauri::{AppHandle, Manager};

pub use commands::{AppInfo, NETWORK};
pub use events::{AgentStage, HotkeyState, PolarisEvent, SpeechState, POLARIS_EVENT_NAME};
pub use notch::{NotchActivationPolicy, ShellGeometry};
pub use panels::{PanelError, PanelSpec, PANELS};
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
            commands::quit_app,
            commands::capture_start,
            commands::capture_stop,
            commands::capture_status,
            commands::speak,
            agent::agent_chat,
            timing::polaris_phase,
            notch::notch_geometry,
            notch::shell_request_state,
            notch::shell_commit_state,
            notch::shell_resize_content,
            notch::notch_hover_health,
            notch::notch_simulate_hover,
            hotkey::hotkey_permission,
            panels::open_panel,
            // First-run onboarding: the focusable window, the permission probes
            // and prompts, the System Settings deep links and the marker file
            // (see `onboarding.rs`).
            onboarding::onboarding_state,
            onboarding::onboarding_open,
            onboarding::onboarding_close,
            onboarding::onboarding_complete,
            onboarding::onboarding_reset,
            onboarding::onboarding_permissions,
            onboarding::onboarding_request_microphone,
            onboarding::onboarding_request_accessibility,
            onboarding::onboarding_open_settings,
            stellar_config::stellar_config,
            approval::approval_begin,
            approval::approval_authorize,
            approval::approval_deny,
            approval::approval_status,
            approval::approval_current,
            health::biometric_health,
            health::biometric_selftest,
            voice_health::voice_health,
            tx_events::tx_submitted_emit,
            // Task F4: one webview log line in the terminal, optionally mirrored
            // onto the `error` event the Debug panel renders.
            weblog::polaris_log,
            bridge::commands::bridge_sign,
            bridge::commands::bridge_selftest,
            bridge::commands::bridge_health,
            bridge::commands::bridge_sign_challenge,
            bridge::commands::anchor_signing_health,
        ])
        // Step W0: a panel's close button hides it instead of quitting the app
        // (the overlay's `main` window is never closed, so the close handler is
        // only ever about panels).
        //
        // Hover fix: opening a panel calls `set_focus`, which activates this
        // accessory app, and macOS pauses the global `mouseMoved` monitor while
        // we are active — so hover expansion went dead after any panel/approval
        // interaction. Once the last panel is hidden, resign active to hand
        // focus back and resume the monitor.
        .on_window_event(|window, event| {
            panels::handle_window_event(window, event);
            onboarding::handle_window_event(window, event);
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let label = window.label();
                if panels::is_panel_label(label) || onboarding::is_onboarding_label(label) {
                    resign_after_interactive_close(window.app_handle(), label);
                }
            }
        })
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

            // Step W3: the Touch ID approval gate. The store holds the one
            // pending approval that may be released to the Freighter bridge;
            // the authenticator is the real LocalAuthentication prompt (a fake
            // is used only in tests).
            app.manage(approval::ApprovalStore::new());
            app.manage(biometric::system());

            // Step W4b: the browser launcher for the Freighter signing bridge.
            // Managed as a trait object so tests can install a fake and never
            // open a real browser.
            app.manage(bridge::commands::system_launcher());

            // Registers the Control+Option monitor and the Control+Option+Space
            // fallback; both feed the same capture latch.
            hotkey::setup(app)?;

            // Configures AppKit geometry, reveals the (initially hidden) window,
            // and registers the double-Control detector that proposes the folded
            // `prompt` shell state.
            notch::setup(app)?;

            // First run: show the centered onboarding window when the stored
            // marker is missing or from an older onboarding version. It is the
            // only interactive window Polaris opens without a user gesture.
            //
            // Non-fatal on purpose: onboarding is not essential, and a
            // transient window-server failure on a fresh install must not stop
            // Polaris from starting. A failed open just means the user can
            // re-run it from the same command later.
            if let Err(error) = onboarding::open_if_needed(app.handle()) {
                eprintln!("polaris: could not open first-run onboarding: {error}");
            }

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
        // the main thread before the process goes away. The overlay also drops
        // back to click-through so a dying process never strands an
        // interactive window over the desktop.
        match event {
            tauri::RunEvent::Exit => {
                hotkey::teardown(app_handle);
                notch::teardown(app_handle);
            }
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed,
                ..
            } => notch::teardown(app_handle),
            // The click-through watchdog must not collapse a prompt the user is
            // actively typing into, so it needs to know whether our window is
            // the key window. Losing focus re-arms the watchdog immediately.
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Focused(focused),
                ..
            } => notch::set_focused(app_handle, focused),
            _ => {}
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

/// Whether any interactive window other than `closing` is still visible.
///
/// Panels and the onboarding window both activate this accessory app when they
/// open, which pauses the global `mouseMoved` monitor the hover feature needs.
/// The app must therefore stay active while one of them is still up, and only
/// the last one to hide hands focus back ([`notch::resign_active`]).
fn any_other_interactive_visible(app: &AppHandle, closing: &str) -> bool {
    let panel_visible = panels::PANELS.iter().any(|spec| {
        spec.label != closing
            && app
                .get_webview_window(spec.label)
                .and_then(|panel| panel.is_visible().ok())
                .unwrap_or(false)
    });
    panel_visible || (closing != onboarding::WINDOW_LABEL && onboarding::is_visible(app))
}

/// Resigns Polaris from the active state when `closing` was the last interactive
/// window.
///
/// Shared by the window-event callback (a panel or the onboarding close button)
/// and the onboarding commands, which hide the window without raising a window
/// event. `closing` is always a panel label or [`onboarding::WINDOW_LABEL`]; the
/// helper only checks whether any *other* interactive window remains.
pub(crate) fn resign_after_interactive_close(app: &AppHandle, closing: &str) {
    if any_other_interactive_visible(app, closing) {
        return;
    }
    if let Err(error) = notch::resign_active(app) {
        eprintln!("polaris: could not resign active after an interactive window closed: {error}");
    }
}
