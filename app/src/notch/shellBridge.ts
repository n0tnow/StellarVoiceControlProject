/**
 * The shell's IPC bridge (step A5).
 *
 * Shell-state geometry and hover live here rather than in `lib/polaris.ts`
 * (which owns the voice/agent event seam): a shell state is a shell concern, and
 * keeping it in its own module keeps the diff to `App.tsx` small while
 * `feat/a4-speak-intent` is edited in parallel.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ShellGeometry, ShellStateGeometry } from "@polaris/interfaces";

/** Separate Tauri event channel for cursor hover (not part of `PolarisEvent`). */
export const NOTCH_HOVER_EVENT_NAME = "notch_hover";

/** Separate Tauri event channel for the hotkey-sourced shell mode (folded A6). */
export const NOTCH_HOTKEY_EVENT_NAME = "notch_hotkey";

/**
 * Every named state, resolved against the measured display. Polled so a display
 * connect/disconnect or a resolution change repositions the overlay; there is no
 * Tauri event for it.
 */
export async function getShellGeometry(): Promise<ShellGeometry> {
  return invoke<ShellGeometry>("notch_geometry");
}

/**
 * Grow-before-animate: Rust grows the OS window to `max(current, target)` so the
 * CSS expansion is never clipped, applies the state's interactivity, and returns
 * the target state geometry. Call this **before** applying the CSS state.
 */
export async function requestShellState(name: string): Promise<ShellStateGeometry> {
  return invoke<ShellStateGeometry>("shell_request_state", { name });
}

/**
 * Shrink-after-animate: called on `transitionend`, Rust snaps the window to
 * exactly this state's frame and re-applies interactivity. A commit for a state
 * that is no longer active is ignored by Rust.
 */
export async function commitShellState(name: string): Promise<void> {
  await invoke("shell_commit_state", { name });
}

/**
 * Reports the measured height of the active content-driven state's body. Rust
 * clamps it to the state's `[minHeight, maxHeight]` and returns the value the
 * CSS must use; the window is grown immediately so the height tween is never
 * clipped, and the commit path shrinks it back afterwards.
 */
export async function resizeShellContent(height: number): Promise<number> {
  return invoke<number>("shell_resize_content", { height });
}

/**
 * Cursor hover changes, debounced in Rust (only emitted on an inside/outside
 * change). Dwell timing is left to React.
 */
export async function listenNotchHover(
  handler: (inside: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ inside?: unknown }>(NOTCH_HOVER_EVENT_NAME, (message) => {
    const inside = message.payload?.inside;
    if (typeof inside === "boolean") {
      handler(inside);
    } else {
      console.warn("dropped malformed notch_hover", message.payload);
    }
  });
}

/**
 * The hotkey-sourced shell proposal (double-Control). `prompt: true` proposes
 * the `prompt` state; `false` clears it (second tap, dismiss, or a watchdog
 * forced collapse).
 */
export async function listenNotchHotkey(
  handler: (prompt: boolean) => void,
): Promise<UnlistenFn> {
  return listen<{ prompt?: unknown }>(NOTCH_HOTKEY_EVENT_NAME, (message) => {
    const prompt = message.payload?.prompt;
    if (typeof prompt === "boolean") {
      handler(prompt);
    } else {
      console.warn("dropped malformed notch_hotkey", message.payload);
    }
  });
}
