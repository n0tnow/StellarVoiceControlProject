/**
 * One reducer for the notch shell's named states (step A5).
 *
 * Before this, `App.tsx` derived a single `expanded` boolean from the capture
 * status and a handful of `setTimeout`s. Adding hover expansion on top of that
 * would have meant more timers racing the voice dwell timers. Instead every
 * source **proposes** a state name and one documented precedence rule resolves
 * them, so the voice dwell and the hover dwell can never fight.
 *
 * The pure rule lives in `shellState.ts`; this hook wires it to the hover event
 * stream and to the native resize lifecycle.
 *
 * ## Why the request/commit pipeline looks the way it does
 *
 * The native window is **grown** immediately when a state is requested (so the
 * CSS expansion is never clipped) and **shrunk** to the exact committed state
 * afterwards. Two things must hold no matter how the async IPC interleaves:
 *
 * - a superseded request must not set a stale `applied` state (guarded by a
 *   generation counter, not by cancelling the outcome), and
 * - the commit that shrinks the window must be **guaranteed**, not best-effort.
 *   `transitionend` is the fast path; a timer that reruns after every settled
 *   request is the guarantee. It also covers `prefers-reduced-motion`, where no
 *   transition event ever fires.
 */
import { useCallback, useEffect, useRef, useState, type TransitionEvent } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  commitShellState,
  listenNotchHover,
  listenNotchHotkey,
  requestShellState,
  resizeShellContent,
} from "./shellBridge";
import {
  HOVER_ENTER_DWELL_MS,
  HOVER_LEAVE_GRACE_MS,
  SHELL_MOTION_MS,
  applyHoverEdge,
  isCommitTransition,
  isUsableShellHeight,
  resolveShellState,
  type ShellStateName,
} from "./shellState";

export type { ShellStateName } from "./shellState";
export { HOVER_ENTER_DWELL_MS, HOVER_LEAVE_GRACE_MS, SHELL_MOTION_MS, resolveShellState } from "./shellState";

export interface ShellStateController {
  /** The state the UI has applied; drives the CSS class and custom properties. */
  applied: ShellStateName;
  /** The state the sources currently resolve to. */
  target: ShellStateName;
  /** Spread onto the shell element so a finished tween commits the window. */
  onTransitionEnd: (event: TransitionEvent<HTMLElement>) => void;
  /**
   * The measured, Rust-clamped height of the active content-driven state's
   * shell, or `null` when the active state is fixed. The shell body reads it as
   * `--shell-height`.
   */
  contentHeight: number | null;
  /**
   * Reports the desired **whole-shell** height for a content-driven state (the
   * measured body plus the top inset). Rust clamps it, grows the window before
   * the tween, and this hook schedules the guaranteed commit.
   */
  applyContentHeight: (shellHeight: number) => void;
  /** Clears the sticky hotkey mode (prompt). Escape / outside-click use this. */
  dismiss: () => void;
}

/**
 * `prefers-reduced-motion` is honoured by skipping the tween wait entirely.
 * Exported so `ShellSurface` can use the same signal to skip its own
 * deferred-unmount wait for the prompt body's closing fade.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface UseShellStateOptions {
  /** Is the voice source an attention state that must outrank hover? */
  voiceAttention?: boolean;
}

