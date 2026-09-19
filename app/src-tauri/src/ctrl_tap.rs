//! Double-Control tap detection for the typed prompt panel (step A6).
//!
//! Polaris is push-to-talk first: the Control+Option hold in
//! [`crate::gesture`] owns the microphone. Typed input needs a *different*
//! gesture that costs no extra key and cannot be confused with that hold. A
//! double tap of Control alone fits: it is physically reachable, it is not a
//! system shortcut on its own, and the app only observes `flagsChanged` (see
//! [`crate::hotkey_flags`]), so Control is never swallowed.
//!
//! Like [`crate::gesture`], this module is deliberately pure: it takes a
//! [`ModifierSample`] plus a timestamp and returns **one bit** — "a double tap
//! just completed". No AppKit, no window, no channel, so every rule is
//! unit-testable without a keyboard.
//!
//! Rules:
//!
//! 1. **A tap is short.** Control down then up in at most [`MAX_TAP_HOLD`].
//!    A longer hold is a hold, not a tap.
//! 2. **The two taps are close.** The second tap must *start* within
//!    [`TAP_GAP`] of the first tap's release.
//! 3. **Any other modifier poisons the attempt.** Option/Command/Shift held at
//!    any point (including between the taps) invalidates the sequence, because
//!    Control+Option is VoiceOver's modifier and the whole point of the gesture
//!    is to stay clear of it. Everything must be released before a new sequence
//!    can start.
//! 4. **No retrigger without a full cycle.** A detected double tap fully resets
//!    the machine; the next one needs two fresh taps.
//!
//! Fn (the Globe key) is intentionally *not* handled: the existing masked
//! sample ([`ModifierSample`]) does not carry it, and extending that struct
//! would mean editing `gesture.rs`, which is outside this step's file scope.
//! It is recorded as a known gap in the A6 report.

use std::time::{Duration, Instant};

use crate::gesture::ModifierSample;

/// Longest a single Control press may be held and still count as a tap.
///
/// 350 ms sits just above a comfortable deliberate tap and well below the
/// 300 ms+ that [`crate::gesture::ARM_DELAY`] already treats as a hold, so the
/// two gestures cannot both fire from one press. Tune here only.
pub const MAX_TAP_HOLD: Duration = Duration::from_millis(350);

/// Longest gap allowed between the first tap's release and the second tap's
/// press.
///
/// 400 ms is the usual double-click threshold (macOS ships ~500 ms; 400 ms is
/// snappier and still forgiving for a modifier tap). Tune here only.
pub const TAP_GAP: Duration = Duration::from_millis(400);

/// The double-Control detector. Owned by the prompt driver thread.
#[derive(Debug, Default)]
pub struct CtrlTap {
    /// Control held at the last sample.
    control_down: bool,
    /// Start of the current Control press, while it is still a tap candidate.
    press_started: Option<Instant>,
    /// Release time of the first valid tap, waiting for its partner.
    first_tap_release: Option<Instant>,
    /// The current press is the second tap of a pair.
    awaiting_second: bool,
    /// A foreign modifier was seen; suppressed until everything is released.
    contaminated: bool,
}

impl CtrlTap {
    /// Applies one masked `flagsChanged` sample. Returns `true` exactly once,
    /// on the release that completes a double tap.
    pub fn on_modifiers(&mut self, sample: ModifierSample, now: Instant) -> bool {
        let foreign = sample.option || sample.command || sample.shift;

        if foreign {
            // A chord in progress (VoiceOver's Control+Option included). Kill
            // any candidate and stay poisoned until every key is released, so
            // a user holding a chord cannot slide into the prompt.
            self.contaminated = true;
            self.press_started = None;
            self.first_tap_release = None;
            self.awaiting_second = false;
            self.control_down = sample.control;
            return false;
        }

        if sample.control == self.control_down {
            // No Control edge. The one transition worth acting on is "nothing
            // is held any more": that is what lets a new sequence start.
            if !sample.control {
                self.contaminated = false;
            }
            return false;
        }

        if sample.control {
            // Control down.
            self.control_down = true;
            if self.contaminated {
                // The press began while a foreign modifier was still around.
                self.press_started = None;
                return false;
            }
            // Only a press that begins soon after the first tap's release can
            // complete the pair; a late press starts a fresh sequence instead.
            let within_gap = self
                .first_tap_release
                .is_some_and(|release| now.duration_since(release) <= TAP_GAP);
            if within_gap {
                self.awaiting_second = true;
            } else {
                self.first_tap_release = None;
                self.awaiting_second = false;
            }
            self.press_started = Some(now);
            return false;
        }

        // Control up.
        self.control_down = false;
        let contaminated = self.contaminated;
        self.contaminated = false;
        let started = self.press_started.take();
        let awaiting = std::mem::take(&mut self.awaiting_second);

        let short_tap = matches!(
            started.map(|start| now.duration_since(start)),
            Some(held) if held <= MAX_TAP_HOLD
        );
        if contaminated || !short_tap {
            self.first_tap_release = None;
            return false;
        }

        if awaiting {
            self.first_tap_release = None;
            return true;
        }

        self.first_tap_release = Some(now);
        false
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

    fn ctrl(down: bool) -> ModifierSample {
        sample(down, false, false, false)
    }

    const TAP: Duration = Duration::from_millis(80);

    /// One tap: Control down at `start`, up `TAP` later. Returns the release
    /// instant so callers can place the next tap.
    fn tap(machine: &mut CtrlTap, start: Instant) -> (bool, Instant) {
        assert!(!machine.on_modifiers(ctrl(true), start));
        let release = start + TAP;
        (machine.on_modifiers(ctrl(false), release), release)
    }

    #[test]
    fn happy_path_double_tap_fires_once_on_the_second_release() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        let (fired, release) = tap(&mut machine, t0);
        assert!(!fired, "the first tap alone must not open the prompt");

        let (fired, _) = tap(&mut machine, release + Duration::from_millis(120));
        assert!(fired, "the second tap within the gap completes the double tap");

        // Firing resets the machine: a duplicate release sample is inert.
        assert!(!machine.on_modifiers(ctrl(false), release + Duration::from_millis(200)));
    }

