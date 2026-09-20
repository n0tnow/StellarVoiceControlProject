//! Keyboard-focus handoff for the typed-prompt state.
//!
//! The overlay is deliberately `focusable: false` so push-to-talk never steals
//! focus. The `prompt` state flips that flag on and takes first-responder focus;
//! on dismiss the window becomes non-focusable again, which by itself does
//! **not** hand keyboard focus back to the app the user came from. This module
//! remembers that app (by pid) and reactivates it, so closing the prompt returns
//! the user exactly where they were.
//!
//! Only [`super::sync_native_focusability`] calls these; both run on the AppKit
//! main thread.

/// Whether a focus handoff should reactivate the remembered app.
///
/// Only when Polaris itself is *still* the frontmost application: then closing
/// the prompt is what removed focus, so handing it back is correct. If the user
/// has already activated another app (an outside-click dismissal), macOS's own
/// activation must stand — blindly activating the remembered app would steal
/// focus from the app the user just clicked (review MAJOR-1).
#[cfg(target_os = "macos")]
fn should_reactivate(frontmost_pid: Option<i32>, our_pid: i32) -> bool {
    frontmost_pid == Some(our_pid)
}

#[cfg(target_os = "macos")]
mod platform {
    use std::sync::Mutex;

    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

    /// Pid of the app that was frontmost before the prompt took focus.
    static PREVIOUS_PID: Mutex<Option<i32>> = Mutex::new(None);

    /// Remembers the frontmost app unless it is us. A no-op when one is already
    /// remembered, so a content resize while the prompt is open cannot overwrite
    /// the real previous app with our own.
    pub fn remember_frontmost() {
        let Ok(mut slot) = PREVIOUS_PID.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        // `sharedWorkspace`/`frontmostApplication` are safe from the main thread
        // (the caller's contract); objc2 exposes them as safe methods.
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
        if let Some(app) = frontmost {
            let pid = app.processIdentifier();
            if pid != std::process::id() as i32 {
                *slot = Some(pid);
            }
        }
    }

    /// Reactivates the remembered app and forgets it. No-op if nothing is
    /// remembered or the app has already quit.
    pub fn restore_frontmost() {
        let pid = match PREVIOUS_PID.lock() {
            Ok(mut slot) => slot.take(),
            Err(poisoned) => poisoned.into_inner().take(),
        };
        let Some(pid) = pid else {
            return;
        };
        // Only hand focus back while we still hold it. On an outside-click
        // dismissal the user has already activated another app, and reactivating
        // the remembered one would steal focus from it (review MAJOR-1).
        let frontmost = NSWorkspace::sharedWorkspace().frontmostApplication();
        let frontmost_pid = frontmost.as_ref().map(|app| app.processIdentifier());
        if !super::should_reactivate(frontmost_pid, std::process::id() as i32) {
            return;
        }
        // Main thread; the looked-up application is autoreleased and may have
        // already quit, in which case there is nothing to restore.
        let Some(app) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
        else {
            return;
        };
        // `ActivateIgnoringOtherApps` is deprecated on macOS 14+ but a plain
        // activation request from the app that is yielding focus is still
        // honoured, so no deprecated flag is used.
        let _ = app.activateWithOptions(NSApplicationActivationOptions::empty());
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::should_reactivate;

    #[test]
    fn only_reactivates_while_polaris_is_still_frontmost() {
        // Escape / trigger dismissal: we are still frontmost, hand focus back.
        assert!(should_reactivate(Some(4242), 4242));
        // Outside-click dismissal: the user already activated another app, so
        // its activation must stand instead of being overwritten.
        assert!(!should_reactivate(Some(100), 4242));
        // No frontmost application at all: nothing to yield focus to.
        assert!(!should_reactivate(None, 4242));
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    pub fn remember_frontmost() {}
    pub fn restore_frontmost() {}
}

pub use platform::{remember_frontmost, restore_frontmost};
