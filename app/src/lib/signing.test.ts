import assert from "node:assert/strict";
import { test } from "node:test";

import type { ExecutionOutcome } from "@polaris/agent";
import type { SubmitResult } from "@polaris/stellar";

import {
  explorerTxUrl,
  isBridgeSigned,
  signAndSubmit,
  type BridgeOutcome,
  type SigningDeps,
} from "./signing.ts";
import type { InvokeFn } from "./approval.ts";

const UNSIGNED = "AAAA...unsigned";
const SIGNED = "AAAA...signed";
const TX_HASH = "2f38a676d5ed29dad5043f5f105fe78c7fb355a4dd1bfc56c5e90ae33df33a2a";
const EXPLORER = `https://stellar.expert/explorer/testnet/tx/${TX_HASH}`;

function executed(overrides: Partial<ExecutionOutcome> = {}): ExecutionOutcome {
  return {
    status: "executed",
    intent: { kind: "send", asset: "XLM", amount: "10", recipient: "acc2" },
    result: {
      unsignedXdr: UNSIGNED,
      summary: { title: "Send 10 XLM", lines: ["to acc2"], estimatedFee: "0.00001 XLM" },
    },
    payloadHash: "digest-1",
    approvalId: "apr_1",
    ...overrides,
  };
}

/** A deps set with a scripted signing outcome and a spy on the submit/emit calls. */
function deps(overrides: Partial<SigningDeps> & { bridge?: BridgeOutcome } = {}) {
  const calls = { submit: [] as string[], emitted: [] as { hash: string; url: string }[] };
  const invoke: InvokeFn = async <T>(_command: string, _args?: Record<string, unknown>) =>
    overrides.bridge as T;
  const built: SigningDeps = {
    invoke,
    submit: async (signedXdr) => {
      calls.submit.push(signedXdr);
      return { hash: TX_HASH, explorerUrl: EXPLORER };
    },
    emitSubmitted: (hash, url) => {
      calls.emitted.push({ hash, url });
    },
    ...overrides,
  };
  return { deps: built, calls };
}

const signed: BridgeOutcome = {
  ok: true,
  signedXdr: SIGNED,
  signerAddress: "GOWNER",
  txHash: TX_HASH,
};

test("ok path: sign, submit, emit; the outcome carries the tx hash and link", async () => {
  const { deps: d, calls } = deps({ bridge: signed });
  const outcome = await signAndSubmit(executed(), d);

  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, TX_HASH);
  assert.equal(outcome.explorerUrl, EXPLORER);
  assert.equal(outcome.signerAddress, "GOWNER");
  assert.deepEqual(calls.submit, [SIGNED]);
  assert.deepEqual(calls.emitted, [{ hash: TX_HASH, url: EXPLORER }]);
});

test("a lowercase-normalised hash equality passes", async () => {
  const { deps: d } = deps({
    bridge: { ...signed, txHash: TX_HASH.toUpperCase() },
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, TX_HASH);
});

test("hash mismatch: the network hash not matching Rust's is a labelled failure", async () => {
  const other = "a".repeat(64);
  const { deps: d, calls } = deps({
    bridge: signed,
    submit: async () => ({ hash: other, explorerUrl: `https://x/tx/${other}` }),
  });
  const outcome = await signAndSubmit(executed(), d);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Transaction mismatch");
  assert.match(outcome.detail ?? "", /hashed to/);
  assert.equal(outcome.txHash, undefined);
  assert.deepEqual(calls.emitted, []);
});

test("rejected: the wallet declined and nothing is submitted", async () => {
  const { deps: d, calls } = deps({ bridge: { ok: false, code: "rejected", message: "user said no" } });
  const outcome = await signAndSubmit(executed(), d);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Wallet didn't sign");
  assert.doesNotMatch(outcome.label ?? "", /user said no/);
  assert.deepEqual(calls.submit, []);
});

test("integrity: a signature that did not verify is a labelled failure", async () => {
  const { deps: d } = deps({ bridge: { ok: false, code: "integrity", message: "bad sig" } });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.label, "Signature check failed");
});

