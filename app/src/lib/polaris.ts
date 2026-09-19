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
  type PolarisEvent,
} from "@polaris/interfaces";

/** `app_info` Tauri command — version/network shown in the panel header. */
export async function getAppInfo(): Promise<AppInfo> {
  return invoke<AppInfo>("app_info");
}

/**
 * Stand-in for the step-A0 hotkey path: asks Rust to push a full
 * `hotkey -> transcript -> agent_status` sequence over the event channel so the
 * log pane can be verified by hand. Deleted once real audio capture lands.
 */
export async function devSelfTest(): Promise<PolarisEvent[]> {
  return invoke<PolarisEvent[]>("dev_self_test");
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
    case "transcript":
      return {
        origin: "agent",
        title: event.final ? "Transcript (final)" : "Transcript (partial)",
        detail: event.text,
        tone: "neutral",
      };
    case "agent_status":
      return { origin: "agent", title: `Agent: ${stageLabel(event.stage)}`, tone: "neutral" };
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