/**
 * A minimal read-only MCP client (step A9 scaffolding) — Raven and friends.
 *
 * `docs/architecture.md` §4.2 plans a read-only MCP client ("Raven") so the model
 * can answer chain questions from official docs, the ecosystem directory and
 * research. Nothing existed; this is the *transport only*. It is deliberately
 * small and dependency-free (`fetch` + JSON-RPC 2.0 over Streamable HTTP), and it
 * exposes exactly three MCP methods: `initialize`, `tools/list`, `tools/call`.
 *
 * ## Read-only by construction
 *
 * The client cannot move value: it only forwards `tools/call`, and the registry
 * bridge (`bridge.ts`) only ever registers tools that pass a read-only policy.
 * There is no resource/prompt/subscribe surface, and no way to send a notification
 * other than the one protocol-mandated `initialized`.
 *
 * ## Transport notes
 *
 * MCP Streamable HTTP servers answer a POST with either a JSON body or an SSE
 * stream (`text/event-stream`) carrying the JSON-RPC response. Both are handled
 * here, so a real server and the fake one in the tests take the same path. The
 * `mcp-session-id` header returned by `initialize` and the negotiated protocol
 * version are echoed on later requests, as the spec requires.
 */

/** Default protocol version offered during `initialize`. */
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

/** The shape of one tool advertised by `tools/list`. */
export interface McpTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool arguments. */
  inputSchema?: Record<string, unknown>;
  /**
   * MCP tool annotations. `readOnlyHint: true` is the server's own claim that the
   * tool does not modify anything; the registry bridge treats it as necessary but
   * not sufficient (see `bridge.ts`).
   */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

/** One content block returned by `tools/call`. Text is the common case. */
export interface McpContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** The result of `tools/call`. `isError` is a *tool* failure, not a transport one. */
export interface McpToolCallResult {
  content?: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** `initialize` result server info. */
export interface McpServerInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/** A JSON-RPC / protocol error from the server or the transport. */
export class McpError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "McpError";
    this.code = code;
    this.data = data;
  }
}

export interface McpClientOptions {
  /** The server's Streamable HTTP endpoint. */
  url: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Overrides the offered protocol version (tests pin it). */
  protocolVersion?: string;
  /** Advertised client identity. */
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** Pulls the JSON objects out of an SSE body (one `data:` payload per event). */
function parseSse(body: string): JsonRpcResponse[] {
  const messages: JsonRpcResponse[] = [];
  let data = "";
  const flush = (): void => {
    if (data.length === 0) return;
    try {
      messages.push(JSON.parse(data) as JsonRpcResponse);
    } catch {
      // A malformed event is ignored; a missing response is reported by the
      // caller with the method name, which is more useful than a parse error.
    }
    data = "";
  };
  for (const line of body.split(/\r?\n/)) {
    if (line.length === 0) {
      flush();
    } else if (line.startsWith("data:")) {
      data += line.slice(5).trimStart();
    }
  }
  flush();
  return messages;
}

export class McpClient {
  readonly #url: string;
  readonly #fetch: typeof fetch;
  readonly #offeredProtocolVersion: string;
  readonly #clientName: string;
  readonly #clientVersion: string;
  #sessionId: string | null = null;
  #protocolVersion: string | null = null;
  #nextId = 1;

  constructor(options: McpClientOptions) {
    this.#url = options.url;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#offeredProtocolVersion = options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    this.#clientName = options.clientName ?? "polaris";
    this.#clientVersion = options.clientVersion ?? "0.1.0";
  }

  /** The negotiated protocol version, once `initialize` has completed. */
  get protocolVersion(): string | null {
    return this.#protocolVersion;
  }

  /** Handshake; returns the server identity. Safe to call once per client. */
  async initialize(): Promise<McpServerInfo> {
    const result = await this.#request<{
      protocolVersion?: string;
      serverInfo?: McpServerInfo;
    }>("initialize", {
      protocolVersion: this.#offeredProtocolVersion,
      capabilities: {},
      clientInfo: { name: this.#clientName, version: this.#clientVersion },
    });
    this.#protocolVersion = result.protocolVersion ?? this.#offeredProtocolVersion;
    await this.#notify("notifications/initialized");
    return result.serverInfo ?? {};
  }

  /** Every advertised tool, following `nextCursor` pages (bounded). */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const result = await this.#request<{ tools?: McpTool[]; nextCursor?: string }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      tools.push(...(result.tools ?? []));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  /** Calls one tool. A tool-level failure comes back as `isError`, not a throw. */
  async callTool(name: string, args: unknown = {}): Promise<McpToolCallResult> {
    return this.#request<McpToolCallResult>("tools/call", { name, arguments: args });
  }

  async #request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;
    const messages = await this.#send({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    const reply = messages.find((message) => message.id === id);
    if (!reply) {
      throw new McpError(-32000, `MCP server sent no response to "${method}"`);
    }
    if (reply.error) {
      throw new McpError(reply.error.code, reply.error.message, reply.error.data);
    }
    return reply.result as T;
  }

  /** The protocol-mandated `initialized` notification (fire and forget). */
  async #notify(method: string): Promise<void> {
    await this.#send({ jsonrpc: "2.0", method });
  }

  async #send(payload: Record<string, unknown>): Promise<JsonRpcResponse[]> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.#sessionId) headers["mcp-session-id"] = this.#sessionId;
    if (this.#protocolVersion) headers["mcp-protocol-version"] = this.#protocolVersion;

    let response: Response;
    try {
      response = await this.#fetch(this.#url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new McpError(
        -32001,
        `could not reach the MCP server at ${this.#url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const session = response.headers.get("mcp-session-id");
    if (session) this.#sessionId = session;

    // A notification is acknowledged with 202 and no body.
    if (response.status === 202) return [];
    if (!response.ok) {
      throw new McpError(-32000, `MCP server answered HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = await response.text();
    if (body.trim().length === 0) return [];
    if (contentType.includes("text/event-stream")) return parseSse(body);
    try {
      const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new McpError(-32000, "MCP server returned a body that was not JSON");
    }
  }
}
