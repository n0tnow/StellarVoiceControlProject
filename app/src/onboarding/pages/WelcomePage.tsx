/**
 * Page 1 — the introduction.
 *
 * One clip, one line, one sentence, one button. The restraint is the design:
 * this is the first thing a user sees of Autonomy and the only job it has is to
 * establish that there is a creature living in their notch. Anything else on
 * this page — a feature list, a "what's new", a second button — would be spent
 * before the product has been shown.
 *
 * The hero is the blob materialising out of black. It is the same creature that
 * appears in the shortcut lesson two pages later and in the notch forever after,
 * which is why it is worth ten seconds of screen here.
 */
import { Clip } from "../Clip.tsx";
import heroPoster from "@/assets/onboarding/blob-hero-poster.jpg";
import heroStill from "@/assets/onboarding/blob-hero-still.png";
import heroVideo from "@/assets/onboarding/blob-hero.mp4";

export interface WelcomePageProps {
  readonly onAdvance: () => void;
}

export function WelcomePage({ onAdvance }: WelcomePageProps) {
  return (
    <>
      {/* The clip materialises the creature out of nothing, so its first frame
          is very nearly an empty black rectangle — a correct poster (it matches
          what the video starts with, so there is no jump) and a useless still.
          `blob-hero-still.png` is a frame from the middle of the clip, where the
          creature is fully formed, and it is what a reduced-motion user sees. */}
      <Clip
        className="ob-media-hero"
        video={heroVideo}
        poster={heroPoster}
        still={heroStill}
      />
      <h1 className="ob-title">Meet Autonomy</h1>
      <p className="ob-body">
        Autonomy lives in the notch. Hold two keys, say what you want, and let go —
        it listens, thinks, and answers without ever taking over your screen.
      </p>
      <div className="ob-actions">
        {/* Autofocused so the whole window is operable from the keyboard from
            the first frame: Return advances, and the focus ring lands somewhere
            sensible for anyone who reaches for Tab. */}
        <button type="button" className="ob-button ob-button-primary" autoFocus onClick={onAdvance}>
          Set up Autonomy
        </button>
      </div>
    </>
  );
}
