//! The notch overlay window (step A0) and its data-driven shell states (step A5).
//!
//! Tauri can make the window transparent / undecorated / always-on-top, but it
//! cannot express the WindowServer details the overlay needs: the window level
//! (above the menu bar), the Space behaviour, or the physical notch geometry.
//! Those come from AppKit, which may only be called on the **main thread**, so
//! every platform call in this module hops there instead of touching `NSScreen`
//! or `NSWindow` from a command thread.
//!
//! ## Shell states are a table, not a boolean
//!
//! Step A4 and earlier drove the shell from a single derived `expanded` boolean
//! and two hardcoded sizes (`idle` / `expanded`). Step A5 replaces that with a
//! table of named states ([`SHELL_STATES`]). Adding a state later means adding
//! **one row** to that table (plus, if it has new body content, one CSS block):
//! geometry, window sizing, hit-testing and animation all read the table.
//!
//! The pure derivation (`ShellDim::resolve`, [`radii_for`], [`shell_rect`]) is
//! kept free of AppKit so it is unit-testable. The window is resized to the
//! active state's frame + margin and the CSS transition runs **inside** the
//! already-grown window, so a growing shell is never clipped.
//!
//! The window's **width is the same for every state** and only its height
//! varies ([`ShellGeometry::window_width`]): a per-state width moved the window's
//! left edge on every transition, and because the webview relayouts a frame
//! behind the native frame change, the CSS-centred shell painted off-centre —
//! the left-edge flash fixed in BUG-1.
//!
//! All coordinates here are AppKit points, so Retina scaling never leaks into
//! the webview's CSS pixel measurements. AppKit screen coordinates put the
//! origin at the bottom-left of the primary display; `y` grows upward.

use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Manager};

mod focus;
mod hover;
mod tap;
mod window;

/// The overlay is the app's only window; the label is pinned by the config.
pub const WINDOW_LABEL: &str = "main";

/// `NSPopUpMenuWindowLevel` (101): above the menu bar (25) and above an
/// ordinary window, so the overlay reads as a system HUD rather than a window
/// (step A14).
///
/// The level is **necessary but not sufficient** over *another* app's
/// fullscreen Space: A14 raised it here and the overlay still vanished, because
/// a regular-policy app is not layered into that Space at all. Step A15 fixed
/// the real gate by making Polaris an accessory app (see
/// [`NotchActivationPolicy`] and `lib.rs::apply_activation_policy`); the level
/// and the collection behaviour [`window::apply_style`] sets still matter for
/// keeping the overlay on top once that Space is joined.
#[cfg(target_os = "macos")]
pub(crate) const OVERLAY_WINDOW_LEVEL: isize = 101;

/// Transparent margin around the shell inside the OS window. The window is the
/// fixed window width (`ShellGeometry::window_width`) by `state height +
/// margin`; the headroom gives the shadow/glow room and keeps a mid-transition
/// shell from ever touching the window edge. The width is deliberately **not**
/// per-state (see [`ShellGeometry::window_width`] and BUG-1).
const WINDOW_MARGIN_SIDE: f64 = 24.0;
const WINDOW_MARGIN_BOTTOM: f64 = 48.0;

/// Width of ONE ear — the strip of shell beside the physical cutout in the
/// `compact` state. There are no pixels behind the camera housing, so all
/// content lives in the two ears; 110 pt holds the longest label
/// ("Enable hold-to-talk") at the 13 pt type scale.
pub const EAR_WIDTH: f64 = 110.0;

/// `panel` state: one 300 pt ear each side and a 420 pt drop. The width is
/// additionally capped at 55% of the screen so the panel can never overflow a
/// narrow display.
const PANEL_EAR_WIDTH: f64 = 300.0;
const PANEL_HEIGHT: f64 = 420.0;
const PANEL_MAX_SCREEN_WIDTH_RATIO: f64 = 0.55;

/// `prompt` state (the folded A6 typed prompt): a notch that grows *slightly*
/// sideways and *slightly* downward — the same visual language as the
/// `compact`/`panel` strip, not a floating sheet.
///
/// * width: exactly the `compact` width (cutout + 2 x [`EAR_WIDTH`]), i.e. the
///   sideways growth the status strip already does;
/// * min height: the cutout plus one comfortable text row ([`PROMPT_TEXT_ROW`]),
///   so it opens as the collapsed-looking notch with a caret in it;
/// * max height: the cutout plus [`PROMPT_MAX_GROWTH`], so a short answer fits
///   under the input and anything longer scrolls inside the body.
const PROMPT_TEXT_ROW: f64 = 44.0;
const PROMPT_MAX_GROWTH: f64 = 200.0;

/// Name of the typed-prompt state. The double-Control tap ([`crate::ctrl_tap`])
/// requests it through the webview reducer; [`crate::notch::tap`] emits the
/// hotkey proposal and the watchdog clears it on a forced collapse.
pub const PROMPT_STATE: &str = "prompt";

/// Centred-pill cutout for displays without a camera housing.
const FALLBACK_CUTOUT: (f64, f64) = (216.0, 34.0);

/// `f64::clamp` is not const on the pinned toolchain, and the fallback/table
/// invariants have to be `const`, so carry a tiny const-callable version.
const fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/* ------------------------------------------------------------------ *
 * Pure geometry model
 * ------------------------------------------------------------------ */

/// One dimension of a shell state, expressed relative to the measured cutout
/// rather than as an absolute number, so the same table works on every display.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ShellDim {
    /// Exactly the measured cutout dimension.
    Cutout,
    /// The cutout plus `per_side` points on each side, never more than
    /// `max_screen_ratio` of the screen.
    CutoutPlus {
        per_side: f64,
        max_screen_ratio: f64,
    },
    /// The cutout plus a fixed number of points (one dimension, not per side).
    CutoutOffset(f64),
    /// A fixed number of points, never more than the screen.
    Fixed(f64),
}

impl ShellDim {
    /// Pure, const resolution against the measured cutout and the screen size.
    /// The clamp is what keeps a wide state from overflowing a narrow display.
    pub const fn resolve(self, cutout: f64, screen: f64) -> f64 {
        let (raw, ratio) = match self {
            Self::Cutout => (cutout, 1.0),
            Self::CutoutPlus {
                per_side,
                max_screen_ratio,
            } => (cutout + 2.0 * per_side, max_screen_ratio),
            Self::CutoutOffset(offset) => (cutout + offset, 1.0),
            Self::Fixed(points) => (points, 1.0),
        };
        clamp(raw, 0.0, screen * ratio)
    }
}

/// Which silhouette a state uses.
///
/// `Pill` is the resting shape that coincides with the hardware cutout (tight
/// convex top + bottom corners). `Shell` is a grown shape: its top edge is flush
/// with the screen and it carries concave "ears" that melt into the screen edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellShape {
    Pill,
    Shell,
}

/// The allowed height range of a **content-driven** state. The state's nominal
/// `height` is the value it opens at (the minimum), and the webview reports its
/// measured content height so Rust can resize within `[min, max]`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellHeightRange {
    pub min: ShellDim,
    pub max: ShellDim,
}

/// One row of the state table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShellStateSpec {
    pub name: &'static str,
    pub width: ShellDim,
    pub height: ShellDim,
    pub shape: ShellShape,
    /// Does this state accept mouse clicks? The click-through watchdog guards
    /// whichever interactive state is active, so more than one row may set this.
    pub interactive: bool,
    /// Does this state accept keyboard input? Only the typed `prompt` state
    /// does; the safety rule is that the native focusable flag has exactly one
    /// writer derived from the runtime state, and is forced off by the watchdog.
    pub focusable: bool,
    /// `Some` for a content-driven state (the measured body may resize it),
    /// `None` for a fixed one.
    pub content_height: Option<ShellHeightRange>,
}

/// Name of the resting state. The watchdog's forced collapse and the default
/// active index resolve it **by name**, never by a hardcoded index, so a new row
/// can be added anywhere in the table.
pub const COLLAPSED_STATE: &str = "collapsed";

/// Initial OS window size declared in `tauri.conf.json`. The largest state must
/// fit inside it, or the first paint would clip before the first `setFrame`.
const INITIAL_WINDOW_WIDTH: f64 = 900.0;
const INITIAL_WINDOW_HEIGHT: f64 = 520.0;

