//! Platform window operations for the notch overlay.
//!
//! Everything that touches AppKit (`NSScreen`, `NSWindow`) lives here so the
//! geometry model in [`super`] stays pure and unit-testable. On macOS every
//! function must run on the main thread; the caller (`super`) is responsible
//! for hopping there. The non-macOS branch keeps the crate building on other
//! hosts (where the app is not shipped) with a plain centred pill.

use tauri::Manager;

use super::{NotchMetrics, Rect, FALLBACK_CUTOUT, WINDOW_LABEL};

/// The display the shell lives on, in AppKit coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenInfo {
    pub metrics: NotchMetrics,
    /// Screen-frame origin of the display (global coordinates).
    pub origin_x: f64,
    pub origin_y: f64,
}

/// Borrows the overlay's `NSWindow` from Tauri after proving we are on the
/// AppKit main thread and the pointer is non-null. Every raw AppKit deref below
/// goes through here, so an off-thread call or a destroyed window is a typed
/// error, never undefined behaviour.
#[cfg(target_os = "macos")]
fn ns_window(app: &tauri::AppHandle) -> Result<objc2::rc::Retained<objc2_app_kit::NSWindow>, String> {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSWindow;

    MainThreadMarker::new().ok_or("AppKit window access requires the main thread")?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    let raw = window.ns_window().map_err(|error| error.to_string())?;
    if raw.is_null() {
        return Err("overlay NSWindow pointer is null".into());
    }
    // SAFETY: `ns_window` returns a borrowed pointer to a window Tauri owns for
    // the app lifetime; we prove it is non-null above and we are on the main
    // thread. Retaining it keeps it alive for the duration of the call.
    let native: Retained<NSWindow> = unsafe { Retained::retain(raw.cast::<NSWindow>()) }
        .ok_or("overlay NSWindow could not be retained")?;
    Ok(native)
}

/// Reads the notched display. Main thread only on macOS.
#[cfg(target_os = "macos")]
pub fn measure(_app: &tauri::AppHandle) -> Result<ScreenInfo, String> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;

    let mtm = MainThreadMarker::new().ok_or("notch geometry requires the main thread")?;
    let screens = NSScreen::screens(mtm);
    // Prefer the built-in notched display; clamshell / external displays fall
    // back to the primary screen and the centred pill.
    let screen = screens
        .iter()
        .find(|screen| screen.safeAreaInsets().top > 0.0)
        .or_else(|| screens.firstObject())
        .ok_or("no display available")?;

    let frame = screen.frame();
    let safe_top = screen.safeAreaInsets().top;
    let origin_x = frame.origin.x;
    let origin_y = frame.origin.y;
    let screen_width = frame.size.width;
    let screen_height = frame.size.height;

    let (cutout_width, cutout_height, cutout_center_x) = if safe_top > 0.0 {
        // The gap between the two auxiliary areas is the camera housing, and
        // their shared edge is its centre — the real thing the shell must be
        // centred on, instead of assuming the cutout sits at the screen centre.
        let left = screen.auxiliaryTopLeftArea();
        let right = screen.auxiliaryTopRightArea();
        let housing = right.origin.x - (left.origin.x + left.size.width);
        let centre = (left.origin.x + left.size.width + right.origin.x) / 2.0;
        (housing.max(0.0), safe_top, centre - origin_x)
    } else {
        (FALLBACK_CUTOUT.0, FALLBACK_CUTOUT.1, screen_width / 2.0)
    };

    Ok(ScreenInfo {
        metrics: NotchMetrics {
            cutout_width,
            cutout_height,
            screen_width,
            screen_height,
            cutout_center_x,
            safe_top,
        },
        origin_x,
        origin_y,
    })
}

/// The AppKit collection behaviour every configure pass applies (step A14).
///
/// * `CanJoinAllSpaces` — the overlay appears on whichever Space is active,
///   including the fullscreen Space an app creates.
/// * `FullScreenAuxiliary` — it is allowed to float above a fullscreen window
///   instead of being forced into that app's fullscreen "primary" role.
/// * `Stationary` — it does not slide with a Space transition.
/// * `IgnoresCycle` — it stays out of the Cmd+Tab / window cycle, so the
///   overlay never activates Polaris.
///
/// Kept as one named value so [`apply_style`] and the tests cannot drift apart
/// in what they claim the window is set to.
#[cfg(target_os = "macos")]
pub(crate) fn overlay_collection_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior;
    NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle
}

/// Sets the window level and Space behaviour. Main thread only on macOS.
#[cfg(target_os = "macos")]
pub fn apply_style(app: &tauri::AppHandle) -> Result<(), String> {
    let native = ns_window(app)?;
    native.setLevel(super::OVERLAY_WINDOW_LEVEL);
    native.setCollectionBehavior(overlay_collection_behavior());
    Ok(())
}

/// Reads the process's live `NSApplicationActivationPolicy` (step A15/#21).
///
/// `NSRunningApplication` is thread-safe and needs no main-thread marker, so
/// this is safe to call from `setup` (which already runs on the main thread
/// anyway). The policy itself is set in `lib.rs::apply_activation_policy`
/// before the run loop opens the window.
#[cfg(target_os = "macos")]
pub fn activation_policy() -> super::NotchActivationPolicy {
    use objc2_app_kit::NSRunningApplication;
    super::activation_policy_of(NSRunningApplication::currentApplication().activationPolicy())
}

