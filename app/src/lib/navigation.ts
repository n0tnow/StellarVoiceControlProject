/**
 * Voice navigation on the shell side (NAV).
 *
 * The agent's `navigate` tool produces a read-only `NavigationRequest`; this
 * module maps its target to a surface and owns the one impure action (opening a
 * panel window). Notch targets (History / Tasks / Rules / Wallet) are handled
 * by `ShellSurface`, which owns the notch's page controller; `applyNavigation`
 * only opens the separate panel windows. It is Tauri-free so the mapping is
 * unit-tested (`navigation.test.ts`), and the `open_panel` call is imported
 * lazily so importing this module never pulls in the Tauri API.
 */
import type { NavigationRequest, NavigationTarget } from "@polaris/interfaces";

import type { NotchPage } from "@/notch/notchPage";
import type { PanelName } from "@/panels/panelRoutes";

/** Targets that live as a page inside Fatih's expandable notch. */
const NOTCH_PAGES: Readonly<Partial<Record<NavigationTarget, NotchPage>>> = {
  wallet: "wallet",
  rules: "rules",
  tasks: "tasks",
  history: "history",
};

/** Targets that live as their own panel window. Names match the Rust allow-list. */
const PANELS: Readonly<Partial<Record<NavigationTarget, PanelName>>> = {
  security: "security",
  schedules: "schedules",
  suggestions: "suggestions",
  anchor: "anchor",
  p2p: "p2p",
  privacy: "privacy",
  settings: "settings",
  debug: "debug",
};

/** The notch page for a target, or `null` when it is not a notch surface. */
export function notchPageFor(target: NavigationTarget): NotchPage | null {
  return NOTCH_PAGES[target] ?? null;
}

/** The panel window for a target, or `null` when it is not a panel surface. */
export function panelFor(target: NavigationTarget): PanelName | null {
  return PANELS[target] ?? null;
}

/**
 * Performs the shell actions a navigation request needs that are not the
 * notch's page controller. A notch page is a no-op here (the notch owns it); a
 * panel target opens its window and a failure is logged, never thrown — a
 * navigation must not fail a turn.
 */
export async function applyNavigation(request: NavigationRequest): Promise<void> {
  const panel = panelFor(request.target);
  if (!panel) return;
  try {
    const { openPanel } = await import("@/lib/panels");
    await openPanel(panel);
  } catch (error) {
    console.warn(`open_panel(${panel}) failed`, error);
  }
}
