/**
 * The onboarding window's video hero, and the reduced-motion rule for it.
 *
 * All three clips are the same thing: ten silent seconds shot on pure `#000`,
 * looping, with a poster frame and — for the two keycap shots — a PNG still.
 * They are decoration with a job: the user is about to be asked to press two
 * physical keys, and a photoreal picture of those keys is a better instruction
 * than any sentence about them.
 *
 * ## Reduced motion swaps the element, not just the animation
 *
 * A `<video>` that is merely paused still decodes, still holds a decoder, and —
 * the part that matters — is still a video element that a future edit can start
 * playing again. When the OS has been asked for less motion, this renders an
 * `<img>` and the video never enters the document. The two keycap lessons ship a
 * PNG for exactly this; the welcome hero has only its poster frame, which is the
 * same picture at lower fidelity and is the honest fallback rather than a
 * missing one.
 *
 * The preference is read live rather than once at mount: macOS lets it be
 * toggled while an app is running, and a first-run window can easily be open
 * across that change.
 *
 * ## `aria-hidden`
 *
 * Every clip repeats something the page already says in words — the welcome
 * page names Polaris, the lesson pages name the keys in their copy. A media
 * element here would therefore be a second, worse announcement of the same
 * fact, so the clips stay out of the accessibility tree entirely.
 */
import { useEffect, useState } from "react";

/**
 * Tracks `prefers-reduced-motion: reduce`.
 *
 * Starts from the real value rather than `false`, so a user who has the
 * preference set never sees one frame of the thing they asked not to see.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false,
  );

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const onChange = () => setReduced(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

export interface ClipProps {
  /** The looping clip. */
  readonly video: string;
  /** The frame painted before the video decodes. */
  readonly poster: string;
  /** The still shown instead of the video under reduced motion. */
  readonly still?: string;
  /** Size class from the `Onboarding window` section of `index.css`. */
  readonly className: string;
}

/** One hero clip, or its still. See the module header. */
export function Clip({ video, poster, still, className }: ClipProps) {
  const reduced = usePrefersReducedMotion();

  if (reduced) {
    return <img className={`ob-media ${className}`} src={still ?? poster} alt="" aria-hidden />;
  }

  return (
    <video
      className={`ob-media ${className}`}
      src={video}
      poster={poster}
      /* Silent by construction, but `muted` is also what lets `autoPlay` start
         without a user gesture; without it the first page would show a poster
         and never move. */
      autoPlay
      muted
      loop
      playsInline
      aria-hidden
    />
  );
}
