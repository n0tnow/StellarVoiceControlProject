import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Account,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanChain, type RpcLike } from "./chain.ts";

const kp = Keypair.random(); // ephemeral: nothing secret is ever committed
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 7));

type Any = Record<string, unknown>;

const okSim = (retval: xdr.ScVal, extra: Any = {}): Any => ({
  _parsed: true,
  id: "1",
  latestLedger: 100,
  events: [],
  transactionData: new SorobanDataBuilder().setResourceFee(5000),
  minResourceFee: "5000",
  result: { auth: [], retval },
  ...extra,
});
const errSim = (error: string): Any => ({ _parsed: true, id: "1", latestLedger: 100, events: [], error });

/** Scripted stand-in for the four RPC methods the chain adapter uses. */
class FakeRpc {
  sims: Any[] = [];
  simulated: Transaction[] = [];
  sent: Transaction[] = [];
  sendResponses: Array<Any | Error> = [];
  txResponses: Array<Any | Error> = [];
  getAccountCalls = 0;

  async getAccount(addr: string): Promise<Account> {
    this.getAccountCalls += 1;
    return new Account(addr, "100");
  }
  async simulateTransaction(tx: Transaction): Promise<Any> {
    this.simulated.push(tx);
    const s = this.sims.length > 1 ? this.sims.shift() : this.sims[0];
    assert.ok(s, "no scripted simulation");
    return s;
  }
  async sendTransaction(tx: Transaction): Promise<Any> {
    this.sent.push(tx);
    const r = this.sendResponses.length > 1 ? this.sendResponses.shift() : this.sendResponses[0];
    if (r instanceof Error) throw r;
    return r ?? { status: "PENDING", hash: "unused" };
  }
  async getTransaction(_hash: string): Promise<Any> {
    const r = this.txResponses.length > 1 ? this.txResponses.shift() : this.txResponses[0];
    if (r instanceof Error) throw r;
    return r ?? { status: "NOT_FOUND" };
  }
}

function setup(over: { maxFeeStroops?: number; now?: () => number } = {}) {
  const rpc = new FakeRpc();
  const clock = { t: Math.floor(Date.now() / 1000) * 1000 };
  const chain = new SorobanChain(rpc as unknown as RpcLike, {
    contractId: CONTRACT,
    keypair: kp,
    networkPassphrase: Networks.TESTNET,
    txTimeoutSeconds: 30,
    maxFeeStroops: over.maxFeeStroops ?? 5_000_000,
    pollIntervalMs: 1000,
    now: over.now ?? (() => clock.t),
    sleep: async (ms) => {
      clock.t += ms;
    },
  });
  return { rpc, chain, clock };
}

const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const vecOf = (ids: number[]): xdr.ScVal => xdr.ScVal.scvVec(ids.map(u32));
const ok = (ledger = 55): Any => ({ status: "SUCCESS", ledger });

test("listDue decodes the u32 vec returned by simulating list_due", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(vecOf([4, 9]))];
  assert.deepEqual(await chain.listDue(0, 10), { ids: [4, 9], nextCursor: null });
  // The read-only call is only simulated, never sent.
  assert.equal(rpc.sent.length, 0);
});

test("listDue surfaces a failing simulation as an error (so the loop backs off)", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [errSim("HostError: Error(Contract, #1)")];
  await assert.rejects(chain.listDue(0, 10), /list_due simulation failed/);
});

test("execute: simulate -> assemble -> sign -> send -> poll to SUCCESS", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "ignored" }];
  rpc.txResponses = [{ status: "NOT_FOUND" }, { status: "NOT_FOUND" }, ok(77)];

  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "success");
  assert.equal(res.kind === "success" && res.ledger, 77);

  assert.equal(rpc.sent.length, 1);
  const tx = rpc.sent[0]!;
  assert.equal(tx.signatures.length, 1, "keeper signs as tx source");
  assert.equal(Number(tx.fee), 100 + 5000, "fee = base fee + simulated resource fee");
  const op = tx.operations[0] as unknown as { type: string };
  assert.equal(op.type, "invokeHostFunction");
  assert.equal(res.kind === "success" && res.hash, Buffer.from(tx.hash()).toString("hex"));
});

test("execute: a contract error at simulation is classified and nothing is sent", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [errSim("HostError: Error(Contract, #42)\n\nEvent log")];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "rejected");
  assert.equal(res.kind === "rejected" && res.error.kind, "unknown_contract");
  assert.equal(res.kind === "rejected" && res.error.code, 42);
  assert.equal(rpc.sent.length, 0);
});

