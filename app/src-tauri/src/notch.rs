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

/// `NSPopUpMenuWindowLevel` (101): above the menu bar (25) *and* above the
/// window a fullscreen app is promoted to, so the overlay reads as a system HUD
/// over a fullscreen Space (step A14). `NSStatusWindowLevel` (25) was above the
/// ordinary desktop/menu bar but lost to a fullscreen window, which is why the
/// overlay vanished as soon as an app went fullscreen.
#[cfg(target_os = "macos")]
const OVERLAY_WINDOW_LEVEL: isize = 101;

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
/// Kept as one named value so [`configure`] and the diagnostics command cannot
/// drift apart in what they claim the window is set to.
#[cfg(target_os = "macos")]
fn overlay_collection_behavior() -> objc2_app_kit::NSWindowCollectionBehavior {
    use objc2_app_kit::NSWindowCollectionBehavior;
    NSWindowCollectionBehavior::CanJoinAllSpaces
        | NSWindowCollectionBehavior::FullScreenAuxiliary
        | NSWindowCollectionBehavior::Stationary
        | NSWindowCollectionBehavior::IgnoresCycle
}

/// The `notch_geometry` command payload, mirrored as `NotchGeometry` in
/// `@polaris/interfaces`.
///
/// Dimensions and radii are AppKit points. The radii are **derived** from the
/// measured safe area (see [`radii_for`]) rather than hardcoded in CSS, so the
/// silhouette tracks the display instead of the 14" reference numbers.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchGeometry {
    pub idle_width: f64,
    pub idle_height: f64,
    pub expanded_width: f64,
    pub expanded_height: f64,
    /// Convex radius of the resting pill's top corners (hardware cutout, ~4 pt).
    pub pill_top_radius: f64,
    /// Convex radius of the resting pill's bottom corners (hardware cutout, ~8 pt).
    pub pill_bottom_radius: f64,
    /// Concave "ear" radius that melts the expanded shell into the screen edge.
    pub shell_ear_radius: f64,
    /// Convex radius of the expanded shell's bottom corners.
    pub shell_bottom_radius: f64,
}

/// Corner radii for both shell states, in AppKit points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Radii {
    pill_top: f64,
    pill_bottom: f64,
    shell_ear: f64,
    shell_bottom: f64,
}

/// `f64::clamp` is not const on the pinned toolchain, and the fallback has to be
/// a `const`, so carry a tiny const-callable version.
const fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// Scales the corner radii to the measured cutout.
///
/// The fractions come from two measured references: the hardware cutout's top
/// corners are ~4 pt and its bottom corners ~8 pt (notchbay.com), while
/// boring.notch's `NotchShape` defaults to a 6 pt concave ear and a 14 pt convex
/// bottom. Deriving them from the measured height keeps a 16" display (38 pt
/// cutout) from reusing the 14" numbers; the clamps stop a degenerate screen
/// report from inverting the silhouette.
const fn radii_for(idle_height: f64, expanded_height: f64) -> Radii {
    Radii {
        pill_top: clamp(idle_height * 0.125, 3.0, 5.0),
        pill_bottom: clamp(idle_height * 0.25, 7.0, 10.0),
        // The expanded shell is the same height as the pill, so its corners are
        // derived from the same scale rather than from a taller shell. The
        // bottom is deliberately much rounder than the pill's: it is the edge
        // that reads as "this grew out of the notch".
        shell_ear: clamp(expanded_height * 0.18, 4.0, 8.0),
        shell_bottom: clamp(expanded_height * 0.45, 10.0, 18.0),
    }
}

/// Expanded shell size, derived from the resting pill.
///
/// The shell **never grows vertically**: the returned height is the cutout
/// height, unchanged. An expanded shell taller than the hardware cutout hangs
/// below the notch and reads as a separate black slab — the defect reported
/// twice against earlier revisions. Only the width changes, by
/// [`EXPANDED_WIDTH_RATIO`], capped so the shell always fits the overlay window.
fn expanded_size(idle_width: f64, idle_height: f64, outer_width: f64) -> (f64, f64) {
    let width = (idle_width + 2.0 * EAR_WIDTH).min(outer_width - 40.0);
    (width.max(idle_width), idle_height)
}

/// Idle pill size for a notched display: **exactly** the measured cutout.
///
/// The earlier revision shipped `housing + 20` wide and `safe_top + 4` tall,
/// which is why the black shape never aligned with the hardware and read as a
/// separate blob.
fn idle_cutout_size(housing: f64, safe_top: f64) -> (f64, f64) {
    (housing.max(0.0), safe_top)
}