/// The state table. **Adding a named state = adding one row here** (plus an
/// optional CSS block if it has new body content). Replacing this table changes
/// geometry, window sizing and hit-testing at once.
///
/// Deliberately a slice without a fixed length: the table's invariants are
/// validated by [`validate_shell_states`] (run at startup and in the tests) over
/// whatever rows exist, instead of by index-based compile-time asserts that had
/// to be rewritten whenever a row was added.
pub const SHELL_STATES: &[ShellStateSpec] = &[
    ShellStateSpec {
        name: COLLAPSED_STATE,
        width: ShellDim::Cutout,
        height: ShellDim::Cutout,
        shape: ShellShape::Pill,
        interactive: false,
        focusable: false,
        content_height: None,
    },
    ShellStateSpec {
        name: "compact",
        width: ShellDim::CutoutPlus {
            per_side: EAR_WIDTH,
            max_screen_ratio: 1.0,
        },
        height: ShellDim::Cutout,
        shape: ShellShape::Shell,
        interactive: false,
        focusable: false,
        content_height: None,
    },
    // The folded A6 typed prompt: the notch itself, grown just enough for a text
    // row and content-driven from there. This is the first row that is both
    // interactive and focusable; the reducer gives it a sticky, top-priority
    // proposal so a hover cannot collapse it while the user is typing.
    ShellStateSpec {
        name: PROMPT_STATE,
        width: ShellDim::CutoutPlus {
            per_side: EAR_WIDTH,
            max_screen_ratio: 1.0,
        },
        height: ShellDim::CutoutOffset(PROMPT_TEXT_ROW),
        shape: ShellShape::Shell,
        interactive: true,
        focusable: true,
        content_height: Some(ShellHeightRange {
            min: ShellDim::CutoutOffset(PROMPT_TEXT_ROW),
            max: ShellDim::CutoutOffset(PROMPT_TEXT_ROW + PROMPT_MAX_GROWTH),
        }),
    },
    ShellStateSpec {
        name: "panel",
        width: ShellDim::CutoutPlus {
            per_side: PANEL_EAR_WIDTH,
            max_screen_ratio: PANEL_MAX_SCREEN_WIDTH_RATIO,
        },
        height: ShellDim::Fixed(PANEL_HEIGHT),
        shape: ShellShape::Shell,
        interactive: true,
        focusable: false,
        content_height: None,
    },
];

/// Checks the invariants the runtime relies on, over the whole table. Called at
/// startup (a bad table is a hard error) and from the tests. Order-independent:
/// adding, reordering or removing a row needs no assert edits.
pub fn validate_shell_states() -> Result<(), String> {
    if SHELL_STATES.is_empty() {
        return Err("shell state table is empty".into());
    }
    let collapsed = SHELL_STATES
        .iter()
        .find(|spec| spec.name == COLLAPSED_STATE)
        .ok_or_else(|| format!("no `{COLLAPSED_STATE}` state for the forced-collapse target"))?;
    if collapsed.interactive || collapsed.focusable {
        return Err(format!(
            "`{COLLAPSED_STATE}` must be neither interactive nor focusable"
        ));
    }
    let interactive = SHELL_STATES.iter().filter(|spec| spec.interactive).count();
    if interactive == 0 {
        return Err("at least one state must be interactive".into());
    }
    let focusable = SHELL_STATES.iter().filter(|spec| spec.focusable).count();
    if focusable > 1 {
        return Err(format!(
            "at most one state may be focusable, found {focusable}"
        ));
    }
    for spec in SHELL_STATES {
        if spec.focusable && !spec.interactive {
            return Err(format!(
                "state `{}` is focusable but not interactive (a click-through window cannot be typed into)",
                spec.name
            ));
        }
        let width = spec.width.resolve(FALLBACK_CUTOUT.0, 1.0e9);
        // The tallest frame a content-driven state can reach is its maximum.
        let max_height = spec.max_height();
        let height = max_height.resolve(FALLBACK_CUTOUT.1, 1.0e9);
        let min_height = spec.min_height().resolve(FALLBACK_CUTOUT.1, 1.0e9);
        if !(width > 0.0 && height > 0.0) {
            return Err(format!("state `{}` resolves to {width}x{height}", spec.name));
        }
        if min_height > height {
            return Err(format!(
                "state `{}` has min height {min_height} above max height {height}",
                spec.name
            ));
        }
        if width + 2.0 * WINDOW_MARGIN_SIDE > INITIAL_WINDOW_WIDTH
            || height + WINDOW_MARGIN_BOTTOM > INITIAL_WINDOW_HEIGHT
        {
            return Err(format!(
                "state `{}` ({width}x{height}) does not fit the {INITIAL_WINDOW_WIDTH}x\
                 {INITIAL_WINDOW_HEIGHT} initial window",
                spec.name
            ));
        }
    }
    Ok(())
}

impl ShellStateSpec {
    /// The lowest height this state may take. Fixed states are their nominal
    /// height; a content-driven state declares its own floor.
    pub const fn min_height(&self) -> ShellDim {
        match self.content_height {
            Some(range) => range.min,
            None => self.height,
        }
    }

    /// The tallest height this state may take.
    pub const fn max_height(&self) -> ShellDim {
        match self.content_height {
            Some(range) => range.max,
            None => self.height,
        }
    }
}

/// Corner radii for a state, in AppKit points.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Radii {
    pill_top: f64,
    pill_bottom: f64,
    shell_ear: f64,
    shell_bottom: f64,
}

/// Scales the corner radii to the measured cutout and the state's own height.
///
/// The fractions come from two measured references: the hardware cutout's top
/// corners are ~4 pt and its bottom corners ~8 pt (notchbay.com), while
/// boring.notch's `NotchShape` defaults to a 6 pt concave ear and a 14 pt convex
/// bottom. Deriving them from the measured height keeps a 16" display (38 pt
/// cutout) from reusing the 14" numbers; the clamps stop a degenerate screen
/// report from inverting the silhouette.
const fn radii_for(cutout_height: f64, state_height: f64) -> Radii {
    Radii {
        pill_top: clamp(cutout_height * 0.125, 3.0, 5.0),
        pill_bottom: clamp(cutout_height * 0.25, 7.0, 10.0),
        // The grown states derive the ear and the much rounder bottom from the
        // state's own height, so a tall panel gets a proportionally softer edge.
        shell_ear: clamp(state_height * 0.18, 4.0, 8.0),
        shell_bottom: clamp(state_height * 0.45, 10.0, 18.0),
    }
}

/// The cutout/display facts a state is resolved against.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchMetrics {
    pub cutout_width: f64,
    pub cutout_height: f64,
    pub screen_width: f64,
    pub screen_height: f64,
    /// Centre of the measured cutout, in points from the screen's left edge.
    /// The shell is centred on this, not blindly on the screen centre.
    pub cutout_center_x: f64,
    /// `NSScreen.safeAreaInsets().top` — the menu-bar/notch inset.
    pub safe_top: f64,
}

/// One resolved state, ready for CSS. Radii are concrete values, so the webview
/// never has to know which shape a state uses.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellStateGeometry {
    pub name: &'static str,
    pub width: f64,
    pub height: f64,
    pub interactive: bool,
    pub focusable: bool,
    /// Bounds for a content-driven state; equal to `height` when fixed.
    pub min_height: f64,
    pub max_height: f64,
    /// Top-left/top-right convex radius (0 for grown states: their ears own the
    /// top edge).
    pub top_radius: f64,
    /// Bottom convex radius.
    pub bottom_radius: f64,
    /// Concave "ear" radius that melts the shell into the screen edge.
    pub ear_radius: f64,
}

/// The whole shell geometry: every state plus the display it was measured on.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ShellGeometry {
    pub states: Vec<ShellStateGeometry>,
    pub notch: NotchMetrics,
}

impl ShellGeometry {
    /// The one OS-window width shared by every state (the BUG-1 invariant).
    ///
    /// The widest state's shell plus the side margins. Because the window never
    /// changes width, its left edge never moves, so the webview viewport — which
    /// relayouts a frame behind a native frame change — can never paint the
    /// CSS-centred shell off-centre. Only the height varies, and the shell is
    /// top-anchored to the screen, so a downward grow does not move it.
    pub fn window_width(&self) -> f64 {
        self.states
            .iter()
            .map(|state| state.width)
            .fold(0.0, f64::max)
            + 2.0 * WINDOW_MARGIN_SIDE
    }
}

/// The app's `NSApplicationActivationPolicy`, mirrored for diagnostics (step
/// A15/#21).
///
/// A **regular** app's windows are not layered over *another* app's fullscreen
/// Space, however high the window level or however wide the collection
/// behaviour. Only an **accessory** (agent) app — `LSUIElement`,
/// `NSApplicationActivationPolicyAccessory` — gets that layering. Polaris is
/// made accessory in `lib.rs::apply_activation_policy` before the run loop
/// opens the window; this enum is the inspectable form of the policy the overlay
/// is actually running under, logged (and warned about) at startup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NotchActivationPolicy {
    /// Dock icon and app menu bar; not layered over other apps' fullscreen.
    Regular,
    /// Agent app: no Dock icon / menu bar, and windows may float over other
    /// apps' fullscreen Spaces. This is what step A15 requires.
    Accessory,
    /// Can neither activate nor be seen — not used by Polaris.
    Prohibited,
    /// An AppKit value this build does not know (forward compatibility).
    Unknown,
    /// Non-macOS: AppKit activation policy does not exist on this platform.
    Unsupported,
}

