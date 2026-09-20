/**
 * Watching the user actually perform Polaris' two gestures.
 *
 * The two shortcut lessons do not ask the user to read about Control+Option and
 * double-Control; they ask them to do it, and refuse to advance until they have.
 * That means this module has to observe real key input from inside a focused
 * window, and *that* turned out to be the one question on this branch worth
 * doing archaeology for. The answer is written down here because the next person
 * to touch these pages will otherwise have to re-derive it.
 *
 * ## Do the native hotkey events reach a focused window? Yes.
 *
 * Polaris observes Control+Option and the double-Control tap with AppKit
 * `NSEvent` monitors, and the received wisdom about those is that a *global*
 * monitor never fires for events delivered to your own application. The
 * onboarding window is focusable and will be frontmost, so on that reading both
 * lessons would be ungatable.
 *
 * `app/src-tauri/src/hotkey_flags.rs` installs a **pair**: a global monitor and
 * a local one, both over `FlagsChanged | KeyDown`, and both call the same
 * `on_sample` plus the same `notify_sample_observers` fan-out. Its own header
 * says so — "a **global** monitor for events delivered to other apps and a
 * **local** monitor for events delivered to our own". Neither consumer gates on
 * application activation: `hotkey.rs::apply` emits `Hotkey { Down | Up }`
 * straight from the latch, and `notch/tap.rs` emits `notch_hotkey` straight from
 * the `CtrlTap` machine. Keyboard events go to the key window, which is ours, so
 * the local monitor sees them and both events fire normally.
 *
 * (Hover is the opposite case and is *not* handled here — see `NotchPage`.)
 *
 * ## So why is there a DOM fallback as well?
 *
 * Because the native path has two costs this page should not pay, and both are
 * facts about the real modules rather than defensive programming:
 *
 * 1. **Latency.** `gesture::ARM_DELAY` is 300 ms, so `Hotkey::Down` arrives only
 *    after the pair has been held that long. Requiring a further 400 ms would
 *    make the lesson's hold 700 ms of real key time — teachable, but slower than
 *    the gesture actually is.
 * 2. **Side effects.** `apply` calls `capture.start(app)`. A native pass means a
 *    real microphone recording and a real WAV on disk, from inside a window
 *    whose job is to explain the feature.
 * 3. **Accessibility trust.** The local monitor does not need it, but the whole
 *    module is disabled outright when `install` returns `None`, and the lesson
 *    should still work in a dev build with no Tauri under it at all.
 *
 * So both sources are read, and they are merged rather than chosen between: the
 * page passes on whichever arrives first. This is safe *because the machines are
 * idempotent* — [`passStep`] ignores a repeat, a second `down` while already
 * held changes nothing, and a `up` after the step has passed is a no-op. Neither
 * source needs to know the other exists.
 *
 * ## What "pure" means in this file
 *
 * The rules — how long a hold must be, what makes two Control taps a double tap
 * — are exported as plain functions and unit-tested in `useShortcutProbe.test.ts`.
 * The hooks below own only subscriptions and refs. The tap rules deliberately
 * mirror `app/src-tauri/src/ctrl_tap.rs` constant for constant: when both
 * sources are live, a gesture the Rust machine rejects must not be accepted by
 * the DOM one, or the lesson would teach a gesture that does not work.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

// Relative, with the extension: `useShortcutProbe.test.ts` is run by
// `node --test`, which resolves imports itself and knows nothing about the
// `@/` alias Vite and tsc share. Every module a node test can reach has to be
// importable by Node on its own — the same reason `lib/useTxRun.ts` does this.
import { listenNotchHotkey, listenNotchHover } from "../notch/shellBridge.ts";
import { listenPolarisEvents } from "../lib/polaris.ts";

/* ------------------------------------------------------------------ *
 * Pure rules
 * ------------------------------------------------------------------ */

/**
 * How long Control+Option must be held for the lesson to count it.
 *
 * 400 ms is the brief's number and it is a good one: it is comfortably longer
 * than an accidental brush of two modifiers on the way to some other chord, and
 * comfortably shorter than the shortest utterance anybody would actually record.
 * It is also just above `gesture::ARM_DELAY` (300 ms), so a hold that satisfies
 * this lesson is always a hold that would have armed the real latch — the lesson
 * cannot pass on a gesture the product would have ignored.
 */
