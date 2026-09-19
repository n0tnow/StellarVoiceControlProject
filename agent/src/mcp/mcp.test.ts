import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { test } from "node:test";

import { createToolRegistry } from "../tools/registry.ts";
import {
  McpClient,
  McpError,
  mcpToolName,
  mcpToolReadOnly,
  registerReadOnlyMcpTools,
  type McpTool,
} from "./index.ts";
import { attachMcpToolsFromEnv } from "./index.ts";
import { mcpConfigFromEnv, MCP_ALLOWED_TOOLS_ENV, MCP_SERVER_URL_ENV } from "./config.ts";

/* ------------------------------------------------------------------ *
 * A fake MCP server. Loopback only: the suite never touches a network.
 * ------------------------------------------------------------------ */

interface FakeServer {
  url: string;
  methods: string[];
  toolCalls: Array<{ name: string; args: unknown }>;
  close: () => Promise<void>;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function startFakeMcp(
  tools: McpTool[],
  options: { sse?: boolean } = {},
): Promise<FakeServer> {
  const methods: string[] = [];
  const toolCalls: Array<{ name: string; args: unknown }> = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      const message = JSON.parse(raw) as {
        id?: number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      methods.push(message.method);

      if (message.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }

      let result: unknown;
      if (message.method === "initialize") {
        res.setHeader("mcp-session-id", "fake-session");
        result = {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-raven", version: "1.0.0" },
        };
      } else if (message.method === "tools/list") {
        result = { tools };
      } else if (message.method === "tools/call") {
        const name = message.params?.name ?? "?";
        const args = message.params?.arguments ?? {};
        if (name === "nope") {
          json(res, 200, {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "unknown tool nope" },
          });
          return;
        }
        toolCalls.push({ name, args });
        result = { content: [{ type: "text", text: `called ${name}` }] };
      } else {
        json(res, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unknown method ${message.method}` },
        });
        return;
      }

      const payload = { jsonrpc: "2.0", id: message.id, result };
      if (options.sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      } else {
        json(res, 200, payload);
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the fake MCP server did not bind a TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    methods,
    toolCalls,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const READ_ONLY: McpTool = {
  name: "search_stellar_docs",
  description: "Search the official docs",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  annotations: { readOnlyHint: true },
};

const WRITE: McpTool = {
  name: "send_payment",
  description: "Move USDC",
  annotations: { readOnlyHint: true }, // even a lying annotation must not help
};

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

test("MCP is off unless a usable server URL is configured", () => {
  assert.equal(mcpConfigFromEnv({}), null);
  assert.equal(mcpConfigFromEnv({ [MCP_SERVER_URL_ENV]: "   " }), null);
  assert.equal(mcpConfigFromEnv({ [MCP_SERVER_URL_ENV]: "not a url" }), null);
  // A non-http(s) scheme must never turn into a runtime call.
  assert.equal(mcpConfigFromEnv({ [MCP_SERVER_URL_ENV]: "file:///etc/passwd" }), null);

  const config = mcpConfigFromEnv({
    [MCP_SERVER_URL_ENV]: "https://raven.stellar.org/mcp",
    [MCP_ALLOWED_TOOLS_ENV]: "search, get_project,  ",
  });
  assert.deepEqual(config, {
    serverUrl: "https://raven.stellar.org/mcp",
    allowedTools: ["search", "get_project"],
  });
});

test("attaching with no config is a no-op that makes no request", async () => {
  const registry = createToolRegistry();
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (input, _init) => {
    calls.push(String(input));
    return new Response("{}");
  };

  const registered = await attachMcpToolsFromEnv(registry, {}, { fetchImpl });
  assert.deepEqual(registered, []);
  assert.deepEqual(calls, []);
  assert.equal(registry.size, 0);
});

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

test("the client initializes, lists tools and calls one", async () => {
  const server = await startFakeMcp([READ_ONLY, WRITE]);
  try {
    const client = new McpClient({ url: server.url });
    const info = await client.initialize();
    assert.equal(info.name, "fake-raven");
    assert.equal(client.protocolVersion, "2025-06-18");

    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["search_stellar_docs", "send_payment"],
    );

    const result = await client.callTool("search_stellar_docs", { query: "SEP-6" });
    assert.equal(result.content?.[0]?.text, "called search_stellar_docs");
    assert.deepEqual(server.toolCalls, [
      { name: "search_stellar_docs", args: { query: "SEP-6" } },
    ]);
    // The handshake notification is part of the protocol, not a tool call.
    assert.deepEqual(server.methods, [
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  } finally {
    await server.close();
  }
});

test("the client reads a JSON-RPC error back as an McpError", async () => {
  const server = await startFakeMcp([]);
  try {
    const client = new McpClient({ url: server.url });
    await client.initialize();
    await assert.rejects(
      // A method the fake server does not implement.
      client.callTool("nope"),
      (error: unknown) => error instanceof McpError && error.code === -32601,
    );
  } finally {
    await server.close();
  }
});

test("the client understands an SSE transport as well as plain JSON", async () => {
  const server = await startFakeMcp([READ_ONLY], { sse: true });
  try {
    const client = new McpClient({ url: server.url });
    await client.initialize();
    const tools = await client.listTools();
    assert.equal(tools[0]?.name, "search_stellar_docs");
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ *
 * Read-only policy + registry bridge
 * ------------------------------------------------------------------ */

test("the read-only policy refuses value-moving and non-annotated tools", () => {
  assert.deepEqual(mcpToolReadOnly(READ_ONLY, {}), { ok: true });
  // A write verb is refused even with a readOnlyHint: true.
  assert.equal(mcpToolReadOnly(WRITE, {}).ok, false);
  // An explicitly-writable tool is refused even if allowlisted.
  assert.equal(
    mcpToolReadOnly({ name: "get_thing", annotations: { readOnlyHint: false } }, {
      allowedTools: ["get_thing"],
    }).ok,
    false,
  );
  // No hint at all: refused by default, admitted only by the operator allowlist.
  const bare: McpTool = { name: "get_project" };
  assert.equal(mcpToolReadOnly(bare, {}).ok, false);
  assert.deepEqual(mcpToolReadOnly(bare, { allowedTools: ["get_project"] }), { ok: true });

  // snake_case, kebab-case and camelCase write names are all caught.
  for (const name of ["send_payment", "create-order", "executeSwap", "submitTx"]) {
    assert.equal(mcpToolReadOnly({ name }, { allowedTools: [name] }).ok, false, name);
  }
});

test("the bridge registers only read-only tools, namespaced, as non-approval tools", async () => {
  const server = await startFakeMcp([READ_ONLY, WRITE, { name: "execute" }]);
  try {
    const client = new McpClient({ url: server.url });
    await client.initialize();
    const registry = createToolRegistry();
    const denied: string[] = [];

    const registered = await registerReadOnlyMcpTools(registry, client, {
      onDenied: (tool, reason) => denied.push(`${tool.name}:${reason}`),
    });

    assert.deepEqual(registered, ["mcp_search_stellar_docs"]);
    assert.equal(registry.size, 1);
    // The value-moving tools are unreachable through the registry.
    assert.equal(registry.get("mcp_send_payment"), undefined);
    assert.equal(registry.get("mcp_execute"), undefined);
    assert.ok(denied.some((entry) => entry.startsWith("send_payment:")));
    assert.ok(denied.some((entry) => entry.startsWith("execute:")));

    const tool = registry.get("mcp_search_stellar_docs");
    assert.ok(tool);
    assert.equal(tool.requiresApproval, false, "read-only tools need no approval");

    // The model's call reaches the server through the namespaced name.
    const output = await tool.run({ query: "SEP-10" } as never, {
      transcript: "",
      network: "testnet",
    });
    assert.deepEqual((output as { content: Array<{ text: string }> }).content[0]?.text, "called search_stellar_docs");
    assert.deepEqual(server.toolCalls, [
      { name: "search_stellar_docs", args: { query: "SEP-10" } },
    ]);
  } finally {
    await server.close();
  }
});

test("the bridge never clobbers a local tool with the same name", async () => {
  const server = await startFakeMcp([READ_ONLY]);
  try {
    const client = new McpClient({ url: server.url });
    await client.initialize();
    const registry = createToolRegistry().register({
      name: mcpToolName(READ_ONLY.name),
      description: "a local tool that owns this name",
      inputSchema: { type: "object" },
      async run() {
        return "local";
      },
    });

    const registered = await registerReadOnlyMcpTools(registry, client);
    assert.deepEqual(registered, []);
    assert.equal(registry.get(mcpToolName(READ_ONLY.name))?.description, "a local tool that owns this name");
  } finally {
    await server.close();
  }
});

test("tool names are sanitized into the registry's legal alphabet", () => {
  assert.equal(mcpToolName("search"), "mcp_search");
  assert.equal(mcpToolName("docs.search/v2"), "mcp_docs_search_v2");
  assert.ok(mcpToolName("x".repeat(120)).length <= 64);
});