/// Maps the live AppKit activation policy to the diagnostics enum (step A15).
///
/// A plain `if` chain over the documented `NSApplicationActivationPolicy`
/// constants, with a [`NotchActivationPolicy::Unknown`] fallback: the AppKit
/// type is a raw `NSInteger`, so a future OS value must not be silently
/// misreported as one of the three known policies.
#[cfg(target_os = "macos")]
pub(crate) fn activation_policy_of(
    policy: objc2_app_kit::NSApplicationActivationPolicy,
) -> NotchActivationPolicy {
    use objc2_app_kit::NSApplicationActivationPolicy;
    if policy == NSApplicationActivationPolicy::Accessory {
        NotchActivationPolicy::Accessory
    } else if policy == NSApplicationActivationPolicy::Regular {
        NotchActivationPolicy::Regular
    } else if policy == NSApplicationActivationPolicy::Prohibited {
        NotchActivationPolicy::Prohibited
    } else {
        NotchActivationPolicy::Unknown
    }
}

/// A rectangle in AppKit screen coordinates (origin bottom-left, `y` up).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
}

/// Resolves one table row against a measured display.
pub fn state_geometry(spec: &ShellStateSpec, notch: &NotchMetrics) -> ShellStateGeometry {
    let width = spec.width.resolve(notch.cutout_width, notch.screen_width);
    let height = spec.height.resolve(notch.cutout_height, notch.screen_height);
    let min_height = spec.min_height().resolve(notch.cutout_height, notch.screen_height);
    let max_height = spec.max_height().resolve(notch.cutout_height, notch.screen_height);
    let radii = radii_for(notch.cutout_height, height);
    let (top_radius, bottom_radius) = match spec.shape {
        // The resting pill's ears are invisible (CSS hides them while
        // collapsed) but keep the grown ear size so the fade-in is gapless.
        ShellShape::Pill => (radii.pill_top, radii.pill_bottom),
        ShellShape::Shell => (0.0, radii.shell_bottom),
    };
    ShellStateGeometry {
        name: spec.name,
        width,
        height,
        interactive: spec.interactive,
        focusable: spec.focusable,
        min_height,
        max_height,
        top_radius,
        bottom_radius,
        ear_radius: radii.shell_ear,
    }
}

/// Builds the full geometry payload from the table and the measured display.
pub fn shell_geometry(notch: NotchMetrics) -> ShellGeometry {
    let states = SHELL_STATES
        .iter()
        .map(|spec| state_geometry(spec, &notch))
        .collect();
    ShellGeometry { states, notch }
}

/// Centred-pill geometry for displays without a notch. Mirrors
/// `FALLBACK_CUTOUT`; kept as a function because the payload now owns a `Vec`.
/// Used by tests (and available to any host without AppKit geometry).
#[cfg(test)]
pub fn fallback_geometry(screen_width: f64, screen_height: f64) -> ShellGeometry {
    shell_geometry(NotchMetrics {
        cutout_width: FALLBACK_CUTOUT.0,
        cutout_height: FALLBACK_CUTOUT.1,
        screen_width,
        screen_height,
        cutout_center_x: screen_width / 2.0,
        safe_top: FALLBACK_CUTOUT.1,
    })
}

/// OS-window size that can host `state` without clipping (shell + margin).
///
/// **The width is the same for every state** ([`ShellGeometry::window_width`],
/// the widest state's shell plus the side margins). Only the height is
/// per-state. This is the fix for the left-edge flash (BUG-1): the OS window may
/// only move/relayout on an axis the page does not depend on. The webview
/// relayouts one frame *behind* a native frame change, so a per-state window
/// width moved the window's left edge (the window is centred on the cutout) and
/// the stale viewport painted the still-centred shell off-centre — a one-frame
/// flash at the left. A constant width and a constant left edge remove that
/// hazard; the shell is top-anchored, so the per-state height growth does not
/// move it either.
pub fn window_size(state: &ShellStateGeometry, _window_width: f64) -> (f64, f64) {
    (state.width + 2.0 * WINDOW_MARGIN_SIDE, state.height + WINDOW_MARGIN_BOTTOM)
}

/// Left edge (global coordinates) of a window centred on the cutout.
///
/// `cutout_center_x` is relative to the screen's left edge; adding the screen
/// origin makes this correct on a secondary display too. This is the function
/// that replaced "assume the cutout is centred on the display".
pub fn window_origin_x(screen_origin_x: f64, cutout_center_x: f64, window_width: f64) -> f64 {
    screen_origin_x + cutout_center_x - window_width / 2.0
}

/// Window frame for `state`: top-anchored to the screen top, centred on the
/// measured cutout, at the one fixed window width every state shares.
pub fn target_frame(
    state: &ShellStateGeometry,
    notch: &NotchMetrics,
    screen_origin_x: f64,
    screen_origin_y: f64,
    window_width: f64,
) -> Rect {
    let (width, height) = window_size(state, window_width);
    Rect {
        x: window_origin_x(screen_origin_x, notch.cutout_center_x, width),
        y: screen_origin_y + notch.screen_height - height,
        width,
        height,
    }
}

/// Screen-coordinate rect of the visible shell body (used for hit-testing).
///
/// The shell is centred on the cutout and hangs from the screen top, so this is
/// independent of the window margin.
pub fn shell_rect(
    state: &ShellStateGeometry,
    notch: &NotchMetrics,
    screen_origin_x: f64,
    screen_origin_y: f64,
) -> Rect {
    Rect {
        x: screen_origin_x + notch.cutout_center_x - state.width / 2.0,
        y: screen_origin_y + notch.screen_height - state.height,
        width: state.width,
        height: state.height,
    }
}

/// Smallest rectangle containing both, used to grow the window before a CSS
/// expansion and never shrink it mid-animation. All shell frames share the same
/// top edge **and the same fixed width/left edge** (BUG-1), so the union only
/// ever grows downward — it can never move the window's horizontal column while
/// the webview viewport is a frame behind.
pub fn grow_union(current: Rect, target: Rect) -> Rect {
    let left = current.x.min(target.x);
    let right = (current.x + current.width).max(target.x + target.width);
    let top = (current.y + current.height).max(target.y + target.height);
    let bottom = current.y.min(target.y);
    Rect {
        x: left,
        y: bottom,
        width: right - left,
        height: top - bottom,
    }
}

/// Frame to apply after re-reading the display. `grow_union` is only safe while
/// both frames live on the **same** display; when the display moved (a monitor
/// was plugged/unplugged, or the arrangement changed) a union of the old and new
/// origins would stretch the window across every monitor in between. In that
/// case snap straight to the target instead of growing.
pub fn reconcile_window_frame(current: Rect, target: Rect, display_changed: bool) -> Rect {
    if display_changed {
        target
    } else {
        grow_union(current, target)
    }
}

/* ------------------------------------------------------------------ *
 * Runtime state
 * ------------------------------------------------------------------ */

/// Shared, app-lifetime shell state. The hover monitor and the state commands
/// both read it; the pure geometry above is what they operate on.
pub struct ShellRuntime {
    inner: Mutex<RuntimeState>,
}

struct RuntimeState {
    geometry: ShellGeometry,
    /// AppKit origin of the display the shell lives on.
    origin_x: f64,
    origin_y: f64,
    /// Index into `geometry.states` of the state the UI last requested.
    active_index: usize,
    /// True while the native window is receiving mouse events. This is the
    /// single source of truth: the native click-through flag is always written
    /// as `!interactive` by [`sync_native_interactivity`], and what was written
    /// is recorded in `native_interactive`, so the two cannot drift.
    interactive: bool,
    /// The value the OS flag was last set to (`Some(interactive)` after a write).
    native_interactive: Option<bool>,
    /// True while the native window accepts keyboard input. Same single-writer
    /// contract as `interactive`: only [`sync_native_focusability`] writes the
    /// OS flag, always derived from this field.
    focusable: bool,
    /// The focusable value the OS flag was last set to.
    native_focusable: Option<bool>,
    /// Whether the window is currently the key window (Tauri `WindowEvent`).
    /// Used only to keep the click-through watchdog from collapsing a prompt the
    /// user is actively typing into; the moment focus is lost the watchdog
    /// resumes guarding the window (see [`ShellRuntime::watchdog_decision`]).
    focused: bool,
    /// Measured height override for a content-driven state, already clamped to
    /// the state's `[min_height, max_height]`. `None` means "use the nominal".
    content_height: Option<f64>,
    /// Last hover sample, or `None` before the first mouse move.
    last_inside: Option<bool>,
    /// When the cursor was last seen outside the active shell rect.
    outside_since: Option<Instant>,
}

/// What a forced collapse did, so the caller can restore every OS flag and
/// notify the UI about the states it left behind.
pub struct ForcedCollapse {
    /// Exact frame of the collapsed state, if the table defines one.
    pub frame: Option<Rect>,
    /// Whether the hover edge changed (inside -> outside), so the caller knows
    /// whether to emit `notch_hover`.
    pub hover_changed: bool,
    /// Whether a focusable (prompt) state was active, so the caller also emits
    /// the hotkey proposal that clears the webview's sticky prompt latch.
    pub left_prompt: bool,
}

