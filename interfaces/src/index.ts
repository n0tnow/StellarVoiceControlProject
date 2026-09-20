/**
 * @polaris/interfaces — the ONLY typed seam between the two owners.
 *
 * Owner A — Brain & Shell (`app/`, `agent/`): Tauri shell, hotkey, voice pipeline,
 * agent core, approval UI.
 * Owner B — Chain (`stellar/`, `contracts/`): anchor client, protocol integration,
 * Soroban contracts, signing service.
 *
 * Source of truth: `docs/interfaces.md`. Change these types only by agreement in PR
 * review, and keep the Rust mirror (`app/src-tauri/src/interfaces.rs`,
 * `app/src-tauri/src/events.rs`) in sync in the same PR.
 */

/* ------------------------------------------------------------------ *
 * 1. Intent — structured value-moving request
 * ------------------------------------------------------------------ */

export type IntentKind = "deposit" | "swap" | "send" | "guard_policy" | "raw_tx";

export interface Intent {
  kind: IntentKind;
  /** e.g. "USDC" (testnet) */
  asset: string;
  /** Decimal string, never float. */
  amount: string;
  /** Address or alias. */
  recipient?: string;
  /** Alias book entry, e.g. "ada". */
  alias?: string;
  memo?: string;
  /** Voice transcript excerpt that produced it. */
  source?: string;
}

/* ------------------------------------------------------------------ *
 * 2. Chain tools exposed to the agent
 * ------------------------------------------------------------------ */

/**
 * Every tool returns an **unsigned XDR** plus a human-readable summary decoded from
 * that XDR — the summary is exactly what the approval card renders.
 */
export interface ChainToolResult {
  /** base64 XDR, unsigned */
  unsignedXdr: string;
  summary: {
    /** e.g. "Swap 500 USDC -> XLM" */
    title: string;
    /** decoded operation details */
    lines: string[];
    /** Stellar Lab / Stellar.Expert scene */
    explorerUrl?: string;
    estimatedFee: string;
  };
}

/** Owner B implements; Owner A's agent core calls these. */
export type ChainTool = (intent: Intent) => Promise<ChainToolResult>;

/* ------------------------------------------------------------------ *
 * 3. Signing service — Touch ID gated
 * ------------------------------------------------------------------ */

/**
 * Rust-side service exposed to the webview via a Tauri command.
 * Owner A owns the Touch ID approval flow; Owner B consumes signed envelopes.
 */
export interface SigningService {
  /** Rejects unless Touch ID approval succeeded for this `payloadHash`. */
  sign(payloadHash: string): Promise<{ signedXdr: string }>;
}

/* ------------------------------------------------------------------ *
 * 4. Push-to-talk capture (step A0)
 * ------------------------------------------------------------------ */

/**
 * The microphone capture lifecycle. `ready` is deliberately **not** a send
 * action: it only means a WAV is on disk waiting for step A1 (STT). Nothing in
 * the shell is allowed to submit or dispatch on release.
 *
 * Step A1 adds `transcribing` (the overlay shows "Thinking") and returns to
 * `idle` once the transcript is emitted. The transcript itself travels on the
 * `transcript` event and is never painted in the notch.
 */
export type CaptureState = "idle" | "recording" | "ready" | "transcribing" | "error";

/** A finished capture on disk. Duration is measured from written sample frames. */
export interface CaptureRecording {
  path: string;
  durationMs: number;
}

/** Snapshot of the capture engine; also pushed on every transition. */
export interface CaptureStatus {
  state: CaptureState;
  recording: CaptureRecording | null;
  /** Full failure detail; non-null iff `state === "error"`. */
  error: string | null;
  /**
   * Short, overlay-safe label for failures the state name cannot describe
   * (step A1, e.g. "No STT key"). `null` means the UI derives its label from
   * `state` — A0 microphone errors stay "Mic error".
   */
  label: string | null;
}

/**
 * One named shell state, already resolved against the display. Width/height and
 * radii are concrete AppKit points and `interactive` says whether the native
 * window should accept mouse clicks in this state. The list and order come from
 * the single Rust table (`notch::SHELL_STATES`); the webview never derives
 * geometry itself.
 */
