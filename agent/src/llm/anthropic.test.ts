import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import {
  AnthropicLlm,
  ANTHROPIC_VERSION,
  messagesEndpoint,
  thinkingFor,
} from "./anthropic.ts";

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
    calls.push({
      url,
      init: init ?? {},
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined,
    });
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

test("sends the Anthropic Messages request with x-api-key and anthropic-version", async () => {
  const { impl, calls } = capturing(
    jsonResponse({
      content: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "send_payment",
          input: { amount: "5", asset: "USDC", recipient: "Ahmet", language: "tr" },
        },
      ],
      stop_reason: "tool_use",
    }),
  );

  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com/",
    model: "claude-sonnet-5",
    apiKey: "sk-ant-secret",
    fetchImpl: impl,
  });

  const turn = await llm.turn({ transcript: "Ahmete 5 USDC gönder", system: "sys", tools });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  // The Messages endpoint is NOT `/chat/completions`.
  assert.equal(call.url, "https://api.anthropic.com/v1/messages");
  const headers = new Headers(call.init.headers);
  assert.equal(headers.get("x-api-key"), "sk-ant-secret");
  assert.equal(headers.get("anthropic-version"), ANTHROPIC_VERSION);
  assert.equal(headers.get("content-type"), "application/json");
  // Anthropic must never receive the OpenAI-compatible headers.
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-opencode-session"), null);

  // `system` is a top-level field, not a message.
  assert.equal(call.body?.system, "sys");
  assert.equal(call.body?.model, "claude-sonnet-5");
  assert.equal(call.body?.max_tokens, 1024);
  const messages = call.body?.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages, [{ role: "user", content: "Ahmete 5 USDC gönder" }]);
  const sentTools = call.body?.tools as Array<Record<string, unknown>>;
  assert.equal(sentTools[0]?.name, "send_payment");
  // Tools use `input_schema`, not `function.parameters`.
  assert.deepEqual(sentTools[0]?.input_schema, tools[0]!.inputSchema);
  assert.equal((sentTools[0] as { function?: unknown }).function, undefined);
  assert.deepEqual(call.body?.tool_choice, { type: "auto" });

  assert.deepEqual(turn.toolCalls, [
    {
      name: "send_payment",
      input: { amount: "5", asset: "USDC", recipient: "Ahmet", language: "tr" },
    },
  ]);
  // The language on the tool input is surfaced for the TTS voice.
  assert.equal(turn.language, "tr");
});

test("Sonnet disables thinking; budget_tokens is never sent", async () => {
  const { impl, calls } = capturing(jsonResponse({ content: [{ type: "text", text: "[en] ok" }] }));
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });

  await llm.turn({ transcript: "hi", system: "s", tools });

  assert.deepEqual(calls[0]!.body?.thinking, { type: "disabled" });
  // `budget_tokens` returns a 400 on Sonnet 5.
  assert.equal(
    (calls[0]!.body?.thinking as { budget_tokens?: unknown }).budget_tokens,
    undefined,
  );
});

test("Haiku omits thinking entirely and never sends output_config.effort", async () => {
  const { impl, calls } = capturing(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5",
    fetchImpl: impl,
  });

  await llm.turn({ transcript: "hi", system: "s", tools });

  assert.equal("thinking" in (calls[0]!.body ?? {}), false);
  assert.equal("output_config" in (calls[0]!.body ?? {}), false);
});

