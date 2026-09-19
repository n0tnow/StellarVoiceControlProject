/**
 * The webview's half of the agent wiring (step A2; transport moved to Rust in A6).
 *
 * The transcript arrives from Rust on the `polaris-event` stream; this module
 * turns it into a structured intent with the same agent core the CLI uses. The
 * only desktop-specific detail is the transport: the webview does **not** call
 * `fetch` against the provider. It invokes the Rust `agent_chat` command
 * (`app/src-tauri/src/agent.rs`), which owns the provider URL and the credential
 * and holds no webview restrictions. The key therefore never enters this bundle,
 * and the same path works in a packaged app — there is no dev-only proxy any more.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  AnthropicLlm,
  createDefaultRegistry,
  createEventBus,
  OpenAiCompatibleLlm,
  runTurn,
  toAgentError,
  type AgentProvider,
} from "@polaris/agent";
import type { AgentStage, Intent } from "@polaris/interfaces";
import { markTurnPhase } from "@/lib/polaris";

/**
 * Logical transport label, only ever used in error copy. The real provider root
 * is read in Rust; the webview never holds it or the credential.
 */
export const AGENT_BASE_URL = "agent+polaris://provider";

/**
 * Which provider the Rust transport should speak to (step A11).
 *
 * Non-secret, so it is bundled from the same `POLARIS_AGENT_PROVIDER` variable
 * the Rust side reads; both sides choosing from one value is what keeps the
 * request body (TS) and the wire headers (Rust) in step.
 */
export const AGENT_PROVIDER: AgentProvider =
  (import.meta.env.POLARIS_AGENT_PROVIDER ?? "").trim().toLowerCase() === "anthropic"
    ? "anthropic"
    : "openai";

/** Model id is safe to bundle (no secret); Rust injects the credential. */
export const AGENT_MODEL =
  import.meta.env.POLARIS_AGENT_MODEL && import.meta.env.POLARIS_AGENT_MODEL.trim().length > 0
    ? import.meta.env.POLARIS_AGENT_MODEL.trim()
    : AGENT_PROVIDER === "anthropic"
      ? "claude-sonnet-5"
      : "glm-5.3-flash";

/** Reply shape of the Rust `agent_chat` command (`AgentHttpResponse`). */
interface AgentHttpResponse {
  status: number;
  body: string;
}

/**
 * The agent's HTTP transport: one `invoke` into Rust. The provider status and
 * raw body come back and are rebuilt into a `Response`, so `OpenAiCompatibleLlm`
 * keeps its exact request/parse/error behaviour unchanged. A transport failure
 * rejects `invoke`, which the client maps to `AgentError("network")`.
 */
async function tauriAgentFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const sessionId = headers["x-opencode-session"] ?? "";
  const body = typeof init?.body === "string" ? init.body : "";
  // A11: the request is fully built (system prompt, tools, transcript) at this
  // instant; Rust records it on the open turn trace before the network call.
  markTurnPhase("agent request built");
  const response = await invoke<AgentHttpResponse>("agent_chat", {
    body,
    sessionId,
    provider: AGENT_PROVIDER,
  });
  return new Response(response.body, {
    status: response.status,
    headers: { "content-type": "application/json" },
  });
}

export interface AgentOutcome {
  transcript: string;
  answer: string;
  intent?: Intent;
  executedTools: string[];
  /** Reconciled BCP-47 language of the turn (steps A11/A12); drives the voice. */
  language?: string;
  /** Which side decided `language`: the model or the audio detector. */
  languageSource?: "stt" | "model";
  /** Measured end-to-end around `runTurn`, mirroring A1's latency line. */
  latencyMs: number;
}

export interface AgentFailure {
  transcript: string;
  /** Short, UI-safe label (e.g. "Net error"). */
  label: string;
  /** Full explanation, for the console only. */
  detail: string;
  latencyMs: number;
}

export type AgentRun =
  | { ok: true; outcome: AgentOutcome }
  | { ok: false; failure: AgentFailure };

const registry = createDefaultRegistry();
const bus = createEventBus();
// The same `AgentLlm` port, two wire formats. The Rust `agent_chat` transport
// is told which provider it is carrying (`AGENT_PROVIDER`) so it can add the
// matching headers — `Authorization` + `x-opencode-session`, or `x-api-key` +
// `anthropic-version`. The credential is injected server-side in both cases, so
// `apiKey` is empty here and no secret ever enters the bundle.
const llm =
  AGENT_PROVIDER === "anthropic"
    ? new AnthropicLlm({
        baseUrl: AGENT_BASE_URL,
        model: AGENT_MODEL,
        apiKey: "",
        fetchImpl: tauriAgentFetch,
      })
    : new OpenAiCompatibleLlm({
        baseUrl: AGENT_BASE_URL,
        model: AGENT_MODEL,
        apiKey: "",
        fetchImpl: tauriAgentFetch,
      });

/** Per-turn observation hooks. Used by the shell to drive the honest stage. */
export interface AgentTurnHooks {
  /**
   * Forwarded from the agent core's `agent_status` events. The shell uses
   * `thinking` to enter its honest "Thinking" stage at the exact moment the
   * transcript is handed to the agent, rather than guessing from capture state.
   */
  onAgentStage?: (stage: AgentStage) => void;
}

/**
 * Runs one transcript through the agent. Never throws: a provider failure comes
 * back as a labelled failure so the UI can stay one line while the console keeps
 * the full detail. An intent is logged with its latency, like A1's transcript.
 *
 * `transcriptLanguage` is the STT-detected language of the audio (step A12). It
 * is passed to the model as a hint and is the fallback reply/voice language; the
 * agent core lets the model's own report win (inverted in A14).
 *
 * The optional `hooks` only observe; they never change the turn's outcome. The
 * subscription is removed in `finally`, so a hook cannot leak across turns.
 */
export async function runAgentTurn(
  transcript: string,
  hooks?: AgentTurnHooks,
  transcriptLanguage?: string,
): Promise<AgentRun> {
  const unsubscribe = hooks?.onAgentStage
    ? bus.subscribe((event) => {
        if (event.type === "agent_status") {
          hooks.onAgentStage?.(event.stage);
        }
      })
    : undefined;
  const started = performance.now();
  try {
    const result = await runTurn({
      transcript,
      registry,
      llm,
      bus,
      ...(transcriptLanguage ? { transcriptLanguage } : {}),
    });
    // A11: the provider response has been parsed into a turn result by now.
    markTurnPhase("intent parsed");
    const latencyMs = Math.round(performance.now() - started);
    if (result.intent) {
      console.info(`intent in ${latencyMs} ms (${result.intentTool ?? "tool"})`, result.intent);
    } else {
      console.info(`no intent in ${latencyMs} ms`);
    }
    return {
      ok: true,
      outcome: {
        transcript,
        answer: result.answer,
        ...(result.intent ? { intent: result.intent } : {}),
        ...(result.language ? { language: result.language } : {}),
        ...(result.languageSource ? { languageSource: result.languageSource } : {}),
        executedTools: result.executedTools,
        latencyMs,
      },
    };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - started);
    const agentError = toAgentError(error);
    console.error(`agent failed in ${latencyMs} ms [${agentError.label}]: ${agentError.detail}`);
    return {
      ok: false,
      failure: { transcript, label: agentError.label, detail: agentError.detail, latencyMs },
    };
  } finally {
    unsubscribe?.();
  }
}
