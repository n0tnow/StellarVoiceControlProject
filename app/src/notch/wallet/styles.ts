/**
 * Shared class strings for the Wallet page's new sections (task W10b).
 *
 * The page's card/list look comes from `index.css`; these are the small form
 * and card utilities the onboarding flows add. Kept in one file so the pages
 * stay readable and the look stays consistent.
 */

/** Text/secret input. */
export const FIELD =
  "w-full rounded-md border border-polaris-line bg-black/20 px-2 py-1 text-xs text-polaris-text outline-none focus:border-polaris-accent";

/** A grouped section inside the page column. */
export const CARD =
  "space-y-2 rounded-lg border border-polaris-line bg-polaris-panel/40 px-3 py-2";

/** A row of buttons/actions. */
export const ACTIONS = "flex flex-wrap items-center gap-2";

/** Muted helper/status line. */
export const HINT = "text-[11px] text-polaris-muted";

/** Error helper/status line. */
export const ERROR = "text-[11px] text-polaris-danger";
