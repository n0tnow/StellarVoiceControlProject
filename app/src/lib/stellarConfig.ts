/**
 * The webview's read-only window onto the chain lane's configuration (step W1).
 *
 * The owner address and the recipient aliases are not secrets, but they are
 * environment-specific, so they are read in Rust (`stellar_config`) and never
 * bundled: `POLARIS_OWNER_ADDRESS` / `POLARIS_ALIASES` are deliberately **not**
 * in the Vite `envPrefix`, so this command is the only path from `.env` to the
 * webview. The command returns an allow-listed, validated [`StellarConfig`] and
 * nothing else — see `app/src-tauri/src/stellar_config.rs`.
 */
import { invoke } from "@tauri-apps/api/core";
import type { StellarConfig } from "@polaris/interfaces";

/** Reads the non-secret chain configuration from the Rust shell. */
export async function getStellarConfig(): Promise<StellarConfig> {
  return invoke<StellarConfig>("stellar_config");
}
