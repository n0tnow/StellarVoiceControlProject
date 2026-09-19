//! Native Control+Option observation and the Accessibility gate.
//!
//! The key-code shortcut API cannot express "hold both modifiers and release
//! either". That gesture is only visible as `NSEventTypeFlagsChanged`, so this
//! module installs a process-global `flagsChanged` monitor pair — a **global**
//! monitor for events delivered to other apps and a **local** monitor for
//! events delivered to our own — and forwards each masked sample over a
//! channel. The channel keeps the AppKit callback minimal: no state machine,
//! no capture, no locks beyond the send.
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

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

    use crate::gesture::ModifierSample;

    /// Keeps both `flagsChanged` subscriptions alive for the app's lifetime.
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

        // Global monitor: observe `flagsChanged` in every app.
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
            // call; we only read its modifier flags.
            let flags = unsafe { event.as_ref() }.modifierFlags();
            global_callback(sample(flags));
        });
        let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged,
            &global_block,
        )?;
        // AppKit copied the block at registration; only the returned token
        // subscribes, so the RcBlock itself can go.
        drop(global_block);

        // Local monitor: observe `flagsChanged` in our own app. The event must
        // be returned unchanged so the webview keeps receiving key state.
        let local_block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
            // SAFETY: see the global block above.
            let flags = unsafe { event.as_ref() }.modifierFlags();
            on_sample(sample(flags));
            event.as_ptr()
        });
        // SAFETY: the closure returns the same non-null event pointer it was
        // handed, which is the required pass-through contract.
        let local = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(
                NSEventMask::FlagsChanged,
                &local_block,
            )
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