export const MIN_HOLD_MS = 400;

/** Longest a single Control press may last and still be a tap. Mirrors `ctrl_tap::MAX_TAP_HOLD`. */
export const MAX_TAP_HOLD_MS = 350;

/** Longest gap between the first tap's release and the second's press. Mirrors `ctrl_tap::TAP_GAP`. */
export const TAP_GAP_MS = 400;

/** Whether a press/release pair was a long enough hold to pass the lesson. */
export function isQualifyingHold(
  pressedAtMs: number,
  releasedAtMs: number,
  minHoldMs: number = MIN_HOLD_MS,
): boolean {
  return releasedAtMs - pressedAtMs >= minHoldMs;
}

/**
 * The double-Control detector's memory.
 *
 * `poisoned` is the interesting field and it exists for the same reason it does
 * in `ctrl_tap.rs`: a bare modifier view cannot tell `Ctrl+C` from a Control
 * tap, because both deliver exactly one Control press and one Control release.
 * Any foreign modifier, or any ordinary key pressed while Control is down,
 * marks the attempt spent.
 */
export interface TapState {
  /** When the current Control press began, while it is still a tap candidate. */
  readonly pressedAt: number | null;
  /** When the first tap of a pending pair was released. */
  readonly lastReleaseAt: number | null;
  /** Whether the current attempt has been disqualified. */
  readonly poisoned: boolean;
}

/** No press, no pending first tap, nothing disqualified. */
export const INITIAL_TAP: TapState = { pressedAt: null, lastReleaseAt: null, poisoned: false };

/** One observation fed to [`tapReducer`]. */
export type TapEvent =
  | { readonly kind: "control-down"; readonly at: number }
  | { readonly kind: "control-up"; readonly at: number }
  /** A non-modifier key went down — this Control press is a chord, not a tap. */
  | { readonly kind: "other-key" }
  /** Option, Command or Shift was seen. Poisons the whole sequence. */
  | { readonly kind: "foreign-modifier" }
  /** The window lost focus, so the matching release will never arrive. */
  | { readonly kind: "reset" };

/** A step of the machine: the next state, and whether a double tap just completed. */
export interface TapResult {
  readonly state: TapState;
  readonly fired: boolean;
}

/**
 * The double-Control rules, as a pure reducer.
 *
 * Same five rules as `ctrl_tap.rs`: a tap is short, the two taps are close, a
 * foreign modifier poisons the attempt, a Control chord is not a tap, and a
 * detected double tap fully resets the machine so the next one needs two fresh
 * taps.
 *
 * A release always clears `poisoned`. That is what "everything must be released
 * before a new sequence can start" means in practice — the poison marks the
 * attempt, not the keyboard, and without the clear one stray `Ctrl+C` would
 * disable the lesson for good.
 */
export function tapReducer(state: TapState, event: TapEvent): TapResult {
  switch (event.kind) {
    case "reset":
      return { state: INITIAL_TAP, fired: false };

    case "other-key":
    case "foreign-modifier":
      // Rule 3/4. `lastReleaseAt` goes too: a foreign modifier *between* the
      // two taps invalidates the sequence, not just the press it lands on.
      return { state: { pressedAt: null, lastReleaseAt: null, poisoned: true }, fired: false };

    case "control-down": {
      // Rule 2 is enforced here rather than on release so a slow second press
      // starts a fresh pair instead of silently pairing with a stale first tap.
      const pending =
        state.lastReleaseAt !== null && event.at - state.lastReleaseAt <= TAP_GAP_MS
          ? state.lastReleaseAt
          : null;
      return {
        state: { pressedAt: event.at, lastReleaseAt: pending, poisoned: false },
        fired: false,
      };
    }

    case "control-up": {
      if (state.poisoned || state.pressedAt === null) {
        return { state: INITIAL_TAP, fired: false };
      }
      // Rule 1: a long press is a hold — very likely the push-to-talk gesture
      // the previous lesson just taught — and must not count as a tap.
      if (event.at - state.pressedAt > MAX_TAP_HOLD_MS) {
        return { state: INITIAL_TAP, fired: false };
      }
      if (state.lastReleaseAt !== null) {
        // Rule 5: a completed double tap resets the machine entirely.
        return { state: INITIAL_TAP, fired: true };
      }
      return {
        state: { pressedAt: null, lastReleaseAt: event.at, poisoned: false },
        fired: false,
      };
    }
  }
}