/// The result of re-reading the display geometry.
pub struct DisplayUpdate {
    /// Exact frame of the active state on the (possibly new) display.
    pub target: Rect,
    /// Whether the display's origin or size changed, i.e. a topology change
    /// where [`grow_union`] must not be used across the old and new origins.
    pub display_changed: bool,
}

impl ShellRuntime {
    pub fn new(geometry: ShellGeometry, origin_x: f64, origin_y: f64) -> Self {
        Self {
            inner: Mutex::new(RuntimeState {
                geometry,
                origin_x,
                origin_y,
                active_index: 0,
                interactive: false,
                native_interactive: None,
                focusable: false,
                native_focusable: None,
                focused: false,
                content_height: None,
                last_inside: None,
                outside_since: None,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, RuntimeState> {
        // A panic while holding the lock must not wedge the overlay (which
        // would leave the window eating clicks); recover the inner value.
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Replaces the measured display facts and returns the active state's
    /// target frame, flagging whether the display itself moved.
    pub fn update_display(
        &self,
        geometry: ShellGeometry,
        origin_x: f64,
        origin_y: f64,
    ) -> Result<DisplayUpdate, String> {
        let mut rt = self.lock();
        let display_changed = rt.origin_x != origin_x
            || rt.origin_y != origin_y
            || rt.geometry.notch.screen_width != geometry.notch.screen_width
            || rt.geometry.notch.screen_height != geometry.notch.screen_height;
        rt.geometry = geometry;
        rt.origin_x = origin_x;
        rt.origin_y = origin_y;
        Ok(DisplayUpdate {
            target: rt.target_frame(rt.active_index)?,
            display_changed,
        })
    }

    /// Resolves a state name to `(index, geometry)`.
    pub fn state_named(&self, name: &str) -> Option<(usize, ShellStateGeometry)> {
        let rt = self.lock();
        rt.geometry
            .states
            .iter()
            .position(|state| state.name == name)
            .map(|index| (index, rt.geometry.states[index]))
    }

    /// Marks `index` as the requested state and returns its target frame.
    pub fn set_active(&self, index: usize) -> Result<(ShellStateGeometry, Rect), String> {
        let mut rt = self.lock();
        let state = *rt
            .geometry
            .states
            .get(index)
            .ok_or_else(|| format!("shell state index {index} out of range"))?;
        rt.active_index = index;
        rt.interactive = state.interactive;
        rt.focusable = state.focusable;
        // A freshly requested state opens at its nominal height; the webview
        // reports its measured content afterwards.
        rt.content_height = None;
        rt.outside_since = None;
        let frame = rt.target_frame(index)?;
        Ok((state, frame))
    }

    /// Stores a measured, clamped height for the active content-driven state and
    /// returns the value actually stored. A fixed state ignores the report and
    /// returns its nominal height.
    pub fn set_content_height(&self, height: f64) -> Result<f64, String> {
        let mut rt = self.lock();
        let state = rt
            .geometry
            .states
            .get(rt.active_index)
            .copied()
            .ok_or_else(|| "no active shell state".to_string())?;
        if state.max_height <= state.min_height {
            return Ok(state.height);
        }
        let clamped = clamp(height, state.min_height, state.max_height);
        rt.content_height = Some(clamped);
        Ok(clamped)
    }

    /// True while the native window accepts keyboard input.
    pub fn is_focusable(&self) -> bool {
        self.lock().focusable
    }

    /// Records the value the native focusable flag was just set to. Only
    /// [`sync_native_focusability`] may call this.
    pub fn note_native_focusable(&self, focusable: bool) {
        self.lock().native_focusable = Some(focusable);
    }

    /// The native focusable flag last written, or `None` before the first write.
    pub fn native_focusable(&self) -> Option<bool> {
        self.lock().native_focusable
    }

    /// Records the window's key/focus state (from Tauri's `Focused` event).
    pub fn set_focused(&self, focused: bool) {
        self.lock().focused = focused;
    }

    /// Whether the active state's name equals `name`.
    pub fn active_state_is(&self, name: &str) -> bool {
        let rt = self.lock();
        rt.geometry
            .states
            .get(rt.active_index)
            .is_some_and(|state| state.name == name)
    }

    /// Target frame of the currently active state (exact, for commit).
    pub fn active_target_frame(&self) -> Result<(usize, Rect), String> {
        let rt = self.lock();
        Ok((rt.active_index, rt.target_frame(rt.active_index)?))
    }

    /// True while the native window accepts mouse input.
    pub fn is_interactive(&self) -> bool {
        self.lock().interactive
    }

    /// Records the value the native click-through flag was just set to. Only
    /// [`sync_native_interactivity`] may call this, so `native_interactive` is a
    /// faithful log of the OS state and the invariant can be checked.
    pub fn note_native_interactive(&self, interactive: bool) {
        self.lock().native_interactive = Some(interactive);
    }

    /// The native flag last written, or `None` before the first write. Used by
    /// the tests to pin the `native == interactive` invariant.
    #[cfg(test)]
    pub fn native_interactive(&self) -> Option<bool> {
        self.lock().native_interactive
    }

    /// True once the cursor has been outside the active shell rect for
    /// `grace`, **and** the window is not the focused/key window. A focused
    /// window is not stranded: the user is in it, and clicks outside its own
    /// rect already reach the app underneath. The moment focus is lost the
    /// predicate resumes guarding, so a frozen webview that never sees the blur
    /// is still restored by the watchdog.
    pub fn outside_for_longer_than(&self, grace: std::time::Duration) -> bool {
        let rt = self.lock();
        rt.interactive
            && !rt.focused
            && rt
                .outside_since
                .is_some_and(|since| since.elapsed() >= grace)
    }

    /// Records a cursor sample. Returns the new inside value only when it
    /// **changed**, so the monitor can debounce its event on this.
    pub fn observe_cursor(&self, x: f64, y: f64, now: Instant) -> Option<bool> {
        let mut rt = self.lock();
        let inside = rt.inside_at(x, y)?;
        let changed = rt.last_inside != Some(inside);
        rt.last_inside = Some(inside);
        rt.track_outside(inside, now);
        changed.then_some(inside)
    }

    /// The watchdog's per-tick decision, given an **actively sampled** cursor
    /// position. It refreshes the outside timer but deliberately leaves
    /// `last_inside` alone: if it consumed a hover edge the monitor would never
    /// emit it, and a sampler running every 250 ms would then eat real hovers.
    /// Returns true when the overlay must be forced click-through.
    pub fn watchdog_decision(
        &self,
        x: f64,
        y: f64,
        now: Instant,
        grace: std::time::Duration,
    ) -> bool {
        {
            let mut rt = self.lock();
            if let Some(inside) = rt.inside_at(x, y) {
                rt.track_outside(inside, now);
            }
        }
        self.outside_for_longer_than(grace)
    }

    /// Decides whether a commit for `name` still applies to the live state.
    /// Returns `(applies, active_index)` so the caller can shrink to the exact
    /// frame only when the commit is not stale — this is what makes a fast
    /// A -> B -> A ordering safe.
    pub fn resolve_commit(&self, name: &str) -> Result<(bool, usize), String> {
        let rt = self.lock();
        let index = rt
            .geometry
            .states
            .iter()
            .position(|state| state.name == name)
            .ok_or_else(|| format!("unknown shell state `{name}`"))?;
        Ok((index == rt.active_index, rt.active_index))
    }

    /// Forces the collapsed state without touching the window. Returns the
    /// collapsed target frame (if the table defines one) plus whether the hover
    /// edge changed and whether a prompt was left behind, so the caller can
    /// restore every OS flag and clear the webview's sticky prompt latch.
    fn mark_forced_collapse(&self) -> ForcedCollapse {
        let mut rt = self.lock();
        let left_prompt = rt.focusable;
        let collapsed = rt
            .geometry
            .states
            .iter()
            .position(|state| state.name == COLLAPSED_STATE);
        let frame = collapsed.and_then(|index| rt.target_frame(index).ok());
        if let Some(index) = collapsed {
            rt.active_index = index;
        }
        rt.interactive = false;
        rt.focusable = false;
        rt.content_height = None;
        rt.outside_since = None;
        let hover_changed = rt.last_inside != Some(false);
        rt.last_inside = Some(false);
        ForcedCollapse {
            frame,
            hover_changed,
            left_prompt,
        }
    }
}

impl RuntimeState {
    fn target_frame(&self, index: usize) -> Result<Rect, String> {
        let mut state = *self
            .geometry
            .states
            .get(index)
            .ok_or_else(|| format!("shell state index {index} out of range"))?;
        // The active content-driven state uses its measured height; the
        // override is already clamped, but clamp again so a stale value can
        // never outlive a table change.
        if index == self.active_index {
            if let Some(height) = self.content_height {
                state.height = clamp(height, state.min_height, state.max_height);
            }
        }
        Ok(target_frame(
            &state,
            &self.geometry.notch,
            self.origin_x,
            self.origin_y,
            self.geometry.window_width(),
        ))
    }

    /// Is the point inside the active state's shell rect? `None` if the table
    /// has no active row (before the first geometry resolves).
    fn inside_at(&self, x: f64, y: f64) -> Option<bool> {
        let state = self.geometry.states.get(self.active_index).copied()?;
        Some(
            shell_rect(&state, &self.geometry.notch, self.origin_x, self.origin_y)
                .contains(x, y),
        )
    }

    /// Advances the "cursor outside" timer from one sample. Kept in one place so
    /// the event monitor and the active watchdog poll agree on the semantics.
    fn track_outside(&mut self, inside: bool, now: Instant) {
        if inside {
            self.outside_since = None;
        } else if self.outside_since.is_none() {
            self.outside_since = Some(now);
        }
    }
}

/* ------------------------------------------------------------------ *
 * Setup / teardown
 * ------------------------------------------------------------------ */

/// Configures AppKit geometry and reveals the overlay. Runs from `setup`, i.e.
/// on the main thread, so platform calls need no extra hop here.
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    if let Err(error) = validate_shell_states() {
        eprintln!("polaris: invalid shell state table: {error}");
        return Err(tauri::Error::Io(std::io::Error::other(error)));
    }

    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or(tauri::Error::WindowNotFound)?;
    let handle = app.handle().clone();
    // The overlay must never eat a click meant for the app underneath it. This
    // is the safe default until a state explicitly asks to be interactive; it is
    // written through the same single path the later toggles use.
    platform(&handle, |app| window::set_ignore_cursor_events(app, true))?;

    let info = platform(&handle, window::measure)?;
    platform(&handle, window::apply_style)?;

    // Step A15/#21: the overlay floats over *another* app's fullscreen Space
    // only when Polaris runs as an accessory app (set in `lib.rs` before the run
    // loop opens the window). Read the policy off the running app and warn
    // loudly if it is not Accessory: the window level and collection behaviour
    // are necessary but not sufficient.
    let activation_policy = window::activation_policy();
    println!("polaris: notch activation policy {activation_policy:?}");
    #[cfg(target_os = "macos")]
    if activation_policy != NotchActivationPolicy::Accessory {
        eprintln!(
            "polaris: WARNING overlay activation policy is {activation_policy:?}, not Accessory — \
             the overlay will not float over another app's fullscreen Space"
        );
    }

    let geometry = shell_geometry(info.metrics);
    println!("polaris: notch geometry {geometry:?}");
    // One fixed window column for every state (BUG-1); logged so a regression
    // that reintroduces a per-state width is visible in the startup trace.
    println!("polaris: notch window width {}", geometry.window_width());
    let runtime = ShellRuntime::new(geometry, info.origin_x, info.origin_y);
    // Size the window for the initial collapsed state before showing it.
    let (_, frame) = runtime
        .active_target_frame()
        .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    platform(&handle, |app| window::set_frame(app, frame))?;
    app.manage(runtime);
    // Record the safe defaults in the runtime too, so `native == interactive`
    // and `native_focusable == focusable` hold from the very first frame.
    platform(&handle, sync_native_interactivity)?;
    platform(&handle, sync_native_focusability)?;

    // Hover detection (a global + local mouseMoved monitor) and the safety
    // watchdog that restores click-through and non-focusability if an
    // interactive state is stranded.
    app.manage(hover::install(&handle));

    // The double-Control detector now proposes the `prompt` shell state instead
    // of a second window; it registers on the same modifier monitors the
    // push-to-talk gesture uses.
    tap::install(&handle);

    window.show()?;
    Ok(())
}

/// Removes the hover monitors and forces click-through plus non-focusability.
/// Runs on the main thread from the run-loop exit callback.
pub fn teardown(app: &AppHandle) {
    hover::teardown(app);
    force_click_through(app);
}

/// Records the window's key/focus state. Called from the run loop's
/// `WindowEvent::Focused`; safe before the runtime is managed.
pub fn set_focused(app: &AppHandle, focused: bool) {
    if let Some(runtime) = app.try_state::<ShellRuntime>() {
        runtime.set_focused(focused);
    }
}

/// Safety net: restores native click-through and non-focusability and collapses
/// the runtime to the resting state. The whole sequence runs as one
/// main-thread task so it is serialized with the state commands: no concurrent
/// request can re-enable the click-eating flag between the collapse and the
/// native write. Native click-through and non-focusability are applied
/// **first**, so the safety property holds even if the frame move fails.
pub fn force_click_through(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if handle.try_state::<ShellRuntime>().is_none() {
            // The runtime is not managed yet (early startup): still guarantee
            // click-through on whatever window exists.
            if let Err(error) = window::set_ignore_cursor_events(&handle, true) {
                eprintln!("polaris: could not restore click-through: {error}");
            }
            if let Err(error) = window::set_focusable(&handle, false) {
                eprintln!("polaris: could not restore non-focusability: {error}");
            }
            return;
        }
        let collapsed = handle.state::<ShellRuntime>().mark_forced_collapse();
        if let Err(error) = sync_native_interactivity(&handle) {
            eprintln!("polaris: could not restore click-through: {error}");
        }
        if let Err(error) = sync_native_focusability(&handle) {
            eprintln!("polaris: could not restore non-focusability: {error}");
        }
        if let Some(frame) = collapsed.frame {
            if let Err(error) = window::set_frame(&handle, frame) {
                eprintln!("polaris: could not collapse the overlay frame: {error}");
            }
        }
        if collapsed.hover_changed {
            crate::events::emit_notch_hover(&handle, false);
        }
        // The sticky prompt latch lives in the webview; tell it the state is
        // gone so it does not immediately request the prompt back.
        if collapsed.left_prompt {
            crate::events::emit_notch_hotkey(&handle, false);
        }
    }) {
        eprintln!("polaris: could not schedule click-through: {error}");
    }
}

/// The **single writer** of the native click-through flag. Reads the guarded
/// `runtime.interactive`, writes the OS flag as its inverse, and records what was
/// written. Running only on the main thread (the caller's contract) and mutating
/// `interactive` only on the main thread makes `native_interactive ==
/// Some(interactive)` an invariant, not a hope.
fn sync_native_interactivity(app: &AppHandle) -> Result<(), String> {
    let Some(runtime) = app.try_state::<ShellRuntime>() else {
        return Ok(());
    };
    let interactive = runtime.is_interactive();
    window::set_ignore_cursor_events(app, !interactive)?;
    runtime.note_native_interactive(interactive);
    Ok(())
}

/// The **single writer** of the native focusable flag, the counterpart of
/// [`sync_native_interactivity`]. Reads the guarded `runtime.focusable`, writes
/// the OS flag, and records what was written; running only on the main thread
/// makes `native_focusable == Some(focusable)` an invariant.
///
/// On the transition to focusable it also remembers which app was frontmost and
/// takes first-responder focus (the text field must receive keys). On the
/// transition away it hands keyboard focus back to that app, which the overlay
/// being `focusable: false` alone does not do.
fn sync_native_focusability(app: &AppHandle) -> Result<(), String> {
    let Some(runtime) = app.try_state::<ShellRuntime>() else {
        return Ok(());
    };
    let focusable = runtime.is_focusable();
    let previously = runtime.native_focusable();
    window::set_focusable(app, focusable)?;
    if focusable && previously != Some(true) {
        focus::remember_frontmost();
        if let Err(error) = window::focus(app) {
            eprintln!("polaris: could not focus the prompt shell: {error}");
        }
    } else if !focusable && previously == Some(true) {
        focus::restore_frontmost();
    }
    runtime.note_native_focusable(focusable);
    Ok(())
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/// Re-reads the display geometry and repositions the overlay. Called on startup
/// and periodically by the webview so display topology changes are picked up.
/// Returns every state at once plus the measured notch metrics.
#[tauri::command]
pub async fn notch_geometry(app: AppHandle) -> Result<ShellGeometry, String> {
    let measure_handle = app.clone();
    let info = on_main(&app, move || window::measure(&measure_handle)).await?;

    let geometry = shell_geometry(info.metrics);
    let runtime = app.state::<ShellRuntime>();
    let update = runtime.update_display(geometry.clone(), info.origin_x, info.origin_y)?;

    // Grow-only while the display is unchanged: a poll must never clip a state
    // transition that is in flight. If the display moved, snap to the exact
    // target so the union cannot stretch the window across two monitors.
    let frame_handle = app.clone();
    on_main(&app, move || {
        let current = window::frame(&frame_handle)?;
        window::set_frame(
            &frame_handle,
            reconcile_window_frame(current, update.target, update.display_changed),
        )
    })
    .await?;

    Ok(geometry)
}

/// Grow-before-animate: immediately grows the OS window to `max(current,
/// target)` so the CSS expansion is never clipped, applies the state's
/// interactivity, and returns the state geometry.
#[tauri::command]
pub async fn shell_request_state(
    app: AppHandle,
    name: String,
) -> Result<ShellStateGeometry, String> {
    let request = name.clone();
    let handle = app.clone();
    on_main(&app, move || {
        let runtime = handle.state::<ShellRuntime>();
        let (index, state) = runtime
            .state_named(&request)
            .ok_or_else(|| format!("unknown shell state `{request}`"))?;
        let (_, target) = runtime.set_active(index)?;
        let current = window::frame(&handle)?;
        window::set_frame(&handle, grow_union(current, target))?;
        // Interactivity and focusability are applied in the same serialized
        // main-thread section as the state change. A late-arriving request
        // therefore cannot toggle either OS flag on its own (the old code did
        // this after an `.await`, which let two requests interleave and leave
        // the OS flags out of step with the guarded state).
        sync_native_interactivity(&handle)?;
        sync_native_focusability(&handle)?;
        Ok(state)
    })
    .await
}

/// Shrink-after-animate: the UI calls this on `transitionend`; the window snaps
/// to exactly the committed state and interactivity is re-applied. A commit for
/// a state that is no longer active is ignored, so a fast A->B->A transition
/// cannot shrink the window under a newer request.
#[tauri::command]
pub async fn shell_commit_state(app: AppHandle, name: String) -> Result<(), String> {
    let request = name.clone();
    let handle = app.clone();
    on_main(&app, move || {
        let runtime = handle.state::<ShellRuntime>();
        let (applies, _active) = runtime.resolve_commit(&request)?;
        if applies {
            let (_, frame) = runtime.active_target_frame()?;
            window::set_frame(&handle, frame)?;
        }
        // Stale or not, re-assert both flags from the live state, in the same
        // main-thread section as the (possible) frame move.
        sync_native_interactivity(&handle)?;
        sync_native_focusability(&handle)?;
        Ok(())
    })
    .await
}

/// Reports the measured height of the active content-driven state's body and
/// resizes the shell within its declared bounds. Grow-before-animate applies to
/// content too: the window grows immediately so the CSS height tween is never
/// clipped, and the guaranteed commit path (`shell_commit_state`) shrinks it
/// back to the exact frame afterwards. Returns the clamped height the CSS must
/// use, so the webview and the native frame stay in lock-step.
#[tauri::command]
pub async fn shell_resize_content(app: AppHandle, height: f64) -> Result<f64, String> {
    let handle = app.clone();
    on_main(&app, move || {
        let runtime = handle.state::<ShellRuntime>();
        let clamped = runtime.set_content_height(height)?;
        let (_, target) = runtime.active_target_frame()?;
        let current = window::frame(&handle)?;
        window::set_frame(&handle, grow_union(current, target))?;
        Ok(clamped)
    })
    .await
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/// Runs a platform closure on the AppKit main thread and awaits its result.
///
/// `NSScreen`/`NSWindow` are main-thread-only, so commands hop to the event loop
/// and block their worker until it answers.
async fn on_main<T, F>(app: &AppHandle, task: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    app.run_on_main_thread(move || {
        let _ = sender.send(task());
    })
    .map_err(|error| error.to_string())?;

    tauri::async_runtime::spawn_blocking(move || receiver.recv())
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?
}

/// Runs a platform `Result` closure and maps its error into a `tauri::Error`.
fn platform<T>(
    app: &AppHandle,
    task: impl FnOnce(&AppHandle) -> Result<T, String>,
) -> tauri::Result<T> {
    task(app).map_err(|error| tauri::Error::Io(std::io::Error::other(error)))
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// The built-in 14" reference display: measured cutout 179 x 32.
    fn reference() -> NotchMetrics {
        NotchMetrics {
            cutout_width: 179.0,
            cutout_height: 32.0,
            screen_width: 1512.0,
            screen_height: 982.0,
            cutout_center_x: 756.0,
            safe_top: 32.0,
        }
    }

    fn state(geometry: &ShellGeometry, name: &str) -> ShellStateGeometry {
        geometry
            .states
            .iter()
            .copied()
            .find(|state| state.name == name)
            .unwrap_or_else(|| panic!("no state named {name}"))
    }

    /// Index of a state by name, so tests never hardcode table positions.
    fn index_of(runtime: &ShellRuntime, name: &str) -> usize {
        runtime
            .state_named(name)
            .unwrap_or_else(|| panic!("no state named {name}"))
            .0
    }

    #[test]
    fn per_state_sizes_derive_from_the_measured_cutout() {
        let geometry = shell_geometry(reference());

        let collapsed = state(&geometry, "collapsed");
        assert_eq!((collapsed.width, collapsed.height), (179.0, 32.0));
        assert!(!collapsed.interactive);

        let compact = state(&geometry, "compact");
        assert_eq!((compact.width, compact.height), (399.0, 32.0));
        assert_eq!((compact.width - 179.0) / 2.0, EAR_WIDTH);
        assert!(!compact.interactive);
        assert!(!compact.focusable);

        // The prompt is the compact width with one text row of extra height,
        // and it is the only interactive + focusable state.
        let prompt = state(&geometry, "prompt");
        assert_eq!(prompt.width, compact.width);
        assert_eq!(prompt.height, 32.0 + PROMPT_TEXT_ROW);
        assert_eq!(prompt.min_height, 32.0 + PROMPT_TEXT_ROW);
        assert_eq!(prompt.max_height, 32.0 + PROMPT_TEXT_ROW + PROMPT_MAX_GROWTH);
        assert!(prompt.interactive);
        assert!(prompt.focusable);

        let panel = state(&geometry, "panel");
        assert_eq!((panel.width, panel.height), (779.0, 420.0));
        assert!(panel.interactive);
        assert!(!panel.focusable);
    }

    #[test]
    fn a_wide_state_is_clamped_to_its_screen_ratio() {
        // 800 pt wide display: the panel's 0.55 cap (440 pt) must win over the
        // nominal cutout + 600 pt.
        let mut notch = reference();
        notch.screen_width = 800.0;
        let geometry = shell_geometry(notch);
        let panel = state(&geometry, "panel").width;
        assert!((panel - 440.0).abs() < 0.01, "got {panel}");
    }

    #[test]
    fn fixed_and_cutout_dims_never_go_negative_on_a_degenerate_report() {
        assert_eq!(ShellDim::Cutout.resolve(-12.0, 800.0), 0.0);
        assert_eq!(ShellDim::Fixed(420.0).resolve(32.0, 0.0), 0.0);
    }

    #[test]
    fn collapsed_is_a_pill_and_grown_states_are_shells() {
        let geometry = shell_geometry(reference());
        let collapsed = state(&geometry, "collapsed");
        // The pill owns a tight convex top and bottom.
        assert!((collapsed.top_radius - 4.0).abs() < f64::EPSILON);
        assert!((collapsed.bottom_radius - 8.0).abs() < f64::EPSILON);

        // A grown shell is flush with the screen top (0) and rounder at the
        // bottom; both derive from the state's own height.
        let compact = state(&geometry, "compact");
        assert_eq!(compact.top_radius, 0.0);
        assert!((compact.bottom_radius - 14.4).abs() < 0.01);
        assert!((compact.ear_radius - 5.76).abs() < 0.01);

        let panel = state(&geometry, "panel");
        assert_eq!(panel.top_radius, 0.0);
        // 420 * 0.45 = 189 clamps to the 18 pt ceiling.
        assert!((panel.bottom_radius - 18.0).abs() < f64::EPSILON);
        assert!((panel.ear_radius - 8.0).abs() < f64::EPSILON);
    }

    #[test]
    fn window_is_centred_on_the_cutout_not_the_screen() {
        // Cutout centre at 756 on a 1512 wide display is the screen centre, but
        // the derivation must not assume that.
        assert!((window_origin_x(0.0, 756.0, 827.0) - 342.5).abs() < 0.01);
    }

    #[test]
    fn off_centre_cutout_centring_and_screen_origin_are_respected() {
        // Cutout at 700 on the primary display.
        assert!((window_origin_x(0.0, 700.0, 400.0) - 500.0).abs() < 0.01);
        // Same cutout, but the display itself starts at x=200 (secondary).
        assert!((window_origin_x(200.0, 700.0, 400.0) - 700.0).abs() < 0.01);
    }

    #[test]
    fn state_table_round_trips_to_the_serialized_geometry() {
        let geometry = fallback_geometry(1512.0, 982.0);
        let json = serde_json::to_value(&geometry).unwrap();

        // Look states up by name: the table's order is an implementation
        // detail and adding a row must not rewrite this test.
        let row = |name: &str| -> &serde_json::Value {
            json["states"]
                .as_array()
                .unwrap()
                .iter()
                .find(|state| state["name"] == name)
                .unwrap_or_else(|| panic!("no serialized state named {name}"))
        };

        assert_eq!(row("collapsed")["interactive"], false);
        assert_eq!(row("collapsed")["focusable"], false);
        assert_eq!(row("compact")["width"], 216.0 + 2.0 * EAR_WIDTH);
        assert_eq!(row("compact")["earRadius"], row("collapsed")["earRadius"]);
        assert_eq!(row("prompt")["focusable"], true);
        assert_eq!(row("prompt")["interactive"], true);
        assert_eq!(
            row("prompt")["minHeight"],
            FALLBACK_CUTOUT.1 + PROMPT_TEXT_ROW
        );
        assert_eq!(
            row("prompt")["maxHeight"],
            FALLBACK_CUTOUT.1 + PROMPT_TEXT_ROW + PROMPT_MAX_GROWTH
        );
        assert_eq!(row("panel")["height"], PANEL_HEIGHT);
        assert_eq!(row("panel")["interactive"], true);
        // camelCase field names are the TS seam.
        assert_eq!(json["notch"]["cutoutWidth"], FALLBACK_CUTOUT.0);
        assert_eq!(json["notch"]["cutoutCenterX"], 756.0);
    }

    #[test]
    fn hit_testing_respects_the_state_rect() {
        let notch = reference();
        let geometry = shell_geometry(notch);
        let collapsed = state(&geometry, "collapsed");
        let rect = shell_rect(&collapsed, &notch, 0.0, 0.0);

        // Hangs from the screen top, centred on the cutout.
        assert!((rect.x - 666.5).abs() < 0.01);
        assert!((rect.y - (982.0 - 32.0)).abs() < 0.01);
        assert!((rect.width, rect.height) == (179.0, 32.0));

        // A point in the cutout is inside; just below it is not; so is a point
        // beside it inside the screen.
        assert!(rect.contains(700.0, 970.0));
        assert!(!rect.contains(700.0, 900.0));
        assert!(!rect.contains(300.0, 970.0));

        // The panel rect is taller and wider, so a point below the cutout is
        // inside the panel but outside the collapsed pill.
        let panel = state(&geometry, "panel");
        let panel_rect = shell_rect(&panel, &notch, 0.0, 0.0);
        assert!(panel_rect.contains(700.0, 900.0));
        assert!(!rect.contains(700.0, 900.0));
    }

    #[test]
    fn grow_union_never_shrinks_and_keeps_the_top_edge() {
        let notch = reference();
        let geometry = shell_geometry(notch);
        let width = geometry.window_width();
        let collapsed = target_frame(&state(&geometry, "collapsed"), &notch, 0.0, 0.0, width);
        let panel = target_frame(&state(&geometry, "panel"), &notch, 0.0, 0.0, width);

        let union = grow_union(collapsed, panel);
        assert!(union.width >= panel.width);
        assert!(union.height >= panel.height);
        assert!((union.y + union.height - (collapsed.y + collapsed.height)).abs() < f64::EPSILON);
        assert_eq!(union, panel);
    }

    /// BUG-1 invariant: the shell is concentric with the cutout in **every**
    /// state and is never anchored to a moving window edge. Every state's target
    /// frame must therefore share one left edge and one width (the fixed window
    /// width), centred on the measured cutout. If a state regains a per-state
    /// width, the window's left edge starts moving again and the stale-viewport
    /// paint returns.
    #[test]
    fn every_state_shares_one_centred_window_column() {
        let notch = reference();
        let geometry = shell_geometry(notch);
        let width = geometry.window_width();
        assert!(
            width >= geometry
                .states
                .iter()
                .map(|state| state.width)
                .fold(0.0, f64::max),
            "the window must host the widest shell"
        );

        let expected_x = window_origin_x(0.0, notch.cutout_center_x, width);
        for spec in SHELL_STATES {
            let frame = target_frame(&state(&geometry, spec.name), &notch, 0.0, 0.0, width);
            assert_eq!(frame.width, width, "state `{}` changed the window width", spec.name);
            assert_eq!(frame.x, expected_x, "state `{}` moved the window left edge", spec.name);
            // Centred on the cutout: the centre of the window is the cutout
            // centre. This is what the CSS `justify-content: center` relies on.
            assert!(
                (frame.x + frame.width / 2.0 - notch.cutout_center_x).abs() < f64::EPSILON,
                "state `{}` is not concentric with the cutout",
                spec.name
            );
        }
    }

    #[test]
    fn fallback_geometry_matches_the_table() {
        let geometry = fallback_geometry(1512.0, 982.0);
        assert_eq!(geometry.notch.cutout_width, FALLBACK_CUTOUT.0);
        assert_eq!(geometry.notch.cutout_height, FALLBACK_CUTOUT.1);
        assert_eq!(geometry.notch.cutout_center_x, 756.0);
        assert_eq!(geometry.states.len(), SHELL_STATES.len());
        // The forced-collapse target is resolved by name, so its position in the
        // table does not matter.
        assert!(geometry.states.iter().any(|s| s.name == COLLAPSED_STATE));
    }

    #[test]
    fn shell_state_table_satisfies_the_runtime_invariants() {
        // Replaces the old index-based compile-time asserts: adding, reordering
        // or removing a row is checked by walking whatever rows exist.
        validate_shell_states().expect("a valid state table is a hard requirement");
    }

    #[test]
    fn watchdog_predicate_fires_only_for_a_stranded_interactive_shell() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        // Collapsed is not interactive: an outside cursor never trips it.
        runtime.observe_cursor(0.0, 0.0, Instant::now());
        assert!(!runtime.outside_for_longer_than(Duration::ZERO));

        // Panel is interactive; a cursor outside its rect trips the predicate
        // (a zero grace stands in for the 1.5 s watchdog window).
        let panel = index_of(&runtime, "panel");
        assert!(runtime.set_active(panel).unwrap().0.interactive);
        runtime.observe_cursor(0.0, 0.0, Instant::now());
        assert!(runtime.outside_for_longer_than(Duration::ZERO));

        // Re-entering the panel rect cancels it.
        runtime.observe_cursor(756.0, 970.0, Instant::now());
        assert!(!runtime.outside_for_longer_than(Duration::ZERO));
    }

    #[test]
    fn watchdog_polls_a_stationary_cursor_instead_of_waiting_for_a_move() {
        let grace = Duration::from_millis(1500);
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let panel = index_of(&runtime, "panel");
        runtime.set_active(panel).unwrap();

        // The mouse never moves, so no monitor callback ever reaches
        // `observe_cursor`. The watchdog's own sample must start the timer anyway.
        assert!(
            !runtime.watchdog_decision(0.0, 0.0, Instant::now(), Duration::from_secs(3600)),
            "the grace has not elapsed yet"
        );

        // A sample whose timestamp is already older than the grace must fire.
        runtime.set_active(panel).unwrap(); // resets the outside timer
        let stale = Instant::now() - Duration::from_secs(5);
        assert!(
            runtime.watchdog_decision(0.0, 0.0, stale, grace),
            "a stationary outside cursor must trip the watchdog"
        );

        // A sample inside the panel rect cancels the timer, so a stationary
        // cursor over the shell never trips it.
        runtime.set_active(panel).unwrap();
        runtime.watchdog_decision(756.0, 970.0, stale, grace);
        assert!(!runtime.outside_for_longer_than(Duration::ZERO));
    }

    #[test]
    fn watchdog_poll_does_not_consume_hover_edges() {
        // The watchdog runs every 250 ms; if its sampling updated `last_inside`
        // it would swallow the enter/leave edge the monitor is meant to emit.
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let panel = index_of(&runtime, "panel");
        runtime.set_active(panel).unwrap();

        runtime.watchdog_decision(0.0, 0.0, Instant::now(), Duration::from_secs(3600));
        // The edge is still fresh for the monitor to report.
        assert_eq!(runtime.observe_cursor(0.0, 0.0, Instant::now()), Some(false));
        assert_eq!(runtime.observe_cursor(0.0, 0.0, Instant::now()), None);
    }

    #[test]
    fn forced_collapse_resets_interactivity_and_reports_the_hover_edge() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let panel = index_of(&runtime, "panel");
        runtime.set_active(panel).unwrap();
        runtime.observe_cursor(756.0, 970.0, Instant::now());

        let collapsed = runtime.mark_forced_collapse();
        assert!(collapsed.frame.is_some(), "must collapse to the smallest state");
        assert!(
            collapsed.hover_changed,
            "the hover edge inside -> outside must be reported"
        );
        assert!(
            !collapsed.left_prompt,
            "the panel is interactive but not a prompt"
        );
        assert!(!runtime.is_interactive());
        assert!(!runtime.is_focusable());

        // A second forced collapse is a no-op edge (no duplicate event).
        assert!(!runtime.mark_forced_collapse().hover_changed);
    }

    #[test]
    fn prompt_state_is_interactive_focusable_and_content_driven() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        let (state, _) = runtime.set_active(prompt).unwrap();

        assert!(state.interactive, "a text field must accept clicks");
        assert!(state.focusable, "a text field must accept keys");
        assert!(runtime.is_interactive() && runtime.is_focusable());
        assert!(
            state.max_height > state.min_height,
            "the prompt must be able to grow its body"
        );
    }

    #[test]
    fn content_height_clamps_between_min_and_max() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        let (state, _) = runtime.set_active(prompt).unwrap();

        // Below the floor clamps up to the min.
        assert_eq!(runtime.set_content_height(0.0).unwrap(), state.min_height);
        // Above the ceiling clamps down to the max.
        assert_eq!(
            runtime.set_content_height(10_000.0).unwrap(),
            state.max_height
        );
        // Inside the range is preserved exactly.
        let middle = (state.min_height + state.max_height) / 2.0;
        assert_eq!(runtime.set_content_height(middle).unwrap(), middle);
    }

