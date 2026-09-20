//! Cursor hover detection and the click-through safety watchdog.
//!
//! The overlay window is `set_ignore_cursor_events(true)` by default, so CSS
//! `:hover` can never fire. Hover is therefore observed natively: a global *and*
//! a local `mouseMoved` monitor (the proven [`crate::hotkey_flags`] pattern — the
//! global one sees moves while the overlay is click-through, the local one sees
//! them once an interactive state makes our own app the event target).
//!
//! The monitor callback only hit-tests the cursor against the currently active
//! shell rect and emits `notch_hover { inside }` **on change**. Dwell timing
//! lives in React so it stays tunable without a Rust rebuild.
//!
//! ## Safety
//!
//! An interactive state turns click-through off. If the UI ever strands that
//! state (frozen webview, lost `transitionend`), the overlay would permanently
//! eat clicks meant for the app underneath. The watchdog thread checks every
//! [`WATCHDOG_TICK`]: if the shell has been interactive with the cursor outside
//! it for longer than [`WATCHDOG_GRACE`], Rust itself restores click-through and
//! drops the runtime back to the collapsed state.
//!
//! Crucially the watchdog **actively samples** the cursor with
//! `NSEvent::mouseLocation` on every tick. Cached event state is not enough: a
//! stationary cursor (and a mouse drag, which does not emit `mouseMoved`) never
//! invokes the monitor callback, so `outside_since` would stay `None` and the
//! watchdog would be blind exactly when it is needed most.
//!
//! ## Monitors and lifetime
//!
//! Both subscriptions are owned by [`HoverMonitor`] as `Retained` handles. Its
//! `Drop` unregisters them (balancing the retain `install` took), and
//! [`teardown`] moves it out and drops it on the main thread — AppKit requires
//! `removeMonitor` there. The run-loop [`crate::notch::teardown`] calls this on
//! window close and on exit, so no monitor outlives the window.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use super::{force_click_through, ShellRuntime};

/// How often the watchdog re-checks a possibly stranded interactive shell.
const WATCHDOG_TICK: Duration = Duration::from_millis(250);

/// How long the cursor may sit outside an interactive shell before Rust forces
/// click-through back on. Non-negotiable safety net.
const WATCHDOG_GRACE: Duration = Duration::from_millis(1500);

/// Event masks the monitors subscribe to. `mouseMoved` alone is not enough: on
/// macOS a button-held drag emits `*MouseDragged`, never `mouseMoved`, so a user
/// who clicks inside the panel and drags out would otherwise never produce an
/// exit sample.
#[cfg(target_os = "macos")]
const HOVER_EVENT_MASK: objc2_app_kit::NSEventMask = objc2_app_kit::NSEventMask::MouseMoved
    .union(objc2_app_kit::NSEventMask::LeftMouseDragged)
    .union(objc2_app_kit::NSEventMask::RightMouseDragged)
    .union(objc2_app_kit::NSEventMask::OtherMouseDragged);

/// App-lifetime hover state: the monitor tokens, the watchdog's run flag, and
/// the last-sample facts the Debug panel's health check reads.
pub struct HoverRuntime {
    /// Dropping the monitor unregisters it — it must live as long as the app.
    monitor: Mutex<Option<platform::HoverMonitor>>,
    running: Arc<AtomicBool>,
    /// Whether both platform monitors were installed at startup. `false` means
    /// hover is silently unavailable, which the health check surfaces.
    installed: bool,
    /// Timestamp of the last cursor sample the monitor delivered (edge or not).
    /// `None` means the monitor has never fired — the silent-failure signal.
    last_sample: Mutex<Option<Instant>>,
    /// The last inside/outside edge value the monitor observed.
    last_inside: Mutex<Option<bool>>,
}

impl HoverRuntime {
    fn note_sample(&self, now: Instant) {
        match self.last_sample.lock() {
            Ok(mut slot) => *slot = Some(now),
            Err(poisoned) => *poisoned.into_inner() = Some(now),
        }
    }

    fn note_inside(&self, inside: bool) {
        match self.last_inside.lock() {
            Ok(mut slot) => *slot = Some(inside),
            Err(poisoned) => *poisoned.into_inner() = Some(inside),
        }
    }

    /// Whether the native monitors were registered.
    pub fn installed(&self) -> bool {
        self.installed
    }

