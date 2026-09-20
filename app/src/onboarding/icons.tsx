/**
 * The window's two glyphs.
 *
 * Two, and both structural rather than decorative: a check that means "this is
 * done" and a cross that closes the window. There is no icon set here and there
 * should not be one — every other affordance in this window is a word, because
 * a word is unambiguous and a small grey pictogram on black is not.
 *
 * They are inline SVG rather than an icon package's components so they inherit
 * `currentColor` and are sized entirely by the stylesheet, which is what lets
 * the same check be muted in one place and accent-coloured in another without a
 * prop.
 */

/** "Done." The one mark the accent colour is spent on. */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M3 8.5 6.2 11.7 13 5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The quiet close affordance. */
export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 4 12 12M12 4 4 12"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
