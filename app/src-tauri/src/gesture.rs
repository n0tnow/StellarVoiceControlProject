//! The push-to-talk gesture state machine (step A0 follow-up).
//!
//! Two independent triggers feed **one** latch:
//!
//! * the default modifier-only gesture — hold Control+Option, release **either**
//!   to stop (`NSEvent` `flagsChanged`, see [`crate::hotkey_flags`]);
//! * the always-available key-code shortcut Control+Option+Space
//!   (`tauri-plugin-global-shortcut`).
//!
//! This module is deliberately pure: it takes a [`ModifierSample`] (or a
//! shortcut press/release) plus a timestamp and returns the capture
//! transitions to perform. That keeps every rule unit-testable without a
//! window server, an Accessibility grant, or a microphone.
//!
//! Rules, distilled from the modifier-only research report
//! (`docs/reports/2026-09-19-modifier-only-hotkey.md`):
//!
//! 1. **Debounce by effective state, never by counting events.** `flagsChanged`
//!    coalesces and fires once per side, so the latch stores the last masked
//!    pair state and only reacts to a change.
//! 2. **Arm with a delay.** A pair hold starts a capture only after
//!    [`ARM_DELAY`] has elapsed with the pair still down; shorter holds are
//!    taps or fragments of someone else's chord.
//! 3. **Command/Shift invalidate the hold.** Control+Option is VoiceOver's
//!    default modifier, so a pair overlapped by Command or Shift is a chord,
//!    not a push-to-talk gesture. Once invalidated, the pair must be fully
//!    released before it can arm again — a VoiceOver user holding the pair
//!    through a chord must not slide into a recording.
//! 4. **Start is idempotent.** The shortcut arms instantly; the capture engine
//!    itself is also idempotent while recording.
//! 5. **A watchdog reconciles with ground truth.** A missed release (sleep,
//!    lock, Secure Input) cannot leave the latch recording forever.

use std::time::{Duration, Instant};

/// How long Control+Option must stay down before capture arms.
///
/// 300 ms is below the point where push-to-talk starts feeling laggy
/// (typically cited at 200–500 ms) while rejecting the tens-of-milliseconds
/// pass-through inside other shortcuts' chords. Tune here only.
pub const ARM_DELAY: Duration = Duration::from_millis(300);

/// The driver wakes at least this often to service the arm deadline. It is
/// event-driven in between, so this only matters while a hold is pending.
pub const DRIVER_TICK: Duration = Duration::from_millis(25);

/// How often the latch is reconciled against `NSEvent`'s live modifier state.
pub const WATCHDOG_INTERVAL: Duration = Duration::from_secs(1);

/// One `flagsChanged` sample, already masked to device-independent bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModifierSample {
    pub control: bool,
    pub option: bool,
    pub command: bool,
    pub shift: bool,
}

impl ModifierSample {
    /// The gesture pair: both Control and Option held.
    pub fn pair_down(self) -> bool {
        self.control && self.option
    }

    /// A third modifier that turns a pair hold into someone else's chord.
    pub fn blocked(self) -> bool {
        self.command || self.shift
    }
}

/// What started the in-flight capture, so only the matching release stops it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Modifiers,
    Shortcut,
}

/// A capture side effect for the driver to apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Start,
    Stop,
}

/// The gesture latch. Owned by the hotkey driver thread.
#[derive(Debug, Default)]
pub struct Latch {
    /// Effective Control+Option state (raw, before the Command/Shift gate).
    pair_down: bool,
    /// Command or Shift currently held.
    blocked: bool,
    /// The current pair hold was invalidated by a chord; wait for full release.
    poisoned: bool,
    /// Deadline at which a still-held pair becomes a capture.
    arm_deadline: Option<Instant>,
    /// Non-`None` while a capture is engaged, and by which trigger.
    active: Option<Trigger>,
}

