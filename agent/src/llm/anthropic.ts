/**
 * Anthropic Messages client (step A11).
 *
 * Anthropic's Messages API is **not** OpenAI-compatible, so this is a second
 * implementation *behind the same `AgentLlm` port* — the loop, the tools and the
 * UI never learn which provider answered, exactly like OpenCode Zen Go / Groq /
 * OpenRouter behind `OpenAiCompatibleLlm`.
 *
 * The wire format below was taken from the Anthropic API reference and pinned by
 * `anthropic.test.ts` (a fake `fetch`, no network):
 *
 * * `POST {base}/v1/messages`, base `https://api.anthropic.com`.
 * * Headers `x-api-key` (NOT a Bearer token), `anthropic-version: 2023-06-01`,
 *   `content-type: application/json`.
 * * `system` is a **top-level** field, not a message; tools use `input_schema`
 *   (not `function.parameters`); `max_tokens` is **required**.
 * * The response `content` is a list of blocks; a tool call is a block with
 *   `type: "tool_use"` carrying `name` and a JSON `input`.
 *
 * Latency is the point of this step, so thinking is off:
 *
 * * **Sonnet 5** takes `thinking: {type: "disabled"}`. `budget_tokens` is *not*
 *   sent — it returns a 400 on Sonnet 5.
 * * **Haiku 4.5** takes no `thinking` field at all (omitting it means no
 *   thinking) and errors on `output_config.effort`, which is never sent.
 *
 * Sampling parameters are never sent (step A13). `temperature`, `top_p` and
 * `top_k` were removed on the current Claude models (Sonnet 5, Opus 5, Opus
 * 4.8/4.7, Fable 5); sending one returns `HTTP 400: temperature is deprecated
 * for this model`. They are still accepted on older models such as Haiku 4.5,
 * but the deterministic-ish intent extraction the product wants does not need
 * them — the model defaults are fine — so the option was deleted rather than
 * left as a trap that only some models reject. The OpenAI-compatible client
 * (`openai.ts`) is unaffected and still sends `temperature`.
 *
 * The client is written against the global `fetch` with the implementation
 * injectable, so it runs unchanged in Node and (through the Rust transport) in
 * the webview.
 */
import type { AgentLlm, LlmToolCall, LlmTurn } from "../loop.ts";
import type { AgentTool } from "../tools/registry.ts";
import { AgentError } from "../errors.ts";
import { languageFromToolCalls, stripLanguageTag } from "../language.ts";

/** Pinned by the API reference; sent on every request. */
export const ANTHROPIC_VERSION = "2023-06-01";

/** Root base URL; the endpoint is `{base}/v1/messages`. */
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** Last-resort default when `POLARIS_AGENT_MODEL` is unset on Anthropic. */
export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";

/** `max_tokens` is required by the Messages API. */
export const DEFAULT_MAX_TOKENS = 1024;

export interface AnthropicOptions {
  /** Provider root, e.g. `https://api.anthropic.com`. */
  baseUrl: string;
  /** Model id, exactly `claude-sonnet-5` or `claude-haiku-4-5` (never dated). */
  model: string;
  /**
   * Anthropic API key. Optional because the desktop app injects it in the Rust
   * transport, so the secret never enters the webview bundle.
   */
  apiKey?: string;
  /** Extra headers (e.g. a User-Agent). */
  headers?: Record<string, string>;
  /** Injected for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Hard cap on one model round trip. */
  timeoutMs?: number;
  /** Response cap; a confirmation is short, so the default is deliberately low. */
  maxTokens?: number;
  /** Extra top-level request fields (tuning / tests). */
  extra?: Record<string, unknown>;
}

/** Response shapes, kept minimal: only the fields this client reads. */
interface AnthropicBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
}