/// Width of ONE ear — the strip of shell beside the physical cutout.
///
/// There are no pixels behind the camera housing, so anything drawn over the
/// cutout is simply not displayed. All content therefore lives in the two ears,
/// and the shell is only as wide as that content needs: a short status label on
/// the left, the indicator on the right. 110 pt holds the longest label
/// ("Enable hold-to-talk") at the 13 pt type scale.
const EAR_WIDTH: f64 = 110.0;

/// Centred-pill fallback for displays without a camera housing.
pub const FALLBACK: NotchGeometry = {
    let radii = radii_for(34.0, 34.0);
    NotchGeometry {
        idle_width: 216.0,
        idle_height: 34.0,
        expanded_width: 216.0 + 2.0 * EAR_WIDTH,
        expanded_height: 34.0,
        pill_top_radius: radii.pill_top,
        pill_bottom_radius: radii.pill_bottom,
        shell_ear_radius: radii.shell_ear,
        shell_bottom_radius: radii.shell_bottom,
    }
};

/// Configures and reveals the overlay. Runs from `setup`, i.e. on the main
/// thread, so no thread hop is needed here.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    // The overlay must never eat a click meant for the app underneath it.
    window.set_ignore_cursor_events(true)?;
    let outcome = configure(app.handle())
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error.to_string())))?;
    println!("polaris: notch geometry {:?}", outcome.geometry);
    // Step A14: log the actual window flags the overlay ended up with, so the
    // fullscreen behaviour is inspectable from the running process rather than
    // assumed from the config.
    println!("polaris: notch window flags {:?}", outcome.flags);
    window.show()?;
    Ok(())
}

/// The AppKit window flags the overlay was configured with (step A14).
///
/// This is the inspectable evidence that the overlay can float over a
/// fullscreen Space: it is returned by [`notch_window_flags`] and logged at
/// startup, straight from the live `NSWindow` rather than read back from
/// `tauri.conf.json` (which cannot express either field).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchWindowFlags {
    /// The raw `NSWindowLevel` (`NSPopUpMenuWindowLevel` is 101).
    pub level: isize,
    /// The raw `NSWindowCollectionBehavior` bitmask.
    pub collection_behavior: u64,
    /// Whether `FullScreenAuxiliary` is set — the window may float above a
    /// fullscreen app instead of being swallowed by it.
    pub full_screen_auxiliary: bool,
    /// Whether `CanJoinAllSpaces` is set — the window appears on every Space.
    pub can_join_all_spaces: bool,
    /// Whether the window can become key, i.e. whether it could activate Polaris.
    pub focusable: bool,
}

/// The AppKit bits for `NSWindowCollectionBehaviorFullScreenAuxiliary` (1 << 8)
/// and `CanJoinAllSpaces` (1 << 0), spelled out so the flags readback does not
/// depend on the generated crate's `bits()` API shape.
#[cfg(target_os = "macos")]
const FULL_SCREEN_AUXILIARY_BIT: u64 = 1 << 8;
#[cfg(target_os = "macos")]
const CAN_JOIN_ALL_SPACES_BIT: u64 = 1 << 0;

/// Re-reads the display geometry and repositions the overlay. Called on startup
/// and periodically by the webview so display topology changes are picked up.
#[tauri::command]
pub async fn notch_geometry(app: AppHandle) -> Result<NotchGeometry, String> {
    // AppKit objects are main-thread-only; hand the closure to the event loop
    // and block this command's worker until it answers.
    with_overlay(app, |outcome| outcome.geometry).await
}

/// Reports the live overlay window's AppKit flags (step A14).
///
/// The owner-visible check for the fullscreen fix: it reads the level and the
/// collection behaviour off the real `NSWindow`, so `level=101` and
/// `fullScreenAuxiliary=true, canJoinAllSpaces=true` are what the running
/// process can be inspected for. The final "does it visually float over a real
/// fullscreen app" check still needs a human eye.
#[tauri::command]
pub async fn notch_window_flags(app: AppHandle) -> Result<NotchWindowFlags, String> {
    with_overlay(app, |outcome| outcome.flags).await
}

/// Runs [`configure`] on the main thread and projects part of its outcome.
async fn with_overlay<T, F>(app: AppHandle, project: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&ConfigureOutcome) -> T + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(configure(&handle));
    })
    .map_err(|error| error.to_string())?;

    let received = tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| error.to_string())?;
    // `recv` fails only if the main-thread closure panicked or never ran.
    let outcome = received.map_err(|error| error.to_string())?;
    outcome.map(|value| project(&value)).map_err(|error| error.to_string())
}