export interface ShellStateGeometry {
  /**
   * `"collapsed" | "compact" | "prompt" | "panel"` today; new names are added
   * in Rust.
   */
  name: string;
  width: number;
  height: number;
  /** Does the native window accept mouse clicks in this state? */
  interactive: boolean;
  /**
   * Does the native window accept keyboard input in this state? Only the typed
   * `prompt` state is focusable; the overlay must never steal focus while
   * push-to-talk is idle. The native flag has a single writer in Rust.
   */
  focusable: boolean;
  /**
   * Content-driven states (`prompt`) may resize between these two heights; the
   * webview reports its measured content and Rust clamps. Equal to `height` for
   * fixed states.
   */
  minHeight: number;
  maxHeight: number;
  /** Top-left/top-right convex radius (0 for grown states: their ears own it). */
  topRadius: number;
  /** Bottom convex radius. */
  bottomRadius: number;
  /** Concave "ear" radius that melts the shell into the screen edge. */
  earRadius: number;
}

/** The measured display the states were resolved against. */
export interface NotchMetrics {
  cutoutWidth: number;
  cutoutHeight: number;
  screenWidth: number;
  screenHeight: number;
  /** Centre of the measured cutout, in points from the screen's left edge. */
  cutoutCenterX: number;
  /** `NSScreen.safeAreaInsets().top` — the menu-bar/notch inset. */
  safeTop: number;
}

/**
 * Everything the shell needs to render, in AppKit **points** (not CSS-relative
 * units), so the webview never has to guess the physical notch. The radii are
 * derived on the Rust side from the measured safe area rather than hardcoded in
 * CSS. On a display without a notch the Rust side returns a centred-pill
 * fallback. Replaces step A0's flat two-state `NotchGeometry`.
 */
export interface ShellGeometry {
  states: ShellStateGeometry[];
  notch: NotchMetrics;
}

/**
 * Pre-first-command placeholder only: the webview renders one frame before
 * `notch_geometry` resolves, and the OS window is already sized/positioned by
 * Rust. Deliberately carries **no state rows**: the state list is owned by the
 * Rust `SHELL_STATES` table, so enumerating it here would make adding a state a
 * second edit and break the "one table row" promise. The shell simply renders
 * nothing until the first `notch_geometry` resolves.
 */
export const FALLBACK_SHELL_GEOMETRY: ShellGeometry = {
  states: [],
  notch: {
    cutoutWidth: 216,
    cutoutHeight: 34,
    screenWidth: 1512,
    screenHeight: 982,
    cutoutCenterX: 756,
    safeTop: 34,
  },
};

/* ------------------------------------------------------------------ *
 * 5. Status / event stream for the UI
 * ------------------------------------------------------------------ */

/** Tauri event channel name; the Rust side emits on the same channel. */
export const POLARIS_EVENT_NAME = "polaris-event";

export type HotkeyState = "down" | "up";
export type AgentStage = "thinking" | "tool_call" | "awaiting_approval" | "done";

/** Whether Polaris is producing audible speech (step A5). */
export type SpeechState = "speaking" | "idle";

export type PolarisEvent =
  | { type: "hotkey"; state: HotkeyState }
  /**
   * Accessibility trust for the modifier-only Control+Option gesture. `trusted:
   * false` disables that gesture by design and leaves Control+Option+Space as
   * the only trigger.
   */
  | { type: "hotkey_permission"; trusted: boolean }
  | { type: "capture_status"; status: CaptureStatus }
  | { type: "audio_captured"; path: string; durationMs: number }
  /**
   * A final transcript, plus the language the STT backend recognized the audio
   * as — a BCP-47 tag such as `"en"`/`"tr-TR"`, or `null` when the backend could
   * not report one (step A12). The detected language is measured from the audio
   * and is what the reply language and the TTS voice follow.
   */
  | { type: "transcript"; text: string; final: boolean; language: string | null }
  | { type: "agent_status"; stage: AgentStage }
  /**
   * Audible-playback lifecycle. `speaking` is emitted when the sentence is handed
   * to the TTS backend, `idle` only once playback has finished or failed, so the
   * notch's "Speaking" state always reflects reality and cannot get stuck.
   */
  | { type: "speech_status"; state: SpeechState }
  | {
      type: "approval_request";
      intent: Intent;
      summary: ChainToolResult["summary"];
      payloadHash: string;
    }
  | { type: "approval_result"; payloadHash: string; approved: boolean }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  | { type: "error"; message: string };

/**
 * Runtime guard for events arriving from Rust as `unknown`.
 * Cheap structural check: the wire contract is `{ type: string, ... }`.
 * Keeping it tag-agnostic means a new union variant (`capture_status`,
 * `audio_captured`, …) is admitted without touching the guard.
 */
export function isPolarisEvent(value: unknown): value is PolarisEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/* ------------------------------------------------------------------ *
 * 6. App metadata (Tauri `app_info` command)
 * ------------------------------------------------------------------ */

export interface AppInfo {
  name: string;
  version: string;
  /** e.g. "testnet" */
  network: string;
  tauriVersion: string;
}