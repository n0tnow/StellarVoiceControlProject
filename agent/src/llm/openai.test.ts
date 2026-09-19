import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import { newSessionId, OpenAiCompatibleLlm } from "./openai.ts";

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

/** A `fetch` stand-in that records the exact request and returns a canned response. */
function capturing(response: Response): { impl: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const raw = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, init: init ?? {}, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined });
    return response;
  }) as typeof fetch;
  return { impl, calls };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const tools = [
  {
    name: "send_payment",
    description: "Send a Stellar payment.",
    inputSchema: { type: "object", properties: {} },
  },
];

test("sends the OpenAI tool request with the session, bearer and user-agent headers", async () => {
  const { impl, calls } = capturing(
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "send_payment",
                  arguments: '{"amount":"5","asset":"USDC","recipient":"Ahmet"}',
                },
              },
            ],
          },
        },
      ],
    }),
  );

  const llm = new OpenAiCompatibleLlm({
    baseUrl: "https://example.test/v1/",
    model: "deepseek-v4.1-flash",
    apiKey: "secret",
    sessionId: "ses_deadbeef",
    headers: { "User-Agent": "polaris/0.1" },
    fetchImpl: impl,
  });

  const turn = await llm.turn({ transcript: "Ahmete 5 USDC gönder", system: "sys", tools });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, "https://example.test/v1/chat/completions");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("x-opencode-session"), "ses_deadbeef");
  assert.equal(headers.get("authorization"), "Bearer secret");
  assert.equal(headers.get("user-agent"), "polaris/0.1");
  assert.equal(headers.get("content-type"), "application/json");

  assert.equal(call.body?.model, "deepseek-v4.1-flash");
  assert.equal(call.body?.tool_choice, "auto");
  const messages = call.body?.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]?.role, "system");
  assert.equal(messages[0]?.content, "sys");
  assert.equal(messages[1]?.content, "Ahmete 5 USDC gönder");
  const sentTools = call.body?.tools as Array<{ function: { name: string } }>;
  assert.equal(sentTools[0]?.function.name, "send_payment");

  assert.deepEqual(turn.toolCalls, [
    { name: "send_payment", input: { amount: "5", asset: "USDC", recipient: "Ahmet" } },
  ]);
  assert.equal(turn.text, undefined);
});

test("omits Authorization when no key is configured (a transport injects it)", async () => {
  const { impl, calls } = capturing(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });

  await llm.turn({ transcript: "x", system: "s", tools });
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("authorization"), null);
  assert.match(headers.get("x-opencode-session") ?? "", /^ses_[0-9a-f]{32}$/);
});

test("an empty tool list is sent as an empty array, not omitted", async () => {
  const { impl, calls } = capturing(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  await llm.turn({ transcript: "x", system: "s", tools: [] });
  assert.deepEqual(calls[0]!.body?.tools, []);
});

test("maps a 401 to an auth failure", async () => {
  const { impl } = capturing(jsonResponse({ error: { message: "bad key" } }, 401));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", apiKey: "x", fetchImpl: impl });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "auth" && error.label === "Agent auth",
  );
});

test("flags the provider's missing-session requirement in the detail", async () => {
  const { impl } = capturing(jsonResponse({ error: { message: "MissingSessionID" } }, 400));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) =>
      error instanceof AgentError && error.kind === "http" && /MissingSessionID/.test(error.detail),
  );
});

test("maps a non-JSON 2xx body to malformed", async () => {
  const { impl } = capturing(new Response("<html>nope</html>", { status: 200 }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "malformed",
  );
});

test("maps a thrown fetch to a network failure", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) =>
      error instanceof AgentError && error.kind === "network" && /ECONNREFUSED/.test(error.detail),
  );
});

test("the provider fetch is invoked without the client as its receiver (WKWebView)", async () => {
  // Regression for the Polaris A6 bug: storing `globalThis.fetch` in a field and
  // calling `this.#fetch(...)` made the client instance the receiver. WebKit
  // (the Tauri WKWebView) enforces the WebIDL receiver for `Window.fetch` and
  // rejected the call with `TypeError: Can only call Window.fetch on instances
  // of Window` before any request went out. The transport must be a plain call.
  const receivers: unknown[] = [];
  const impl = function (this: unknown) {
    receivers.push(this);
    return Promise.resolve(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
  } as unknown as typeof fetch;
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });

  await llm.turn({ transcript: "x", system: "s", tools });

  assert.equal(receivers.length, 1, "the transport must be called exactly once");
  assert.notEqual(receivers[0], llm, "the client must not be the receiver");
  assert.equal(receivers[0], undefined, "the transport is a plain call, not a method");
});

test("tool_call arguments that are not JSON are malformed", async () => {
  const { impl } = capturing(
    jsonResponse({
      choices: [{ message: { tool_calls: [{ function: { name: "send_payment", arguments: "{oops" } }] } }],
    }),
  );
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "malformed",
  );
});

test("session ids are stable per client and well formed", () => {
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m" });
  assert.match(llm.sessionId, /^ses_[0-9a-f]{32}$/);
  assert.match(newSessionId(), /^ses_[0-9a-f]{32}$/);
});

test("a leading language tag on a text answer is stripped and reported", async () => {
  const { impl } = capturing(
    jsonResponse({ choices: [{ message: { content: "[TR] Hava durumunu bilmiyorum." } }] }),
  );
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  const turn = await llm.turn({ transcript: "bugün hava nasıl", system: "s", tools });
  assert.equal(turn.text, "Hava durumunu bilmiyorum.");
  assert.equal(turn.language, "tr");
});

test("a language field on a tool call is surfaced (step A11)", async () => {
  const { impl } = capturing(
    jsonResponse({
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: "send_payment",
                  arguments: '{"amount":"400","asset":"USD","recipient":"bilal","language":"en"}',
                },
              },
            ],
          },
        },
      ],
    }),
  );
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  const turn = await llm.turn({ transcript: "can you send 400 dollar to bilal", system: "s", tools });
  assert.equal(turn.language, "en");
  assert.deepEqual(turn.toolCalls[0]?.input, {
    amount: "400",
    asset: "USD",
    recipient: "bilal",
    language: "en",
  });
});

test("no language tag means no reported language, and the text is untouched", async () => {
  const { impl } = capturing(jsonResponse({ choices: [{ message: { content: "Just a reply." } }] }));
  const llm = new OpenAiCompatibleLlm({ baseUrl: "/agent-api", model: "m", fetchImpl: impl });
  const turn = await llm.turn({ transcript: "x", system: "s", tools });
  assert.equal(turn.text, "Just a reply.");
  assert.equal(turn.language, undefined);
});