    /// Timestamp of the last delivered cursor sample.
    pub fn last_sample(&self) -> Option<Instant> {
        self.last_sample.lock().ok().and_then(|slot| *slot)
    }

    /// Last inside/outside edge observed by the monitor.
    pub fn last_inside(&self) -> Option<bool> {
        self.last_inside.lock().ok().and_then(|slot| *slot)
    }
}

/// Installs the monitors and starts the watchdog. Called from `notch::setup`,
/// which runs on the main thread, which is where AppKit requires registration.
pub fn install(app: &AppHandle) -> HoverRuntime {
    let running = Arc::new(AtomicBool::new(true));
    let monitor = platform::install(app);
    if monitor.is_none() {
        eprintln!(
            "polaris: mouseMoved monitor unavailable; \
             hover expansion is disabled (the hotkey/voice path is unaffected)"
        );
    }
    spawn_watchdog(app.clone(), Arc::clone(&running));
    HoverRuntime {
        installed: monitor.is_some(),
        monitor: Mutex::new(monitor),
        running,
        last_sample: Mutex::new(None),
        last_inside: Mutex::new(None),
    }
}

/// Stops the watchdog and unregisters the monitors. Main thread only on macOS:
/// the taken [`platform::HoverMonitor`] is dropped here, and its `Drop` calls
/// AppKit's `removeMonitor`.
pub fn teardown(app: &AppHandle) {
    let Some(runtime) = app.try_state::<HoverRuntime>() else {
        return;
    };
    runtime.running.store(false, Ordering::Relaxed);
    // Taking the monitor moves it out; the temporary is dropped on this thread.
    drop(
        runtime
            .monitor
            .lock()
            .ok()
            .and_then(|mut guard| guard.take()),
    );
}

/// Forwards one cursor sample to the webview's gaze driver, in the webview's
/// client coordinates.
///
/// Only while a face-bearing state (`compact`/`panel`) is active: the overlay
/// runs all day and `mouseMoved` fires per move, so forwarding unconditionally
/// would pay one `NSWindow.frame` read and one IPC message per move for a face
/// that is not on screen. This stays event-driven — the one monitor is still the
/// one monitor, and nothing here caches a sample to re-read on a timer.
fn emit_gaze_cursor(app: &AppHandle, runtime: &ShellRuntime, x: f64, y: f64) {
    if !matches!(runtime.active_state_name(), "compact" | "panel") {
        return;
    }
    // The monitor callbacks run on the AppKit main thread, which is where
    // `window::frame` must read the `NSWindow`; a failure (off the main thread,
    // or no window yet) simply drops the sample.
    let Ok(frame) = super::window::frame(app) else {
        return;
    };
    // AppKit's origin is bottom-left and `y` grows up; the webview's is
    // top-left and `y` grows down.
    crate::events::emit_notch_cursor(app, x - frame.x, frame.y + frame.height - y);
}

/// One cursor sample from the monitor callback. Cheap by design: a hit-test plus
/// (only on a change) one Tauri emit and one terminal line.
fn observe(app: &AppHandle) {
    let now = Instant::now();
    // Stamp every callback, edge or not: this is what proves the monitor is
    // delivering, and the Debug panel's health check reads it.
    if let Some(hover) = app.try_state::<HoverRuntime>() {
        hover.note_sample(now);
    }
    let Some(runtime) = app.try_state::<ShellRuntime>() else {
        return;
    };
    let (x, y) = platform::cursor_location();
    emit_gaze_cursor(app, &runtime, x, y);
    if let Some(inside) = runtime.observe_cursor(x, y, now) {
        if let Some(hover) = app.try_state::<HoverRuntime>() {
            hover.note_inside(inside);
        }
        // One line per inside/outside change (so it is naturally rate-limited):
        // the first line proves the native half of the chain works at all, and
        // the state tells which shell rect was hit-tested.
        println!(
            "polaris: notch hover inside={inside} state={}",
            runtime.active_state_name()
        );
        crate::events::emit_notch_hover(app, inside);
    }
}

