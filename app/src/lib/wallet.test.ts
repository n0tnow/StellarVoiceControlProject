import assert from "node:assert/strict";
import { test } from "node:test";

import type { InvokeFn } from "./approval.ts";
import {
  isWalletCommandError,
  walletCreate,
  walletErrorKind,
  walletImport,
  walletImportPreview,
  walletRemove,
  walletRename,
  walletSelect,
  walletStatus,
} from "./wallet.ts";

interface Call {
  command: string;
  args?: Record<string, unknown>;
}

function recorder(): { invoke: InvokeFn; calls: Call[] } {
  const calls: Call[] = [];
  const invoke: InvokeFn = async (command, args) => {
    calls.push({ command, args });
    return undefined as never;
  };
  return { invoke, calls };
}

test("the wallet wrappers name the fixed commands and pass camelCase args", async () => {
  const { invoke, calls } = recorder();
  const deps = { invoke };
  await walletStatus(deps);
  await walletCreate("Main", deps);
  await walletImportPreview("word ".repeat(12).trim(), 1, deps);
  await walletImport("S-secret", { index: 2, label: "Imported" }, deps);
  await walletSelect("GADDR", deps);
  await walletRename("GADDR", "Savings", deps);
  await walletRemove("GADDR", deps);

  assert.deepEqual(
    calls.map((call) => call.command),
    [
      "wallet_status",
      "wallet_create",
      "wallet_import_preview",
      "wallet_import",
      "wallet_select",
      "wallet_rename",
      "wallet_remove",
    ],
  );
  assert.deepEqual(calls[1]!.args, { label: "Main" });
  assert.deepEqual(calls[3]!.args, {
    secretOrPhrase: "S-secret",
    index: 2,
    label: "Imported",
  });
  assert.deepEqual(calls[5]!.args, { address: "GADDR", label: "Savings" });
});

test("a typed wallet rejection is recognised by its kind", () => {
  assert.equal(isWalletCommandError({ kind: "exists", message: "one already" }), true);
  assert.equal(isWalletCommandError(new Error("boom")), false);
  assert.equal(walletErrorKind({ kind: "cancelled", message: "x" }), "cancelled");
  assert.equal(walletErrorKind(new Error("boom")), "unknown");
});