/// What one [`configure`] pass produced: the geometry the webview needs and the
/// window flags the A14 diagnostics report.
#[cfg(target_os = "macos")]
struct ConfigureOutcome {
    geometry: NotchGeometry,
    flags: NotchWindowFlags,
}

/// Non-macOS [`configure`] outcome: no AppKit flags to report, so the fields
/// are zeroed and only the geometry is real.
#[cfg(not(target_os = "macos"))]
struct ConfigureOutcome {
    geometry: NotchGeometry,
    flags: NotchWindowFlags,
}

#[cfg(target_os = "macos")]
fn configure(app: &AppHandle) -> Result<ConfigureOutcome, Box<dyn std::error::Error + Send + Sync>> {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSScreen, NSWindow};
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
        let housing = right.origin.x - (left.origin.x + left.size.width);
        // Match the cutout exactly. The menu bar paints ~5 pt deeper than the
        // physical housing (notchbay.com), but the system already draws that
        // strip for us; painting black into it is what made the overlay read as
        // a blob in light mode, so the resting pill stops at `safe_top`.
        idle_cutout_size(housing, safe_top)
    } else {
        (FALLBACK.idle_width, FALLBACK.idle_height)
    };

    let outer_width = WINDOW_WIDTH.min(frame.size.width);
    let (expanded_width, expanded_height) = expanded_size(idle_width, idle_height, outer_width);
    let radii = radii_for(idle_height, expanded_height);

    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or("overlay window unavailable")?;
    let raw_window = window.ns_window()?;
    // Tauri owns this NSWindow for the app's lifetime and we are on the main
    // thread, so the borrowed reference cannot outlive its owner here.
    let native = unsafe { &*raw_window.cast::<NSWindow>() };
    native.setLevel(OVERLAY_WINDOW_LEVEL);
    native.setCollectionBehavior(overlay_collection_behavior());
    // Step A14: neither line above activates Polaris or takes focus — the window
    // is click-through and cannot become key — so the overlay floats over a
    // fullscreen app without stealing the keyboard. The flags are read straight
    // off the live NSWindow as the inspectable evidence for that.
    let behavior = native.collectionBehavior().0 as u64;
    let flags = NotchWindowFlags {
        level: native.level(),
        collection_behavior: behavior,
        full_screen_auxiliary: behavior & FULL_SCREEN_AUXILIARY_BIT != 0,
        can_join_all_spaces: behavior & CAN_JOIN_ALL_SPACES_BIT != 0,
        focusable: native.canBecomeKeyWindow(),
    };

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

    Ok(ConfigureOutcome {
        geometry: NotchGeometry {
            idle_width,
            idle_height,
            expanded_width,
            expanded_height,
            pill_top_radius: radii.pill_top,
            pill_bottom_radius: radii.pill_bottom,
            shell_ear_radius: radii.shell_ear,
            shell_bottom_radius: radii.shell_bottom,
        },
        flags,
    })
}

#[cfg(not(target_os = "macos"))]
fn configure(app: &AppHandle) -> Result<ConfigureOutcome, Box<dyn std::error::Error + Send + Sync>> {
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
    // No AppKit on this platform: report zeroed flags so the diagnostics command
    // still answers, and keep the geometry real.
    Ok(ConfigureOutcome {
        geometry: FALLBACK,
        flags: NotchWindowFlags {
            level: 0,
            collection_behavior: 0,
            full_screen_auxiliary: false,
            can_join_all_spaces: false,
            focusable: false,
        },
    })
}

