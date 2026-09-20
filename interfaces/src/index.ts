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

export type IntentKind =
  | "deposit"
  | "withdraw"
  | "swap"
  | "send"
  | "guard_policy"
  | "raw_tx"
  | "schedule_payment"
  | "cancel_schedule"
  // P2P escrow (W8): lock tokens and ask TRY off-chain, take an offer, confirm
  // the off-chain TRY payment. Value-moving, so every one is approval-gated.
  | "p2p_offer"
  | "p2p_accept"
  | "p2p_confirm"
  // Panel-only escrow actions (no voice tool yet): cancel an open offer and
  // reclaim after the pay deadline. They still go through the approval gate.
  | "p2p_cancel"
  | "p2p_reclaim";

/**
 * A spending rule spoken by the user (`set_approval_rule`, voice-dialog). It is
 * attached to a `guard_policy` intent as a **proposal only**: the executor does
 * not apply it in this build (it answers "Autonomous rules aren't enabled in this
 * build yet"), and a weakening change is never applied silently by voice.
 * Amounts are decimal strings, never floats. Mirrors `guardState.ts`'s fields.
 */
export interface ApprovalRulePayload {
  mode: "always_ask" | "auto_under_limit";
  /** Biggest single unattended payment; required for `auto_under_limit`. */
  autoApproveLimit?: string;
  /** Asset the limits apply to; absent means the user's ambiguity was not resolved. */
  asset?: string;
  perTxLimit?: string;
  dailyLimit?: string;
  /** When true the agent may only pay addresses in the owner's alias book. */
  knownRecipientsOnly?: boolean;
}

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
  /**
   * `schedule_payment` only. The wall-clock first run plus its **explicit**
   * IANA zone — never the machine zone implicitly. The chain tool resolves these
   * to UTC epoch seconds (`resolveLocalTime`) and shows local + UTC on the card.
   */
  firstRun?: { localDate: string; localTime: string; timeZone: string };
  /** `schedule_payment` only. Fixed-second repeat; absent means one-shot. */
  repeat?: { every: "day" | "week" | "custom"; customSeconds?: number };
  /** `schedule_payment` only. Number of executions; required with `repeat`. */
  runs?: number;
  /** `cancel_schedule` only. An exact schedule id when the user named one. */
  scheduleId?: number;
  /** `cancel_schedule` only. How to pick among several schedules for one recipient. */
  which?: "last" | "next";
  /**
   * P2P offer only: the asking price in TRY as a decimal string (e.g. "3400").
   * The off-chain TRY leg is never moved by Polaris; this is only the price the
   * seller asks for and the rate the offer shows.
   */
  priceTry?: string;
  /** P2P accept/confirm only: the on-chain offer id spoken by the user. */
  offerId?: number;
  /**
   * `guard_policy` voice proposal only (`set_approval_rule`). Present iff the rule
   * came from a spoken command; the Security panel builds its own `guard_policy`
   * intents without it, so the executor can tell the two apart.
   */
  rule?: ApprovalRulePayload;
  /**
   * `sell`/`buy` voice hint: which ramp the user chose. Display/telemetry only;
   * the executor dispatches on `kind` (withdraw/deposit/p2p_offer/p2p_accept).
   */
  route?: "anchor" | "p2p";
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
 * ``payloadHash`` on this seam is the **XDR digest**: lowercase-hex SHA-256 of
 * the UTF-8 bytes of the base64 unsigned-XDR string (the same definition the
 * agent seam and the `approval_request` / `approval_result` events use, and the
 * one the Rust approval gate will recompute without XDR parsing).
 *
 * It is **not** the Stellar transaction hash. `Transaction.hash()`
 * (`payloadHashOf` in `@polaris/stellar`, `stellar/src/payments/summary.ts`) is
 * a different value that identifies the transaction on-chain and appears only in
 * the chain summary's explorer URL. The transaction hash must never be passed
 * where the digest is expected, and vice versa.
 */

