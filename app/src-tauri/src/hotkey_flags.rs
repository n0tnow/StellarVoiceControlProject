//! Native Control+Option observation and the Accessibility gate.
//!
//! The key-code shortcut API cannot express "hold both modifiers and release
//! either". That gesture is only visible as `NSEventTypeFlagsChanged`, so this
//! module installs a process-global monitor pair — a **global** monitor for
//! events delivered to other apps and a **local** monitor for events delivered
//! to our own — and forwards each masked sample over a channel. The channel
//! keeps the AppKit callback minimal: no state machine, no capture, no locks
//! beyond the send.
//!
//! Each monitor also covers `NSEventMask::KeyDown` next to `FlagsChanged`. A
//! `flagsChanged` sample cannot see an ordinary key press, so step A6's
//! double-Control detector would read `Ctrl+C` (or tmux's `Ctrl+B`) as a bare
//! Control tap; the ordered key-down observation is what lets it tell an
//! ordinary Control chord from a deliberate tap. Key-downs are only *observed*
//! and never swallowed, so ordinary typing is unaffected.
//!
//! Everything here is macOS-only; the non-macOS stub keeps the crate building
//! on other hosts (where the app is not shipped).
//!
//! Two AppKit facts drive the shape of this code:
//!
//! * The object returned by `add*Monitor…` **is** the subscription — dropping
//!   it silently unregisters the monitor. The handles are therefore converted
//!   to raw pointers with `Retained::into_raw` and deliberately kept alive for
//!   the process lifetime; `remove` unregisters delivery on the main thread at
//!   exit.
//! * `addLocalMonitorForEventsMatchingMask_handler` is `unsafe` because the
//!   returned pointer may be mutated or nulled. This module returns the incoming
//!   pointer unchanged, which is the documented pass-through contract.
//!
//! A global `flagsChanged` monitor additionally requires Accessibility trust
//! (`AXIsProcessTrusted`); the local monitor does not. See
//! `docs/reports/2026-09-19-modifier-only-hotkey.md` §4.

use std::sync::{Arc, Mutex};

use crate::gesture::ModifierSample;

/// Extra, permanent sample observers, fed every masked `flagsChanged` sample
/// next to the push-to-talk driver.
///
/// Step A6's double-Control prompt detector needs the same events as the
/// Control+Option latch but must not disturb it. Rather than register a second
/// AppKit monitor (the object returned by `add*Monitor…` *is* the
/// subscription), the one monitor pair fans out to every observer here. The
/// hotkey driver keeps using its own channel; these are additive and never
/// change the gesture's semantics.
type SampleObserver = Arc<dyn Fn(ModifierSample) + Send + Sync + 'static>;

/// Permanent key-down observers, fed once per non-modifier `keyDown`.
///
/// A `flagsChanged` sample cannot see an ordinary key press. Step A6's double
/// Control detector would read two quick `Ctrl+C` chords as two bare taps
/// without this ordered signal (see [`crate::ctrl_tap`]).
type KeyObserver = Arc<dyn Fn() + Send + Sync + 'static>;

/// Per-observer registries. Each observer is itself an `Arc`, so the
/// notification path can clone the list under the lock, release it, and only
/// then run the callbacks: an observer that re-enters `add_*` would otherwise
/// deadlock, and a blocking observer would stall AppKit's event dispatch.
static SAMPLE_OBSERVERS: Mutex<Vec<SampleObserver>> = Mutex::new(Vec::new());
static KEY_OBSERVERS: Mutex<Vec<KeyObserver>> = Mutex::new(Vec::new());

/// Registers a callback invoked for every masked modifier sample, for the
/// process lifetime. Must stay cheap: it runs on the AppKit monitor callback's
/// thread, so it should only forward the sample (e.g. into a channel).
pub fn add_sample_observer<F>(observer: F)
where
    F: Fn(ModifierSample) + Send + Sync + 'static,
{
    match SAMPLE_OBSERVERS.lock() {
        Ok(mut observers) => observers.push(Arc::new(observer)),
        // A previous observer panicked while the lock was held; the data is not
        // corrupt, so recover it rather than losing the registration.
        Err(poisoned) => poisoned.into_inner().push(Arc::new(observer)),
    }
}

/// Registers a callback invoked for every non-modifier key-down, for the
/// process lifetime. Same contract as [`add_sample_observer`].
pub fn add_key_observer<F>(observer: F)
where
    F: Fn() + Send + Sync + 'static,
{
    match KEY_OBSERVERS.lock() {
        Ok(mut observers) => observers.push(Arc::new(observer)),
        Err(poisoned) => poisoned.into_inner().push(Arc::new(observer)),
    }
}

/// Forwards one masked sample to every registered observer.
///
/// Only the macOS monitor callbacks call this; other hosts keep the function so
/// the module's API stays uniform, hence the explicit allow there.
///
/// The lock is released *before* the observers run (the `Arc` snapshot is
/// cloned under it). Every body runs inside `catch_unwind`: it is called from
/// an Objective-C block, and a panic unwinding across that FFI boundary is
/// undefined behaviour that aborts the process. A faulty observer must not be
/// able to tear down the AppKit event loop.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn notify_sample_observers(sample: ModifierSample) {
    let observers = match SAMPLE_OBSERVERS.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    notify_all(&observers, &mut |observer| observer(sample));
}

