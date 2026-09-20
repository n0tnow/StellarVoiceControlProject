import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clarificationSentence,
  DialogMemory,
  DIALOG_TTL_MS,
  isCancelUtterance,
  MAX_EXCHANGES,
} from "./dialog.ts";
import { createEventBus } from "./events.ts";
import { runTurn, type AgentLlm, type LlmTurn } from "./loop.ts";
import { createToolRegistry } from "./tools/registry.ts";
import { sellAssetTool } from "./tools/sell.ts";

/** Deterministic provider: returns a scripted turn, no network. */
class ScriptedLlm implements AgentLlm {
  readonly model = "scripted";
  readonly #turns: LlmTurn[];
  #index = 0;
  /** The system prompt of the last call, so the test can inspect the context. */
  lastSystem = "";

  constructor(turns: LlmTurn[]) {
    this.#turns = turns;
  }

  async turn(input: { system: string }): Promise<LlmTurn> {
    this.lastSystem = input.system;
    const turn = this.#turns[this.#index] ?? { text: "(no script)", toolCalls: [] };
    this.#index += 1;
    return turn;
  }
}

test("a fresh dialogue contributes no context block", () => {
  const dialog = new DialogMemory();
  assert.equal(dialog.contextBlock(), "");
  assert.equal(dialog.isEmpty, true);
});

test("exchanges are kept most-recent-last and capped at MAX_EXCHANGES pairs", () => {
  const dialog = new DialogMemory();
  for (let i = 0; i < MAX_EXCHANGES + 3; i += 1) {
    dialog.recordUser(`u${i}`);
    dialog.recordAssistant(`a${i}`);
  }
  const block = dialog.contextBlock();
  assert.match(block, /user: u5/);
  assert.doesNotMatch(block, /user: u2\b/);
});

test("a pending clarification expires after the TTL and is dropped on read", () => {
  const dialog = new DialogMemory();
  const now = 1_000_000;
  dialog.setPending(
    { kind: "sell", filledSlots: { asset: "USDC" }, missing: ["route"], question: "sell_route" },
    now,
  );
  assert.ok(dialog.pending(now + DIALOG_TTL_MS - 1));
  assert.equal(dialog.pending(now + DIALOG_TTL_MS), null);
});

test("reset clears both the exchanges and the pending clarification", () => {
  const dialog = new DialogMemory();
  dialog.recordUser("sell my USDC");
  dialog.setPending(
    { kind: "sell", filledSlots: { asset: "USDC" }, missing: ["route"], question: "sell_route" },
    0,
  );
  dialog.reset();
  assert.equal(dialog.isEmpty, true);
  assert.equal(dialog.pending(0), null);
});

test("cancel words are recognised in Turkish and English, diacritics or not", () => {
  for (const text of ["cancel", "iptal", "vazgeç", "vazgec", "never mind", "Never mind!", "boşver"]) {
    assert.equal(isCancelUtterance(text), true, text);
  }
  assert.equal(isCancelUtterance("sell my USDC"), false);
});

test("clarification questions are localized", () => {
  assert.equal(clarificationSentence("sell_route", "en"), "Via the bank (anchor) or peer-to-peer?");
  assert.match(clarificationSentence("sell_route", "tr"), /anchor/);
  assert.match(clarificationSentence("rule_asset", "tr"), /USDC/);
});

test("a tool's pending slot is stored and the next turn sees it (loop integration)", async () => {
  const dialog = new DialogMemory();
  const registry = createToolRegistry().register(sellAssetTool);
  const llm = new ScriptedLlm([
    // Turn 1: asset+amount, no route -> the tool arms a pending clarification.
    { toolCalls: [{ name: "sell_asset", input: { asset: "USDC", amount: "all" } }] },
    // Turn 2: the follow-up answers the route, but still no price.
    { toolCalls: [{ name: "sell_asset", input: { asset: "USDC", amount: "all", route: "p2p" } }] },
  ]);

  const first = await runTurn({
    transcript: "sell my USDC",
    registry,
    llm,
    bus: createEventBus(),
    dialog,
  });
  assert.equal(first.intent, undefined);
  assert.equal(first.answer, "Via the bank (anchor) or peer-to-peer?");
  const pending = dialog.pending();
  assert.deepEqual(pending?.missing, ["route"]);
  assert.deepEqual(pending?.filledSlots, { asset: "USDC", amount: "all" });

  const second = await runTurn({
    transcript: "peer to peer",
    registry,
    llm,
    bus: createEventBus(),
    dialog,
  });
  // The model saw the pending clarification in its system prompt.
  assert.match(llm.lastSystem, /Pending clarification: the last request was a "sell"/);
  assert.equal(second.answer, "What price in TRY?");
  assert.deepEqual(dialog.pending()?.missing, ["priceTry"]);
});

test("an explicit cancel resets the dialogue", async () => {
  const dialog = new DialogMemory();
  const registry = createToolRegistry().register(sellAssetTool);
  const llm = new ScriptedLlm([{ text: "Okay.", toolCalls: [] }]);
  dialog.setPending(
    { kind: "sell", filledSlots: { asset: "USDC" }, missing: ["route"], question: "sell_route" },
    0,
  );
  await runTurn({ transcript: "iptal", registry, llm, bus: createEventBus(), dialog });
  assert.equal(dialog.isEmpty, true);
});
