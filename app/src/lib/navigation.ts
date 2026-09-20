/**
 * Voice navigation on the shell side (NAV).
 *
 * The agent's `navigate` tool produces a read-only `NavigationRequest`; this
 * module maps its target to the notch page that now owns it. Every target lives
 * as a page inside the notch — the old separate panel windows are gone — so
 * `ShellSurface`, which owns the notch's page controller, applies the mapping,
 * and `applyNavigation` opens nothing.
 *
 * It is Tauri-free so the mapping is unit-tested (`navigation.test.ts`).
 */
import type { NavigationRequest, NavigationTarget } from "@polaris/interfaces";

import type { NotchPage } from "@/notch/notchPage";

/**
 * Every target's notch page. Several former panels were folded into the page
 * that already covered their subject (Schedules/Suggestions → Tasks, Security →
 * Rules, Anchor/P2P → Trade, Privacy/Debug → Settings).
 */
const NOTCH_PAGES: Readonly<Partial<Record<NavigationTarget, NotchPage>>> = {
  wallet: "wallet",
  history: "history",
  tasks: "tasks",
  schedules: "tasks",
  suggestions: "tasks",
  rules: "rules",
  security: "rules",
  anchor: "trade",
  p2p: "trade",
  settings: "settings",
  privacy: "settings",
  debug: "settings",
};

/**
 * The notch page for a target. Every target has one except `close`, which
 * collapses the panel instead (handled by `ShellSurface`); `null` means "not a
 * page".
 */
export function notchPageFor(target: NavigationTarget): NotchPage | null {
  return NOTCH_PAGES[target] ?? null;
}

/**
 * The shell seam `App` calls after a turn. Every navigation target is a notch
 * page now (`ShellSurface` selects it), so there is no window to open and this
 * is intentionally a no-op. Kept so the call site and the seam stay in place.
 */
export async function applyNavigation(_request: NavigationRequest): Promise<void> {}