// Compile-time invariants: the pill must be smaller than the expanded shell,
// the outer window must be able to host the widest expanded shell, and the
// radii must describe a valid (non-inverted) silhouette.
const _: () = {
    assert!(FALLBACK.idle_width < FALLBACK.expanded_width);
    // The shell only ever widens. Equal heights are the invariant, not an
    // oversight: any expanded height greater than the pill would make the
    // overlay grow downwards out of the hardware cutout.
    assert!(FALLBACK.idle_height == FALLBACK.expanded_height);
    assert!(FALLBACK.expanded_width <= WINDOW_WIDTH);
    assert!(FALLBACK.expanded_height <= WINDOW_HEIGHT);
    assert!(FALLBACK.pill_top_radius > 0.0);
    assert!(FALLBACK.pill_bottom_radius > FALLBACK.pill_top_radius);
    assert!(FALLBACK.shell_ear_radius > 0.0);
    assert!(FALLBACK.shell_bottom_radius > FALLBACK.shell_ear_radius);
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_pill_is_the_measured_cutout_not_inflated() {
        // Measured on the built-in 14" display: the auxiliary areas leave a
        // 179 pt housing and `safeAreaInsets.top` is 32 pt. The old code
        // returned 199 x 36 here.
        assert_eq!(idle_cutout_size(179.0, 32.0), (179.0, 32.0));
    }

    #[test]
    fn idle_size_never_goes_negative_on_a_degenerate_report() {
        assert_eq!(idle_cutout_size(-12.0, 32.0), (0.0, 32.0));
    }

    #[test]
    fn radii_track_the_measured_heights() {
        // The expanded shell is the same height as the pill (the overlay only
        // ever widens), so both sets of radii derive from the 32 pt cutout.
        let radii = radii_for(32.0, 32.0);
        assert!((radii.pill_top - 4.0).abs() < f64::EPSILON);
        assert!((radii.pill_bottom - 8.0).abs() < f64::EPSILON);
        assert!((radii.shell_ear - 5.76).abs() < 0.01);
        assert!((radii.shell_bottom - 14.4).abs() < 0.01);
    }

    #[test]
    fn the_shell_never_grows_taller_than_the_cutout() {
        // Regression guard for the defect reported twice against earlier
        // revisions: an expanded shell taller than the hardware cutout hangs
        // below the notch and reads as a separate black slab.
        for idle_height in [28.0_f64, 32.0, 38.0, 44.0] {
            let (_, expanded_height) = expanded_size(179.0, idle_height, 780.0);
            assert_eq!(
                expanded_height, idle_height,
                "expanded height must equal the cutout height"
            );
        }
        assert_eq!(FALLBACK.expanded_height, FALLBACK.idle_height);
    }

    #[test]
    fn the_shell_widens_by_two_ears_and_stays_inside_the_window() {
        // 179 pt cutout on this machine + two 110 pt ears = 399 pt.
        let (width, _) = expanded_size(179.0, 32.0, 780.0);
        assert!((width - 399.0).abs() < 0.01, "got {width}");
        // Each ear must really be EAR_WIDTH, or content lands over the cutout
        // where the display has no pixels.
        assert!(((width - 179.0) / 2.0 - EAR_WIDTH).abs() < 0.01);

        // A narrow overlay window clamps the shell instead of overflowing it,
        // and the shell never ends up narrower than the resting pill.
        let (clamped, _) = expanded_size(179.0, 32.0, 200.0);
        assert_eq!(clamped, 179.0);
    }

    #[test]
    fn fallback_radii_match_the_shared_derivation() {
        let radii = radii_for(FALLBACK.idle_height, FALLBACK.expanded_height);
        assert!((FALLBACK.pill_top_radius - radii.pill_top).abs() < f64::EPSILON);
        assert!((FALLBACK.pill_bottom_radius - radii.pill_bottom).abs() < f64::EPSILON);
        assert!((FALLBACK.shell_ear_radius - radii.shell_ear).abs() < f64::EPSILON);
        assert!((FALLBACK.shell_bottom_radius - radii.shell_bottom).abs() < f64::EPSILON);
    }

    /// Step A14: the overlay must sit above a fullscreen window, not just above
    /// the menu bar. `NSStatusWindowLevel` (25) lost to fullscreen, so the
    /// configured level must be strictly higher, and it must carry both
    /// `FullScreenAuxiliary` and `CanJoinAllSpaces`.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_overlay_clears_a_fullscreen_window_and_joins_every_space() {
        use objc2_app_kit::{NSStatusWindowLevel, NSWindowCollectionBehavior};
        // Above the status (menu bar) level, which is where the old code stopped.
        assert!(
            OVERLAY_WINDOW_LEVEL > NSStatusWindowLevel,
            "the overlay level must clear the status/menu-bar level"
        );
        let behavior = overlay_collection_behavior();
        assert!(behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(behavior.contains(NSWindowCollectionBehavior::Stationary));
        assert!(behavior.contains(NSWindowCollectionBehavior::IgnoresCycle));
        // The bit readback the diagnostics command reports must agree with the
        // constants, so `notch_window_flags` cannot claim a flag that was not set.
        let raw = behavior.0 as u64;
        assert!(raw & FULL_SCREEN_AUXILIARY_BIT != 0);
        assert!(raw & CAN_JOIN_ALL_SPACES_BIT != 0);
    }
}
