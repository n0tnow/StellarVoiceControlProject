//! Global push-to-talk triggers and the shared capture state machine.
//!
//! Two triggers feed the **same** latch (step A0 follow-up):
//!
//! * **Control+Option hold** — the product default. Recording starts while both
//!   are held (after a short arming delay) and stops as soon as **either** is
//!   released. Observed natively via `flagsChanged` (see [`crate::hotkey_flags`]).
//! * **Control+Option+Space** — a permanent secondary trigger. It needs no
//!   permissions, so it is the whole UX before Accessibility is granted and the
//!   accessible alternative for VoiceOver users (Control+Option is VoiceOver's
//!   default modifier).
//!
//! The AppKit monitor callbacks only push samples into a channel; a dedicated
//! driver thread owns [`Latch`] and applies the resulting `start`/`stop` to the
//! capture engine. That keeps the event callbacks minimal and means the
//! blocking WAV finalization never runs on the main thread.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::capture::Capture;
use crate::events::{self, HotkeyState, PolarisEvent};
use crate::gesture::{Action, Latch, ModifierSample, DRIVER_TICK, WATCHDOG_INTERVAL};
use crate::hotkey_flags::{self, FlagsMonitor};
use crate::timing;

/// One input for the driver's state machine.
enum Input {
    /// A masked `flagsChanged` sample.
    Modifiers(ModifierSample),
    /// Control+Option+Space pressed (`true`) or released.
    Shortcut(bool),
}

/// App-lifetime state: the two monitor tokens and the trust flag. Also owns the
/// channel sender the shortcut handler uses to reach the driver thread.
pub struct HotkeyRuntime {
    /// Dropping these unregisters the `flagsChanged` monitors — they must live
    /// as long as the app.
    monitor: Mutex<Option<FlagsMonitor>>,
    /// `None` only between construction and [`setup`]; the plugin handler can
    /// in principle fire very early.
    inputs: Mutex<Option<Sender<Input>>>,
    /// Accessibility trust; polled, never derived from a prompt's return value.
    trusted: Arc<AtomicBool>,
}

/// The always-available fallback shortcut, kept typed so the registration and
/// the UI copy cannot drift apart.
pub fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Installs the modifier monitors and the fallback shortcut, then starts the
/// driver thread. Called from `tauri::Builder::setup`, i.e. on the main thread,
/// which is where AppKit requires the monitors to be registered.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let trusted = hotkey_flags::is_trusted();
    if !trusted {
        // First run (or after a TCC reset): raise the standard system consent
        // dialog. It is non-modal and asynchronous, and its return value must
        // not be trusted — the watchdog polls `AXIsProcessTrusted()` and flips
        // the gesture on the moment the user grants access.
        let _ = hotkey_flags::prompt_for_trust();
    }

    let trusted = Arc::new(AtomicBool::new(trusted));
    let (sender, receiver) = std::sync::mpsc::channel::<Input>();

    let monitor = hotkey_flags::install({
        let sender = sender.clone();
        move |sample: ModifierSample| {
            let _ = sender.send(Input::Modifiers(sample));
        }
    });
    if monitor.is_none() {
        eprintln!(
            "polaris: flagsChanged monitor unavailable; \
             the Control+Option gesture is disabled, Control+Option+Space still works"
        );
    }

    app.manage(HotkeyRuntime {
        monitor: Mutex::new(monitor),
        inputs: Mutex::new(Some(sender)),
        trusted: Arc::clone(&trusted),
    });

    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_shortcut(shortcut())
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?
        .with_handler(|app, _shortcut, event| handle_shortcut(app, event.state))
        .build();
    app.handle().plugin(plugin)?;

    events::emit(
        app.handle(),
        PolarisEvent::HotkeyPermission {
            trusted: trusted.load(Ordering::Relaxed),
        },
    );
    spawn_driver(app.handle().clone(), receiver, trusted);
    Ok(())
}

/// Routes a shortcut press/release into the driver thread. Called from the
/// plugin handler; keeping it to a channel send keeps the handler cheap.
pub fn handle_shortcut(app: &AppHandle, state: ShortcutState) {
    let Some(runtime) = app.try_state::<HotkeyRuntime>() else {
        return;
    };
    let Ok(guard) = runtime.inputs.lock() else {
        return;
    };
    if let Some(sender) = guard.as_ref() {
        let _ = sender.send(Input::Shortcut(matches!(state, ShortcutState::Pressed)));
    }
}

