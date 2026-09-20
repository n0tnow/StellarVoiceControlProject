/**
 * App-level Tauri commands that are not tied to a feature.
 */
import { invoke } from "@tauri-apps/api/core";

/**
 * Quits Polaris (`quit_app`). With the menu-bar tray removed this is the only
 * user-facing quit path; the notch Settings page calls it.
 */
export async function quitPolaris(): Promise<void> {
  await invoke("quit_app");
}

/**
 * Opens a block-explorer link in the default browser (`open_external`). Rust
 * only accepts testnet explorer URLs, so this cannot be pointed anywhere else.
 */
export async function openExternal(url: string): Promise<void> {
  await invoke("open_external", { url });
}
