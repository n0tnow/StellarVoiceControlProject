/**
 * The webview's half of the agent wiring (step A2).
 *
 * The transcript arrives from Rust on the `polaris-event` stream; this module
 * turns it into a structured intent with the same agent core the CLI uses. The
 * only desktop-specific detail is the base URL: the webview calls a same-origin
 * `/agent-api` path, which the Vite dev server proxies to the real provider and
 * where it injects the API key. The credential therefore never enters this
 * bundle, and provider switching stays a `.env` change.
 */
import {
  createDefaultRegistry,
  createEventBus,
  OpenAiCompatibleLlm,
  runTurn,
  toAgentError,
} from "@polaris/agent";
import type { Intent, PolarisEvent } from "@polaris/interfaces";

/** Same-origin path served by the Vite proxy in `app/vite.config.ts`. */
export const AGENT_BASE_URL = "/agent-api";

/** Model id is safe to bundle (no secret); the proxy injects the credential. */
export const AGENT_MODEL =
  import.meta.env.POLARIS_AGENT_MODEL && import.meta.env.POLARIS_AGENT_MODEL.trim().length > 0
    ? import.meta.env.POLARIS_AGENT_MODEL.trim()
    : "deepseek-v4.1-flash";

export interface AgentOutcome {
  transcript: string;
  answer: string;
  intent?: Intent;
  executedTools: string[];
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
const llm = new OpenAiCompatibleLlm({
  baseUrl: AGENT_BASE_URL,
  model: AGENT_MODEL,
  // Empty on purpose: the dev proxy adds `Authorization` server-side.
  apiKey: "",
});

/** Subscribes to the agent's local event stream (status stages for the UI). */
export function subscribeAgentEvents(handler: (event: PolarisEvent) => void): () => void {
  return bus.subscribe(handler);
}

/**
 * Runs one transcript through the agent. Never throws: a provider failure comes
 * back as a labelled failure so the UI can stay one line while the console keeps
 * the full detail. An intent is logged with its latency, like A1's transcript.
 */
export async function runAgentTurn(transcript: string): Promise<AgentRun> {
  const started = performance.now();
  try {
    const result = await runTurn({ transcript, registry, llm, bus });
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
  }
}
