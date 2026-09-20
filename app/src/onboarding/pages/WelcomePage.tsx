/**
 * Page 1 — the introduction.
 *
 * One clip, one line, one sentence, one button. The restraint is the design:
 * this is the first thing a user sees of Polaris and the only job it has is to
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
import heroVideo from "@/assets/onboarding/blob-hero.mp4";

export interface WelcomePageProps {
  readonly onAdvance: () => void;
}

export function WelcomePage({ onAdvance }: WelcomePageProps) {
  return (
    <>
      <Clip className="ob-media-hero" video={heroVideo} poster={heroPoster} />
      <h1 className="ob-title">Meet Polaris</h1>
      <p className="ob-body">
        Polaris lives in the notch. Hold two keys, say what you want, and let go —
        it listens, thinks, and answers without ever taking over your screen.
      </p>
      <div className="ob-actions">
        {/* Autofocused so the whole window is operable from the keyboard from
            the first frame: Return advances, and the focus ring lands somewhere
            sensible for anyone who reaches for Tab. */}
        <button type="button" className="ob-button ob-button-primary" autoFocus onClick={onAdvance}>
          Set up Polaris
        </button>
      </div>
    </>
  );
}