/// Forwards one non-modifier key-down to every registered observer. See
/// [`notify_sample_observers`] for the locking and panic-boundary contract.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn notify_key_observers() {
    let observers = match KEY_OBSERVERS.lock() {
        Ok(guard) => guard.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    notify_all(&observers, &mut |observer| observer());
}

/// Runs every observer, containing each one's panic.
///
/// Split out from the two `notify_*` functions so the panic boundary is
/// unit-testable against a local list rather than the process-global registry.
/// The callbacks are invoked from an Objective-C block, where unwinding is
/// undefined behaviour; a panic must be caught here, not allowed to reach
/// AppKit.
fn notify_all<T: ?Sized, F>(observers: &[Arc<T>], call: &mut F)
where
    F: FnMut(&T),
{
    for observer in observers {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| call(observer)));
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags, NSEventType};

    use crate::gesture::ModifierSample;

    use super::{notify_key_observers, notify_sample_observers};

    /// The two event types the monitors observe: modifier transitions for the
    /// push-to-talk latch and the double-Control detector, and non-modifier
    /// key-downs so the detector can tell a Control chord (`Ctrl+C`) from a
    /// bare tap. Key-downs are observed, never swallowed.
    const OBSERVED_MASK: NSEventMask =
        NSEventMask::FlagsChanged.union(NSEventMask::KeyDown);

    /// Keeps both monitor subscriptions alive for the app's lifetime.
    pub struct FlagsMonitor {
        global: *mut AnyObject,
        local: *mut AnyObject,
    }

    // SAFETY: the two fields are opaque AppKit handles whose only operation is
    // `NSEvent::removeMonitor`, which must run on the main thread —
    // `hotkey::teardown` calls it from the run-loop callback. The raw pointers
    // are never dereferenced off the main thread.
    unsafe impl Send for FlagsMonitor {}
    unsafe impl Sync for FlagsMonitor {}

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
        fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
    }

    /// Installs both monitors. Returns `None` if AppKit refuses registration
    /// (for example before the TCC database is available); the caller then runs
    /// shortcut-only and logs the failure.
    ///
    /// `on_sample` is called on the monitor callback (assumed main thread;
    /// flagged as unverified in the research report) and must stay cheap.
    pub fn install<F>(on_sample: F) -> Option<FlagsMonitor>
    where
        F: Fn(ModifierSample) + Clone + 'static,
    {
        // The research report flagged the delivery thread as unverified. Log it
        // once, against the thread that registered the monitor (`setup`, which
        // Tauri runs on the main thread), so the first real run settles it.
        let registering_thread = std::thread::current().id();
        static LOGGED_DELIVERY_THREAD: std::sync::Once = std::sync::Once::new();

        // Global monitor: observe modifiers and key-downs in every app.
        let global_callback = on_sample.clone();
        let global_block = RcBlock::new(move |event: NonNull<NSEvent>| {
            LOGGED_DELIVERY_THREAD.call_once(|| {
                let delivered = std::thread::current().id();
                println!(
                    "polaris: flagsChanged delivered on {delivered:?} \
                     (registered on {registering_thread:?}, match={})",
                    delivered == registering_thread
                );
            });
            // SAFETY: AppKit hands us a valid NSEvent for the duration of the
            // call; we only read its type and modifier flags.
            let event = unsafe { event.as_ref() };
            if event.r#type() == NSEventType::KeyDown {
                notify_key_observers();
                return;
            }
            let masked = sample(event.modifierFlags());
            global_callback(masked);
            // Step A6: the same sample drives the double-Control detector.
            notify_sample_observers(masked);
        });
        let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(OBSERVED_MASK, &global_block)?;
        // AppKit copied the block at registration; only the returned token
        // subscribes, so the RcBlock itself can go.
        drop(global_block);

        // Local monitor: observe modifiers and key-downs in our own app. The
        // event must be returned unchanged so the webview keeps receiving key
        // state.
        let local_block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            let raw = event.as_ptr();
            // SAFETY: see the global block above.
            let event = unsafe { event.as_ref() };
            if event.r#type() == NSEventType::KeyDown {
                notify_key_observers();
                return raw;
            }
            let masked = sample(event.modifierFlags());
            on_sample(masked);
            notify_sample_observers(masked);
            raw
        });
        // SAFETY: the closure returns the same non-null event pointer it was
        // handed, which is the required pass-through contract.
        let local = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(OBSERVED_MASK, &local_block)
        }?;
        drop(local_block);

        Some(FlagsMonitor {
            // `into_raw` transfers the retain count to us; leaking it on
            // purpose is what keeps the subscriptions alive until exit.
            global: Retained::into_raw(global),
            local: Retained::into_raw(local),
        })
    }

    /// Unregisters both monitors. Called from `hotkey::teardown`, which runs on
    /// the main thread from the run-loop callback.
    pub fn remove(monitor: &FlagsMonitor) {
        // SAFETY: the pointers came from the two add* calls and are still
        // retained; AppKit removal is idempotent.
        unsafe {
            if !monitor.global.is_null() {
                NSEvent::removeMonitor(&*monitor.global);
            }
            if !monitor.local.is_null() {
                NSEvent::removeMonitor(&*monitor.local);
            }
        }
    }

    /// The live global modifier state, for the watchdog. `NSEvent` is an
    /// any-thread class in `objc2-app-kit` 0.3 (its `modifierFlags` class
    /// method takes no `MainThreadMarker`), so the driver can poll it directly.
    pub fn current_sample() -> ModifierSample {
        sample(NSEvent::modifierFlags_class())
    }

    /// Masks a raw flags word down to the four modifiers the latch cares about.
    fn sample(flags: NSEventModifierFlags) -> ModifierSample {
        let flags = flags.intersection(NSEventModifierFlags::DeviceIndependentFlagsMask);
        ModifierSample {
            control: flags.contains(NSEventModifierFlags::Control),
            option: flags.contains(NSEventModifierFlags::Option),
            command: flags.contains(NSEventModifierFlags::Command),
            shift: flags.contains(NSEventModifierFlags::Shift),
        }
    }

    /// Silent trust check; safe to call every tick.
    pub fn is_trusted() -> bool {
        // SAFETY: takes no arguments and has no preconditions.
        unsafe { AXIsProcessTrusted() }
    }

    /// Shows the standard, non-modal Accessibility consent dialog.
    ///
    /// Per Apple's header the prompt is asynchronous and its return value does
    /// **not** reflect the user's choice — callers must poll [`is_trusted`].
    /// The dictionary key value is the documented string constant
    /// `kAXTrustedCheckOptionPrompt`.
    pub fn prompt_for_trust() -> bool {
        use core_foundation::base::TCFType;
        use core_foundation::boolean::CFBoolean;
        use core_foundation::dictionary::CFDictionary;
        use core_foundation::string::CFString;

        let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        // SAFETY: `options` is a live CFDictionary for the duration of the
        // call and is released when it drops afterwards.
        unsafe {
            AXIsProcessTrustedWithOptions(
                options.as_concrete_TypeRef() as *const std::ffi::c_void
            )
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use crate::gesture::ModifierSample;

    pub struct FlagsMonitor;

    pub fn install<F>(_on_sample: F) -> Option<FlagsMonitor>
    where
        F: Fn(ModifierSample) + Clone + 'static,
    {
        None
    }

    pub fn remove(_monitor: &FlagsMonitor) {}

    pub fn current_sample() -> ModifierSample {
        ModifierSample {
            control: false,
            option: false,
            command: false,
            shift: false,
        }
    }

    pub fn is_trusted() -> bool {
        true
    }

    pub fn prompt_for_trust() -> bool {
        true
    }
}

pub use imp::{current_sample, install, is_trusted, prompt_for_trust, remove, FlagsMonitor};

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;

    fn sample(control: bool) -> ModifierSample {
        ModifierSample {
            control,
            option: false,
            command: false,
            shift: false,
        }
    }

    /// A panic in one observer must not stop the others and must not escape:
    /// `notify_*` runs inside an Objective-C block, where unwinding is
    /// undefined behaviour.
    #[test]
    fn notify_all_contains_a_panicking_observer() {
        let ran = AtomicUsize::new(0);
        let observers: Vec<Arc<dyn Fn() + Send + Sync>> = vec![
            Arc::new(|| panic!("observer boom")),
            Arc::new(|| {
                ran.fetch_add(1, Ordering::Relaxed);
            }),
        ];
        // Would abort the whole test process if the panic escaped.
        notify_all(&observers, &mut |observer| observer());
        assert_eq!(
            ran.load(Ordering::Relaxed),
            1,
            "observers after a panicking one must still run"
        );
    }

    /// The fan-out must not hold the registry lock while an observer runs:
    /// registering another observer from inside one would otherwise deadlock.
    #[test]
    fn a_sample_observer_can_register_another_observer() {
        // Serialize against other tests that touch the global registry.
        static TEST_LOCK: Mutex<()> = Mutex::new(());
        let _guard = TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let hit = Arc::new(AtomicUsize::new(0));
        let inner_hit = Arc::clone(&hit);
        // Registered once; on every notification it registers another observer
        // and bumps the counter. Before the fix this deadlocked on the held
        // lock.
        add_sample_observer(move |_| {
            let nested = Arc::clone(&inner_hit);
            add_sample_observer(move |_| {
                nested.fetch_add(1, Ordering::Relaxed);
            });
        });
        // Must return rather than deadlock. The first call runs the original
        // observer; the observer it registers is not part of this snapshot.
        notify_sample_observers(sample(true));
    }
}
