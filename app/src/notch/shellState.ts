/**
 * The pure shell-state resolution rule (step A5), split out of `useShellState`
 * so it can be unit-tested without React or Tauri (see `shellState.test.ts`).
 *
 * A source **proposes** a named state; one documented precedence rule resolves
 * them. The names themselves are owned by the Rust `SHELL_STATES` table, so this
 * module never enumerates them: adding a state is a Rust table row (plus, only
 * if it has new body content, one CSS block).
 */

/**
 * A named shell state. Deliberately `string` rather than a closed union: the
 * authoritative list lives in Rust, so a new state must not force a TypeScript
 * edit here (that would break the "one table row" promise).
 */
export type ShellStateName = string;

/** Where a proposal came from. */
export type ShellSource = "voice" | "hover" | "hotkey";

/** Continuous hover before the panel opens. */
export const HOVER_ENTER_DWELL_MS = 250;
/** Grace after the cursor exits, so a wobble does not collapse the panel. */
export const HOVER_LEAVE_GRACE_MS = 400;
/** Mirrors `--shell-motion`; the fallback commit fires just after the CSS tween. */
export const SHELL_MOTION_MS = 470;

/**
 * Resolution options.
 *
 * `voiceAttention` says whether the voice source is in an **attention** state
 * (recording, transcribing, a permission hint, a connection error). Only then
 * does voice outrank hover. During the ready/error *dwell* the voice source only
 * keeps the label up; a hover must still be able to open the panel, otherwise
 * the dwell (up to 6 s) locks hover out (review MINOR-1).
 */
export interface ShellResolutionOptions {
  voiceAttention?: boolean;
}

/**
 * Resolves the proposals. Precedence:
 *
 * 1. `hotkey` — an **explicitly invoked mode** (today the double-Control
 *    `prompt`). It outranks everything because it is a deliberate user mode
 *    with its own dismissal paths, and no ambient signal may tear it away:
 *    losing hover must not collapse a half-typed prompt, and a recording must
 *    not replace it.
 *
 *    **Voice and prompt may be active at the same time.** This is a new case,
 *    so the rule is written down here rather than left to fall out of the
 *    ordering: while the prompt is latched, an attention voice state does *not*
 *    take the surface, so the prompt body (and the typed text in it) survives
 *    the turn. The turn's stage is surfaced **inside** the prompt by the inline
 *    indicator ([`inlineVoiceStage`]) — the status strip is not rendered in the
 *    `prompt` state, so this mapping is what carries the voice feedback into the
 *    single surface. Dismissal is explicit: Escape, outside-click/blur, or the
 *    trigger again.
 * 2. an **attention** voice state — something the user must see right now;
 * 3. `hover` — the pointer rests on the shell;
 * 4. `voice` — the ambient ready/error dwell, which only keeps the label up.
 *
 * A source with nothing to say proposes `"collapsed"`. Because a quiet hotkey
 * source proposes `"collapsed"`, this reordering only changes behaviour while a
 * mode is actually latched.
 */
export function resolveShellState(
  proposals: Record<ShellSource, ShellStateName>,
  options: ShellResolutionOptions = {},
): ShellStateName {
  const { voice, hover, hotkey } = proposals;
  if (hotkey !== "collapsed") return hotkey;
  if ((options.voiceAttention ?? true) && voice !== "collapsed") {
    return voice;
  }
  if (hover !== "collapsed") return hover;
  if (voice !== "collapsed") return voice;
  return "collapsed";
}

/**
 * Whether a finished CSS transition on `.notch` should commit the native
 * window for the applied state. Width, height and border-radius tween together,
 * so three `transitionend` events fire per transition and only one may commit.
 * Fixed states always change width, but a content-driven state (the prompt)
 * keeps its width and only changes height, so height must commit it too
 * (review MINOR-1). `contentDriven` is supplied by the caller, which owns the
 * name of the content-driven state, so this module stays state-table agnostic.
 */
export function isCommitTransition(propertyName: string, contentDriven: boolean): boolean {
  if (propertyName === "width") return true;
  return contentDriven && propertyName === "height";
}

/**
 * Whether a measured content height is safe to send across IPC. `Math.round`
 * preserves `NaN` and `Infinity`, and `NaN <= 0` is `false`, so a naive guard
 * let `NaN` reach `JSON.stringify` as `{"height": null}`, which Tauri's `f64`
 * deserializer rejects (review MINOR-2).
 */
export function isUsableShellHeight(height: number): boolean {
  return Number.isFinite(height) && height > 0;
}

/**
 * Applies the explicit-dismissal hover latch to one hover edge.
 *
 * A dismissal while the cursor rests on the shell must not let the still-"inside"
 * hover source immediately re-open the interactive panel. The latch swallows
 * `inside` edges until the cursor has actually left the shell (`inside: false`),
 * which clears it. It is a latch, not a timer: no amount of waiting re-arms
 * hover; only a leave-and-return does (review MAJOR-2).
 */
export function applyHoverEdge(
  inside: boolean,
  latched: boolean,
): { latched: boolean; accept: boolean } {
  if (inside) return { latched, accept: !latched };
  return { latched: false, accept: true };
}

/**
 * The voice stages the prompt's inline indicator can show. These are exactly the
 * three stage names the shell strip already uses; the indicator re-uses the
 * strip's `state-*` animation classes, so this introduces no new vocabulary.
 */
export type VoiceStage = "listening" | "thinking" | "speaking";

/**
 * Maps the shell's `visual` state name to the inline voice stage the prompt
 * shows while a voice turn is live, or `null` when there is nothing to show.
 *
 * This is the co-active case [`resolveShellState`] documents: the latched
 * `prompt` state wins the surface, so the voice stage has to reach the prompt
 * through this mapping instead of the status strip. The mapping re-uses the
 * shell's existing stage semantics (`recording` = listening, `transcribing` =
 * thinking, `speaking` = speaking). `idle` (no turn) and `error` (a settled
 * turn or a connection problem) return `null`, so the indicator disappears and
 * the prompt returns to its normal look once the turn settles.
 */
export function inlineVoiceStage(visual: string): VoiceStage | null {
  switch (visual) {
    case "recording":
      return "listening";
    case "transcribing":
      return "thinking";
    case "speaking":
      return "speaking";
    default:
      return null;
  }
}
