/**
 * Polaris' face: a `blobatar` in the notch's status strip.
 *
 * Thin by design. Every decision it makes is imported from [`faceState`], which
 * is pure and tested; what is left here is the one thing that cannot be tested
 * without a DOM — mounting the library's component with those values.
 *
 * ## Why the component stays mounted across stages
 *
 * The stage is a *prop change* on one long-lived element, never a remount. That
 * is load-bearing rather than tidy: `blobatar` renders the pose as registered
 * custom properties on an inline SVG, so a pose change is a CSS transition on
 * thirteen numbers (`--mo-morph`, ~300 ms in, ~400 ms out). A transition needs a
 * previous computed value, so a fresh element would have none and the morph
 * would not be slow — it would not exist — and the idle breathe/blink/saccade
 * loops underneath would restart from phase zero on every stage change. The
 * shell around it animates on a 470 ms spring; the face is not allowed to be the
 * one thing that hard-cuts.
 *
 * The caller therefore renders/unmounts this only on the *state* boundary
 * (`shouldRenderFace`), which is a real open/close, and never on the stage
 * boundary.
 *
 * ## Why `animate="always"`
 *
 * The library gates idle motion on `:hover` by default, because ambient motion
 * across a grid of hundreds of avatars is motion worth removing. That argument
 * does not apply to a single creature that *is* the assistant, and the notch is
 * frequently expanded by the push-to-talk hotkey with the pointer nowhere near
 * it — hover-gated, the face would sit frozen for exactly the turn it is meant
 * to be reacting to. `"always"` is the library's own documented escape hatch for
 * the single-blobatar case.
 *
 * `prefers-reduced-motion` is honoured by `blobatar/motion.css` itself: it
 * drops every animation *and* every transition, leaving a still face that still
 * changes pose with the stage. Nothing to do here.
 *
 * ## Accessibility
 *
 * Decorative. The stage it depicts is already spoken by the strip's
 * [`StageLabel`] and by the live region in `App`, so a second announcement would
 * be a duplicate; the wrapper is `aria-hidden` and no `title` is passed (a
 * `title` would put the blobatar back in the accessibility tree).
 */
import "blobatar/motion.css";

import { Blobatar } from "@blobatar/react";

import {
  FACE_HUE,
  FACE_NAME,
  FACE_SIZE,
  FACE_TONE,
  faceExpressionFor,
  faceMoodFor,
} from "./faceState";
import type { VoiceStage } from "./shellState";

export interface BlobatarFaceProps {
  /** The live turn's stage, or `null` when no turn is running. */
  stage: VoiceStage | null;
}

export function BlobatarFace({ stage }: BlobatarFaceProps) {
  const mood = faceMoodFor(stage);
  return (
    /* `data-mood` is for debugging and for the CSS glow only — the pose itself
       travels as the `expression` prop, not as a class. */
    <span className="notch-face" data-mood={mood} aria-hidden="true">
      <Blobatar
        name={FACE_NAME}
        size={FACE_SIZE}
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