test("timeout: the wallet timing out is a labelled failure", async () => {
  const { deps: d } = deps({ bridge: { ok: false, code: "timeout", message: "no signature" } });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.label, "Wallet timed out");
});

test("tx_bad_seq from submission gets a friendly 'expired' label", async () => {
  const { deps: d } = deps({
    bridge: signed,
    submit: async () => {
      throw new Error('Stellar rejected the transaction: {"transaction":"tx_bad_seq"}');
    },
  });
  const outcome = await signAndSubmit(executed(), d);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Transaction expired");
});

test("insufficient balance from submission is labelled 'Not enough balance'", async () => {
  const { deps: d } = deps({
    bridge: signed,
    submit: async () => {
      throw new Error('Stellar rejected the transaction: {"operations":["op_underfunded"]}');
    },
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.label, "Not enough balance");
});

test("a generic submission failure is labelled but never throws", async () => {
  const { deps: d } = deps({
    bridge: signed,
    submit: async () => {
      throw new Error("horizon: 503");
    },
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Submit failed");
  assert.equal(outcome.txHash, undefined);
});

test("a rejected wallet_sign command is a labelled failure", async () => {
  const { deps: d } = deps({
    invoke: async () => {
      throw new Error("gate unreachable");
    },
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Signing error");
});

test("a non-executed outcome passes through unchanged", async () => {
  const rejected: ExecutionOutcome = {
    status: "rejected",
    intent: { kind: "send", asset: "XLM", amount: "10", recipient: "acc2" },
    label: "Not approved",
  };
  const { deps: d, calls } = deps({ bridge: signed });
  const outcome = await signAndSubmit(rejected, d);
  assert.equal(outcome, rejected);
  assert.deepEqual(calls.submit, []);
});

test("an executed outcome without an approvalId is not signed", async () => {
  const { deps: d, calls } = deps({ bridge: signed });
  const outcome = await signAndSubmit(executed({ approvalId: undefined }), d);
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, undefined);
  assert.deepEqual(calls.submit, []);
});

test("a failed tx_submitted emit does not fail a successful submission", async () => {
  const { deps: d } = deps({
    bridge: signed,
    emitSubmitted: () => {
      throw new Error("event bus gone");
    },
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, TX_HASH);
});

test("isBridgeSigned discriminates on the ok field", () => {
  assert.equal(isBridgeSigned(signed), true);
  assert.equal(isBridgeSigned({ ok: false, code: "error", message: "x" }), false);
});

test("isBridgeSigned rejects a malformed success payload (MINOR-1)", () => {
  // `ok: true` without a string `signedXdr`/`txHash` is not a usable signature.
  assert.equal(isBridgeSigned({ ok: true, signerAddress: "G" } as unknown as BridgeOutcome), false);
  assert.equal(
    isBridgeSigned({ ok: true, signedXdr: SIGNED, txHash: 42 } as unknown as BridgeOutcome),
    false,
  );
  assert.equal(isBridgeSigned({ ok: true, signedXdr: SIGNED, signerAddress: "G", txHash: TX_HASH }), true);
});

test("a malformed signing success is a labelled failure, never a throw", async () => {
  const { deps: d, calls } = deps({
    bridge: { ok: true, signerAddress: "G" } as unknown as BridgeOutcome,
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Signing error");
  assert.deepEqual(calls.submit, []);
});

test("an injected explorerTxUrl builds the link when submit omits one", async () => {
  const { deps: d } = deps({
    bridge: signed,
    // The real `SubmitResult` always carries a link; exercise the fallback.
    submit: async () => ({ hash: TX_HASH }) as SubmitResult,
    explorerTxUrl: (hash) => `https://example.test/tx/${hash}`,
  });
  const outcome = await signAndSubmit(executed(), d);
  assert.equal(outcome.explorerUrl, `https://example.test/tx/${TX_HASH}`);
});

test("explorerTxUrl builds the canonical testnet link", () => {
  assert.equal(explorerTxUrl(TX_HASH), EXPLORER);
});