fn spawn_watchdog(app: AppHandle, running: Arc<AtomicBool>) {
    let spawned = std::thread::Builder::new()
        .name("polaris-hover-watchdog".into())
        .spawn(move || {
            // Suppresses repeated log lines/forces while main is still applying
            // the previous force; reset once the shell is no longer stranded.
            let mut forcing = false;
            while running.load(Ordering::Relaxed) {
                std::thread::sleep(WATCHDOG_TICK);
                if !running.load(Ordering::Relaxed) {
                    break;
                }
                let Some(runtime) = app.try_state::<ShellRuntime>() else {
                    continue;
                };
                // Actively sample the real cursor every tick. A stationary mouse
                // (and a drag) never fires the monitor, so this is the only way
                // the outside timer advances in those cases.
                let (x, y) = platform::cursor_location();
                let stranded =
                    runtime.watchdog_decision(x, y, Instant::now(), WATCHDOG_GRACE);
                if stranded && !forcing {
                    forcing = true;
                    eprintln!(
                        "polaris: hover watchdog restoring click-through \
                         (interactive with the cursor outside for {WATCHDOG_GRACE:?})"
                    );
                    force_click_through(&app);
                } else if !stranded {
                    forcing = false;
                }
            }
        });
    if let Err(error) = spawned {
        eprintln!("polaris: could not start the hover watchdog: {error}");
    }
}

/* ------------------------------------------------------------------ *
 * Platform monitors
 * ------------------------------------------------------------------ */

#[cfg(target_os = "macos")]
mod platform {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::NSEvent;

    use super::HOVER_EVENT_MASK;

    /// Owns both cursor-monitor subscriptions for as long as it lives. Dropping
    /// it unregisters them on the thread that drops it — [`super::teardown`]
    /// drops it from the main-thread run-loop callback, which is where AppKit
    /// requires `removeMonitor`.
    pub struct HoverMonitor {
        global: Retained<AnyObject>,
        local: Retained<AnyObject>,
    }

    // SAFETY: the two fields are opaque AppKit handles whose only operation is
    // `NSEvent::removeMonitor`, which `teardown` runs on the main thread. The
    // handles are never dereferenced anywhere else.
    unsafe impl Send for HoverMonitor {}
    unsafe impl Sync for HoverMonitor {}

    impl Drop for HoverMonitor {
        fn drop(&mut self) {
            // SAFETY: both tokens came from the add* calls and are still
            // retained by `self`; AppKit removal is idempotent. Balancing the
            // retain here means no monitor token is leaked.
            unsafe {
                NSEvent::removeMonitor(&self.global);
                NSEvent::removeMonitor(&self.local);
            }
        }
    }

    pub fn install(app: &tauri::AppHandle) -> Option<HoverMonitor> {
        // Global: while the overlay is click-through, moves over it are
        // delivered to whatever is underneath, so only a global monitor sees
        // them.
        let global_app = app.clone();
        let global_block = RcBlock::new(move |_event: NonNull<NSEvent>| {
            super::observe(&global_app);
        });
        let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            HOVER_EVENT_MASK,
            &global_block,
        )?;
        // AppKit copied the block at registration; only the returned token
        // subscribes, so the RcBlock itself can go.
        drop(global_block);

        // Local: once an interactive state turns click-through off, our own app
        // receives the moves and a global monitor would not see them. The event
        // must be returned unchanged so the webview keeps receiving it.
        let local_app = app.clone();
        let local_block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            super::observe(&local_app);
            event.as_ptr()
        });
        // SAFETY: the closure returns the same non-null event pointer it was
        // handed, which is the required pass-through contract.
        let local = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                HOVER_EVENT_MASK,
                &local_block,
            )
        };
        let Some(local) = local else {
            // Roll back the already-installed global monitor rather than leak
            // a subscription nothing can remove.
            unsafe { NSEvent::removeMonitor(&global) };
            return None;
        };
        drop(local_block);

        Some(HoverMonitor { global, local })
    }

    /// Current cursor position in AppKit screen coordinates. `NSEvent`'s
    /// `mouseLocation` is documented as callable from any thread of the app (and
    /// objc2 exposes it as a safe fn), which is what lets the watchdog sample the
    /// real cursor without a main-thread hop.
    pub fn cursor_location() -> (f64, f64) {
        let point = NSEvent::mouseLocation();
        (point.x, point.y)
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub struct HoverMonitor;

    pub fn install(_app: &tauri::AppHandle) -> Option<HoverMonitor> {
        None
    }

    /// The app is macOS-only; this branch keeps the crate building and the tests
    /// running. A `NaN` sample can never be inside a shell rect, so the watchdog
    /// stays inert.
    pub fn cursor_location() -> (f64, f64) {
        (f64::NAN, f64::NAN)
    }
}
