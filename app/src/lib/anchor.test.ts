import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Account,
  Asset,
  Operation,
  TimeoutInfinite,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { TESTNET } from "@polaris/stellar";
import type { ChainToolResult } from "@polaris/interfaces";

import {
  AnchorSigningUnavailableError,
  anchorTxHash,
  classifyAnchorTx,
  createAnchorSigner,
  defaultSignViaPipeline,
  isMissingCommandError,
  runAnchorIntent,
  type AnchorFlowSession,
  type AnchorPipelineDeps,
} from "./anchor.ts";
import type { BridgeOutcome } from "./signing.ts";

const OWNER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNED = "SIGNED-ENVELOPE";

/** Builds an envelope with the given integer sequence (builder emits sequence + 1). */
function xdrWithSequence(sequence: string, op: (b: TransactionBuilder) => void): string {
  const builder = new TransactionBuilder(new Account(OWNER, sequence), {
    fee: "100",
    networkPassphrase: TESTNET.networkPassphrase,
  });
  op(builder);
  return builder.setTimeout(TimeoutInfinite).build().toXDR();
}

/** A sequence-0 login challenge (builder at -1 emits 0). */
function challengeXdr(): string {
  return xdrWithSequence("-1", (b) => {
    b.addOperation(Operation.manageData({ name: "home.test auth", value: "nonce" }));
  });
}

/** A non-zero payment (builder at 1 emits 2). */
function paymentXdr(): string {
  return xdrWithSequence("1", (b) => {
    b.addOperation(Operation.payment({ destination: OWNER, asset: Asset.native(), amount: "1" }));
  });
}

/** A non-zero changeTrust (builder at 1 emits 2). */
function trustlineXdr(): string {
  return xdrWithSequence("1", (b) => {
    b.addOperation(Operation.changeTrust({ asset: new Asset("USDC", OWNER) }));
  });
}

function signedOk(): BridgeOutcome {
  return { ok: true, signedXdr: SIGNED, signerAddress: OWNER, txHash: "a".repeat(64) };
}

/** A `ChainToolResult` over a real envelope, so `runTx` can hash it. */
function anchorResult(xdr: string): ChainToolResult {
  return { unsignedXdr: xdr, summary: { title: "anchor tx", lines: [], estimatedFee: "0.1 XLM" } };
}

/** Real-pipeline test seams: an auto-approving gate and a signer that returns `signedXdr`. */
function pipeline(signedXdr: string, overrides: Partial<AnchorPipelineDeps> = {}): AnchorPipelineDeps {
  return {
    approver: {
      async approve() {
        return { approved: true, approvalId: "apr_1" };
      },
    },
    invoke: async <T,>(_command: string, _args?: Record<string, unknown>) =>
      ({ ok: true, signedXdr, signerAddress: OWNER, txHash: anchorTxHash(signedXdr) }) as T,
    now: () => 1,
    ...overrides,
  };
}

test("classifyAnchorTx flags a sequence-0 challenge and never builds a summary from it", () => {
  const facts = classifyAnchorTx(challengeXdr());
  assert.equal(facts.isChallenge, true);
  assert.equal(facts.intent.kind, "raw_tx");
});

test("classifyAnchorTx reads a payment as a withdraw intent with a decoded summary", () => {
  const facts = classifyAnchorTx(paymentXdr());
  assert.equal(facts.isChallenge, false);
  assert.equal(facts.intent.kind, "withdraw");
  // The SDK normalises the operation amount to its 7-decimal form.
  assert.equal(Number(facts.intent.amount), 1);
  assert.match(facts.summary.lines.join(" "), /Pay 1\.0+ XLM/);
});

test("createAnchorSigner routes a sequence-0 challenge to the wallet-only signer", async () => {
  const seen: string[] = [];
  const signer = createAnchorSigner({
    owner: async () => OWNER,
    signChallenge: async (xdr) => {
      seen.push(xdr);
      return signedOk();
    },
    signViaPipeline: async () => assert.fail("the pipeline must not run for a challenge"),
  });
  assert.equal(await signer.publicKey(), OWNER);
  assert.equal(await signer.signTransaction(challengeXdr(), { networkPassphrase: TESTNET.networkPassphrase }), SIGNED);
  assert.equal(seen.length, 1);
});

test("createAnchorSigner routes a normal payment through the real Touch ID pipeline (B1)", async () => {
  const xdr = paymentXdr();
  const signer = createAnchorSigner({
    owner: async () => OWNER,
    signChallenge: async () => assert.fail("the challenge signer must not run"),
    pipeline: pipeline(xdr),
  });
  assert.equal(
    await signer.signTransaction(xdr, { networkPassphrase: TESTNET.networkPassphrase }),
    xdr,
  );
});

test("a wallet refusal on the challenge is a labelled error, never an unsigned envelope", async () => {
  const signer = createAnchorSigner({
    owner: async () => OWNER,
    signChallenge: async () => ({ ok: false, code: "rejected", message: "user cancelled" }),
    signViaPipeline: async () => assert.fail("the pipeline must not run"),
  });
  await assert.rejects(
    () => signer.signTransaction(challengeXdr(), { networkPassphrase: TESTNET.networkPassphrase }),
    /did not sign the anchor login challenge/,
  );
});

