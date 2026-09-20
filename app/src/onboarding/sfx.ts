/**
 * The onboarding window's sound vocabulary.
 *
 * One re-export layer over `@/lib/sfx` (the UI-sound worker's module) for two
 * reasons, neither of them indirection for its own sake:
 *
 * 1. **One import site.** `@/lib/sfx` does not exist on this branch — see the
 *    merge stub at that path — so the number of files that name it should be
 *    one, not seven. When the real module lands, nothing else moves.
 * 2. **The vocabulary is a decision, not a parameter.** The brief's rule is "at
 *    most one sound per user action", and the cheapest way to break that rule is
 *    to let each page reach for whichever cue reads nicely in isolation. Naming
 *    the six sounds this window is allowed to make, here, with the reason
 *    attached, makes an unexplained seventh obvious in review.
 *
 * `playSfx` never throws and never awaits: the real module swallows a locked
 * `AudioContext`, and the stub does nothing at all. So no caller here handles a
 * failure, and none should — a silent window is a correct window.
 */
import { playSfx, unlockSfx } from "@/lib/sfx";

/**
 * Every cue the onboarding window may play, and the single event that earns it.
 *
 * - `forward` / `back` — a page move, and *only* a page move. The slide is the
 *   window's main gesture and the only thing that happens often enough to need
 *   a sound at all; giving it a directional pair is what makes a step backwards
 *   feel like an undo rather than a second step forwards.
 * - `check` — one permission turning green. Deliberately not played for the
 *   *request* (the OS dialog is the feedback for that) and not for the second
 *   permission's arrival on top of the first: it marks a state change the user
 *   caused and may not be looking at, because the grant can land while they are
 *   in System Settings.
 * - `success` — a shortcut test passing. Distinct from `check` on purpose: the
 *   user just performed a gesture with their hands and the only confirmation
 *   the page can give is immediate. This is the one sound in the window that is
 *   doing real work.
 * - `complete` — arrival on the last page. Once, per run.
 * - `press` — the primary button. Not `hover`, and not `focus`: a hover sound
 *   on a six-page window fires on every stray mouse move, and a focus sound
 *   fires on every Tab, which is a punishment for using the keyboard.
 *
 * `hover` and `focus` are therefore left unused, which is a deliberate
 * subtraction rather than an oversight; this comment is the record of it.
 */
export type OnboardingCue = "forward" | "back" | "check" | "success" | "complete" | "press";

/** Plays one cue. Fire-and-forget by contract — see the module header. */
export function cue(name: OnboardingCue): void {
  playSfx(name);
}

/**
 * Releases the browser's autoplay gate, from the first real user gesture.
 *
 * WebAudio will not start an `AudioContext` until the page has been interacted
 * with, so the welcome page's button is the earliest possible moment — and it is
 * also the moment the *first* cue wants to play. Unlocking is therefore fired
 * alongside that cue rather than before it: the first sound may be swallowed,
 * every one after it will not, and waiting on the unlock would put an await
 * between the click and the slide.
 */
export function unlockOnFirstGesture(): void {
  void unlockSfx().catch(() => {});
}