/// Reads the native window frame. Main thread only on macOS.
#[cfg(target_os = "macos")]
pub fn frame(app: &tauri::AppHandle) -> Result<Rect, String> {
    let frame = ns_window(app)?.frame();
    Ok(Rect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    })
}

/// Sets the native window frame **without** AppKit animation. Main thread only.
///
/// Animation is deliberately left to CSS: an AppKit frame animation would fight
/// the CSS easing on the same 470 ms and land the clip boundary in the wrong
/// place mid-flight.
#[cfg(target_os = "macos")]
pub fn set_frame(app: &tauri::AppHandle, frame: Rect) -> Result<(), String> {
    use objc2_foundation::{NSPoint, NSRect, NSSize};

    let native = ns_window(app)?;
    let desired = NSRect::new(
        NSPoint::new(frame.x, frame.y),
        NSSize::new(frame.width, frame.height),
    );
    if native.frame() != desired {
        native.setFrame_display(desired, true);
    }
    Ok(())
}

/// Writes `NSWindow.ignoresMouseEvents`. This is the one native write behind
/// [`super::sync_native_interactivity`]; the caller derives `ignore` from the
/// guarded runtime state. Main thread only on macOS (Tauri would also route an
/// off-thread call to the event loop, but we require the main thread explicitly
/// so the write is synchronous and serialized with the state commands).
#[cfg(target_os = "macos")]
pub fn set_ignore_cursor_events(app: &tauri::AppHandle, ignore: bool) -> Result<(), String> {
    let _native = ns_window(app)?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())
}

/// Writes `NSWindow.focusable`. This is the one native write behind
/// [`super::sync_native_focusability`]; the caller derives `focusable` from the
/// guarded runtime state. Main thread only on macOS.
#[cfg(target_os = "macos")]
pub fn set_focusable(app: &tauri::AppHandle, focusable: bool) -> Result<(), String> {
    let _native = ns_window(app)?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window
        .set_focusable(focusable)
        .map_err(|error| error.to_string())
}

/// Makes the overlay the key window so the prompt's text field receives keys.
/// Only called on the transition into a focusable state, after the flag is set.
/// Main thread only on macOS.
#[cfg(target_os = "macos")]
pub fn focus(app: &tauri::AppHandle) -> Result<(), String> {
    let _native = ns_window(app)?;
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window.set_focus().map_err(|error| error.to_string())
}

/* ------------------------------------------------------------------ *
 * Non-macOS: best-effort mirror so the crate builds and unit tests run.
 * The app is only shipped on macOS, so top-left vs bottom-left coordinate
 * differences are not reconciled here.
 * ------------------------------------------------------------------ */

#[cfg(not(target_os = "macos"))]
pub fn measure(app: &tauri::AppHandle) -> Result<ScreenInfo, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    let monitor = window.primary_monitor().map_err(|error| error.to_string())?;
    let (screen_width, screen_height, origin_x, origin_y) = match monitor {
        Some(monitor) => {
            let scale = monitor.scale_factor();
            (
                f64::from(monitor.size().width) / scale,
                f64::from(monitor.size().height) / scale,
                f64::from(monitor.position().x) / scale,
                f64::from(monitor.position().y) / scale,
            )
        }
        None => (1512.0, 982.0, 0.0, 0.0),
    };
    Ok(ScreenInfo {
        metrics: NotchMetrics {
            cutout_width: FALLBACK_CUTOUT.0,
            cutout_height: FALLBACK_CUTOUT.1,
            screen_width,
            screen_height,
            cutout_center_x: screen_width / 2.0,
            safe_top: FALLBACK_CUTOUT.1,
        },
        origin_x,
        origin_y,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn apply_style(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}

/// Non-macOS: there is no AppKit activation policy, so the diagnostics report
/// [`super::NotchActivationPolicy::Unsupported`] instead of a guessed value.
#[cfg(not(target_os = "macos"))]
pub fn activation_policy() -> super::NotchActivationPolicy {
    super::NotchActivationPolicy::Unsupported
}

#[cfg(not(target_os = "macos"))]
pub fn frame(app: &tauri::AppHandle) -> Result<Rect, String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?;
    let size = window.inner_size().map_err(|error| error.to_string())?;
    Ok(Rect {
        x: f64::from(position.x) / scale,
        y: f64::from(position.y) / scale,
        width: f64::from(size.width) / scale,
        height: f64::from(size.height) / scale,
    })
}

#[cfg(not(target_os = "macos"))]
pub fn set_frame(app: &tauri::AppHandle, frame: Rect) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window
        .set_size(tauri::LogicalSize::new(frame.width, frame.height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(tauri::LogicalPosition::new(frame.x, frame.y))
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn set_ignore_cursor_events(app: &tauri::AppHandle, ignore: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn set_focusable(app: &tauri::AppHandle, focusable: bool) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window
        .set_focusable(focusable)
        .map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn focus(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    window.set_focus().map_err(|error| error.to_string())
}
