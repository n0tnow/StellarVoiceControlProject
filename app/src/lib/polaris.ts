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
  type AgentStage,
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

export type LogTone = "neutral" | "accent" | "ok" | "warn" | "danger";

export interface LogLine {
  /** Stable key for React lists. */
  id: string;
  /** Local time, `HH:MM:SS`. */
  at: string;
  /** Who produced the line — shown so wiring problems are obvious at a glance. */
  origin: "ui" | "rust" | "agent";
  title: string;
  detail?: string;
  tone: LogTone;
}

export function nowLabel(now: Date = new Date()): string {
  return now.toTimeString().slice(0, 8);
}

let lineCounter = 0;

export function makeLine(line: Omit<LogLine, "id" | "at">): LogLine {
  lineCounter += 1;
  return { id: `line-${lineCounter}`, at: nowLabel(), ...line };
}

/** Renders one wire event into a log line. The UI never branches on the raw JSON. */
export function describeEvent(event: PolarisEvent): Omit<LogLine, "id" | "at"> {
  switch (event.type) {
    case "hotkey":
      return {
        origin: "rust",
        title: event.state === "down" ? "Hotkey pressed" : "Hotkey released",
        tone: "accent",
      };
    case "hotkey_permission":
      return {
        origin: "rust",
        title: event.trusted
          ? "Hold-to-talk enabled (Control+Option)"
          : "Hold-to-talk needs Accessibility access",
        detail: event.trusted
          ? undefined
          : "Control+Option is disabled; Control+Option+Space still works",
        tone: event.trusted ? "ok" : "warn",
      };
    case "capture_status":
      return {
        origin: "rust",
        title: `Capture: ${event.status.state}`,
        detail:
          event.status.error ??
          (event.status.recording
            ? `${event.status.recording.path} · ${event.status.recording.durationMs} ms`
            : undefined),
        tone:
          event.status.state === "error"
            ? "danger"
            : event.status.state === "ready"
              ? "ok"
              : "neutral",
      };
    case "audio_captured":
      return {
        origin: "rust",
        title: "Audio captured",
        detail: `${event.path} · ${event.durationMs} ms`,
        tone: "ok",
      };
    case "transcript":
      return {
        origin: "agent",
        title: event.final ? "Transcript (final)" : "Transcript (partial)",
        detail: event.text,
        tone: "neutral",
      };
    case "agent_status":
      return { origin: "agent", title: `Agent: ${stageLabel(event.stage)}`, tone: "neutral" };
    case "speech_status":
      return {
        origin: "rust",
        title: event.state === "speaking" ? "Speaking" : "Speech finished",
        tone: event.state === "speaking" ? "accent" : "neutral",
      };
    case "approval_request":
      return {
        origin: "agent",
        title: `Approval requested — ${event.summary.title}`,
        detail: event.summary.lines.join("\n"),
        tone: "warn",
      };
    case "approval_result":
      return {
        origin: "rust",
        title: event.approved ? "Touch ID approved" : "Approval denied",
        detail: event.payloadHash,
        tone: event.approved ? "ok" : "danger",
      };
    case "tx_submitted":
      return { origin: "rust", title: "Transaction submitted", detail: event.hash, tone: "ok" };
    case "error":
      return { origin: "rust", title: "Error", detail: event.message, tone: "danger" };
  }
}

function stageLabel(stage: AgentStage): string {
  switch (stage) {
    case "thinking":
      return "thinking";
    case "tool_call":
      return "calling a tool";
    case "awaiting_approval":
      return "awaiting approval";
    case "done":
      return "done";
  }
}