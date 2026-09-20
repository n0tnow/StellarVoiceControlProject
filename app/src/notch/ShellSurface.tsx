/**
 * The notch shell surface (step A5, folded A6 prompt).
 *
 * Pure presentation: it reads a [`ShellGeometry`] and the shell state controller
 * and renders the pill/compact/prompt/panel shape. All geometry arrives from Rust
 * as concrete CSS custom properties; the class name is the only state switch, so
 * adding a state is a Rust table row plus (if it has new body) a CSS block.
 *
 * The `prompt` state's body is the folded A6 [`PromptPanel`]: the typed prompt
 * grows the *notch itself* slightly sideways and downward — no second window, no
 * floating sheet. The prompt owns the whole surface: the status strip is a
 * voice-state affordance and is not rendered while the prompt is applied. A
 * voice turn can still be live underneath it, so [`PromptPanel`] carries the
 * turn's stage as a small inline indicator (see `inlineVoiceStage`). The panel
 * placeholder remains for the menus we design later.
 *
 * Polaris' face ([`BlobatarFace`]) is the shell's own child rather than any
 * body's, because it has two presentations in two different places — small and
 * alone in the strip's right ear during a voice turn, large in the panel's nav
 * header — and moving it between them in the *tree* would remount it and
 * destroy the pose morph. It is mounted on the state boundary only
 * (`shouldRenderFace`), and the stylesheet does the moving.
 *
 * It replaced the three indicator dots outright: the face is the stage signal
 * now, and the strip does not say the same thing twice.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

import type { NavigationRequest, ShellGeometry } from "@polaris/interfaces";

import { StageLabel } from "@/components/StageLabel";
import { notchPageFor } from "@/lib/navigation";
import { playSfx } from "@/lib/sfx";
import { BlobatarFace } from "./BlobatarFace";
import { facePlacementFor, shouldRenderFace } from "./faceState";
import { MoreMenu } from "./MoreMenu";
import { NotchPanel } from "./NotchPanel";
import { PromptPanel } from "./PromptPanel";
import { inlineVoiceStage } from "./shellState";
import { useNotchPage } from "./useNotchPage";
import { SHELL_MOTION_MS, useShellState, usePrefersReducedMotion, type ShellStateName } from "./useShellState";

export interface ShellSurfaceProps {
  geometry: ShellGeometry;
  /** Voice visual state name ("idle" | "recording" | …) for the animation class. */
  visual: string;
  /** The voice source's proposal for the shell state, resolved by the reducer. */
  voiceState: ShellStateName;
  /**
   * Whether the voice proposal is an attention state (recording/transcribing/…)
   * that must outrank hover, or just the ready/error dwell label.
   */
  voiceAttention: boolean;
  label: string;
  detail: string;
  /**
   * A read-only voice navigation request (NAV): `ShellSurface` selects the notch
   * page and pins the panel for the targets that live in the notch. A new object
   * identity is what re-triggers an identical request.
   */
  navigation?: NavigationRequest | null;
}

