//! The typed-prompt window (step A6).
//!
//! A second, focusable window that hangs under the notch: the top edge is flush
//! with the screen top (so it reads as if the sheet grew out of the hardware
//! cutout), it is transparent and undecorated, and its **height is driven by the
//! panel's measured content** — the webview measures, Rust resizes.
//!
//! Two things this module owns that the overlay (`crate::notch`) does not:
//!
//! * **It accepts keyboard input.** The overlay is deliberately
//!   `focusable: false` and click-through; the prompt must take focus so the
//!   text field works, so it is configured `focusable: true`.
//! * **It is opened by a gesture.** A double Control tap (see
//!   [`crate::ctrl_tap`]) toggles it. The detector is fed by
//!   [`crate::hotkey_flags::add_sample_observer`] on the same `flagsChanged`
//!   monitor the push-to-talk gesture uses, then runs on its own thread so the
//!   AppKit callback stays cheap.
//!
//! Closing is panel-driven: Rust emits `polaris-prompt` with `close` and the
//! webview plays the collapse-upward animation, then calls `prompt_hide` once
//! it has finished. A native hide would cut the animation off.

use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::ctrl_tap::CtrlTap;
use crate::gesture::ModifierSample;
use crate::hotkey_flags;

/// The window label pinned by `tauri.conf.json`.
pub const WINDOW_LABEL: &str = "prompt";

/// The prompt event channel. Deliberately separate from `polaris-event`
/// (`crate::events`): the overlay's typed union must not grow a transient
/// window-lifecycle variant (step A6 file-ownership rule).
pub const PROMPT_EVENT_NAME: &str = "polaris-prompt";

/// Sheet width in AppKit points. The design reference is ~660–780 pt; 720 sits
/// in the middle and is clamped to the screen on narrower displays.
const PROMPT_WIDTH: f64 = 720.0;

/// Smallest window height the panel may ask for. Below this the rounded sheet
/// would look like a sliver during the open animation.
const MIN_WINDOW_HEIGHT: f64 = 56.0;

/// Largest window height, so a runaway answer cannot cover the whole screen.
const MAX_WINDOW_HEIGHT: f64 = 720.0;

/// Height used before the panel has measured itself.
const DEFAULT_HEIGHT: f64 = 220.0;

/// `NSStatusWindowLevel`, matching the overlay: above the menu bar, but this
/// window *is* focusable (unlike the overlay).
#[cfg(target_os = "macos")]
const PROMPT_WINDOW_LEVEL: isize = 25;

/// The last height the panel reported, reused when the window reopens.
static CONTENT_HEIGHT: Mutex<f64> = Mutex::new(DEFAULT_HEIGHT);

/// What the prompt window asks the panel to do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptAction {
    Open,
    Close,
}

/// Payload of [`PROMPT_EVENT_NAME`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptEvent {
    pub action: PromptAction,
}

/// Positions the prompt window and starts the double-Control driver. Called
/// from `tauri::Builder::setup`, i.e. on the main thread, which is where AppKit
/// requires the frame to be set.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();
    if let Err(error) = place(&handle, current_height()) {
        eprintln!("polaris: could not place the prompt window: {error}");
    }
    start_tap_driver(handle);
    Ok(())
}

/// Toggles the panel. Called from the tap driver thread.
pub fn toggle(app: &AppHandle) {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        eprintln!("polaris: the prompt window is missing");
        return;
    };
    match window.is_visible() {
        // Closing is animated by the panel, which calls `prompt_hide` afterwards.
        Ok(true) => emit(app, PromptAction::Close),
        _ => {
            if let Err(error) = show(app) {
                eprintln!("polaris: could not open the prompt panel: {error}");
            }
        }
    }
}

/// Shows, focuses and announces the panel. Returns once the show has been
/// scheduled on the main thread.
pub fn show(app: &AppHandle) -> Result<(), String> {
    let height = current_height();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = place(&handle, height) {
            eprintln!("polaris: could not place the prompt window: {error}");
        }
        let Some(window) = handle.get_webview_window(WINDOW_LABEL) else {
            return;
        };
        if let Err(error) = window.show() {
            eprintln!("polaris: could not show the prompt window: {error}");
        }
        // Focusable, unlike the overlay: the text field must receive keys.
        if let Err(error) = window.set_focus() {
            eprintln!("polaris: could not focus the prompt window: {error}");
        }
    })
    .map_err(|error| error.to_string())?;
    emit(app, PromptAction::Open);
    Ok(())
}

