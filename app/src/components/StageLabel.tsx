import { useEffect, useState } from "react";

/**
 * The single label in the notch's left ear, cross-faded on every stage change.
 *
 * A plain text swap is a hard cut, which the owner asked us to remove. Keeping
 * the outgoing label on top for the length of the fade lets the two overlap, so
 * `listening -> thinking -> speaking` reads as one motion. The
 * outgoing layer is skipped entirely when the user prefers reduced motion.
 */
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Matches `--shell-motion`-scale fades in `index.css`. */
const FADE_MS = 260;

interface Layers {
  current: string;
  leaving: string | null;
}

export function StageLabel({ label }: { label: string }) {
  const [layers, setLayers] = useState<Layers>({ current: label, leaving: null });

  useEffect(() => {
    setLayers((previous) =>
      previous.current === label
        ? previous
        : { current: label, leaving: prefersReducedMotion ? null : previous.current },
    );
  }, [label]);

  // Clear the outgoing layer once it has faded. A plain timer (rather than
  // `animationend`) keeps this correct even when animations are disabled, so the
  // stack can never be left with two visible labels.
  useEffect(() => {
    if (layers.leaving === null) return;
    const timer = setTimeout(() => {
      setLayers((previous) =>
        previous.leaving === null ? previous : { ...previous, leaving: null },
      );
    }, FADE_MS);
    return () => clearTimeout(timer);
  }, [layers.leaving]);

  return (
    <span className="notch-label-stack">
      {layers.leaving !== null ? (
        <span key={`leave-${layers.current}`} className="notch-label is-leaving" aria-hidden="true">
          {layers.leaving}
        </span>
      ) : null}
      <span key={`stay-${layers.current}`} className="notch-label is-current">
        {layers.current}
      </span>
    </span>
  );
}
