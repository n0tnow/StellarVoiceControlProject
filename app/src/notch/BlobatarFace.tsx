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
 * turn, and large in the panel's header band while the panel is open. Those are
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
 * `lookAt: "pointer"` is declarative and re-applied whenever it changes, unlike
 * the driver's construction-time `target`. The driver itself is built once per
 * mounted element (the hook keys it to the callback ref, not to the options), so
 * changing `travel` between presentations re-aims nothing.
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
import type { VoiceStage } from "./shellState";

export interface BlobatarFaceProps {
  /** The live turn's stage, or `null` when no turn is running. */
  stage: VoiceStage | null;
  /** Size and gaze excursion for the applied shell state. */
  placement: FacePlacement;
}

export function BlobatarFace({ stage, placement }: BlobatarFaceProps) {
  const mood = faceMoodFor(stage);
  const { ref } = useGaze({ travel: placement.travel, lookAt: "pointer" });
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
