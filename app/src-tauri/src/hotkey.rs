//! Global push-to-talk hotkey (step A0).
//!
//! The gesture is the key-code shortcut `Control + Option + Space`: hold to
//! record, release to stop. `tauri-plugin-global-shortcut` (backed by Carbon
//! `RegisterEventHotKey` on macOS) delivers both the pressed and released
//! events, which is exactly the hold/release model we need.
//!
//! A modifier-only Control+Option gesture is a deliberate follow-up task: the
//! key-code shortcut cannot express it, so it needs a native `flagsChanged`
//! observer with an Accessibility-permission prompt.

use tauri::AppHandle;
use tauri::Manager;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

use crate::capture::Capture;
use crate::events::{self, HotkeyState, PolarisEvent};

/// The push-to-talk keyboard shortcut, kept typed so the registration and the
/// window config's UI copy cannot drift from each other.
pub fn shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL | Modifiers::ALT), Code::Space)
}

/// Routes one shortcut event into the capture engine. Called from the plugin's
/// handler, so it must stay cheap: `start` spawns its own worker thread and
/// `stop` only waits for the WAV to finalize.
pub fn handle(app: &AppHandle, state: ShortcutState) {
    let capture = app.state::<Capture>();
    match state {
        ShortcutState::Pressed => {
            events::emit(
                app,
                PolarisEvent::Hotkey {
                    state: HotkeyState::Down,
                },
            );
            capture.start(app);
        }
        ShortcutState::Released => {
            events::emit(
                app,
                PolarisEvent::Hotkey {
                    state: HotkeyState::Up,
                },
            );
            // No send, no submit: the capture engine lands in `ready` with the
            // WAV on disk and waits for step A1.
            capture.stop();
        }
    }
}