/**
 * Rust-side service exposed to the webview via a Tauri command.
 * Owner A owns the Touch ID approval flow; Owner B consumes signed envelopes.
 */
export interface SigningService {
  /** Rejects unless Touch ID approval succeeded for this XDR digest (`payloadHash`). */
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
      /** The XDR digest (SHA-256 of the base64 unsigned-XDR string), never the tx hash. */
      payloadHash: string;
    }
  | {
      type: "approval_result";
      /** The XDR digest the decision is bound to (see `approval_request`). */
      payloadHash: string;
      approved: boolean;
    }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  /**
   * Wallet session transitions (step W13a). Emitted on the shared event channel
   * whenever login/logout/auto-lock changes the session; the payload is the
   * same `WalletSession` shape the `wallet_session` command returns, plus the
   * `type` tag.
   */
  | ({ type: "wallet_session_changed" } & WalletSession)
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

/* ------------------------------------------------------------------ *
 * 7. Chain configuration (Tauri `stellar_config` command)
 * ------------------------------------------------------------------ */

/**
 * The non-secret chain configuration the shell reads once from Rust and hands to
 * the chain tool (`app/src/lib/chain.ts`). Rust mirrors this type byte-for-byte
 * in `app/src-tauri/src/stellar_config.rs`; it is an allow-list — no secret
 * (provider key, keeper secret) is ever part of it.
 *
 * `ownerAddress` is the sender (a public `G...` address); `null` means the shell
 * must refuse with "Set POLARIS_OWNER_ADDRESS" rather than guess. `aliases` is
 * the env-supplied book (`POLARIS_ALIASES`), merged over the committed
 * `aliases.json` on the TypeScript side.
 */
export interface StellarConfig {
  network: string;
  rpcUrl: string;
  horizonUrl: string;
  networkPassphrase: string;
  ownerAddress: string | null;
  /**
   * Which signer the shell uses (step W10): always `embedded`, the in-app
   * wallet. This field is kept on the wire for compatibility.
   */
  signer: "embedded";
  aliases: Record<string, string>;
  guardContractId: string | null;
  /** `POLARIS_P2P_CONTRACT_ID`; the deployed `polaris_p2p_escrow` id, or null. */
  p2pContractId: string | null;
}

/* ------------------------------------------------------------------ *
 * 7b. Embedded wallet (step W10)
 * ------------------------------------------------------------------ */

/**
 * `wallet_status` result. `store` is `keychain`, `file (testnet only,
 * plaintext)` (only with `POLARIS_WALLET_ALLOW_FILE_STORE=1`), or
 * `keychain unavailable` (no seed can be written or read).
 */
export interface WalletStatus {
  signer: "embedded";
  /** The active account, or null when no wallet exists yet. */
  active: { address: string; label: string } | null;
  /** How many accounts the metadata file holds. */
  count: number;
  store: string;
}

/** One account in `wallet_list`; metadata only, never a secret. */
export interface WalletAccount {
  address: string;
  label: string;
  /** Milliseconds since the Unix epoch. */
  createdAt: number;
  active: boolean;
}

/** `wallet_create` result: the address plus the one-time recovery phrase. */
export interface WalletCreateOutcome {
  address: string;
  /** The 24-word BIP-39 phrase; show once, then discard. */
  recoveryPhrase: string;
}

/** `wallet_import_preview`/`wallet_import`/select/rename/remove result. */
export interface WalletAddressOutcome {
  address: string;
}

/** The failure categories the wallet commands reject with. */
export type WalletErrorKind =
  | "exists"
  | "invalid"
  | "notFound"
  | "cancelled"
  | "keychain"
  | "file"
  | "unauthorized"
  // Step W13a: the session is locked, so no secret-touching action is allowed.
  | "locked";

/* ------------------------------------------------------------------ *
 * 7c. Wallet session (step W13a: login / logout / auto-lock)
 * ------------------------------------------------------------------ */

/** `none` = no wallet stored; `locked` = wallets exist, nobody logged in. */
export type WalletSessionState = "none" | "locked" | "unlocked";

