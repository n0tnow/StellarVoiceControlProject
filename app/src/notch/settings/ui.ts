/**
 * Small class strings for the Settings page (task W15d).
 *
 * The page uses the notch's Tailwind tokens directly; these keep the repeated
 * text styles in one place instead of scattering them through the sections.
 */

/** Section heading above the hairline. */
export const SECTION_TITLE = "text-[11px] font-semibold uppercase tracking-wide text-polaris-muted";

/** Muted helper/status line. */
export const HINT = "text-[11px] leading-4 text-polaris-muted";

/** Text/select input. */
export const FIELD =
  "rounded-md border border-polaris-line bg-black/20 px-2 py-1 text-xs text-polaris-text outline-none focus:border-polaris-accent";

/** The severity dot beside a status row. */
export const DOT = "mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full";