/**
 * Reads one keyboard event as a [`TapEvent`], or `null` when it says nothing.
 *
 * Split out from the listener so the browser's exact flag semantics are pinned
 * by a test rather than trusted. The subtle one is that on a `keyup` of Control
 * the event's own `ctrlKey` is already `false`, which is why the key name is
 * what decides and the flags only ever poison.
 */
export function tapEventFor(
  type: "keydown" | "keyup",
  key: string,
  modifiers: { altKey: boolean; metaKey: boolean; shiftKey: boolean },
  at: number,
): TapEvent | null {
  if (modifiers.altKey || modifiers.metaKey || modifiers.shiftKey) {
    return { kind: "foreign-modifier" };
  }
  if (key === "Control") {
    return type === "keydown" ? { kind: "control-down", at } : { kind: "control-up", at };
  }
  // Shift/Alt/Meta on their own are caught by the flag check above; anything
  // else that goes down is an ordinary key and makes this press a chord.
  return type === "keydown" ? { kind: "other-key" } : null;
}

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

/**
 * Subscribes to one Tauri channel without ever rejecting.
 *
 * Outside Tauri — `npm run dev` in a plain browser, which is how these pages are
 * actually looked at — `listen` rejects because there is no IPC. The lessons
 * must still work there on the DOM path alone, so a failed subscription is one
 * console line and nothing else.
 */
function useTauriSubscription(
  subscribe: () => Promise<UnlistenFn>,
  enabled: boolean,
  label: string,
): void {
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void subscribeRef
      .current()
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => {
        console.warn(`onboarding: ${label} unavailable`, error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, label]);
}

/** What the push-to-talk lesson needs to render itself. */
export interface PushToTalkProbe {
  /** Whether Control+Option is down right now — drives the listening pose. */
  readonly held: boolean;
  /**
   * Whether a hold was released too early. Purely advisory: the page uses it to
   * say "hold it a little longer" instead of leaving the user guessing why
   * nothing happened, which is the difference between a lesson and a puzzle.
   */
  readonly tooShort: boolean;
}

/**
 * Watches for a real Control+Option hold of at least [`MIN_HOLD_MS`], from both
 * the native latch and the DOM.
 *
 * `onPass` may fire more than once; see the module header on idempotence.
 *
 * The DOM half reads `ctrlKey && altKey` off every key event rather than
 * tracking the two keys separately, which is exactly the masked
 * `ModifierSample` the Rust latch works from — the browser maintains that state
 * correctly across auto-repeat, and tracking the keys by name would have to
 * handle the left/right pairs and would still miss a modifier that changed while
 * the window was blurred.
 */