export function useShellState(
  voice: ShellStateName,
  options: UseShellStateOptions = {},
): ShellStateController {
  const { voiceAttention = true } = options;
  const [hoverActive, setHoverActive] = useState(false);
  // The hotkey source is a latch, not a pulse: the double-Control tap event
  // sets it, and Escape / click-away / a second tap / the Rust watchdog's
  // forced collapse clears it. See `shellState.ts` for why it outranks hover.
  const [hotkeyState, setHotkeyState] = useState<ShellStateName>("collapsed");
  // Read inside the event listeners without re-subscribing on every change.
  const hoverActiveRef = useRef(hoverActive);
  const hotkeyRef = useRef(hotkeyState);
  hotkeyRef.current = hotkeyState;
  const enterTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Set by an explicit dismissal and cleared only when the cursor actually
  // leaves the shell. While set, `inside` edges are swallowed so a dismissal
  // made while hovering cannot immediately re-open the interactive panel.
  const hoverLatch = useRef(false);
  const reducedMotion = usePrefersReducedMotion();

  /**
   * Drops the ambient hover source in one step. Every explicit mode transition
   * calls this so a hover armed before (or during) the prompt can never be the
   * hover that resolves the state the instant the mode closes — the failure
   * the reducer's precedence alone cannot prevent (MAJOR-2). `armLatch` sets
   * the leave-and-return latch on the way out.
   */
  const releaseHover = useCallback((armLatch: boolean): void => {
    clearTimeout(enterTimer.current);
    clearTimeout(leaveTimer.current);
    hoverActiveRef.current = false;
    setHoverActive(false);
    if (armLatch) hoverLatch.current = true;
  }, []);

  /** Clears the sticky hotkey mode. Escape / outside-click / the trigger call this. */
  const dismiss = useCallback((): void => {
    releaseHover(true);
    setHotkeyState("collapsed");
  }, [releaseHover]);

  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const update = (active: boolean): void => {
      hoverActiveRef.current = active;
      setHoverActive(active);
    };

    void listenNotchHover((inside) => {
      if (disposed) return;
      // While an explicit mode (the prompt) is latched, hover is suppressed
      // entirely: hovering inside the prompt must not arm a panel expansion for
      // the moment the mode closes. A leave edge still clears the latch so a
      // later hover works after the mode has gone.
      if (hotkeyRef.current !== "collapsed") {
        if (!inside) hoverLatch.current = false;
        return;
      }
      // The latch may swallow an `inside` edge (and is cleared by a leave edge).
      const edge = applyHoverEdge(inside, hoverLatch.current);
      hoverLatch.current = edge.latched;
      if (!edge.accept) return;
      if (inside) {
        clearTimeout(leaveTimer.current);
        if (!hoverActiveRef.current) {
          clearTimeout(enterTimer.current);
          enterTimer.current = setTimeout(() => update(true), HOVER_ENTER_DWELL_MS);
        }
      } else {
        clearTimeout(enterTimer.current);
        if (hoverActiveRef.current) {
          clearTimeout(leaveTimer.current);
          leaveTimer.current = setTimeout(() => update(false), HOVER_LEAVE_GRACE_MS);
        }
      }
    })
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((error: unknown) => {
        console.warn("notch hover unavailable", error);
      });

    return () => {
      disposed = true;
      unlisten?.();
      clearTimeout(enterTimer.current);
      clearTimeout(leaveTimer.current);
    };
  }, []);

  // The hotkey source: Rust emits the tap result as a proposal. A `prompt`
  // proposal latches until an explicit dismissal clears it.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listenNotchHotkey((prompt) => {
      if (disposed) return;
      // Entering the mode: drop ambient hover so the prompt owns the surface.
      // Leaving it (a second tap, or the Rust watchdog's forced collapse):
      // latch hover so a still-inside cursor cannot morph the shell into the
      // panel. The watchdog emits `hover(false)` then `hotkey(false)`, so the
      // mode can be gone before the hover source has caught up.
      releaseHover(!prompt);
      setHotkeyState(prompt ? "prompt" : "collapsed");
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => {
        console.warn("notch hotkey unavailable", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [releaseHover]);

  // Outside-click: a click in another app makes our window resign key, which
  // the webview sees as `blur`. That is the documented dismissal path, so it
  // clears the prompt latch through the same `dismiss` the keyboard path uses
  // (and arms the hover latch, so a still-inside cursor cannot re-open the
  // panel). The Rust watchdog emits its own clear proposal for a stranded
  // prompt that never sees the blur (a frozen webview).
  useEffect(() => {
    const onBlur = (): void => {
      if (hotkeyRef.current !== "collapsed") dismiss();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [dismiss]);

  const target = resolveShellState(
    { voice, hover: hoverActive ? "panel" : "collapsed", hotkey: hotkeyState },
    { voiceAttention },
  );
  const [applied, setApplied] = useState<ShellStateName>(target);
  // Measured, Rust-clamped shell height for the active content-driven state.
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  // Bumped after every completed request so the commit guarantee runs even when
  // `target` returned to the state that is already applied (otherwise the
  // all-equal dependency check would skip the commit and strand the oversized
  // native window).
  const [settle, setSettle] = useState(0);
  const appliedRef = useRef(applied);
  appliedRef.current = applied;
  // Monotonic id: only the latest request may set `applied`.
  const generation = useRef(0);

  const commit = useCallback((name: ShellStateName): void => {
    void commitShellState(name).catch((error: unknown) => {
      console.warn(`shell_commit_state(${name}) failed`, error);
    });
  }, []);

  // Content-driven height. Rust clamps the reported body, grows the window
  // before the tween, and returns the clamped shell height. Bumping `settle`
  // re-runs the guaranteed commit, so the window shrinks back to the exact frame
  // after the height tween and a content resize can never strand it oversized.
  const applyContentHeight = useCallback((shellHeight: number): void => {
    const rounded = Math.round(shellHeight);
    // `Math.round` keeps NaN/Infinity, which JSON-serialise as null and are
    // rejected by the `f64` command; reject them here (MINOR-2).
    if (!isUsableShellHeight(rounded)) return;
    void resizeShellContent(rounded)
      .then((clamped) => {
        setContentHeight(clamped);
        setSettle((count) => count + 1);
      })
      .catch((error: unknown) => {
        console.warn("shell_resize_content failed", error);
      });
  }, []);

  // The measured height belongs to whichever content-driven state is applied;
  // drop it when the shell leaves that state so the next open starts at the
  // state's nominal height.
  useEffect(() => {
    if (applied !== "prompt") setContentHeight(null);
  }, [applied]);

  // Grow the native window first, then apply the CSS state, so the animation
  // runs inside an already-large-enough window and is never clipped. A stale
  // response is dropped by generation, but the request itself was still sent —
  // the returned-to state sends its own request, so native always converges.
  useEffect(() => {
    const id = ++generation.current;
    let active = true;
    void requestShellState(target)
      .catch((error: unknown) => {
        // The watchdog in Rust restores click-through on its own; still apply
        // the CSS state so the UI matches the user's intent.
        console.warn(`shell_request_state(${target}) failed`, error);
      })
      .finally(() => {
        if (!active || id !== generation.current) return;
        setApplied(target);
        setSettle((count) => count + 1);
      });
    return () => {
      active = false;
    };
  }, [target]);

  // The guaranteed commit path. It runs when `applied` changes (after which
  // `transitionend` normally commits first) and after every settled request
  // (`settle`), and it commits whatever React currently shows. This covers
  // reduced motion (no transition event at all) and a cancelled/replaced
  // transition, neither of which may leave the OS window oversized.
  useEffect(() => {
    const delay = reducedMotion ? 0 : SHELL_MOTION_MS + 60;
    const timer = setTimeout(() => commit(appliedRef.current), delay);
    return () => clearTimeout(timer);
  }, [applied, settle, reducedMotion, commit]);

  const onTransitionEnd = useCallback(
    (event: TransitionEvent<HTMLElement>): void => {
      // Ignore bubbling transitions from the panel body / content fade.
      if (event.target !== event.currentTarget) return;
      // `.notch` transitions width, height and border-radius together, so three
      // events fire per transition; commit once, on the geometry-carrying
      // event. The content-driven prompt keeps its width and only tweens
      // height, so height must commit it too (review MINOR-1).
      if (!isCommitTransition(event.propertyName, appliedRef.current === "prompt")) return;
      commit(appliedRef.current);
    },
    [commit],
  );

  return {
    applied,
    target,
    onTransitionEnd,
    contentHeight,
    applyContentHeight,
    dismiss,
  };
}
