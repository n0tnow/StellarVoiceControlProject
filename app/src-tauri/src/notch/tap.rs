//! Double-Control tap -> the shell's `hotkey` source.
//!
//! The detector itself is pure ([`crate::ctrl_tap`]); this module is the thin
//! platform edge that feeds it from the shared modifier monitors and forwards
//! the result to the webview. A6 toggled a second window here; the folded shell
//! instead emits `notch_hotkey { prompt }` and lets the reducer decide, which is
//! what keeps the single-surface rule.
//!
//! Toggle semantics: the tap asks the *runtime* whether `prompt` is already the
//! active state and emits the opposite, so a second double-tap closes it — the
//! same behaviour the A6 window had, but driven by the shell state. A forced
//! collapse emits the same clear proposal, so the webview's sticky latch can
//! never resurrect a prompt the watchdog just tore down.
//!
//! ## The tap during a live voice turn (decided behaviour)
//!
//! A double-Control tap is **ignored while the microphone hold owns the moment**,
//! and that needs no extra runtime gate: push-to-talk holds Control *and*
//! Option, and [`crate::ctrl_tap`] rule 3 poisons any sequence that ever sees
//! Option/Command/Shift, so the short Control edges inside the hold can never
//! seed or complete a pair. This is pinned by
//! `ctrl_tap::tests::a_push_to_talk_hold_owns_the_control_key_so_no_tap_can_fire`.
//!
//! Once the hold is released and the turn has moved on (transcribing, thinking,
//! speaking), the tap is live again and toggles the prompt exactly as it does
//! with no turn running. The prompt and a voice turn are allowed to be active
//! together — the reducer keeps the prompt on top and the prompt shows the
//! turn's stage inline — so there is nothing to suppress there. A blanket
//! "ignore the tap for the whole turn" rule would force Rust to own a
//! voice-turn notion it does not have (thinking/speaking live in the webview
//! turn session, not in `Capture`), duplicating state and risking a second
//! source of truth. The hold is the only moment the mic owns, and it owns it by
//! construction.

use std::time::Instant;

use tauri::{AppHandle, Manager};

use super::{ShellRuntime, PROMPT_STATE};
use crate::ctrl_tap::CtrlTap;
use crate::gesture::ModifierSample;
use crate::hotkey_flags;

/// Registers the tap observers and starts the detector thread. Called from
/// `setup`, i.e. on the main thread, which is where AppKit requires the
/// monitors to be registered. The observers are process-lifetime by design
/// (see [`hotkey_flags::add_sample_observer`]).
pub fn install(app: &AppHandle) {
    enum TapInput {
        Modifiers(ModifierSample),
        KeyPressed,
    }

    let (sender, receiver) = std::sync::mpsc::channel::<TapInput>();
    hotkey_flags::add_sample_observer({
        let sender = sender.clone();
        move |sample| {
            // The AppKit callback must stay cheap; the machine runs on its own
            // thread.
            let _ = sender.send(TapInput::Modifiers(sample));
        }
    });
    hotkey_flags::add_key_observer(move || {
        let _ = sender.send(TapInput::KeyPressed);
    });

    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("polaris-shell-taps".into())
        .spawn(move || {
            let mut machine = CtrlTap::default();
            while let Ok(input) = receiver.recv() {
                let fired = match input {
                    TapInput::Modifiers(sample) => machine.on_modifiers(sample, Instant::now()),
                    TapInput::KeyPressed => {
                        machine.on_key_press();
                        false
                    }
                };
                if fired {
                    // Rehearsal: while the onboarding window is on screen the
                    // first run must have no real side effects, so a rehearsal
                    // double-Control tap must not open the notch's prompt
                    // behind the onboarding window (see
                    // `onboarding::is_rehearsing`). The detector keeps running
                    // and consuming samples so the gesture machinery stays
                    // warm; only the emitted consequence is suppressed.
                    if crate::onboarding::is_rehearsing(&app) {
                        continue;
                    }
                    let prompt_open = app
                        .try_state::<ShellRuntime>()
                        .is_some_and(|runtime| runtime.active_state_is(PROMPT_STATE));
                    crate::events::emit_notch_hotkey(&app, !prompt_open);
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the double-Control detector: {error}");
    }
}