impl Latch {
    /// Applies one Control/Option/Command/Shift state change.
    pub fn on_modifiers(&mut self, sample: ModifierSample, now: Instant) -> Vec<Action> {
        let pair = sample.pair_down();
        let mut actions = Vec::new();

        if sample.blocked() {
            self.blocked = true;
            // Only poison a hold that is actually paired; pressing Command
            // alone must not invalidate the *next* pair press.
            if pair {
                self.poisoned = true;
            }
            self.arm_deadline = None;
            if pair && self.active == Some(Trigger::Modifiers) {
                self.active = None;
                actions.push(Action::Stop);
            }
            self.pair_down = pair;
            return actions;
        }

        self.blocked = false;

        if pair {
            self.pair_down = true;
            if !self.poisoned && self.active.is_none() && self.arm_deadline.is_none() {
                self.arm_deadline = Some(now + ARM_DELAY);
            }
        } else {
            self.pair_down = false;
            self.poisoned = false;
            self.arm_deadline = None;
            if self.active == Some(Trigger::Modifiers) {
                self.active = None;
                actions.push(Action::Stop);
            }
        }
        actions
    }

    /// Applies a Control+Option+Space shortcut press (`true`) or release.
    ///
    /// The shortcut is explicit, so it arms instantly and works with or without
    /// Accessibility trust.
    pub fn on_shortcut(&mut self, pressed: bool) -> Vec<Action> {
        if pressed {
            self.arm_deadline = None;
            if self.active.is_none() {
                self.active = Some(Trigger::Shortcut);
                return vec![Action::Start];
            }
            Vec::new()
        } else if self.active == Some(Trigger::Shortcut) {
            self.active = None;
            vec![Action::Stop]
        } else {
            Vec::new()
        }
    }

    /// Fires the pending arm once its deadline passes. Called on every driver
    /// tick; returns nothing when no hold is pending.
    pub fn tick(&mut self, now: Instant) -> Vec<Action> {
        if let Some(deadline) = self.arm_deadline {
            if now >= deadline {
                self.arm_deadline = None;
                if self.pair_down && !self.blocked && !self.poisoned && self.active.is_none() {
                    self.active = Some(Trigger::Modifiers);
                    return vec![Action::Start];
                }
            }
        }
        Vec::new()
    }

    /// Reconciles the latch with `NSEvent`'s live modifier state. When ground
    /// truth disagrees with what the latch last saw, the sample is replayed
    /// through [`Self::on_modifiers`], which also heals a stuck recording.
    pub fn watchdog(&mut self, sample: ModifierSample, now: Instant) -> Vec<Action> {
        if sample.pair_down() != self.pair_down || sample.blocked() != self.blocked {
            return self.on_modifiers(sample, now);
        }
        Vec::new()
    }

    /// Drops all modifier state (used when Accessibility trust is missing or
    /// revoked) and stops any capture the gesture had started.
    pub fn reset_modifiers(&mut self) -> Vec<Action> {
        self.pair_down = false;
        self.blocked = false;
        self.poisoned = false;
        self.arm_deadline = None;
        if self.active == Some(Trigger::Modifiers) {
            self.active = None;
            return vec![Action::Stop];
        }
        Vec::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(control: bool, option: bool, command: bool, shift: bool) -> ModifierSample {
        ModifierSample {
            control,
            option,
            command,
            shift,
        }
    }

    fn pair() -> ModifierSample {
        sample(true, true, false, false)
    }

    #[test]
    fn both_down_arms_after_the_delay_and_starts() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        assert_eq!(latch.on_modifiers(pair(), t0), vec![]);
        // Not yet.
        assert_eq!(latch.tick(t0 + ARM_DELAY - Duration::from_millis(1)), vec![]);
        // Exactly at the deadline, while the pair is still down, it starts once.
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
        // A second tick must not start again.
        assert_eq!(latch.tick(t0 + ARM_DELAY + Duration::from_millis(50)), vec![]);
    }

    #[test]
    fn releasing_either_modifier_stops() {
        for release in [
            sample(false, true, false, false),
            sample(true, false, false, false),
            sample(false, false, false, false),
        ] {
            let mut latch = Latch::default();
            let t0 = Instant::now();
            latch.on_modifiers(pair(), t0);
            assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
            assert_eq!(latch.on_modifiers(release, t0 + ARM_DELAY), vec![Action::Stop]);
            // Release is a no-op once stopped.
            assert_eq!(latch.on_modifiers(release, t0 + ARM_DELAY), vec![]);
        }
    }