test("dry-run simulates but never signs or submits", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  const res = await chain.execute(3, { dryRun: true });
  assert.equal(res.kind, "dry_run");
  assert.equal(rpc.simulated.length, 1);
  assert.equal(rpc.sent.length, 0);
});

test("refuses when the contract needs a signature from someone other than the keeper", async () => {
  const { rpc, chain } = setup();
  const foreign = { credentials: { type: "sorobanCredentialsAddress" } };
  rpc.sims = [okSim(xdr.ScVal.scvVoid(), { result: { auth: [foreign], retval: xdr.ScVal.scvVoid() } })];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind === "rejected" && res.error.kind, "auth_required");
  assert.equal(rpc.sent.length, 0);
});

test("refuses to sign above the fee cap", async () => {
  const { rpc, chain } = setup({ maxFeeStroops: 1000 });
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind === "rejected" && res.error.name, "FeeAboveCap");
  assert.equal(rpc.sent.length, 0);
});

test("network-level ERROR (bad sequence) is classified for retry", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "ERROR", hash: "h", errorResult: { result: { type: "txBadSeq" } } }];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind === "rejected" && res.error.kind, "bad_seq");
});

test("TRY_AGAIN_LATER is transient, not a schedule problem", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "TRY_AGAIN_LATER", hash: "h" }];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind === "rejected" && res.error.kind, "rpc");
});

test("sequence numbers come fresh from the network for every attempt", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [ok()];
  await chain.execute(1, { dryRun: false });
  await chain.execute(2, { dryRun: false });
  assert.equal(rpc.getAccountCalls, 2);
  // Both transactions use sequence 101 (account was 100 each time), not a locally incremented counter.
  assert.equal(rpc.sent[0]!.sequence, "101");
  assert.equal(rpc.sent[1]!.sequence, "101");
});

test("a send call that fails ambiguously returns pending with the locally computed hash", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [new Error("socket hang up")];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "pending");
  assert.equal(res.kind === "pending" && res.hash, Buffer.from(rpc.sent[0]!.hash()).toString("hex"));
});

test("a polling error after submission does not lose the hash", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [new Error("rpc 502")];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "pending");
});

test("NOT_FOUND past the validity window (+slack) is a definitive tx_expired", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [{ status: "NOT_FOUND" }];
  const res = await chain.execute(3, { dryRun: false }); // fake sleep advances the clock
  assert.equal(res.kind === "rejected" && res.error.kind, "tx_expired");
});

test("an on-chain FAILED result is reported as failed with a decoded code", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [
    {
      status: "FAILED",
      resultXdr: {
        result: { type: "txFailed", results: [{ tr: { invokeHostFunctionResult: { type: "invokeHostFunctionTrapped" } } }] },
      },
    },
  ];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "failed");
  assert.equal(res.kind === "failed" && res.error.name, "invokeHostFunctionTrapped");
});

test("archived entries: restore first, then re-simulate and execute", async () => {
  const { rpc, chain } = setup();
  const restoreSim = okSim(xdr.ScVal.scvVoid(), {
    restorePreamble: { minResourceFee: "900", transactionData: new SorobanDataBuilder().setResourceFee(900) },
  });
  rpc.sims = [restoreSim, okSim(xdr.ScVal.scvVoid())];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [ok(10)];

  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "success");
  assert.equal(rpc.sent.length, 2, "one RestoreFootprint tx, then the execute tx");
  assert.equal((rpc.sent[0]!.operations[0] as unknown as { type: string }).type, "restoreFootprint");
  assert.equal((rpc.sent[1]!.operations[0] as unknown as { type: string }).type, "invokeHostFunction");
  assert.equal(rpc.simulated.length, 2);
  assert.equal(Number(rpc.sent[0]!.fee), 100 + 900, "restore fee = base fee + resource fee, counted once");
});

test("dry-run over archived entries reports the restore without spending anything", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [
    okSim(xdr.ScVal.scvVoid(), { restorePreamble: { minResourceFee: "900", transactionData: new SorobanDataBuilder() } }),
  ];
  const res = await chain.execute(3, { dryRun: true });
  assert.equal(res.kind, "dry_run");
  assert.equal(rpc.sent.length, 0);
});

test("checkPending resolves an earlier submission by hash", async () => {
  const { rpc, chain, clock } = setup();
  rpc.txResponses = [ok(12)];
  const res = await chain.checkPending("abc", clock.t + 30_000);
  assert.equal(res.kind === "success" && res.ledger, 12);
});