export function usePushToTalkProbe(onPass: () => void, active: boolean): PushToTalkProbe {
  const [held, setHeld] = useState(false);
  const [tooShort, setTooShort] = useState(false);
  const pressedAt = useRef<number | null>(null);
  const passRef = useRef(onPass);
  passRef.current = onPass;

  const press = useCallback((at: number) => {
    if (pressedAt.current !== null) return;
    pressedAt.current = at;
    setTooShort(false);
    setHeld(true);
  }, []);

  const release = useCallback((at: number) => {
    const start = pressedAt.current;
    pressedAt.current = null;
    setHeld(false);
    if (start === null) return;
    if (isQualifyingHold(start, at)) passRef.current();
    else setTooShort(true);
  }, []);

  // The native latch. Its `Down` already costs `ARM_DELAY`, so a native pass is
  // a longer hold than a DOM one — deliberately not compensated for, because a
  // shorter-than-real hold is the failure that would matter.
  useTauriSubscription(
    () =>
      listenPolarisEvents((event) => {
        if (event.type !== "hotkey") return;
        if (event.state === "down") press(performance.now());
        else release(performance.now());
      }),
    active,
    "polaris hotkey events",
  );

  useEffect(() => {
    if (!active) return;
    const both = (event: KeyboardEvent) =>
      event.ctrlKey && event.altKey && !event.metaKey && !event.shiftKey;
    const onKeyDown = (event: KeyboardEvent) => {
      if (both(event)) press(performance.now());
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!both(event)) release(performance.now());
    };
    // Without this a hold that ends while the window is blurred (the OS dialog
    // stealing focus, a Space switch) would leave `held` stuck true and the face
    // stuck listening, with no release ever arriving to clear it.
    const onBlur = () => {
      pressedAt.current = null;
      setHeld(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active, press, release]);

  return { held, tooShort };
}

/**
 * Watches for a real double tap of Control, from both `notch_hotkey` and the DOM.
 *
 * The DOM half runs the same five rules as the Rust detector (see
 * [`tapReducer`]), so the lesson cannot be passed by a gesture — a slow pair, a
 * `Ctrl+C`, a Control+Option hold — that the product itself would reject.
 */
export function useDoubleControlProbe(onPass: () => void, active: boolean): void {
  const tap = useRef<TapState>(INITIAL_TAP);
  const passRef = useRef(onPass);
  passRef.current = onPass;

  useTauriSubscription(
    () =>
      listenNotchHotkey(() => {
        // The payload is a *proposal* for the prompt state (`true` opens it,
        // `false` closes it). Either value means the detector fired, which is
        // the only fact this lesson cares about.
        passRef.current();
      }),
    active,
    "notch hotkey events",
  );

  useEffect(() => {
    if (!active) return;
    const feed = (event: TapEvent) => {
      const result = tapReducer(tap.current, event);
      tap.current = result.state;
      if (result.fired) passRef.current();
    };
    const handle = (type: "keydown" | "keyup") => (event: KeyboardEvent) => {
      const parsed = tapEventFor(type, event.key, event, performance.now());
      if (parsed) feed(parsed);
    };
    const onKeyDown = handle("keydown");
    const onKeyUp = handle("keyup");
    const onBlur = () => feed({ kind: "reset" });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [active]);
}

/**
 * Watches for a real hover of the notch — opportunistically, never as a gate.
 *
 * ## Why this one cannot be a gate, with the evidence
 *
 * Hover is observed by a `mouseMoved` monitor pair in
 * `app/src-tauri/src/notch/hover.rs`, shaped exactly like the keyboard pair. The
 * symmetry is where the reasoning usually stops, and it is wrong here, because
 * mouse events and key events are delivered by completely different rules:
 *
 * * The **global** monitor is paused while Polaris is the active application.
 *   That is not inference — `notch.rs::hover_health` reports it as a diagnostic
 *   in plain words ("Polaris is the active app, so macOS pauses the global mouse
 *   monitor; close the open panel to restore hover"), and `lib.rs` resigns
 *   active when the last panel closes *specifically* to bring hover back. The
 *   onboarding window is focusable and will be frontmost, so it puts the app in
 *   exactly that state.
 * * The **local** monitor only sees events delivered to one of our own windows.
 *   The notch overlay is `set_ignore_cursor_events(true)` — hover.rs' own header
 *   opens by saying CSS `:hover` can never fire there — so a cursor over the
 *   notch is not delivered to us at all, and the onboarding card is 900x640 in
 *   the middle of the screen, nowhere near it.
 *
 * Both halves of the pair are therefore blind at once, and `notch_hover` cannot
 * be expected to arrive. A step gated on it would be unpassable, which is the
 * one outcome a first-run window must never ship — so `notch` is not in
 * `GATED_STEPS` and the page teaches by illustration instead.
 *
 * This hook exists anyway because the cost is one subscription and the payoff is
 * real: if the Rust side ever gains a local monitor that covers this case (see
 * the hand-off note in `backlog/onboarding-ui.md`), or if the user hovers the
 * notch in some state we have not predicted, the page notices and says so. It
 * can only ever add a confirmation, never withhold one.
 */
export function useNotchHoverProbe(onHover: () => void, active: boolean): void {
  const passRef = useRef(onHover);
  passRef.current = onHover;

  useTauriSubscription(
    () =>
      listenNotchHover((inside) => {
        if (inside) passRef.current();
      }),
    active,
    "notch hover events",
  );
}
