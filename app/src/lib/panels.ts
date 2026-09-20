/**
 * The shell's side of the panel-window seam (step W0).
 *
 * Rust owns the windows; the webview asks for one by name. `open_panel` is the
 * only way a panel can be created, so the Rust allow-list
 * (`app/src-tauri/src/panels.rs`) stays the single source of truth.
 */
import { invoke } from "@tauri-apps/api/core";

import type { PanelName } from "@/panels/panelRoutes";

/**
 * Panel names the Rust registry accepts. `panelRoutes.ts` owns the union (it is
 * the pure module tested against the hash grammar), so this re-export is the
 * only declaration — do not redeclare it here.
 */
export type { PanelName };

/**
 * Opens (or focuses) a panel window by name.
 *
 * Rejects when the name is not on the Rust allow-list, which means the type
 * above and the registry have drifted — a bug, not a user error.
 */
export async function openPanel(name: PanelName): Promise<void> {
  await invoke("open_panel", { name });
}

/**
 * Quits Polaris (`quit_app`). With the menu-bar tray removed this is the only
 * user-facing quit path; the notch Settings page calls it.
 */
export async function quitPolaris(): Promise<void> {
  await invoke("quit_app");
}