    #[test]
    fn a_content_resize_grows_the_target_frame_and_commits_to_it() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        let (state, min_frame) = runtime.set_active(prompt).unwrap();
        let (_, target_at_min) = runtime.active_target_frame().unwrap();
        assert_eq!(min_frame, target_at_min, "opens at the nominal height");

        runtime.set_content_height(state.max_height).unwrap();
        let (_, target_at_max) = runtime.active_target_frame().unwrap();
        assert!(
            target_at_max.height > min_frame.height,
            "the measured content must grow the committed frame"
        );

        // A fixed state ignores a content report and keeps its table height.
        let panel = index_of(&runtime, "panel");
        runtime.set_active(panel).unwrap();
        let reported = runtime.set_content_height(10_000.0).unwrap();
        assert_eq!(reported, PANEL_HEIGHT);
    }

    #[test]
    fn forced_collapse_clears_a_prompt_and_reports_that_it_did() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        runtime.set_active(prompt).unwrap();
        runtime.set_content_height(10_000.0).unwrap();

        let collapsed = runtime.mark_forced_collapse();
        assert!(
            collapsed.left_prompt,
            "the webview needs the clear proposal for a torn-down prompt"
        );
        assert!(!runtime.is_focusable());
        assert!(!runtime.is_interactive());

        // The content override is gone, so re-requesting the prompt opens at its
        // nominal (minimum) height again.
        let (_, reopened) = runtime.set_active(prompt).unwrap();
        let geometry = fallback_geometry(1512.0, 982.0);
        let nominal = state(&geometry, PROMPT_STATE);
        assert_eq!(reopened.height, window_size(&nominal, geometry.window_width()).1);
    }

    #[test]
    fn watchdog_does_not_collapse_a_focused_prompt() {
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        runtime.set_active(prompt).unwrap();

        // Cursor outside and the grace elapsed, but the window is focused: the
        // user is typing, so the watchdog must not tear it down.
        let stale = Instant::now() - Duration::from_secs(5);
        runtime.set_focused(true);
        assert!(!runtime.watchdog_decision(0.0, 0.0, stale, Duration::ZERO));

        // Losing focus re-arms it immediately, so a stranded focused prompt is
        // still recovered the moment the user leaves.
        runtime.set_focused(false);
        assert!(runtime.watchdog_decision(0.0, 0.0, stale, Duration::ZERO));
    }

    #[test]
    fn native_focusable_log_matches_the_guarded_state() {
        // `sync_native_focusability` is the only writer of both values; this
        // pins the invariant the safety argument depends on.
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let prompt = index_of(&runtime, PROMPT_STATE);
        let collapsed = index_of(&runtime, COLLAPSED_STATE);

        runtime.set_active(prompt).unwrap();
        runtime.note_native_focusable(runtime.is_focusable());
        assert_eq!(runtime.native_focusable(), Some(true));

        runtime.set_active(collapsed).unwrap();
        runtime.note_native_focusable(runtime.is_focusable());
        assert_eq!(runtime.native_focusable(), Some(false));

        runtime.set_active(prompt).unwrap();
        runtime.mark_forced_collapse();
        runtime.note_native_focusable(runtime.is_focusable());
        assert_eq!(runtime.native_focusable(), Some(false));
    }

    #[test]
    fn commit_is_ignored_until_the_matching_state_is_active() {
        // Ordering guarantee behind the async request/commit pair.
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let panel = index_of(&runtime, "panel");
        let collapsed = index_of(&runtime, COLLAPSED_STATE);

        runtime.set_active(panel).unwrap();
        assert!(runtime.resolve_commit("panel").unwrap().0);
        assert!(!runtime.resolve_commit(COLLAPSED_STATE).unwrap().0);

        // A fast panel -> collapsed flap: the panel commit is now stale...
        runtime.set_active(collapsed).unwrap();
        assert!(!runtime.resolve_commit("panel").unwrap().0);
        // ...and only the collapsed commit may shrink the window.
        assert!(runtime.resolve_commit(COLLAPSED_STATE).unwrap().0);
        // Unknown names are an error, never a silent no-op.
        assert!(runtime.resolve_commit("nope").is_err());
    }

    #[test]
    fn display_topology_change_snaps_instead_of_spanning_monitors() {
        let notch = reference();
        let geometry = shell_geometry(notch);
        let width = geometry.window_width();
        let collapsed = target_frame(&state(&geometry, "collapsed"), &notch, 0.0, 0.0, width);
        // The display moved from x=0 to x=1920 (700 pt cutout centre).
        let moved = target_frame(&state(&geometry, "collapsed"), &notch, 1920.0, 0.0, width);

        // Without the guard, the union spans both displays.
        let union = grow_union(collapsed, moved);
        assert!(union.width > 2000.0, "the hazard this guard exists for");

        // With the guard, a topology change snaps to the exact target.
        assert_eq!(reconcile_window_frame(collapsed, moved, true), moved);
        // With no topology change, grow-before-reveal is preserved (same column,
        // the panel only adds height).
        let panel = target_frame(&state(&geometry, "panel"), &notch, 0.0, 0.0, width);
        assert_eq!(reconcile_window_frame(collapsed, panel, false), panel);
    }

    #[test]
    fn native_interactivity_log_matches_the_guarded_state() {
        // `sync_native_interactivity` is the only writer of both values; this
        // pins the invariant the safety argument depends on.
        let runtime = ShellRuntime::new(fallback_geometry(1512.0, 982.0), 0.0, 0.0);
        let panel = index_of(&runtime, "panel");
        let collapsed = index_of(&runtime, COLLAPSED_STATE);

        runtime.set_active(panel).unwrap();
        runtime.note_native_interactive(runtime.is_interactive());
        assert_eq!(runtime.native_interactive(), Some(true));

        runtime.set_active(collapsed).unwrap();
        runtime.note_native_interactive(runtime.is_interactive());
        assert_eq!(runtime.native_interactive(), Some(false));

        runtime.mark_forced_collapse();
        runtime.note_native_interactive(runtime.is_interactive());
        assert_eq!(runtime.native_interactive(), Some(false));
    }

    /// Step A14, preserved through the A5 shell rewrite: the overlay must sit
    /// above a fullscreen window, not just above the menu bar.
    /// `NSStatusWindowLevel` (25) lost to fullscreen, so the configured level
    /// must be strictly higher, and the collection behaviour must carry both
    /// `FullScreenAuxiliary` and `CanJoinAllSpaces`.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_overlay_clears_a_fullscreen_window_and_joins_every_space() {
        use objc2_app_kit::{NSStatusWindowLevel, NSWindowCollectionBehavior};
        assert!(
            OVERLAY_WINDOW_LEVEL > NSStatusWindowLevel,
            "the overlay level must clear the status/menu-bar level"
        );
        let behavior = window::overlay_collection_behavior();
        assert!(behavior.contains(NSWindowCollectionBehavior::FullScreenAuxiliary));
        assert!(behavior.contains(NSWindowCollectionBehavior::CanJoinAllSpaces));
        assert!(behavior.contains(NSWindowCollectionBehavior::Stationary));
        assert!(behavior.contains(NSWindowCollectionBehavior::IgnoresCycle));
    }

    /// Step A15: the diagnostics must report the live activation policy honestly.
    /// The three documented AppKit policies map to their names, and an unknown
    /// raw value is not silently folded into one of them.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_activation_policy_maps_from_appkit() {
        use objc2_app_kit::NSApplicationActivationPolicy as Policy;
        assert_eq!(
            activation_policy_of(Policy::Regular),
            NotchActivationPolicy::Regular
        );
        assert_eq!(
            activation_policy_of(Policy::Accessory),
            NotchActivationPolicy::Accessory
        );
        assert_eq!(
            activation_policy_of(Policy::Prohibited),
            NotchActivationPolicy::Prohibited
        );
        assert_eq!(
            activation_policy_of(Policy(42)),
            NotchActivationPolicy::Unknown
        );
    }

    /// The diagnostics payload contract, pinned camelCase like the rest of the
    /// crate (step A15).
    #[test]
    fn activation_policy_serializes_as_camel_case() {
        assert_eq!(
            serde_json::to_string(&NotchActivationPolicy::Accessory).unwrap(),
            "\"accessory\""
        );
        assert_eq!(
            serde_json::to_string(&NotchActivationPolicy::Regular).unwrap(),
            "\"regular\""
        );
    }
}
