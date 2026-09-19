//! The notch overlay window (step A0).
//!
//! Tauri can make the window transparent / undecorated / always-on-top, but it
//! cannot express the WindowServer details the overlay needs: the window level
//! (above the menu bar), the Space behaviour, or the physical notch geometry.
//! Those come from AppKit, which may only be called on the **main thread** —
//! `notch_geometry` therefore hops there instead of touching `NSScreen` from a
//! command thread.
//!
//! All coordinates here are AppKit points, so Retina scaling never leaks into
//! the webview's CSS pixel measurements.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Outer window size, kept in sync with `tauri.conf.json`. It is deliberately
/// larger than the widest notch shell so the overlay never clips mid-animation.
const WINDOW_WIDTH: f64 = 780.0;
const WINDOW_HEIGHT: f64 = 120.0;

/// The overlay is the app's only window; the label is pinned by the config.
pub const WINDOW_LABEL: &str = "main";

/// `NSStatusWindowLevel`: above the menu bar, without stealing keyboard focus.
#[cfg(target_os = "macos")]
const OVERLAY_WINDOW_LEVEL: isize = 25;

/// The `notch_geometry` command payload, mirrored as `NotchGeometry` in
/// `@polaris/interfaces`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchGeometry {
    pub idle_width: f64,
    pub idle_height: f64,
    pub expanded_width: f64,
    pub expanded_height: f64,
}

/// Centred-pill fallback for displays without a camera housing.
pub const FALLBACK: NotchGeometry = NotchGeometry {
    idle_width: 216.0,
    idle_height: 34.0,
    expanded_width: 680.0,
    expanded_height: 66.0,
};

/// Configures and reveals the overlay. Runs from `setup`, i.e. on the main
/// thread, so no thread hop is needed here.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    // The overlay must never eat a click meant for the app underneath it.
    window.set_ignore_cursor_events(true)?;
    let geometry = configure(app.handle())
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?;
    println!("polaris: notch geometry {geometry:?}");
    window.show()?;
    Ok(())
}

/// Re-reads the display geometry and repositions the overlay. Called on startup
/// and periodically by the webview so display topology changes are picked up.
#[tauri::command]
pub async fn notch_geometry(app: AppHandle) -> Result<NotchGeometry, String> {
    // AppKit objects are main-thread-only; hand the closure to the event loop
    // and block this command's worker until it answers.
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(configure(&handle));
    })
    .map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn configure(app: &AppHandle) -> Result<NotchGeometry, Box<dyn std::error::Error + Send + Sync>> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow, NSWindowCollectionBehavior};
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let mtm = MainThreadMarker::new().ok_or("notch geometry requires the main thread")?;
    let screens = NSScreen::screens(mtm);
    // Prefer the built-in notched display; clamshell / external displays fall
    // back to the primary screen and the centered pill.
    let screen = screens
        .iter()
        .find(|screen| screen.safeAreaInsets().top > 0.0)
        .or_else(|| screens.firstObject())
        .ok_or("no display available")?;

    let frame = screen.frame();
    let safe_top = screen.safeAreaInsets().top;
    let (idle_width, idle_height) = if safe_top > 0.0 {
        // The gap between the two auxiliary areas is the camera housing.
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        let housing = (right.origin.x - (left.origin.x + left.size.width)).max(0.0);
        ((housing + 20.0).max(180.0), safe_top + 4.0)
    } else {
        (FALLBACK.idle_width, FALLBACK.idle_height)
    };

    let outer_width = WINDOW_WIDTH.min(frame.size.width);
    let expanded_width = 680.0_f64.max(idle_width + 380.0).min(outer_width - 40.0);
    let expanded_height = 66.0_f64.max(idle_height + 20.0);

    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    let raw_window = window.ns_window()?;
    // Tauri owns this NSWindow for the app's lifetime and we are on the main
    // thread, so the borrowed reference cannot outlive its owner here.
    let native = unsafe { &*raw_window.cast::<NSWindow>() };
    native.setLevel(OVERLAY_WINDOW_LEVEL);
    native.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );

    let desired = NSRect::new(
        NSPoint::new(
            frame.origin.x + (frame.size.width - outer_width) / 2.0,
            frame.origin.y + frame.size.height - WINDOW_HEIGHT,
        ),
        NSSize::new(outer_width, WINDOW_HEIGHT),
    );
    if native.frame() != desired {
        native.setFrame_display(desired, true);
    }

    Ok(NotchGeometry {
        idle_width,
        idle_height,
        expanded_width,
        expanded_height,
    })
}

#[cfg(not(target_os = "macos"))]
fn configure(app: &AppHandle) -> Result<NotchGeometry, Box<dyn std::error::Error + Send + Sync>> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    if let Some(monitor) = window.primary_monitor()? {
        let scale = monitor.scale_factor();
        let width = f64::from(monitor.size().width) / scale;
        window.set_position(tauri::LogicalPosition::new(
            f64::from(monitor.position().x) / scale + (width - WINDOW_WIDTH) / 2.0,
            f64::from(monitor.position().y) / scale,
        ))?;
    }
    Ok(FALLBACK)
}

// Compile-time invariants: the pill must be smaller than the expanded shell,
// and the outer window must be able to host the widest expanded shell.
const _: () = {
    assert!(FALLBACK.idle_width < FALLBACK.expanded_width);
    assert!(FALLBACK.idle_height < FALLBACK.expanded_height);
    assert!(FALLBACK.expanded_width <= WINDOW_WIDTH);
    assert!(FALLBACK.expanded_height <= WINDOW_HEIGHT);
};
