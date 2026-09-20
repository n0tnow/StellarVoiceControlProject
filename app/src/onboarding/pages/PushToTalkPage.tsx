/**
 * Page 3 — push to talk, taught by making the user do it.
 *
 * The page will not advance until a real Control+Option hold of at least 400 ms
 * has been held and released. That the gesture is *possible* to detect from a
 * focused window is not an assumption: `hotkey_flags.rs` installs a local
 * `NSEvent` monitor next to the global one, and both feed the same latch, so the
 * `hotkey` event arrives here exactly as it would if Autonomy were in the
 * background. [`usePushToTalkProbe`] carries the whole argument, and reads the
 * DOM as well so the lesson also works in a plain browser.
 *
 * ## The face
 *
 * `BlobatarFace` — the notch's own component, unchanged — is on this page, and
 * while the keys are down it is given the `listening` stage: the same pose the
 * real notch shows during a real turn. This is the pedagogical heart of the
 * window. The user presses two keys and the creature they met on page one opens
 * its eyes; no sentence does that.
 *
 * It is passed `FACE_PLACEMENTS.panel` rather than a size of this page's own
 * invention. That table is where the face's size and its gaze excursion are
 * chosen *together* — the excursion is in viewBox units and only reads at the
 * larger size — and it is pinned by a unit test. A third placement invented here
 * would quietly reintroduce the "hareketsiz" bug that table exists to fix.
 *
 * ## Why this page is two columns
 *
 * The keycap clip is portrait (640x800) and the page has four things to show:
 * the keys, the creature, the instruction and the result. Stacked, that is
 * taller than the 640px window and every element has to shrink to fit — which
 * is how a plain page turns cramped. Side by side, the clip keeps its full
 * height, the copy keeps its air, and the composition still holds exactly one
 * idea.
 */
import { BlobatarFace } from "@/notch/BlobatarFace";
import { FACE_PLACEMENTS } from "@/notch/faceState";

import { Clip } from "../Clip.tsx";
import { CheckIcon } from "../icons.tsx";
import { usePushToTalkProbe } from "../useShortcutProbe.ts";
import keysPoster from "@/assets/onboarding/keys-control-option-poster.jpg";
import keysStill from "@/assets/onboarding/key-control-option.png";
import keysVideo from "@/assets/onboarding/keys-control-option.mp4";

export interface PushToTalkPageProps {
  readonly active: boolean;
  readonly passed: boolean;
  readonly onPass: () => void;
  readonly onAdvance: () => void;
  readonly onSkip: () => void;
}

export function PushToTalkPage({
  active,
  passed,
  onPass,
  onAdvance,
  onSkip,
}: PushToTalkPageProps) {
  // The probe is disarmed once the step has passed: there is nothing left for it
  // to observe, and leaving it live would keep the face reacting on a page whose
  // lesson is over.
  const { held, tooShort } = usePushToTalkProbe(onPass, active && !passed);

  return (
    <div className="ob-lesson">
      <Clip
        className="ob-media-keys"
        video={keysVideo}
        poster={keysPoster}
        still={keysStill}
      />

      <div className="ob-lesson-copy">
        <div className="ob-face">
          <BlobatarFace
            /* The only stage this page can honestly show. `listening` is what
               the real shell shows for the same gesture; a turn's later stages
               belong to a turn this window is not running. */
            stage={held ? "listening" : null}
            placement={FACE_PLACEMENTS.panel}
          />
        </div>

        <h1 className="ob-title">Hold to talk</h1>
        <p className="ob-body">
          Hold <span className="ob-key">control</span> and{" "}
          <span className="ob-key">option</span>, say what you want, then let go.
          Autonomy listens only while you hold them.
        </p>

        {/* One fixed-height line, so nothing above it moves as the text changes. */}
        <div className={`ob-lesson-status${passed ? " is-passed" : ""}`}>
          {passed ? (
            <>
              <CheckIcon />
              That is the whole gesture.
            </>
          ) : (
            <>
              <span className={`ob-held-dot${held ? " is-held" : ""}`} />
              {held
                ? "Keep holding…"
                : tooShort
                  ? "Almost — hold them a beat longer."
                  : "Try it now."}
            </>
          )}
        </div>

        <div className="ob-actions">
          <button
            type="button"
            className="ob-button ob-button-primary"
            disabled={!passed}
            onClick={onAdvance}
          >
            Continue
          </button>
          {passed ? null : (
            <button type="button" className="ob-skip" onClick={onSkip}>
              Skip this
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