export function ShellSurface({
  geometry,
  visual,
  voiceState,
  voiceAttention,
  label,
  detail,
  navigation = null,
}: ShellSurfaceProps) {
  // A voice-opened panel is pinned until an explicit dismissal, independent of
  // the turn session, so the screen survives the turn settling. It rides the
  // existing `voice` proposal as `panel` with attention forced on.
  const [panelRequest, setPanelRequest] = useState(false);
  const {
    applied,
    onTransitionEnd,
    contentHeight,
    applyContentHeight,
    dismiss,
  } = useShellState(panelRequest ? "panel" : voiceState, {
    voiceAttention: panelRequest || voiceAttention,
  });

  // Page routing for the `panel` state. Owned here (not in the panel) so the
  // controller survives the panel body's mount/unmount cycles and the voice
  // seam can later be wired one level up without touching the pages. Closing
  // the panel is the shell's `dismiss`, wrapped so it also clears a voice-opened
  // panel (otherwise the pinned request would immediately reopen it). Nav-close,
  // Escape and hover-leave all end in the same collapse path.
  const closePanel = useCallback((): void => {
    setPanelRequest(false);
    dismiss();
  }, [dismiss]);
  const pageController = useNotchPage(closePanel);
  const { setNotchPage } = pageController;

  // A cue on the shell's own open/close, not on every state change: `open`
  // when it commits into an interactive surface (`panel`/`prompt`), and
  // `close` only when an interactive surface collapses back to `collapsed`
  // (`previous` was `panel`/`prompt`). The `collapsed <-> compact` voice-strip
  // transition is deliberately silent *in both directions* — it fires on every
  // push-to-talk press and release while a turn's TTS may already be speaking,
  // and a click cue racing the voice audio would read as a glitch, not a
  // confirmation.
  const previousApplied = useRef(applied);
  useEffect(() => {
    const previous = previousApplied.current;
    previousApplied.current = applied;
    if (previous === applied) return;
    if (applied === "panel" || applied === "prompt") {
      playSfx("open");
    } else if (applied === "collapsed" && (previous === "panel" || previous === "prompt")) {
      playSfx("close");
    }
  }, [applied]);

  // Apply a voice navigation request. Notch targets select their page and pin
  // the panel; panel-window targets are opened by App's `applyNavigation`, so
  // the notch simply gives way; `close` dismisses.
  useEffect(() => {
    if (!navigation) return;
    if (navigation.target === "close") {
      closePanel();
      return;
    }
    const page = notchPageFor(navigation.target);
    if (page) {
      setNotchPage(page);
      setPanelRequest(true);
    } else {
      setPanelRequest(false);
    }
  }, [navigation, closePanel, setNotchPage]);

  // `PromptPanel` measures the body below the top inset; the state's min/max
  // are **whole-shell** heights, so add the inset before reporting. It is the
  // same `safe_top` the prompt body is anchored to, so the shell grows by
  // exactly the measured body. Declared before the early return so the hook
  // order never changes (the first frame has no states in
  // `FALLBACK_SHELL_GEOMETRY`).
  const safeTop = geometry.notch.safeTop;
  const handleContentHeight = useCallback(
    (bodyHeight: number) => {
      // Guard against the deferred-unmount window below: `PromptPanel` stays
      // mounted (and its `ResizeObserver` keeps firing) for one shell-motion
      // length after `applied` has already moved off `prompt`, purely so its
      // closing fade can play. Reporting a height for a state that is no
      // longer active would resize a state Rust no longer considers
      // content-driven.
      if (applied !== "prompt") return;
      applyContentHeight(bodyHeight + safeTop);
    },
    [applied, applyContentHeight, safeTop],
  );

  // Open/close polish (2026-09-20): `PromptPanel` mounts and unmounts with
  // `applied` (see its own doc comment: "starts clean and measured on every
  // open"), but instantly removing it the moment `applied` leaves `prompt`
  // used to cut its `.notch-prompt` closing fade off on the very first frame —
  // the text just vanished while the shell was still collapsing. Keeping it
  // mounted for one shell-motion length after the state moves on gives the CSS
  // fade (`.notch:not(.shell-prompt) .notch-prompt { opacity: 0; }`) time to
  // actually play, matching how `.notch-panel` (always mounted, only
  // crossfaded) already closes. Declared before the early return so hook order
  // never changes.
  const reducedMotion = usePrefersReducedMotion();
  const [showPrompt, setShowPrompt] = useState(applied === "prompt");
  useEffect(() => {
    if (applied === "prompt") {
      setShowPrompt(true);
      return;
    }
    if (reducedMotion) {
      setShowPrompt(false);
      return;
    }
    const timer = setTimeout(() => setShowPrompt(false), SHELL_MOTION_MS);
    return () => clearTimeout(timer);
  }, [applied, reducedMotion]);

  const active = geometry.states.find((state) => state.name === applied) ?? geometry.states[0];
  if (!active) return null;
  const expanded = applied !== "collapsed";
  // The prompt owns the whole surface: the status strip (and its purple
  // indicator wash) is a voice-state affordance and is removed from the tree
  // entirely while the prompt is applied.
  const showStrip = applied !== "prompt";
  // A voice turn can run while the prompt is latched (the reducer keeps the
  // prompt on top). Because the strip is not rendered in `prompt`, the turn's
  // stage travels into the prompt as this inline stage instead.
  const voiceStage = inlineVoiceStage(visual);
  // Polaris' face. Gated on the applied *state* only: the collapsed shell is
  // the camera cutout and must stay faceless, and the prompt owns its surface.
  // The placement (size + gaze excursion) is also per state — small and alone
  // in the strip's ear during a turn, large in the panel's nav header.
  const showFace = shouldRenderFace(applied);
  const facePlacement = facePlacementFor(applied);

  // A content-driven state (the prompt) uses its measured, Rust-clamped height;
  // every other state uses the table value.
  const shellHeight = contentHeight ?? active.height;

  const style = {
    "--shell-width": `${active.width}px`,
    "--shell-height": `${shellHeight}px`,
    "--shell-top-radius": `${active.topRadius}px`,
    "--shell-bottom-radius": `${active.bottomRadius}px`,
    "--shell-ear": `${active.earRadius}px`,
    "--cutout-width": `${geometry.notch.cutoutWidth}px`,
    "--cutout-height": `${geometry.notch.cutoutHeight}px`,
    // `safe_top` is the menu-bar/notch inset. On a notched display it equals the
    // cutout height, but the prompt anchors to it explicitly so no prompt pixel
    // can ever be drawn behind the camera housing.
    "--safe-top": `${geometry.notch.safeTop}px`,
    // The face's drawn size, from the tested placement table. It lives on the
    // shell rather than on the face so that the panel's nav-header padding can
    // be `calc(var(--face-size) + …)` instead of a second copy of the number
    // that silently stops matching the day the face is resized.
    "--face-size": `${facePlacement.size}px`,
  } as CSSProperties;

  return (
    <section
      className={`notch shell-${applied} state-${visual}${
        active.interactive ? " is-interactive" : ""
      }${active.focusable ? " is-focusable" : ""}`}
      style={style}
      onTransitionEnd={onTransitionEnd}
      aria-label={
        expanded
          ? `${label}. ${detail}`
          : "Polaris ready. Hold Control and Option to record, or hold Control, Option and Space."
      }
    >
      {/* Polaris' face. A direct child of the shell, and rendered in exactly one
          place in the tree no matter which presentation is on screen: the
          stylesheet moves it from the strip's right ear to the panel's nav
          header and resizes it on the shell's own curve. Rendering it inside the
          strip in one state and inside the panel in the other would remount it,
          which kills the pose morph, restarts the idle loops and snaps the gaze
          back to centre — see `BlobatarFace`. It is absent only where there is
          nothing to draw on (`shouldRenderFace`). */}
      {showFace ? <BlobatarFace stage={voiceStage} placement={facePlacement} /> : null}

      {/* Voice states only. The `prompt` state removes the strip from the tree
          rather than hiding it, so its label and indicator cannot occupy space
          or paint the purple wash behind the prompt body. */}
      {showStrip ? (
        <div className="notch-content" aria-hidden={!expanded}>
          <div className="notch-copy">
            {/* Label only. `detail` and the error text are not drawn — the ear is
                too narrow for them and the housing to its right cannot be used —
                but they still reach assistive tech via the live region in App. */}
            <StageLabel label={label} />
          </div>
          {/* The camera housing: no pixels exist here, so it stays empty. */}
          <span className="notch-gap" aria-hidden="true" />
          {/* The right ear is the face's, and only the face's. The three
              indicator dots that used to animate here are gone: one surface
              cannot have two things saying the same thing, and the face says it
              with a shape rather than with three dots. The face itself is not
              rendered here — it is a direct child of the shell (below), because
              it also has to be able to sit in the panel's nav header without
              being torn out of the tree on the way. The grid keeps the column either
              way — `grid-template-columns` sizes it, not its contents. */}
        </div>
      ) : null}

      {/* The folded A6 typed prompt: mounted while its state is applied *and*
          for one shell-motion length after (`showPrompt`), so it starts clean
          and measured on every open but gets to play its closing fade instead
          of vanishing the instant `applied` moves on (see the comment on
          `showPrompt` above). */}
      {showPrompt ? (
        <PromptPanel
          voiceStage={voiceStage}
          onContentHeight={handleContentHeight}
          onDismiss={dismiss}
        />
      ) : null}

      {/* The `panel` state body: the multi-page surface (History / Tasks /
          Rules / Wallet). Always mounted and crossfaded by the shell-panel
          class, so page state survives a close/reopen within the session. */}
      <div className="notch-panel" aria-hidden={applied !== "panel"}>
        <NotchPanel controller={pageController} />
        {/* RMTRAY: the "⋯" menu replaces the removed menu-bar tray (panels +
            Quit). Mounted only while the panel is applied so no focusable
            control hides inside the collapsed, click-through shell. */}
        {applied === "panel" ? <MoreMenu /> : null}
      </div>
    </section>
  );
}
