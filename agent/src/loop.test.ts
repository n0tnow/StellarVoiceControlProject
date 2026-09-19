import assert from "node:assert/strict";
import { test } from "node:test";

import type { PolarisEvent } from "@polaris/interfaces";

import { AgentError } from "./errors.ts";
import { createEventBus } from "./events.ts";
import { runTurn, type AgentLlm, type LlmTurn } from "./loop.ts";
import { createDefaultRegistry } from "./runtime.ts";
import { noopTool } from "./tools/noop.ts";
import { sendPaymentTool } from "./tools/payment.ts";
import { createToolRegistry } from "./tools/registry.ts";

/** Deterministic provider: returns the same scripted turn, with no network. */
class ScriptedLlm implements AgentLlm {
  readonly model = "scripted";
  readonly #turn: LlmTurn;

  constructor(turn: LlmTurn) {
    this.#turn = turn;
  }

  async turn(): Promise<LlmTurn> {
    return this.#turn;
  }
}

function harness(turn: LlmTurn, transcript: string) {
  const bus = createEventBus();
  const events: PolarisEvent[] = [];
  bus.subscribe((event) => events.push(event));
  return {
    events,
    run: () =>
      runTurn({
        transcript,
        registry: createDefaultRegistry(),
        llm: new ScriptedLlm(turn),
        bus,
      }),
  };
}

test("a send_payment tool call becomes a validated Intent and is never executed", async () => {
  const transcript = "Ahmete 5 USDC gönder";
  const { run, events } = harness(
    {
      toolCalls: [
        { name: "send_payment", input: { amount: "5", asset: "USDC", recipient: "Ahmet" } },
      ],
    },
    transcript,
  );

  const result = await run();
  assert.deepEqual(result.intent, {
    kind: "send",
    asset: "USDC",
    amount: "5",
    recipient: "Ahmet",
    source: transcript,
  });
  assert.equal(result.intentTool, "send_payment");
  assert.deepEqual(result.executedTools, []);
  assert.match(result.answer, /Send 5 USDC to Ahmet/);
  assert.ok(
    events.some((event) => event.type === "agent_status" && event.stage === "awaiting_approval"),
    "the loop must announce that approval is required",
  );
});

test("an unrelated command yields no tool call and no intent", async () => {
  const { run } = harness({ text: "Hava durumunu bilmiyorum.", toolCalls: [] }, "bugün hava nasıl");
  const result = await run();
  assert.equal(result.intent, undefined);
  assert.equal(result.answer, "Hava durumunu bilmiyorum.");
  assert.deepEqual(result.executedTools, []);
});

test("a bogus tool call becomes a clarification, not an intent", async () => {
  const { run } = harness(
    { toolCalls: [{ name: "send_payment", input: { amount: "abc", asset: "USDC", recipient: "Ahmet" } }] },
    "Ahmete biraz USDC gönder",
  );
  const result = await run();
  assert.equal(result.intent, undefined);
  assert.match(result.answer, /couldn't turn that into a payment/i);
});

test("more than one action at once is refused", async () => {
  const { run } = harness(
    {
      toolCalls: [
        { name: "send_payment", input: { amount: "5", asset: "USDC", recipient: "Ahmet" } },
        { name: "send_payment", input: { amount: "6", asset: "USDC", recipient: "Ada" } },
      ],
    },
    "Ahmete 5 ve Ada'ya 6 USDC gönder",
  );
  const result = await run();
  assert.equal(result.intent, undefined);
  assert.match(result.answer, /one action at a time/i);
});

test("a non-approval tool still runs and feeds the round trip", async () => {
  // `noop` is not in the production registry any more (step A5 trimmed the demo
  // probe out of every request); the loop's non-approval path is still real, so
  // register it here explicitly.
  const bus = createEventBus();
  const registry = createToolRegistry().register(sendPaymentTool).register(noopTool);
  const result = await runTurn({
    transcript: "please run the noop tool",
    registry,
    llm: new ScriptedLlm({ text: "calling noop", toolCalls: [{ name: "noop", input: { echo: "hello" } }] }),
    bus,
  });
  assert.deepEqual(result.executedTools, ["noop"]);
  assert.equal(result.intent, undefined);
  assert.match(result.answer, /noop -> /);
});

test("an unknown tool is a programming error, not an intent", async () => {
  const { run } = harness({ toolCalls: [{ name: "does_not_exist", input: {} }] }, "do something");
  await assert.rejects(run(), (error: unknown) => error instanceof AgentError && error.kind === "unknown_tool");
});

test("the model-reported language flows into the turn result (step A11)", async () => {
  const { run } = harness(
    { text: "Yes, I can hear you.", toolCalls: [], language: "en" },
    "hello can you hear me",
  );
  const result = await run();
  assert.equal(result.language, "en");
});

test("a language reported for the tool call flows into the turn result", async () => {
  // The provider clients already lift `language` off the tool input and into
  // `LlmTurn.language` (covered in `llm/anthropic.test.ts` and
  // `llm/openai.test.ts`); the loop forwards it verbatim.
  const { run } = harness(
    {
      language: "en",
      toolCalls: [
        { name: "send_payment", input: { amount: "400", asset: "USD", recipient: "bilal" } },
      ],
    },
    "can you send 400 dollar to bilal",
  );
  const result = await run();
  assert.equal(result.language, "en");
  assert.equal(result.intent?.recipient, "bilal");
  // The language is metadata, not part of the intent.
  assert.equal((result.intent as unknown as { language?: string }).language, undefined);
});

test("no reported language leaves the field absent rather than guessing", async () => {
  const { run } = harness({ text: "ok", toolCalls: [] }, "hello");
  const result = await run();
  assert.equal(result.language, undefined);
});

test("a provider failure propagates and emits an error event", async () => {
  const bus = createEventBus();
  const events: PolarisEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const failing: AgentLlm = {
    model: "failing",
    async turn() {
      throw new AgentError("network", "simulated outage");
    },
  };

  await assert.rejects(
    runTurn({ transcript: "hi", registry: createDefaultRegistry(), llm: failing, bus }),
    (error: unknown) => error instanceof AgentError && error.kind === "network",
  );
  assert.ok(events.some((event) => event.type === "error"));
  // Step A6: a failed turn must still settle its stage, or the notch/trace is
  // left stuck on "thinking".
  const stages = events.flatMap((event) =>
    event.type === "agent_status" ? [event.stage] : [],
  );
  assert.deepEqual(stages, ["thinking", "done"]);
});
