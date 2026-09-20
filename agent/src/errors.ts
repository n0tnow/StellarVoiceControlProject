/**
 * Agent failures, split exactly the way step A1 split `SttError`: a short,
 * overlay/log-safe [`AgentError.label`] for the UI and a full
 * [`AgentError.detail`] that goes to the console/Rust log.
 *
 * The split is what lets the trace under the notch stay one line while the
 * terminal still carries the provider's actual message (status code, body
 * excerpt, DNS error). Nothing here ever contains an API key — the key is only
 * ever read by the HTTP client, never interpolated into a message.
 */
import type { PendingClarificationDraft } from "./dialog.ts";

export type AgentErrorKind =
  /** Missing/invalid local configuration (base URL, model). */
  | "config"
  /** The provider rejected our credential (HTTP 401/403). */
  | "auth"
  /** DNS, TLS, connection reset, timeout. */
  | "network"
  /** Any other non-2xx status. */
  | "http"
  /** 2xx but the body was not the documented chat-completions shape. */
  | "malformed"
  /** The model asked for a tool that is not in the registry. */
  | "unknown_tool"
  /** The model's tool arguments failed local validation. */
  | "input";

export const AGENT_ERROR_LABELS: Record<AgentErrorKind, string> = {
  config: "Agent config",
  auth: "Agent auth",
  network: "Net error",
  http: "Agent error",
  malformed: "Bad response",
  unknown_tool: "Unknown tool",
  input: "Bad input",
};

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  /** Short, UI-safe label. */
  readonly label: string;
  /** Full, terminal-safe explanation. */
  readonly detail: string;
  /**
   * For an `input` error only (voice-dialog): the slot the tool could not fill.
   * The loop turns it into a short question and remembers it in the dialogue, so
   * the next utterance can complete the request.
   */
  readonly pending?: PendingClarificationDraft;

  constructor(kind: AgentErrorKind, detail: string, pending?: PendingClarificationDraft) {
    super(detail);
    this.name = "AgentError";
    this.kind = kind;
    this.label = AGENT_ERROR_LABELS[kind];
    this.detail = detail;
    if (pending) this.pending = pending;
  }
}

export function isAgentError(value: unknown): value is AgentError {
  return value instanceof AgentError;
}

/** Narrows any thrown value into an `AgentError` so callers can always log a label. */
export function toAgentError(value: unknown): AgentError {
  if (isAgentError(value)) return value;
  return new AgentError("http", value instanceof Error ? value.message : String(value));
}

/**
 * Short, overlay-safe labels for the chain's typed refusal codes (task F4).
 *
 * The codes are `PaymentRefusal.code` values from `@polaris/stellar`, matched
 * structurally: the agent never imports the chain package, so they are plain
 * strings here. Each label is deliberately specific ("I don't know that
 * recipient" rather than "Chain error") so the notch, the spoken line and the
 * terminal all name the real cause. An unknown code keeps the generic fallback.
 */
export const REFUSAL_LABELS: Record<string, string> = {
  not_configured: "Chain not configured",
  invalid_intent: "Bad payment request",
  invalid_amount: "Invalid amount",
  unsupported_asset: "Asset not supported",
  unknown_recipient: "I don't know that recipient",
  mode_not_supported: "Private payments unavailable",
  guarded_route_not_available: "Guarded route unavailable",
  recipient_no_trustline: "Recipient can't hold that asset",
  trustline_check_failed: "Asset check failed",
  account_not_found: "Account not funded",
  guard_rule_missing: "No spending rule",
  guard_limit_exceeded: "Spending limit reached",
  guard_asset_not_allowed: "Asset not allowed",
  guard_client_error: "Guard error",
};

/**
 * The label for a refusal code, or `fallback` when the code is absent/unknown.
 * A malformed chain result or a plain tool error carries no code and must still
 * settle with a label, so the fallback is the existing generic one.
 */
export function refusalLabel(code?: string, fallback = "Chain error"): string {
  if (!code) return fallback;
  return REFUSAL_LABELS[code] ?? fallback;
}
