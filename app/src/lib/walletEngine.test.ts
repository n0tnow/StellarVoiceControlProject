import assert from "node:assert/strict";
import { test } from "node:test";

import {
  WalletEngineError,
  createWalletEngine,
  isMissingCommandError,
  toWalletEngineError,
  type WalletInvokeFn,
} from "./walletEngine.ts";

interface Call {
  command: string;
  args?: Record<string, unknown>;
}

/** Builds an injected invoke that records calls and replies from a table. */
function spyInvoke(
  replies: Record<string, unknown> = {},
  rejectFor: Record<string, unknown> = {},
): { calls: Call[]; invoke: WalletInvokeFn } {
  const calls: Call[] = [];
  const invoke: WalletInvokeFn = async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    if (command in rejectFor) throw rejectFor[command];
    return command in replies ? replies[command] : undefined;
  };
  return { calls, invoke };
}

test("each method forwards to its fixed camelCase command", async () => {
  const { calls, invoke } = spyInvoke({
    wallet_list: [],
    wallet_create: { address: "GAAA", recoveryPhrase: "w1 w2" },
    wallet_import_preview: { address: "GBBB" },
    wallet_import: { address: "GBBB" },
  });
  const engine = createWalletEngine(invoke);

  await engine.status();
  await engine.list();
  await engine.create({ label: "Main" });
  await engine.importPreview({ secretOrPhrase: "S...", index: 1 });
  await engine.import({ secretOrPhrase: "S...", index: 1 });
  await engine.select("GAAA");
  await engine.rename("GAAA", "Spending");
  await engine.remove("GAAA");

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "wallet_status",
      "wallet_list",
      "wallet_create",
      "wallet_import_preview",
      "wallet_import",
      "wallet_select",
      "wallet_rename",
      "wallet_remove",
    ],
  );
  assert.deepEqual(calls[2]?.args, { label: "Main" });
  assert.deepEqual(calls[3]?.args, { secretOrPhrase: "S...", index: 1 });
  assert.deepEqual(calls[5]?.args, { address: "GAAA" });
  assert.deepEqual(calls[6]?.args, { address: "GAAA", label: "Spending" });
  assert.deepEqual(calls[7]?.args, { address: "GAAA" });
});

test("a structured engine rejection becomes a typed WalletEngineError", async () => {
  const { invoke } = spyInvoke({}, { wallet_create: { kind: "exists", message: "already there" } });
  const engine = createWalletEngine(invoke);
  await assert.rejects(
    () => engine.create(),
    (error: unknown) => {
      assert.ok(error instanceof WalletEngineError);
      assert.equal(error.kind, "exists");
      assert.equal(error.message, "already there");
      return true;
    },
  );
});

test("a missing command is feature-detected instead of throwing", async () => {
  const { invoke } = spyInvoke({}, { wallet_status: new Error("Command wallet_status not found") });
  const engine = createWalletEngine(invoke);
  assert.equal(await engine.available(), false);
  assert.equal(isMissingCommandError(new Error("Command wallet_status not found")), true);
});

test("available() is true when the engine answers", async () => {
  const { invoke } = spyInvoke({ wallet_status: { signer: "embedded", active: null, count: 0, store: "keychain" } });
  assert.equal(await createWalletEngine(invoke).available(), true);
});

test("an unstructured error maps to unknown, a missing command to unavailable", () => {
  assert.equal(toWalletEngineError(new Error("boom")).kind, "unknown");
  assert.equal(toWalletEngineError("Command wallet_list not found").kind, "unavailable");
});
