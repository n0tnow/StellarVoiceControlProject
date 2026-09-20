/**
 * Page 4 — type instead of talking.
 *
 * Same shape as the push-to-talk lesson and deliberately so: the user has just
 * learned how this window teaches, and a second lesson that looked different
 * would make them re-learn the page instead of the gesture.
 *
 * The gesture is a double tap of Control alone, which opens the notch's typed
 * prompt. It exists because push-to-talk is not always available — a quiet room,
 * a call, a word the transcriber will mangle — and because it costs no extra
 * key.
 *
 * ## Why this lesson is strict
 *
 * [`tapReducer`] runs the same five rules as `ctrl_tap.rs`, constant for
 * constant: a tap is short, the two taps are close, a foreign modifier poisons
 * the attempt, a Control chord is not a tap, and a detected double tap resets
 * the machine. Being *looser* than the real detector would be the expensive
 * mistake — the user would leave this page believing in a gesture that does not
 * work, and would blame the product rather than the lesson.
 *
 * One consequence is worth naming: the previous page's Control+Option hold can
 * never satisfy this one, because Option is a foreign modifier here. The two
 * lessons cannot be passed by the same gesture, which is the point of teaching
 * them separately.
 *
 * There is no face on this page. The typed prompt is the one shell state that
 * deliberately has no face (`shouldRenderFace` excludes it — the prompt owns the
 * whole surface and carries its own stage indicator), so drawing one here would
 * promise something the product does not do.
 */
import { Clip } from "../Clip.tsx";
import { CheckIcon } from "../icons.tsx";
import { useDoubleControlProbe } from "../useShortcutProbe.ts";
import keyPoster from "@/assets/onboarding/keys-control-poster.jpg";
import keyStill from "@/assets/onboarding/key-control.png";
import keyVideo from "@/assets/onboarding/keys-control.mp4";

export interface TypePromptPageProps {
  readonly active: boolean;
  readonly passed: boolean;
  readonly onPass: () => void;
  readonly onAdvance: () => void;
  readonly onSkip: () => void;
}

export function TypePromptPage({
  active,
  passed,
  onPass,
  onAdvance,
  onSkip,
}: TypePromptPageProps) {
  useDoubleControlProbe(onPass, active && !passed);

  return (
    <div className="ob-lesson">
      <Clip className="ob-media-key" video={keyVideo} poster={keyPoster} still={keyStill} />

      <div className="ob-lesson-copy">
        <h1 className="ob-title">Or type it</h1>
        <p className="ob-body">
          Tap <span className="ob-key">control</span> twice and the notch opens a
          text field. Same assistant, no talking.
        </p>

        <div className={`ob-lesson-status${passed ? " is-passed" : ""}`}>
          {passed ? (
            <>
              <CheckIcon />
              The prompt is yours whenever you want it.
            </>
          ) : (
            <>
              <span className="ob-held-dot" />
              Two quick taps — nothing else held.
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