/**
 * The wallet session snapshot returned by `wallet_session` and carried on the
 * `wallet_session_changed` event. `active` is `null` unless unlocked.
 */
export interface WalletSession {
  state: WalletSessionState;
  active: { address: string; label: string } | null;
  count: number;
  /** Wall-clock ms when the session was unlocked, or `null`. */
  unlockedAt: number | null;
  /** Idle auto-lock timeout in minutes; `0` means "never". */
  autoLockMinutes: number;
}

/** The typed rejection shape of the wallet commands. */
export interface WalletCommandError {
  kind: WalletErrorKind;
  message: string;
}

/* ------------------------------------------------------------------ *
 * 7d. Autopay executor (step W11a)
 *
 * The on-chain autonomy path: the owner registers a separate executor key, and
 * payments inside the rule are signed by that key with `pay_executor` — no
 * approval card, no Touch ID. Rust decodes the transaction and signs ONLY that
 * one call shape; the `ExecutorSignOutcome` union is the whole contract.
 * ------------------------------------------------------------------ */

/** `executor_status`: whether the active owner has an executor key. */
export interface ExecutorStatus {
  exists: boolean;
  /** The executor's public `G…` address, or null. */
  address: string | null;
  /**
   * Always null from Rust: funding needs a network read, which the Debug check
   * performs over Horizon.
   */
  funded: boolean | null;
}

/** `executor_create` result. The seed never leaves Rust. */
export interface ExecutorAddress {
  address: string;
}

/** Why `executor_sign_pay` refused to sign. */
export type ExecutorSignCode =
  | "locked"
  | "no_executor"
  | "not_pay_executor"
  | "wrong_source"
  | "wrong_contract"
  | "over_hard_cap"
  | "invalid"
  | "error";

/** `executor_sign_pay`'s typed union: a signed XDR, or a coded refusal. */
export type ExecutorSignOutcome =
  | { ok: true; signedXdr: string; txHash: string }
  | { ok: false; code: ExecutorSignCode; message: string };

/* ------------------------------------------------------------------ *
 * 8. Approval gate (step W3)
 *
 * Section 7 is reserved for the chain-configuration types (W1), which append
 * after `AppInfo` too; this section is numbered 8 so the two branches do not
 * collide on merge.
 * ------------------------------------------------------------------ */

/** How an approval is expected to be granted. */
export type ApprovalMode = "touch_id" | "wallet_only";

/** The lifecycle of one approval request; `consumed` is terminal and one-way. */
export type ApprovalState = "pending" | "authorized" | "denied" | "expired" | "consumed";

/**
 * The input to `approval_begin`. `payloadHash` must be the lowercase hex SHA-256
 * of the UTF-8 bytes of `unsignedXdr`; the gate rejects a mismatch.
 */
export interface ApprovalRequestInput {
  /** Assigned by the gate; the webview may omit it. */
  id?: string;
  payloadHash: string;
  /** base64 XDR, unsigned */
  unsignedXdr: string;
  summary: ChainToolResult["summary"];
  intent: Intent;
  /** Defaults to `"touch_id"`. */
  mode?: ApprovalMode;
  /**
   * Reserved for the anchor flow (W5). It is **not** an authorization signal:
   * `approval_begin` rejects `"wallet_only"` unconditionally, and only an
   * in-process Rust API can create such a request.
   */
  origin?: string;
}

/**
 * What `approval_current` returns so a panel that opened *after* the
 * `approval_request` event can hydrate. It deliberately never carries the
 * unsigned XDR.
 */
export interface ApprovalSnapshot {
  id: string;
  payloadHash: string;
  summary: ChainToolResult["summary"];
  intent: Intent;
  mode: ApprovalMode;
  state: ApprovalState;
  expiresAtMs: number;
  /**
   * Step W11a: present only while a **batch** is the current request. It
   * carries step ids, titles and states — never any XDR.
   */
  batch?: ApprovalBatchSnapshot;
}

