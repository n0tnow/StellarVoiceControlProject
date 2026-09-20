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

/**
 * Separate Tauri event channel for the raw cursor position (not part of
 * `PolarisEvent`). The overlay is click-through until a state makes it
 * interactive, so the webview never receives `pointermove` on its own — the
 * global `mouseMoved` monitor is the only cursor stream there is, and this
 * carries its samples to the webview's gaze driver. High-frequency by nature;
 * Rust emits it only while a shell state that draws the face is active.
 */
export const NOTCH_CURSOR_EVENT_NAME = "notch_cursor";

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
 * Tells Rust whether the active panel is a gate the UI is deliberately holding
 * open (the wallet login/unlock pin). While pinned Rust's click-through
 * watchdog must not force-collapse the shell the moment the cursor leaves it —
 * that is what clipped the wallet screen to a thin strip (notch-clip).
 */
export async function setShellPinned(pinned: boolean): Promise<void> {
  await invoke("shell_set_pinned", { pinned });
}

/**
 * Asks Rust to make the overlay keyboard-focusable because a text field inside
 * the panel was clicked. The hover-opened panel is not focusable by itself, so
 * without this no field can be typed into.
 */
export async function requestShellKeyboard(): Promise<boolean> {
  return invoke<boolean>("shell_request_keyboard");
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
 * A cursor sample in the webview's own client coordinates (CSS pixels from the
 * viewport's top-left), as Rust converts it from the global monitor's AppKit
 * screen coordinates using the overlay window's frame.
 */
export interface NotchCursorPoint {
  x: number;
  y: number;
}

/**
 * The raw cursor position from the global mouse monitor, for the gaze driver.
 * Unlike `notch_hover` this fires on every move, not only on an edge; malformed
 * payloads are dropped with a warning rather than fed to the driver.
 */
export async function listenNotchCursor(
  handler: (point: NotchCursorPoint) => void,
): Promise<UnlistenFn> {
  return listen<{ x?: unknown; y?: unknown }>(NOTCH_CURSOR_EVENT_NAME, (message) => {
    const x = message.payload?.x;
    const y = message.payload?.y;
    if (typeof x === "number" && typeof y === "number") {
      handler({ x, y });
    } else {
      console.warn("dropped malformed notch_cursor", message.payload);
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

/** A rectangle in AppKit screen coordinates, as Rust serializes it. */
export interface ShellRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Read-only diagnostics for the whole hover chain (`notch_hover_health`). */
export interface NotchHoverHealth {
  monitorsInstalled: boolean;
  lastSampleAgeMs: number | null;
  lastInside: boolean | null;
  state: string;
  shellRect: ShellRect | null;
  clickThrough: boolean;
  interactive: boolean;
  focusable: boolean;
  /** True while a pinned gate (the wallet login/unlock screen) owns the shell. */
  pinned: boolean;
  /** Native OS window height in points. */
  windowHeight: number;
  /** `NSApplication.isActive` — macOS pauses the global monitor while active. */
  active: boolean;
  activationPolicy: string;
  trusted: boolean;
  detail: string;
}

/** Reads the hover-chain health snapshot (never destructive). */
export async function getNotchHoverHealth(): Promise<NotchHoverHealth> {
  return invoke<NotchHoverHealth>("notch_hover_health");
}

/**
 * Self-test only (Debug panel button): emits the same `notch_hover` edge the
 * native monitor emits, so the webview/reducer half can be exercised even while
 * the native monitor is paused. Watch the notch expand.
 */
export async function simulateNotchHover(): Promise<void> {
  await invoke("notch_simulate_hover");
}