/// Hides the panel. Called by the webview after the collapse animation.
pub fn hide(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the prompt window is missing".to_string())?;
    window.hide().map_err(|error| error.to_string())
}

/// Resizes the window to the panel's measured content, keeping the top edge
/// flush with the screen top.
pub fn resize(app: &AppHandle, height: f64) -> Result<(), String> {
    let clamped = height.clamp(MIN_WINDOW_HEIGHT, MAX_WINDOW_HEIGHT);
    match CONTENT_HEIGHT.lock() {
        Ok(mut current) => *current = clamped,
        Err(poisoned) => *poisoned.into_inner() = clamped,
    }
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(error) = place(&handle, clamped) {
            eprintln!("polaris: could not resize the prompt window: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

/// Pushes one prompt action to the webview. Failures are logged, never fatal.
fn emit(app: &AppHandle, action: PromptAction) {
    if let Err(error) = app.emit(PROMPT_EVENT_NAME, PromptEvent { action }) {
        eprintln!("polaris: failed to emit the prompt event: {error}");
    }
}

fn current_height() -> f64 {
    match CONTENT_HEIGHT.lock() {
        Ok(height) => *height,
        Err(poisoned) => *poisoned.into_inner(),
    }
}

/// Forwards every masked modifier sample into the tap machine's own thread.
fn start_tap_driver(app: AppHandle) {
    let (sender, receiver) = std::sync::mpsc::channel::<ModifierSample>();
    hotkey_flags::add_sample_observer(move |sample| {
        // The AppKit callback must stay cheap; the machine runs on its own thread.
        let _ = sender.send(sample);
    });

    let spawned = std::thread::Builder::new()
        .name("polaris-prompt-taps".into())
        .spawn(move || {
            let mut machine = CtrlTap::default();
            while let Ok(sample) = receiver.recv() {
                if machine.on_modifiers(sample, Instant::now()) {
                    toggle(&app);
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the double-Control detector: {error}");
    }
}

/// Sets the window frame to `height`, centred and flush with the screen top.
#[cfg(target_os = "macos")]
fn place(app: &AppHandle, height: f64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = MainThreadMarker::new().ok_or("prompt placement requires the main thread")?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("prompt window unavailable")?;
    let raw_window = window.ns_window()?;
    // Tauri owns this NSWindow for the app's lifetime and we are on the main
    // thread, so the borrowed reference cannot outlive its owner here.
    let native = unsafe { &*raw_window.cast::<NSWindow>() };
    native.setLevel(PROMPT_WINDOW_LEVEL);
    native.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );

    // Prefer the built-in notched display, matching the overlay's choice.
    let screens = NSScreen::screens(mtm);
    let screen = screens
        .iter()
        .find(|screen| screen.safeAreaInsets().top > 0.0)
        .or_else(|| screens.firstObject())
        .ok_or("no display available")?;
    let frame = screen.frame();
    let width = PROMPT_WIDTH.clamp(320.0, (frame.size.width - 40.0).max(320.0));

    // AppKit's origin is bottom-left: `top - height` keeps the top edge pinned
    // to the screen top while the window grows downward.
    let desired = NSRect::new(
        NSPoint::new(
            frame.origin.x + (frame.size.width - width) / 2.0,
            frame.origin.y + frame.size.height - height,
        ),
        NSSize::new(width, height),
    );
    if native.frame() != desired {
        native.setFrame_display(desired, true);
    }
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn place(app: &AppHandle, height: f64) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("prompt window unavailable")?;
    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?);
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let position = monitor.position();
        let size = monitor.size();
        let monitor_width = f64::from(size.width) / scale;
        let width = PROMPT_WIDTH.clamp(320.0, (monitor_width - 40.0).max(320.0));
        window.set_position(tauri::LogicalPosition::new(
            f64::from(position.x) / scale + (monitor_width - width) / 2.0,
            f64::from(position.y) / scale,
        ))?;
    }
    window.set_size(tauri::LogicalSize::new(PROMPT_WIDTH, height))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_event_serializes_as_camel_case_action() {
        let json = serde_json::to_string(&PromptEvent {
            action: PromptAction::Open,
        })
        .unwrap();
        assert_eq!(json, r#"{"action":"open"}"#);
        let json = serde_json::to_string(&PromptEvent {
            action: PromptAction::Close,
        })
        .unwrap();
        assert_eq!(json, r#"{"action":"close"}"#);
    }
}