interface AnthropicResponse {
  content?: AnthropicBlock[];
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_DETAIL_CHARS = 400;

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function truncate(text: string, max = MAX_DETAIL_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/**
 * The `thinking` field for a model, or `undefined` to omit it.
 *
 * Only the two supported models are considered: Haiku 4.5 must not receive a
 * `thinking` field, and Sonnet 5 disables it explicitly. Anything else gets the
 * Sonnet treatment (an explicit disable), which is the latency-first default.
 */
export function thinkingFor(model: string): { type: "disabled" } | undefined {
  return /haiku/i.test(model) ? undefined : { type: "disabled" };
}

/** `{base}/v1/messages`, tolerating a base that already ends in `/v1`. */
export function messagesEndpoint(base: string): string {
  const root = trimSlash(base).replace(/\/v1$/, "");
  return `${root}/v1/messages`;
}

export class AnthropicLlm implements AgentLlm {
  readonly model: string;
  readonly baseUrl: string;

  readonly #apiKey: string;
  readonly #headers: Record<string, string>;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #extra: Record<string, unknown>;

  constructor(options: AnthropicOptions) {
    this.baseUrl = trimSlash(options.baseUrl);
    this.model = options.model;
    this.#apiKey = options.apiKey?.trim() ?? "";
    this.#headers = { ...(options.headers ?? {}) };
    // Plain-call wrapper: storing `globalThis.fetch` and invoking it as a method
    // makes the client the receiver, which WebKit (the Tauri WKWebView) rejects.
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#fetch = (input, init) => fetchImpl(input, init);
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.#extra = { ...(options.extra ?? {}) };
  }

  async turn(input: {
    transcript: string;
    system: string;
    tools: Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
  }): Promise<LlmTurn> {
    const thinking = thinkingFor(this.model);
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.#maxTokens,
      system: input.system,
      messages: [{ role: "user", content: input.transcript }],
      tools: input.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      // `auto` keeps an off-topic command free to call no tool.
      tool_choice: { type: "auto" },
      // No sampling parameters (temperature/top_p/top_k): the current models
      // reject them with HTTP 400. See the header note.
      ...(thinking ? { thinking } : {}),
      ...this.#extra,
    };

    const response = await this.#request(body);
    return this.#parse(response);
  }

  async #request(body: unknown): Promise<AnthropicResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
      ...this.#headers,
    };
    // Anthropic authenticates with `x-api-key`, never a Bearer token. When the
    // key is absent the transport adds it server-side.
    if (this.#apiKey) {
      headers["x-api-key"] = this.#apiKey;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(messagesEndpoint(this.baseUrl), {
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
        throw new AgentError(
          "auth",
          `the provider rejected the credential (HTTP ${response.status}): ${detail}`,
        );
      }
      throw new AgentError("http", `provider HTTP ${response.status}: ${detail}`);
    }

    let data: AnthropicResponse;
    try {
      data = JSON.parse(raw) as AnthropicResponse;
    } catch {
      throw new AgentError("malformed", `provider returned non-JSON: ${truncate(raw)}`);
    }
    return data;
  }

  #errorMessage(raw: string): string | undefined {
    try {
      const parsed = JSON.parse(raw) as AnthropicResponse;
      return parsed.error?.message;
    } catch {
      return undefined;
    }
  }

  #parse(data: AnthropicResponse): LlmTurn {
    const blocks = data.content;
    if (!Array.isArray(blocks)) {
      throw new AgentError(
        "malformed",
        `provider response had no content blocks: ${truncate(JSON.stringify(data))}`,
      );
    }

    const rawText = blocks
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .join("")
      .trim();
    const toolCalls = blocks
      .filter((block) => block.type === "tool_use")
      .map((block) => this.#parseToolCall(block));

    const { text, language: tagged } = stripLanguageTag(rawText.length > 0 ? rawText : undefined);
    const language = languageFromToolCalls(toolCalls) ?? tagged;
    return {
      ...(text !== undefined && text.length > 0 ? { text } : {}),
      toolCalls,
      ...(language ? { language } : {}),
    };
  }

  #parseToolCall(block: AnthropicBlock): LlmToolCall {
    const name = block.name;
    if (!name) {
      throw new AgentError("malformed", "a response tool_use block was missing name");
    }
    let input: unknown = {};
    const raw = block.input;
    if (typeof raw === "string") {
      // Some gateways re-serialise the input; it is always JSON, never matched
      // as a string.
      if (raw.trim().length > 0) {
        try {
          input = JSON.parse(raw);
        } catch {
          throw new AgentError(
            "malformed",
            `tool_use ${name} carried input that was not valid JSON: ${truncate(raw)}`,
          );
        }
      }
    } else if (raw !== undefined && raw !== null) {
      input = raw;
    }
    return { name, input };
  }
}
