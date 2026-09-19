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

  constructor(kind: AgentErrorKind, detail: string) {
    super(detail);
    this.name = "AgentError";
    this.kind = kind;
    this.label = AGENT_ERROR_LABELS[kind];
    this.detail = detail;
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
