/**
 * The notch panel's page routing — the seam voice commands will later trigger.
 *
 * The panel has four pages (History / Tasks / Rules / Wallet). Which page is
 * shown is a single string; today only the in-panel nav calls
 * [`useNotchPage`]'s setter, but the follow-up voice-wiring task only needs to
 * call `setNotchPage("history")` (from "geçmişi aç" etc.) — nothing else about
 * the shell, the nav or the pages needs to know where the request came from.
 *
 * The pure part (validation, the page list) lives here so it can be
 * unit-tested without React or Tauri (see `notchPage.test.ts`), mirroring how
 * `shellState.ts` is split out of `useShellState.ts`.
 */

/** The four panel pages. `"history"` is the default when the panel opens. */
export type NotchPage = "history" | "tasks" | "rules" | "wallet";

export const NOTCH_PAGES: readonly NotchPage[] = ["history", "tasks", "rules", "wallet"];

export const DEFAULT_NOTCH_PAGE: NotchPage = "history";

/** Runtime guard for the seam: a voice intent arrives as an arbitrary string. */
export function isNotchPage(value: string): value is NotchPage {
  return (NOTCH_PAGES as readonly string[]).includes(value);
}

/**
 * Coerces an arbitrary page request (voice intent, deep link, nav click) to a
 * known page, falling back to the default. Keeps the setter total: a
 * mis-heard command can never leave the panel on a page that does not exist.
 */
export function coerceNotchPage(value: string): NotchPage {
  return isNotchPage(value) ? value : DEFAULT_NOTCH_PAGE;
}
