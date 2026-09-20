/**
 * The first-run window.
 *
 * One card, one page at a time, sliding to the next. This component owns three
 * things and nothing else: the flow state (delegated wholesale to the pure
 * machine in `steps.ts`), the page-turn animation, and the window-level
 * keyboard. Every page below it renders and calls back; none of them knows what
 * comes next.
 *
 * ## The card is the window
 *
 * The native window is 900x640, centred, `decorations: false`,
 * `transparent: true`. So there is no title bar, no traffic lights and no
 * system radius — all of it is drawn here: a black surface, a 22px radius, one
 * hairline inside it, and a quiet close affordance top-right. The top strip
 * carries `data-tauri-drag-region`, which is the only thing that makes an
 * undecorated window movable.
 *
 * ## The turn
 *
 * During a page change both pages are mounted and absolutely stacked in the same
 * rectangle: the outgoing one animates out, the incoming one animates in, and a
 * timer of exactly the motion duration unmounts the outgoing one. That is more
 * bookkeeping than a cross-fade of a single element, and it buys the one thing a
 * cross-fade cannot — a *direction*. Forward slides left, back slides right, on
 * the notch shell's own 470ms and `cubic-bezier(0.32, 0.72, 0, 1)`, so the two
 * surfaces read as one product.
 *
 * The timer is the honest mechanism here rather than `animationend`. Under
 * `prefers-reduced-motion` the animation is swapped for a fade of the same
 * duration, but an element that is display-suppressed or never composited may
 * not fire the event at all, and a missed `animationend` would strand a dead
 * page on top of the live one forever. A timeout cannot miss.
 *
 * ## Focus
 *
 * Every page's primary button is the first thing in its tab order, and the page
 * container takes focus on arrival so a screen reader starts reading the new
 * page rather than staying wherever the old page's button used to be. The
 * window-level Enter/Space handler is deliberately narrow — it does nothing when
 * the focus is already on a button, because the browser will fire that button's
 * own click and doing both would advance two pages at once.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { closeOnboarding, completeOnboarding, type PermissionSnapshot } from "./bridge.ts";
import { CloseIcon } from "./icons.tsx";
import { allGranted } from "./usePermissions.ts";
import { cue, unlockOnFirstGesture } from "./sfx.ts";
import {
  INITIAL_FLOW,
  STEP_ORDER,
  advance,
  canAdvance,
  completedCleanly,
  isPassed,
  isSkipped,
  passStep,
  retreat,
  skipStep,
  slideDirection,
  stepIndex,
  type FlowState,
  type StepId,
} from "./steps.ts";
import { NotchPage } from "./pages/NotchPage.tsx";
import { PermissionsPage } from "./pages/PermissionsPage.tsx";
import { PushToTalkPage } from "./pages/PushToTalkPage.tsx";
import { ReadyPage } from "./pages/ReadyPage.tsx";
import { TypePromptPage } from "./pages/TypePromptPage.tsx";
import { WelcomePage } from "./pages/WelcomePage.tsx";

/**
 * The page turn's duration, in milliseconds.
 *
 * It matches `--ob-motion` in the stylesheet, which matches `--shell-motion` on
 * the notch. Restated rather than read back from CSS because reading a custom
 * property from JavaScript means a layout flush per turn, and because the number
 * only has to agree with a value in the very section of `index.css` this
 * component's markup was written against.
 */
const MOTION_MS = 470;

/** A page on the stage: which one, and which way it is moving. */
interface StagedPage {
  readonly step: StepId;
  readonly direction: "forward" | "back";
}

/** The sentence a screen reader hears when a gate is satisfied. */
const PASSED_ANNOUNCEMENTS: Partial<Record<StepId, string>> = {
  permissions: "Both permissions are granted. You can continue.",
  "push-to-talk": "Push to talk works. You can continue.",
  "type-prompt": "The typed prompt works. You can continue.",
};

