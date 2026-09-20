/**
 * Page 6 — done.
 *
 * The creature, one line, one button. The button is the only thing in the whole
 * window that calls `onboarding_complete`, which is what makes closing the
 * window at any earlier point genuinely free: first run is marked done when the
 * user finishes it, never when they escape it.
 *
 * ## Two endings, and why both are true
 *
 * [`completedCleanly`] asks whether anything was skipped. A user who granted
 * both permissions and performed both gestures gets the confident line. A user
 * who skipped something gets a different one that says where to find the parts
 * they passed over — congratulating them on a setup that is not finished would
 * be the kind of small lie a first-run window never recovers from, because the
 * first thing they do next is try the thing that does not work.
 *
 * The face is `speaking`, the liveliest pose in the vocabulary. There is nothing
 * for it to listen to and nothing pending, so `listening` and `thinking` would
 * both be theatre; `speaking` is the pose the shell shows when Polaris is doing
 * something for you, which is the note to end on.
 */
import { BlobatarFace } from "@/notch/BlobatarFace";
import { FACE_PLACEMENTS } from "@/notch/faceState";

export interface ReadyPageProps {
  /** Whether the user reached the end without skipping any gate. */
  readonly clean: boolean;
  readonly onComplete: () => void;
}

export function ReadyPage({ clean, onComplete }: ReadyPageProps) {
  return (
    <>
      <div className="ob-face">
        <BlobatarFace stage="speaking" placement={FACE_PLACEMENTS.panel} />
      </div>

      <h1 className="ob-title">Polaris is ready</h1>
      <p className="ob-body">
        {clean
          ? "Hold control and option whenever you need it. Polaris will be waiting in the notch."
          : "You can finish the parts you skipped any time — everything lives in the notch, under the ⋯ menu."}
      </p>

      <div className="ob-actions">
        <button type="button" className="ob-button ob-button-primary" autoFocus onClick={onComplete}>
          Start using Polaris
        </button>
      </div>
    </>
  );
}