    #[test]
    fn a_too_slow_second_tap_does_not_fire() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        let (fired, release) = tap(&mut machine, t0);
        assert!(!fired);

        // Starts after TAP_GAP has elapsed: a new first tap, not a partner.
        let (fired, release) = tap(&mut machine, release + TAP_GAP + Duration::from_millis(1));
        assert!(!fired, "a tap starting after the gap must not complete a pair");

        // It *did* become the new first tap, so a prompt one follows.
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(100));
        assert!(fired);
    }

    #[test]
    fn a_long_control_hold_is_not_a_tap() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        assert!(!machine.on_modifiers(ctrl(true), t0));
        assert!(
            !machine.on_modifiers(ctrl(false), t0 + MAX_TAP_HOLD + Duration::from_millis(1)),
            "a hold longer than MAX_TAP_HOLD must be rejected"
        );

        // The rejected hold must not seed a sequence either.
        assert!(!machine.on_modifiers(ctrl(true), t0 + Duration::from_secs(1)));
        assert!(!machine.on_modifiers(
            ctrl(false),
            t0 + Duration::from_secs(1) + TAP
        ));
    }

    #[test]
    fn option_or_command_contamination_invalidates_the_sequence() {
        // Control, then adding Option mid-hold (the push-to-talk chord) must
        // never register as a tap.
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();
        assert!(!machine.on_modifiers(ctrl(true), t0));
        assert!(!machine.on_modifiers(sample(true, true, false, false), t0));
        assert!(!machine.on_modifiers(sample(false, false, false, false), t0 + TAP));

        // Option appearing *between* the two taps also poisons the pair.
        let mut machine = CtrlTap::default();
        let (_, release) = tap(&mut machine, t0);
        assert!(!machine.on_modifiers(sample(false, true, false, false), release));
        assert!(!machine.on_modifiers(sample(false, false, false, false), release));
        let (fired, release) = tap(&mut machine, release + Duration::from_millis(60));
        assert!(!fired, "contamination between the taps must break the pair");

        // With everything released, a fresh pair works again.
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(60));
        assert!(fired);
    }

    #[test]
    fn no_retrigger_until_a_full_release_cycle() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        // Complete one double tap.
        let (_, release) = tap(&mut machine, t0);
        let (fired, release) = tap(&mut machine, release + Duration::from_millis(80));
        assert!(fired);

        // A single tap right after is only the first half of the *next* pair:
        // the machine rearmed, it did not fire again.
        assert!(!machine.on_modifiers(ctrl(true), release + Duration::from_millis(10)));
        assert!(!machine.on_modifiers(ctrl(false), release + Duration::from_millis(10) + TAP));

        // Its matching partner completes exactly one new double tap.
        assert!(!machine.on_modifiers(ctrl(true), release + Duration::from_millis(200)));
        assert!(machine.on_modifiers(ctrl(false), release + Duration::from_millis(200) + TAP));

        // Sustained Control samples never fire on their own.
        assert!(!machine.on_modifiers(ctrl(true), release + Duration::from_millis(400)));
        assert!(!machine.on_modifiers(ctrl(true), release + Duration::from_millis(600)));
        assert!(!machine.on_modifiers(ctrl(false), release + Duration::from_millis(800)));
    }

    #[test]
    fn three_taps_fire_once_and_start_a_new_sequence() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        let (_, release) = tap(&mut machine, t0);
        let (fired, release) = tap(&mut machine, release + Duration::from_millis(80));
        assert!(fired);
        // The third tap is the first half of a *new* pair, not an instant second
        // double tap.
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(80));
        assert!(!fired);
    }
}