test("a missing wallet_sign_challenge command surfaces as AnchorSigningUnavailableError", async () => {
  const signer = createAnchorSigner({
    owner: async () => OWNER,
    signChallenge: async () => {
      throw new AnchorSigningUnavailableError("wallet_sign_challenge is not present on this build yet");
    },
    signViaPipeline: async () => assert.fail("the pipeline must not run"),
  });
  await assert.rejects(
    () => signer.signTransaction(challengeXdr(), { networkPassphrase: TESTNET.networkPassphrase }),
    AnchorSigningUnavailableError,
  );
});

test("isMissingCommandError only matches the missing-command shape", () => {
  assert.equal(isMissingCommandError("Command wallet_sign_challenge not found"), true);
  assert.equal(isMissingCommandError(new Error("unknown command wallet_sign_challenge")), true);
  assert.equal(isMissingCommandError(new Error("no such command wallet_sign_challenge")), true);
  assert.equal(isMissingCommandError(new Error("wallet_sign_challenge: key not found")), false);
  assert.equal(isMissingCommandError(new Error("network request failed")), false);
});

test("B1: the real pipeline captures and returns the signed trustline XDR", async () => {
  const xdr = trustlineXdr();
  const returned = await defaultSignViaPipeline(
    anchorResult(xdr),
    { intent: { kind: "deposit", asset: "USDC", amount: "0" }, label: "trustline" },
    TESTNET.networkPassphrase,
    pipeline(xdr),
  );
  assert.equal(returned, xdr);
});

test("B1: the real pipeline captures and returns the signed withdrawal payment XDR", async () => {
  const xdr = paymentXdr();
  const returned = await defaultSignViaPipeline(
    anchorResult(xdr),
    { intent: { kind: "withdraw", asset: "USDC", amount: "1" }, label: "payment" },
    TESTNET.networkPassphrase,
    pipeline(xdr),
  );
  assert.equal(returned, xdr);
});

test("B1: a denied anchor step throws a labelled error", async () => {
  const xdr = paymentXdr();
  await assert.rejects(
    () =>
      defaultSignViaPipeline(
        anchorResult(xdr),
        { intent: { kind: "withdraw", asset: "USDC", amount: "1" }, label: "payment" },
        TESTNET.networkPassphrase,
        pipeline(xdr, {
          approver: {
            async approve() {
              return { approved: false, reason: "user said no" };
            },
          },
        }),
      ),
    /user said no/,
  );
});

test("B1: a wallet refusal throws a labelled error", async () => {
  const xdr = paymentXdr();
  await assert.rejects(
    () =>
      defaultSignViaPipeline(
        anchorResult(xdr),
        { intent: { kind: "withdraw", asset: "USDC", amount: "1" }, label: "payment" },
        TESTNET.networkPassphrase,
        pipeline(xdr, {
          invoke: async <T,>() => ({ ok: false, code: "rejected", message: "the wallet declined" }) as T,
        }),
      ),
    /the wallet declined/,
  );
});

test("B1: a run that reports submitted without a signed envelope throws", async () => {
  const xdr = paymentXdr();
  await assert.rejects(
    () =>
      defaultSignViaPipeline(
        anchorResult(xdr),
        { intent: { kind: "withdraw", asset: "USDC", amount: "1" }, label: "payment" },
        TESTNET.networkPassphrase,
        pipeline(xdr, {
          sign: async (outcome) => ({
            ...outcome,
            txHash: "a".repeat(64),
            explorerUrl: `https://stellar.expert/explorer/testnet/tx/${"a".repeat(64)}`,
          }),
        }),
      ),
    /no signed envelope was produced/,
  );
});

/** A fake session recording the step order the voice anchor flow drives. */
function flowSession(calls: string[], overrides: Partial<AnchorFlowSession> = {}): AnchorFlowSession {
  return {
    async discover() {
      calls.push("discover");
    },
    async login() {
      calls.push("login");
    },
    async prepareAccount() {
      calls.push("prepareAccount");
    },
    async startDeposit(amount) {
      calls.push(`startDeposit:${amount}`);
    },
    async startWithdraw(amount) {
      calls.push(`startWithdraw:${amount}`);
    },
    async payWithdrawal(amount) {
      calls.push(`payWithdrawal:${amount}`);
      return { data: { hash: "h".repeat(64), explorerUrl: "https://x" } };
    },
    ...overrides,
  };
}

test("runAnchorIntent drives auth → prepare → start → pay for a withdrawal", async () => {
  const calls: string[] = [];
  const outcome = await runAnchorIntent(
    { kind: "withdraw", asset: "USDC", amount: "5" },
    { session: flowSession(calls) },
  );
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, "h".repeat(64));
  assert.deepEqual(calls, ["discover", "login", "prepareAccount", "startWithdraw:5", "payWithdrawal:5"]);
});

test("runAnchorIntent stops a deposit at the anchor's bank instructions", async () => {
  const calls: string[] = [];
  const outcome = await runAnchorIntent(
    { kind: "deposit", asset: "TRY", amount: "50" },
    { session: flowSession(calls) },
  );
  assert.equal(outcome.status, "executed");
  assert.equal(outcome.txHash, undefined);
  assert.deepEqual(calls, ["discover", "login", "prepareAccount", "startDeposit:50"]);
});

test("runAnchorIntent maps a missing login command to a labelled failure", async () => {
  const calls: string[] = [];
  const outcome = await runAnchorIntent(
    { kind: "deposit", asset: "TRY", amount: "50" },
    {
      session: flowSession(calls, {
        async login() {
          throw new AnchorSigningUnavailableError("wallet_sign_challenge is not present on this build yet");
        },
      }),
    },
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.label, "Anchor login unavailable");
});
