/**
 * Polaris' face: a `blobatar` that lives directly on the shell.
 *
 * Thin by design. Every decision it makes is imported from [`faceState`], which
 * is pure and tested; what is left here is the part that cannot be tested
 * without a DOM — mounting the library's component and attaching the gaze
 * driver.
 *
 * ## One element, two presentations
 *
 * The face is small and alone in the status strip's right ear during a voice
 * turn, and large in the panel's nav header while the panel is open. Those are
 * two very different places on screen, and the obvious implementation — render
 * it inside the strip in one state and inside the panel in the other — is the
 * one thing that must not be done.
 *
 * `blobatar` renders the pose as registered custom properties on an inline SVG,
 * so a pose change is a CSS transition on thirteen numbers. A transition needs a
 * *previous computed value*, so a freshly created element has none: the morph
 * would not be slow or wrong, it would not exist. The same frame would also
 * restart all seven idle loops from phase zero and snap the gaze driver's eyes
 * back to centre, because the driver holds their current position and is rebuilt
 * with the element.
 *
 * So this component is rendered **once**, as a direct child of `.notch`, and it
 * is moved and resized between the two presentations by the stylesheet
 * (`--face-size` plus the `.shell-*` state classes), which transitions on the
 * shell's own curve. The element survives; therefore the morph, the idle phase
 * and the gaze position all survive with it.
 *
 * That is not a theoretical win. Hovering the notch and then starting a turn
 * moves `panel → compact` on the same commit as `null → listening`: with a
 * per-state element that turn's first morph — the one the user is most likely to
 * be looking at — would be the one that did not happen.
 *
 * `placement.size` is not passed to the library either. The library emits it as `width`/
 * `height` attributes, which cannot transition and would make the element's
 * markup vary with the state; letting CSS size the SVG (the viewBox always
 * scales) keeps every attribute on the element constant across states, so the
 * only thing React ever changes here is the pose `style` — the diff-in-place
 * path the library's own docs describe.
 *
 * ## Why `animate="always"`
 *
 * The library gates idle motion on `:hover`, because ambient motion across a
 * grid of hundreds of avatars is motion worth removing. That argument does not
 * apply to a single creature that *is* the assistant, and the notch is
 * frequently expanded by the push-to-talk hotkey with the pointer nowhere near
 * it — hover-gated, the face would sit frozen for exactly the turn it is meant
 * to be reacting to. `"always"` is the library's own documented escape hatch.
 *
 * ## Gaze
 *
 * `useGaze` needs three things and gives no error when it has only two: the
 * stylesheet, a driver, and a non-zero `--mo-track-travel`. The property is
 * registered with an initial value of `0px`, so the layer's likeliest failure is
 * a face that renders perfectly and never moves. `travel` is therefore passed as
 * a hook option — which writes the property inline on the SVG — and is
 * **deliberately not** set anywhere in `index.css`: a rule matching `.mo-eyes`
 * directly beats an inherited inline value, and the symptom of getting that
 * wrong is indistinguishable from not having wired gaze at all.
 *
 * ### The target is the native cursor, not `"pointer"`
 *
 * `lookAt: "pointer"` is wrong here. It arms the driver with a `pointermove`
 * listener on the document, and this overlay window does not receive pointer
 * events until something makes it interactive: it is click-through by default —
 * which is exactly *why* hover expansion is driven by the native monitor in
 * `src-tauri/src/notch/hover.rs` and not by CSS `:hover`. So the driver ran and
 * maintained its custom properties correctly, and yet the eyes only began to
 * track after the panel had been clicked. The fix removes the dependency
 * entirely: Rust already runs one global `mouseMoved` monitor (the only cursor
 * monitor there is), and `hover.rs` now emits each sample on `notch_cursor` in
 * the webview's client coordinates. This component subscribes and re-aims the
 * driver with `lookAt(point)`.
 *
 * It calls the hook's returned `lookAt` **function**, not the `lookAt={{x, y}}`
 * option, and not for style. The option is applied from a React effect, so a
 * point that changes on every mouse move would be a render per move; the
 * library provides the stable function as its documented seam for exactly a
 * target that changes on every input. Either way the driver, which holds the
 * eyes' current position, is never rebuilt — that is the invariant that matters,
 * and rebuilding it would snap the eyes to centre. The point is compared by
 * coordinates inside the driver, so a sample that has not moved re-aims nothing.
 *
 * A subscription rather than a declared target also means the driver is aimed
 * only by real cursor events: when the monitor is quiet (the app is active and
 * the global monitor is paused), the eyes hold their last position rather than
 * springing back to centre.
 *
 * ## Reduced motion
 *
 * `blobatar/motion.css` honours `prefers-reduced-motion` itself: it drops every
 * animation *and* transition, leaving a still face that still changes pose with
 * the stage. That is the correct behaviour and it is left alone — the face is a
 * product surface, but a user who has asked the OS for less motion has asked for
 * exactly this, and the stage is never carried by motion alone (the pose is a
 * static shape and the strip's label spells it out in words).
 *
 * ## Accessibility
 *
 * Decorative. The stage it depicts is already spoken by the strip's
 * [`StageLabel`] and by the live region in `App`, so a second announcement would
 * be a duplicate; the wrapper is `aria-hidden` and no `title` is passed (a
 * `title` would put the blobatar back in the accessibility tree).
 */
import "blobatar/motion.css";
import "blobatar/gaze.css";

import { useEffect } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Blobatar } from "@blobatar/react";
import { useGaze } from "@blobatar/react/gaze";

import {
  FACE_HUE,
  FACE_NAME,
  FACE_TONE,
  faceExpressionFor,
  faceMoodFor,
  type FacePlacement,
} from "./faceState";
import { listenNotchCursor } from "./shellBridge";
import type { VoiceStage } from "./shellState";

export interface BlobatarFaceProps {
  /** The live turn's stage, or `null` when no turn is running. */
  stage: VoiceStage | null;
  /** Size and gaze excursion for the applied shell state. */
  placement: FacePlacement;
}

export function BlobatarFace({ stage, placement }: BlobatarFaceProps) {
  const mood = faceMoodFor(stage);
  const { ref, lookAt } = useGaze({ travel: placement.travel });

  // The native cursor stream (see "Gaze" above). `lookAt` is stable for the
  // life of the component, so this subscribes exactly once; the hook queues the
  // point until the driver exists, so a sample that arrives before the SVG
  // mounts is remembered rather than dropped.
  useEffect(() => {
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listenNotchCursor((point) => {
      if (!disposed) lookAt(point);
    })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((error: unknown) => {
        console.warn("notch cursor unavailable", error);
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [lookAt]);

  return (
    /* The box is sized by the stylesheet from `--face-size`, which the shell
       sets from this same placement — geometry is the shell's to publish, as it
       already does for every other dimension. `data-mood` is for debugging
       only: the pose travels as the `expression` prop, never as a class. */
    <span className="notch-face" data-mood={mood} aria-hidden="true">
      <Blobatar
        ref={ref}
        name={FACE_NAME}
        hue={FACE_HUE}
        tone={FACE_TONE}
        /* The shell is solid black and already has a shape; a backdrop plate
           behind the creature would read as a second, misaligned pill. */
        background={false}
        animate="always"
        expression={faceExpressionFor(mood)}
      />
    </span>
  );
}