export function OnboardingRoot() {
  const [flow, setFlow] = useState<FlowState>(INITIAL_FLOW);
  const [leaving, setLeaving] = useState<StagedPage | null>(null);
  const [direction, setDirection] = useState<"forward" | "back">("forward");
  const [announcement, setAnnouncement] = useState("");
  const stageRef = useRef<HTMLDivElement | null>(null);
  const turnTimer = useRef<number | null>(null);

  /**
   * Applies a transition and starts the turn.
   *
   * Everything that changes the page goes through here — Continue, Skip, Back,
   * the keyboard — so the animation bookkeeping exists in exactly one place and
   * a transition that turns out to be a no-op (a blocked gate, the last page)
   * silently animates nothing rather than playing a sound and a slide for a page
   * that did not change.
   */
  const go = useCallback((transition: (state: FlowState) => FlowState) => {
    setFlow((current) => {
      const next = transition(current);
      if (next.step === current.step) return next;

      const way = slideDirection(current.step, next.step);
      setDirection(way);
      setLeaving({ step: current.step, direction: way });
      cue(way === "back" ? "back" : "forward");

      if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
      turnTimer.current = window.setTimeout(() => {
        turnTimer.current = null;
        setLeaving(null);
      }, MOTION_MS);

      return next;
    });
  }, []);

  useEffect(
    () => () => {
      if (turnTimer.current !== null) window.clearTimeout(turnTimer.current);
    },
    [],
  );

  const onAdvance = useCallback(() => {
    unlockOnFirstGesture();
    cue("press");
    go(advance);
  }, [go]);

  const onSkip = useCallback(() => go((state) => skipStep(state, state.step)), [go]);

  /**
   * Goes back a page.
   *
   * Never blocked, including out of a gate the user has not satisfied: going
   * back is how somebody re-reads a page they skimmed, and a gate that also
   * refused to be *re-entered* would be a trap facing the other way. A gate
   * already passed stays passed (`steps.ts` never clears it), so returning to
   * one shows it satisfied rather than demanding the gesture again.
   */
  const onBack = useCallback(() => go(retreat), [go]);

  /**
   * Records a gate as satisfied.
   *
   * Does not advance — the user gets a beat to see that their gesture worked,
   * which is the entire payload of a "now you try it" step. The sound and the
   * announcement are fired from the state updater's *decision*, not from an
   * effect on `passed`, so a repeat pass (both probe sources reporting the same
   * hold) stays silent.
   */
  const onPass = useCallback((step: StepId) => {
    setFlow((current) => {
      const next = passStep(current, step);
      if (next === current) return current;
      cue("success");
      const sentence = PASSED_ANNOUNCEMENTS[step];
      if (sentence) setAnnouncement(sentence);
      return next;
    });
  }, []);

  const onGranted = useCallback(
    (key: "microphone" | "accessibility", snapshot: PermissionSnapshot) => {
      // The `check` cue marks one permission turning green. When the grant
      // completes the set, the gate's own `success` cue fires in the same
      // instant (see `PermissionsPage`), and two cues in one moment read as a
      // stutter — so the per-permission cue yields and lets the gate speak.
      if (!allGranted(snapshot)) {
        cue("check");
        setAnnouncement(`${key === "microphone" ? "Microphone" : "Accessibility"} granted.`);
      }
    },
    [],
  );

  // `press`, not `complete`: the `complete` cue belongs to *arriving* on the
  // last page, and firing it again on the way out would play the window's most
  // emphatic sound twice for one ending.
  const onComplete = useCallback(() => {
    cue("press");
    void completeOnboarding();
  }, []);

  const onClose = useCallback(() => {
    // Never `completeOnboarding`: a user who closed the window has not finished,
    // and recording that they had would cost them the one chance to be taught.
    void closeOnboarding();
  }, []);

  // Arriving on the final page is itself worth a sound, and it is the one cue
  // that belongs to a page rather than to an action.
  useEffect(() => {
    if (flow.step === "ready") cue("complete");
  }, [flow.step]);

  /** Moves focus to the new page so assistive tech reads it from the top. */
  useEffect(() => {
    stageRef.current?.focus({ preventScroll: true });
  }, [flow.step]);

  /**
   * Window-level keyboard.
   *
   * Escape closes; Enter and Space advance. The `target` check is what keeps
   * Enter from advancing twice: a focused button already turns Enter and Space
   * into a click, and the pages' own buttons are the normal way through.
   *
   * It is deliberately *not* wired while the push-to-talk lesson is live in any
   * special way — Control and Option are modifiers and never produce Enter or
   * Space, so the two listeners cannot collide.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("button")) return;
      if (!canAdvance(flow)) return;
      event.preventDefault();
      if (flow.step === "ready") onComplete();
      else onAdvance();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flow, onAdvance, onClose, onComplete]);

  /** Renders one page. Split out so the stage can render two at once. */
  const renderPage = useCallback(
    (step: StepId, active: boolean) => {
      switch (step) {
        case "welcome":
          return <WelcomePage onAdvance={onAdvance} />;
        case "permissions":
          return (
            <PermissionsPage
              active={active}
              passed={isPassed(flow, "permissions")}
              onPass={() => onPass("permissions")}
              skipped={isSkipped(flow, "permissions")}
              onAdvance={onAdvance}
              onSkip={onSkip}
              onGranted={onGranted}
            />
          );
        case "push-to-talk":
          return (
            <PushToTalkPage
              active={active}
              passed={isPassed(flow, "push-to-talk")}
              onPass={() => onPass("push-to-talk")}
              onAdvance={onAdvance}
              onSkip={onSkip}
            />
          );
        case "type-prompt":
          return (
            <TypePromptPage
              active={active}
              passed={isPassed(flow, "type-prompt")}
              onPass={() => onPass("type-prompt")}
              onAdvance={onAdvance}
              onSkip={onSkip}
            />
          );
        case "notch":
          return <NotchPage active={active} onAdvance={onAdvance} />;
        case "ready":
          return <ReadyPage clean={completedCleanly(flow)} onComplete={onComplete} />;
      }
    },
    [flow, onAdvance, onComplete, onGranted, onPass, onSkip],
  );

  const currentIndex = useMemo(() => stepIndex(flow.step), [flow.step]);

  return (
    <div className="ob-root">
      <div className="ob-card">
        {/* The only draggable surface. An undecorated window has no title bar to
            grab, and making the whole card draggable would swallow the clicks
            the pages depend on. */}
        <div className="ob-chrome" data-tauri-drag-region>
          {/* Absent rather than disabled on the first page: there is nothing
              behind it, and a permanently dead control in the chrome is a worse
              first impression than an empty corner. */}
          {currentIndex > 0 ? (
            <button type="button" className="ob-back" onClick={onBack}>
              Back
            </button>
          ) : null}
          <span className="ob-chrome-spacer" data-tauri-drag-region />
          <button
            type="button"
            className="ob-close"
            aria-label="Close setup"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="ob-stage">
          {leaving ? (
            /* `aria-hidden` as well as `pointer-events: none`: the outgoing page
               is visible for 470ms and would otherwise be a second, stale copy
               of the window's content in the accessibility tree. */
            <div
              key={`${leaving.step}-leaving`}
              className={`ob-page is-leaving is-leaving-${leaving.direction}`}
              aria-hidden
            >
              {renderPage(leaving.step, false)}
            </div>
          ) : null}

          <div
            key={flow.step}
            ref={stageRef}
            className={`ob-page is-entering-${direction}`}
            /* Focusable but not tabbable: the effect above moves focus here on
               arrival, and Tab then continues into the page's own controls. */
            tabIndex={-1}
          >
            {renderPage(flow.step, true)}
          </div>
        </div>

        {/* Position, never a percentage. */}
        <div className="ob-steps" aria-hidden>
          {STEP_ORDER.map((step, index) => (
            <span
              key={step}
              className={`ob-step-dot${
                index === currentIndex ? " is-current" : index < currentIndex ? " is-done" : ""
              }`}
            />
          ))}
        </div>

        {/* One live region for the whole window, so a permission turning green
            and a gesture passing are announced the same way and never twice. */}
        <p className="sr-only ob-announce" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
    </div>
  );
}