/** What `approval_status` returns, including why a request was denied. */
export interface ApprovalStatus {
  id: string;
  state: ApprovalState;
  reason?: string;
}

/**
 * The failure categories every approval command rejects with. The approval card
 * branches on `kind`; `message` is human-readable detail. The Rust mirror is
 * `ApprovalErrorKind` in `app/src-tauri/src/approval.rs`.
 */
export type ApprovalErrorKind =
  | "cancelled"
  | "failed"
  | "unavailable"
  | "timeout"
  | "expired"
  | "notPending"
  // Step W13a: the wallet session is locked, so the approval path is refused.
  | "locked";

/**
 * The typed rejection shape of the approval commands. `approval_authorize` and
 * `approval_deny` otherwise resolve to the updated `ApprovalSnapshot`; the
 * command contract is declared in `docs/interfaces.md` §8.
 */
export interface ApprovalCommandError {
  kind: ApprovalErrorKind;
  message: string;
}

/* ------------------------------------------------------------------ *
 * 8b. Approval batch (step W11a)
 *
 * Enabling auto-pay is several transactions (`set_rule` → `set_executor` →
 * `set_alias`…). A batch lets ONE Touch ID authorise them together, while each
 * step keeps its own digest binding and is released once by `wallet_sign(id)`.
 * ------------------------------------------------------------------ */

/** One step of an approval batch: id, title and state only — never any XDR. */
export interface ApprovalBatchStep {
  id: string;
  title: string;
  state: ApprovalState;
}

/** The batch half of an `ApprovalSnapshot`. */
export interface ApprovalBatchSnapshot {
  batchId: string;
  title: string;
  count: number;
  state: ApprovalState;
  steps: ApprovalBatchStep[];
  expiresAtMs: number;
}

/** `approval_begin_batch` result: the batch id and each step's request id. */
export interface ApprovalBatchBegin {
  batchId: string;
  ids: string[];
}

/** `approval_authorize_batch` result: every step id the one prompt authorised. */
export interface ApprovalBatchAuthorized {
  authorized: string[];
}

/* ------------------------------------------------------------------ *
 * 9. Feature health (Debug panel contract)
 * ------------------------------------------------------------------ */

export type HealthStatus = "ok" | "warn" | "fail" | "unknown";

/** One feature's health, rendered directly by the in-app Debug panel. */
export interface FeatureHealth {
  id: string;
  title: string;
  milestone: string;
  status: HealthStatus;
  /** One actionable sentence; never contains secrets. */
  detail: string;
  /** Milliseconds since the Unix epoch. */
  checkedAt: number;
}

/* ------------------------------------------------------------------ *
 * 10. Navigation — read-only, moves no value (NAV)
 *
 * The `navigate` agent tool produces one of these instead of an `Intent`, so
 * the shell can open a notch page or a panel window by voice. It never reaches
 * the approval gate or the chain; `IntentKind` is deliberately unchanged.
 * Unlike `Intent`, this type never crosses the Rust seam, so no Rust mirror is
 * needed.
 * ------------------------------------------------------------------ */

/** Every screen a voice command may open, plus `close`. */
export type NavigationTarget =
  | "wallet"
  | "rules"
  | "tasks"
  | "history"
  | "security"
  | "schedules"
  | "suggestions"
  | "anchor"
  | "p2p"
  | "privacy"
  | "settings"
  | "debug"
  | "close";

/** The accepted `target` values, in the order the tool advertises them. */
export const NAVIGATION_TARGETS: readonly NavigationTarget[] = [
  "wallet",
  "rules",
  "tasks",
  "history",
  "security",
  "schedules",
  "suggestions",
  "anchor",
  "p2p",
  "privacy",
  "settings",
  "debug",
  "close",
];

/** A read-only request from the agent that the shell performs. */
export interface NavigationRequest {
  target: NavigationTarget;
  /** Ready-to-speak confirmation in the user's language; the shell may say it. */
  spoken: string;
  /** BCP-47 base of `spoken` ("tr" | "en"), when the model reported one. */
  language?: string;
}