/// Unregisters the monitors. Runs on the main thread from the run-loop exit
/// callback; AppKit monitor removal is main-thread only.
pub fn teardown(app: &AppHandle) {
    let Some(runtime) = app.try_state::<HotkeyRuntime>() else {
        return;
    };
    let Ok(mut guard) = runtime.monitor.lock() else {
        return;
    };
    if let Some(monitor) = guard.take() {
        hotkey_flags::remove(&monitor);
    }
}

/// Accessibility trust for the modifier-only gesture, for the UI's first paint.
#[tauri::command]
pub fn hotkey_permission(app: AppHandle) -> bool {
    match app.try_state::<HotkeyRuntime>() {
        Some(runtime) => runtime.trusted.load(Ordering::Relaxed),
        None => hotkey_flags::is_trusted(),
    }
}

fn spawn_driver(app: AppHandle, receiver: Receiver<Input>, trusted: Arc<AtomicBool>) {
    let spawned = std::thread::Builder::new()
        .name("polaris-hotkey".into())
        .spawn(move || driver_loop(app, receiver, trusted));
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the hotkey driver: {error}");
    }
}

fn driver_loop(app: AppHandle, receiver: Receiver<Input>, trusted: Arc<AtomicBool>) {
    let mut latch = Latch::default();
    let mut last_watchdog = Instant::now();

    loop {
        match receiver.recv_timeout(DRIVER_TICK) {
            Ok(Input::Modifiers(sample)) => {
                // Without Accessibility trust the modifier-only gesture is dead
                // by design (the global monitor cannot see other apps); ignore
                // samples rather than half-working only while focused.
                if trusted.load(Ordering::Relaxed) {
                    let actions = latch.on_modifiers(sample, Instant::now());
                    apply(&app, actions);
                }
            }
            Ok(Input::Shortcut(pressed)) => {
                // Explicit and permission-free: always applied.
                let actions = latch.on_shortcut(pressed);
                apply(&app, actions);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }

        if trusted.load(Ordering::Relaxed) {
            let actions = latch.tick(Instant::now());
            apply(&app, actions);
        }

        if last_watchdog.elapsed() >= WATCHDOG_INTERVAL {
            last_watchdog = Instant::now();
            let now_trusted = hotkey_flags::is_trusted();
            let previous = trusted.swap(now_trusted, Ordering::Relaxed);
            if previous != now_trusted {
                events::emit(
                    &app,
                    PolarisEvent::HotkeyPermission {
                        trusted: now_trusted,
                    },
                );
            }
            if now_trusted {
                let sample = hotkey_flags::current_sample();
                let actions = latch.watchdog(sample, Instant::now());
                apply(&app, actions);
            } else {
                // Trust lost mid-recording: never leave the gesture capture on.
                let actions = latch.reset_modifiers();
                apply(&app, actions);
            }
        }
    }
}

/// Applies latch transitions to the capture engine and mirrors them on the
/// event stream. `start` is idempotent in the engine; the latch only emits an
/// action on a real transition, so Down/Up stay balanced.
fn apply(app: &AppHandle, actions: Vec<Action>) {
    if actions.is_empty() {
        return;
    }
    let capture = app.state::<Capture>();
    for action in actions {
        match action {
            Action::Start => {
                events::emit(app, PolarisEvent::Hotkey { state: HotkeyState::Down });
                capture.start(app);
            }
            Action::Stop => {
                events::emit(app, PolarisEvent::Hotkey { state: HotkeyState::Up });
                // Step A11: the release is the start of the measured turn.
                // Opening the trace here (not at capture start) is what makes
                // the first phase the human-meaningful "hotkey release".
                timing::begin_turn();
                timing::mark("hotkey release");
                // No send, no submit: the engine lands in `ready` with the WAV
                // on disk and waits for step A1.
                capture.stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fallback_shortcut_is_control_option_space() {
        let expected = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space);
        assert_eq!(shortcut(), expected);
    }
}
