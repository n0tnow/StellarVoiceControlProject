/**
 * The shell's side of the `PolarisEvent` seam.
 *
 * Rust owns the hotkey, microphone and Touch ID; the webview owns the UI. All
 * traffic in either direction goes through the helpers here so that when step A0
 * wires real audio and step A5 wires signing, only the Rust side changes.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  POLARIS_EVENT_NAME,
  isPolarisEvent,
  type AppInfo,
  type CaptureStatus,
  type NotchGeometry,
  type PolarisEvent,
} from "@polaris/interfaces";

/** `app_info` Tauri command — version/network for diagnostics. */
export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/** Current capture snapshot; the overlay calls this once before events arrive. */
export async function getCaptureStatus(): Promise<CaptureStatus> {
  return invoke<CaptureStatus>("capture_status");
}

/**
 * Accessibility trust for the modifier-only gesture. Read on startup because
 * the matching `hotkey_permission` event is emitted during Rust setup, before
 * the webview listener attaches.
 */
export async function getHotkeyPermission(): Promise<boolean> {
  return invoke<boolean>("hotkey_permission");
}

/** Programmatic capture start — the global hotkey drives the same engine. */
export async function captureStart(): Promise<CaptureStatus> {
  return invoke<CaptureStatus>("capture_start");
}

/** Programmatic capture stop. Returns the final snapshot (`ready` on success). */
export async function captureStop(): Promise<CaptureStatus> {
  return invoke<CaptureStatus>("capture_stop");
}

/**
 * Notch size in AppKit points. Polled so a display connect/disconnect or a
 * resolution change repositions the overlay; there is no Tauri event for it.
 */
export async function getNotchGeometry(): Promise<NotchGeometry> {
  return invoke<NotchGeometry>("notch_geometry");
}

/**
 * Reports one agent-loop phase to the Rust per-turn timing trace (step A11).
 *
 * The webview console is invisible to the owner, so the phases that only exist
 * in TypeScript (request built, intent parsed, sentence built) are forwarded to
 * Rust, which owns the trace and prints the single per-turn block. Fire and
 * forget on purpose: a missing or failing command must never add latency to, or
 * break, a real turn.
 */
export function markTurnPhase(name: string): void {
  void invoke("polaris_phase", { name }).catch(() => {});
}

/** Subscribes to the typed event stream. Events with an unknown shape are ignored. */
export async function listenPolarisEvents(
  handler: (event: PolarisEvent) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(POLARIS_EVENT_NAME, (message) => {
    if (isPolarisEvent(message.payload)) {
      handler(message.payload);
    } else {
      console.warn("dropped malformed PolarisEvent", message.payload);
    }
  });
}