test("never sends a sampling parameter, for any model (step A13)", async () => {
  // The current Claude models (Sonnet 5, Opus 5, Opus 4.8/4.7, Fable 5) reject
  // `temperature`/`top_p`/`top_k` with HTTP 400. Haiku 4.5 would accept them,
  // but the client must not send them anywhere — checked on the serialised body.
  for (const model of ["claude-sonnet-5", "claude-haiku-4-5"]) {
    const { impl, calls } = capturing(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
    const llm = new AnthropicLlm({
      baseUrl: "https://api.anthropic.com",
      model,
      fetchImpl: impl,
    });

    await llm.turn({ transcript: "hi", system: "s", tools });

    const body = calls[0]!.body ?? {};
    for (const key of ["temperature", "top_p", "top_k"]) {
      assert.equal(key in body, false, `${model} must not send ${key}`);
    }
    const serialised = JSON.stringify(body);
    for (const key of ["temperature", "top_p", "top_k"]) {
      assert.equal(serialised.includes(`"${key}"`), false, `${model} serialised body must not contain ${key}`);
    }
  }
});

test("maps the response blocks: text is joined and a [xx] tag is stripped", async () => {
  const { impl } = capturing(
    jsonResponse({
      content: [
        { type: "text", text: "[en] Yes, " },
        { type: "text", text: "I can hear you." },
      ],
      stop_reason: "end_turn",
    }),
  );
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-haiku-4-5",
    fetchImpl: impl,
  });

  const turn = await llm.turn({ transcript: "hello", system: "s", tools });
  assert.equal(turn.text, "Yes, I can hear you.");
  assert.equal(turn.language, "en");
  assert.deepEqual(turn.toolCalls, []);
});

test("a tool_use input arriving as a JSON string is parsed, never string-matched", async () => {
  const { impl } = capturing(
    jsonResponse({
      content: [
        {
          type: "tool_use",
          name: "send_payment",
          input: '{"amount":"5","asset":"USDC","recipient":"Ahmet"}',
        },
      ],
    }),
  );
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });

  const turn = await llm.turn({ transcript: "x", system: "s", tools });
  assert.deepEqual(turn.toolCalls, [
    { name: "send_payment", input: { amount: "5", asset: "USDC", recipient: "Ahmet" } },
  ]);
});

test("an invalid JSON string input is malformed, not a crash", async () => {
  const { impl } = capturing(
    jsonResponse({
      content: [{ type: "tool_use", name: "send_payment", input: "{oops" }],
    }),
  );
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "malformed",
  );
});

test("omits x-api-key when no key is configured (the Rust transport injects it)", async () => {
  const { impl, calls } = capturing(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });
  await llm.turn({ transcript: "x", system: "s", tools });
  const headers = new Headers(calls[0]!.init.headers);
  assert.equal(headers.get("x-api-key"), null);
  // `anthropic-version` is still required on every request.
  assert.equal(headers.get("anthropic-version"), ANTHROPIC_VERSION);
});

test("maps a 401 to an auth failure", async () => {
  const { impl } = capturing(jsonResponse({ error: { type: "authentication_error", message: "bad key" } }, 401));
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    apiKey: "x",
    fetchImpl: impl,
  });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "auth",
  );
});

test("maps a non-JSON 2xx body to malformed", async () => {
  const { impl } = capturing(new Response("<html>nope</html>", { status: 200 }));
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) => error instanceof AgentError && error.kind === "malformed",
  );
});

test("maps a thrown fetch to a network failure", async () => {
  const impl = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });
  await assert.rejects(
    llm.turn({ transcript: "x", system: "s", tools }),
    (error: unknown) =>
      error instanceof AgentError && error.kind === "network" && /ECONNREFUSED/.test(error.detail),
  );
});

test("the provider fetch is invoked without the client as its receiver (WKWebView)", async () => {
  const receivers: unknown[] = [];
  const impl = function (this: unknown) {
    receivers.push(this);
    return Promise.resolve(jsonResponse({ content: [{ type: "text", text: "ok" }] }));
  } as unknown as typeof fetch;
  const llm = new AnthropicLlm({
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    fetchImpl: impl,
  });

  await llm.turn({ transcript: "x", system: "s", tools });

  assert.equal(receivers.length, 1);
  assert.notEqual(receivers[0], llm);
  assert.equal(receivers[0], undefined);
});

test("the endpoint tolerates a trailing slash and a base that already ends in /v1", () => {
  assert.equal(messagesEndpoint("https://api.anthropic.com"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesEndpoint("https://api.anthropic.com/"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesEndpoint("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
  assert.equal(messagesEndpoint("https://proxy.test/api/v1/"), "https://proxy.test/api/v1/messages");
});

test("thinking is disabled for Sonnet and omitted for Haiku", () => {
  assert.deepEqual(thinkingFor("claude-sonnet-5"), { type: "disabled" });
  assert.equal(thinkingFor("claude-haiku-4-5"), undefined);
  assert.equal(thinkingFor("CLAUDE-HAIKU-4-5"), undefined);
});
