//! Double-Control tap detection for the typed prompt panel (step A6).
//!
//! Polaris is push-to-talk first: the Control+Option hold in
//! [`crate::gesture`] owns the microphone. Typed input needs a *different*
//! gesture that costs no extra key and cannot be confused with that hold. A
//! double tap of Control alone fits: it is physically reachable, it is not a
//! system shortcut on its own, and the app only *observes* modifiers and
//! key-downs (see [`crate::hotkey_flags`]) — it never swallows them.
//!
//! A bare `flagsChanged` view is not enough on its own: `Ctrl+C`, tmux's
//! `Ctrl+B`, or `Ctrl+A Ctrl+K` deliver only the Control press/release to the
//! modifier monitor, so two ordinary Control chords look exactly like two bare
//! taps. The ordered `keyDown` observation ([`CtrlTap::on_key_press`]) supplies
//! the missing bit: a non-modifier key pressed while Control is down marks that
//! press as a chord, never a tap.
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
//! 4. **A Control chord is not a tap.** A non-modifier key pressed while
//!    Control is down (`Ctrl+C`, tmux's `Ctrl+B`, `Ctrl+A Ctrl+K`) poisons the
//!    press exactly like a foreign modifier; see [`CtrlTap::on_key_press`].
//!    This is what keeps ordinary terminal/editor shortcuts from opening the
//!    prompt.
//! 5. **No retrigger without a full cycle.** A detected double tap fully resets
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

    /// Applies one non-modifier key-down from the shared monitor pair.
    ///
    /// A key pressed while Control is down means the Control press is part of a
    /// chord (`Ctrl+C` to interrupt, tmux's `Ctrl+B`, `Ctrl+A Ctrl+K`, …), not a
    /// bare tap. `flagsChanged` alone cannot see that key, so without this the
    /// two look identical and two quick Control chords would open the prompt.
    ///
    /// Only a key pressed *while Control is held* poisons the attempt: a key
    /// with Control up is ordinary typing and must not disable the gesture. The
    /// poison follows the same path as a foreign modifier and clears once every
    /// key is released.
    pub fn on_key_press(&mut self) {
        if !self.control_down {
            return;
        }
        self.contaminated = true;
        self.press_started = None;
        self.first_tap_release = None;
        self.awaiting_second = false;
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
        let hold_release = t0 + MAX_TAP_HOLD + Duration::from_millis(1);
        assert!(
            !machine.on_modifiers(ctrl(false), hold_release),
            "a hold longer than MAX_TAP_HOLD must be rejected"
        );

        // The rejected hold must not seed a sequence. A fresh tap begun *inside*
        // TAP_GAP of the hold's release must not pair with it — this only holds
        // if the hold really left `first_tap_release` empty.
        let (fired, release) = tap(&mut machine, hold_release + Duration::from_millis(100));
        assert!(
            !fired,
            "a tap within TAP_GAP of a rejected hold must not complete a pair"
        );

        // That tap *did* become the new first tap, so its partner fires: the
        // machine was rearmed rather than permanently poisoned.
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(100));
        assert!(fired, "the machine must rearm after the rejected hold");
    }

    #[test]
    fn option_or_command_contamination_invalidates_the_sequence() {
        // Control, then adding Option mid-hold (the push-to-talk chord) must
        // never register as a tap.
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();
        assert!(!machine.on_modifiers(ctrl(true), t0));
        assert!(!machine.on_modifiers(sample(true, true, false, false), t0));
        let contaminated_release = t0 + TAP;
        assert!(!machine.on_modifiers(sample(false, false, false, false), contaminated_release));

        // The contaminated press must not have seeded a sequence: a fresh tap
        // begun within TAP_GAP of its release must not pair with it.
        let (fired, release) = tap(&mut machine, contaminated_release + Duration::from_millis(60));
        assert!(
            !fired,
            "a tap after a contaminated press must not complete a pair"
        );

        // Fully released, a fresh pair works again.
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(60));
        assert!(fired, "the machine must rearm after the contamination clears");

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
    fn command_and_shift_also_contaminate_the_sequence() {
        for foreign in [sample(true, false, true, false), sample(true, false, false, true)] {
            let mut machine = CtrlTap::default();
            let t0 = Instant::now();
            assert!(!machine.on_modifiers(ctrl(true), t0));
            assert!(!machine.on_modifiers(foreign, t0));
            let release = t0 + TAP;
            assert!(!machine.on_modifiers(ctrl(false), release));
            // Nothing was seeded: a tap inside TAP_GAP does not pair.
            let (fired, _) = tap(&mut machine, release + Duration::from_millis(60));
            assert!(
                !fired,
                "Command/Shift contamination must invalidate the sequence"
            );
        }
    }

    #[test]
    fn a_long_second_tap_does_not_fire() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        let (fired, release) = tap(&mut machine, t0);
        assert!(!fired);

        // The second press begins in time but is held past MAX_TAP_HOLD: it is
        // a hold, so the release must not complete the pair.
        let start = release + Duration::from_millis(80);
        assert!(!machine.on_modifiers(ctrl(true), start));
        assert!(!machine.on_modifiers(ctrl(false), start + MAX_TAP_HOLD + Duration::from_millis(1)));
    }

    #[test]
    fn a_foreign_modifier_during_the_second_press_breaks_the_pair() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        let (fired, release) = tap(&mut machine, t0);
        assert!(!fired);

        let start = release + Duration::from_millis(80);
        assert!(!machine.on_modifiers(ctrl(true), start));
        // Shift arrives mid-second-press: the pair is dead.
        assert!(!machine.on_modifiers(sample(true, false, false, true), start));
        assert!(!machine.on_modifiers(ctrl(false), start + TAP));
    }

    #[test]
    fn a_key_pressed_while_control_is_down_invalidates_the_sequence() {
        // Ctrl+C twice: each chord is Control down, key down, Control up. The
        // modifier samples look like two bare taps, so the key-down must break
        // both the pending first tap and the second press.
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        // First chord: Control down, C down, Control up.
        assert!(!machine.on_modifiers(ctrl(true), t0));
        machine.on_key_press();
        let chord_release = t0 + TAP;
        assert!(
            !machine.on_modifiers(ctrl(false), chord_release),
            "a chord is not a tap"
        );

        // Second chord begins inside TAP_GAP of the first release and would
        // otherwise pair. The key-down must kill it again.
        let start = chord_release + Duration::from_millis(80);
        assert!(!machine.on_modifiers(ctrl(true), start));
        machine.on_key_press();
        assert!(
            !machine.on_modifiers(ctrl(false), start + TAP),
            "two quick Control chords must never open the prompt"
        );
    }

    #[test]
    fn a_key_press_with_control_up_is_ordinary_typing_and_does_not_invalidate() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        // Typing between two bare taps must not disturb the gesture.
        let (fired, release) = tap(&mut machine, t0);
        assert!(!fired);
        machine.on_key_press();
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(120));
        assert!(fired, "typing with Control up must not block the double tap");
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

    /// Decided interaction: a double-Control tap during the microphone hold is
    /// ignored. Push-to-talk holds Control **and** Option, and rule 3 poisons any
    /// attempt that ever sees Option, so the short Control edges inside the hold
    /// can never seed or complete a pair — no separate voice-state gate is
    /// needed. After the hold the tap must be live again (no permanent poison).
    /// See `super::tap` for the full rationale.
    #[test]
    fn a_push_to_talk_hold_owns_the_control_key_so_no_tap_can_fire() {
        let mut machine = CtrlTap::default();
        let t0 = Instant::now();

        // Control down, then Option joins: the push-to-talk pair.
        assert!(!machine.on_modifiers(ctrl(true), t0));
        assert!(!machine.on_modifiers(sample(true, true, false, false), t0));

        // The user mashes Control twice inside the hold. Every sample still
        // carries Option, so the pair stays poisoned and nothing fires.
        assert!(!machine.on_modifiers(
            sample(false, true, false, false),
            t0 + Duration::from_millis(120)
        ));
        assert!(!machine.on_modifiers(
            sample(true, true, false, false),
            t0 + Duration::from_millis(200)
        ));
        assert!(!machine.on_modifiers(
            sample(false, true, false, false),
            t0 + Duration::from_millis(280)
        ));
        // Releasing Option first (Control still down) must not sneak a tap
        // through either.
        assert!(!machine.on_modifiers(ctrl(true), t0 + Duration::from_millis(360)));
        assert!(!machine.on_modifiers(ctrl(false), t0 + Duration::from_millis(420)));

        // Everything released. The turn has moved past recording (transcribing /
        // thinking / speaking), where the tap is live again: a fresh pair opens
        // the prompt, which then coexists with the turn.
        let (_, release) = tap(&mut machine, t0 + Duration::from_millis(500));
        let (fired, _) = tap(&mut machine, release + Duration::from_millis(120));
        assert!(fired, "the tap must be live again once the hold has ended");
    }
}
