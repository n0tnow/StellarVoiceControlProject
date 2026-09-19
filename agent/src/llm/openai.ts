/**
 * OpenAI-compatible chat-completions client (step A2).
 *
 * This is the only file that knows how a provider is spoken to. It implements
 * the `AgentLlm` port from `loop.ts`, so the loop, the tools and the UI never
 * depend on a vendor. OpenCode Zen Go, Groq and OpenRouter all expose the same
 * `/chat/completions` shape, so switching is a change of `baseUrl` / `model` /
 * credential — never a rewrite.
 *
 * Two provider quirks are handled here because they were verified against the
 * live endpoint:
 *
 * * OpenCode Zen Go rejects a request without a per-conversation
 *   `x-opencode-session` header (`MissingSessionID`). A stable `ses_<hex>` id is
 *   generated once per client instance and reused for every turn.
 * * It wants a descriptive `User-Agent` rather than a generic SDK default. The
 *   header is only set when the caller supplies one, because browsers silently
 *   drop `User-Agent` (a transport can add it server-side).
 *
 * The client is intentionally written against the global `fetch`, with the
 * implementation injectable (`fetchImpl`) so tests exercise the exact request
 * shape with no network.
 */
import type { AgentLlm, LlmToolCall, LlmTurn } from "../loop.ts";
import type { AgentTool } from "../tools/registry.ts";
import { AgentError } from "../errors.ts";
import { languageFromToolCalls, stripLanguageTag } from "../language.ts";

export interface OpenAiCompatibleOptions {
  /** Provider root, e.g. `https://opencode.ai/zen/go/v1`, or a logical label when a transport ignores it. */
  baseUrl: string;
  /** Model id, e.g. `deepseek-v4.1-flash`. */
  model: string;
  /**
   * Bearer credential. Optional because the credential may be injected by a
   * transport the caller supplies instead (the desktop app's Rust command adds
   * it), so the secret never enters the webview bundle.
   */
  apiKey?: string;
  /** Stable per-conversation id; generated if omitted. */
  sessionId?: string;
  /** Extra headers (e.g. `User-Agent` from the CLI). */
  headers?: Record<string, string>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Hard cap on one model round trip. */
  timeoutMs?: number;
  /** Defaults to 0 — intent extraction wants determinism, not creativity. */
  temperature?: number;
}

/** Provider reply shapes, kept minimal: only the fields this client reads. */
interface ChatToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface ChatMessage {
  role?: string;
  content?: string | null;
  tool_calls?: ChatToolCall[] | null;
}

interface ChatResponse {
  choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DETAIL_CHARS = 400;

/** Stable `ses_<32 hex>` conversation id, mirroring the endpoint's own recipe. */
export function newSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  const hex = random
    ? random.replace(/-/g, "")
    : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `ses_${hex.slice(0, 32)}`;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function truncate(text: string, max = MAX_DETAIL_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

export class OpenAiCompatibleLlm implements AgentLlm {
  readonly model: string;
  readonly baseUrl: string;
  readonly sessionId: string;

  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #temperature: number;

  constructor(options: OpenAiCompatibleOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.model = options.model;
    this.sessionId = options.sessionId ?? newSessionId();
    this.#apiKey = options.apiKey?.trim() ?? "";
    this.#headers = { ...(options.headers ?? {}) };
    // Never store a raw `globalThis.fetch` and invoke it as `this.#fetch(...)`:
    // that makes the client instance the receiver, and WebKit (the Tauri
    // WKWebView) enforces the WebIDL receiver for `Window.fetch`, rejecting the
    // call with `TypeError: Can only call Window.fetch on instances of Window`
    // before any request is made. A plain-call wrapper keeps the receiver off
    // the client and works identically in Node, browsers and the webview.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#temperature = options.temperature ?? 0;
  }

  async turn(input: {
    transcript: string;
    system: string;
    tools: Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
  }): Promise<LlmTurn> {
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.transcript },
      ],
      tools: input.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      })),
      // `auto` is deliberate: an off-topic command must be allowed to produce no
      // tool call. Forcing a tool would turn "bugün hava nasıl" into a bogus intent.
      tool_choice: "auto" as const,
      temperature: this.#temperature,
    };

    const response = await this.#request(body);
    return this.#parse(response);
  }

  async #request(body: unknown): Promise<ChatResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...this.#headers,
      // Always present: the endpoint rejects requests without it.
      "x-opencode-session": this.sessionId,
    };
    if (this.#apiKey) {
      headers.Authorization = `Bearer ${this.#apiKey}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AgentError(
          "network",
          `the model request timed out after ${this.#timeoutMs} ms`,
        );
      }
      throw new AgentError(
        "network",
        `could not reach the model provider at ${this.baseUrl}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();

    if (!response.ok) {
      const detail = this.#errorMessage(raw) ?? truncate(raw);
      if (response.status === 401 || response.status === 403) {
        throw new AgentError("auth", `the provider rejected the credential (HTTP ${response.status}): ${detail}`);
      }
      // The endpoint's session requirement surfaces as a 4xx with this code; a
      // short label here saves a confused debugging session.
      const labelSession = /MissingSessionID/i.test(raw);
      throw new AgentError(
        "http",
        `provider HTTP ${response.status}${labelSession ? " (MissingSessionID)" : ""}: ${detail}`,
      );
    }

    let data: ChatResponse;
    try {
      data = JSON.parse(raw) as ChatResponse;
    } catch {
      throw new AgentError("malformed", `provider returned non-JSON: ${truncate(raw)}`);
    }
    return data;
  }

  #errorMessage(raw: string): string | undefined {
    try {
      const parsed = JSON.parse(raw) as ChatResponse;
      return parsed.error?.message;
    } catch {
      return undefined;
    }
  }

  #parse(data: ChatResponse): LlmTurn {
    const message = data.choices?.[0]?.message;
    if (!message || typeof message !== "object") {
      throw new AgentError("malformed", `provider response had no choices[0].message: ${truncate(JSON.stringify(data))}`);
    }

    const rawText =
      typeof message.content === "string" && message.content.length > 0 ? message.content : undefined;
    const toolCalls = (message.tool_calls ?? []).map((call) => this.#parseToolCall(call));
    // Step A11: the model reports the language either as a `language` field on a
    // tool call's JSON input or as a leading `[xx]` tag on a text answer.
    const { text, language: tagged } = stripLanguageTag(rawText);
    const language = languageFromToolCalls(toolCalls) ?? tagged;
    return {
      ...(text !== undefined && text.length > 0 ? { text } : {}),
      toolCalls,
      ...(language ? { language } : {}),
    };
  }

  #parseToolCall(call: ChatToolCall): LlmToolCall {
    const name = call.function?.name;
    if (!name) {
      throw new AgentError("malformed", "a response tool_call was missing function.name");
    }
    const rawArguments = call.function?.arguments ?? "{}";
    let input: unknown = {};
    if (rawArguments.trim().length > 0) {
      try {
        input = JSON.parse(rawArguments);
      } catch {
        throw new AgentError("malformed", `tool_call ${name} carried arguments that were not valid JSON: ${truncate(rawArguments)}`);
      }
    }
    return { name, input };
  }
}