    #[test]
    fn command_or_shift_hold_is_ignored_and_poisons_the_pair() {
        for block in [
            sample(true, true, true, false),
            sample(true, true, false, true),
        ] {
            let mut latch = Latch::default();
            let t0 = Instant::now();
            assert_eq!(latch.on_modifiers(block, t0), vec![]);
            // Even after the arming delay, no capture starts.
            assert_eq!(latch.tick(t0 + ARM_DELAY), vec![]);
            // Releasing the blocker while the pair is still held must NOT arm:
            // the whole hold was invalidated.
            assert_eq!(
                latch.on_modifiers(pair(), t0 + ARM_DELAY),
                vec![],
                "a poisoned pair must not re-arm until it is fully released"
            );
            assert_eq!(
                latch.tick(t0 + ARM_DELAY + ARM_DELAY),
                vec![],
                "no capture may start from a poisoned hold"
            );
            // Fully releasing, then pressing again, arms normally.
            latch.on_modifiers(sample(false, false, false, false), t0);
            latch.on_modifiers(pair(), t0);
            assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
        }
    }

    #[test]
    fn command_pressed_mid_hold_cancels_and_stops() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        latch.on_modifiers(pair(), t0);
        // Command arrives before the deadline: the arm is cancelled.
        assert_eq!(latch.on_modifiers(sample(true, true, true, false), t0), vec![]);
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![]);

        // If it had already armed, the chord stops the capture.
        let mut latch = Latch::default();
        latch.on_modifiers(pair(), t0);
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
        assert_eq!(
            latch.on_modifiers(sample(true, true, false, true), t0),
            vec![Action::Stop]
        );
    }

    #[test]
    fn a_sub_delay_tap_never_starts_a_capture() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        latch.on_modifiers(pair(), t0);
        // Released well before the arm delay.
        assert_eq!(
            latch.on_modifiers(sample(false, false, false, false), t0 + Duration::from_millis(40)),
            vec![]
        );
        // Ticking past the would-be deadline must not start anything.
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![]);
    }

    #[test]
    fn shortcut_is_immediate_idempotent_and_release_stops() {
        let mut latch = Latch::default();
        assert_eq!(latch.on_shortcut(true), vec![Action::Start]);
        // A repeat press while recording is idempotent.
        assert_eq!(latch.on_shortcut(true), vec![]);
        assert_eq!(latch.on_shortcut(false), vec![Action::Stop]);
        assert_eq!(latch.on_shortcut(false), vec![]);
    }

    #[test]
    fn watchdog_heals_a_stuck_modifier_latch() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        latch.on_modifiers(pair(), t0);
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);

        // Ground truth says the pair is up even though no release arrived.
        assert_eq!(
            latch.watchdog(sample(false, false, false, false), t0 + WATCHDOG_INTERVAL),
            vec![Action::Stop]
        );
        // The healed latch is quiet afterwards.
        assert_eq!(
            latch.watchdog(sample(false, false, false, false), t0 + WATCHDOG_INTERVAL),
            vec![]
        );
    }

    #[test]
    fn watchdog_catches_a_missed_press() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        // The press event was dropped; the watchdog discovers the held pair.
        assert_eq!(latch.watchdog(pair(), t0), vec![]);
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
    }

    #[test]
    fn reset_modifiers_stops_the_gesture_capture_only() {
        let mut latch = Latch::default();
        let t0 = Instant::now();
        latch.on_modifiers(pair(), t0);
        assert_eq!(latch.tick(t0 + ARM_DELAY), vec![Action::Start]);
        assert_eq!(latch.reset_modifiers(), vec![Action::Stop]);
        assert_eq!(latch.reset_modifiers(), vec![]);

        // A capture started by the shortcut survives a modifier reset (trust
        // loss must not kill the always-available fallback).
        let mut latch = Latch::default();
        assert_eq!(latch.on_shortcut(true), vec![Action::Start]);
        assert_eq!(latch.reset_modifiers(), vec![]);
        assert_eq!(latch.on_shortcut(false), vec![Action::Stop]);
    }
}
