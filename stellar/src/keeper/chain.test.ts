import assert from "node:assert/strict";
import { test } from "node:test";
import {
  Account,
  Address,
  Keypair,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  nativeToScVal,
  scValToNative,
  xdr,
  type Operation,
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

/** Simulation response for the paginated `list_due(cursor, limit) -> (Vec<u32>, u32)`. */
const pageSim = (ids: number[], nextCursor: number): Any =>
  okSim(xdr.ScVal.scvVec([vecOf(ids), u32(nextCursor)]));

/** Decode the contract invocation carried by a (single-op) built transaction. */
function invokedCall(tx: Transaction): { name: string; args: xdr.ScVal[] } {
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  assert.equal(op.func.type, "hostFunctionTypeInvokeContract");
  if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not an invoke");
  return {
    name: op.func.invokeContract.functionName.toString(),
    args: op.func.invokeContract.args,
  };
}

test("listDue calls list_due(cursor, limit) and decodes the (Vec<u32>, u32) tuple", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [pageSim([4, 9], 0)];
  assert.deepEqual(await chain.listDue(0, 10), { ids: [4, 9], nextCursor: null });
  const call = invokedCall(rpc.simulated[0]!);
  assert.equal(call.name, "list_due");
  assert.deepEqual(call.args.map((a) => scValToNative(a)), [0, 10], "cursor is passed, not just the limit");
  // The read-only call is only simulated, never sent.
  assert.equal(rpc.sent.length, 0);
});

test("listDue follows a mid-list cursor; only the contract's 0 ends the scan", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [pageSim([3], 8)];
  assert.deepEqual(await chain.listDue(4, 5), { ids: [3], nextCursor: 8 });
  assert.deepEqual(invokedCall(rpc.simulated[0]!).args.map((a) => scValToNative(a)), [4, 5]);
});

test("a full sweep walks pages until the contract returns cursor 0", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [pageSim([1, 2], 4), pageSim([5], 0)];
  assert.deepEqual(await chain.listDue(0, 2), { ids: [1, 2], nextCursor: 4 });
  assert.deepEqual(await chain.listDue(4, 2), { ids: [5], nextCursor: null });
});

test("listDue surfaces a failing simulation as an error (so the loop backs off)", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [errSim("HostError: Error(Contract, #1)")];
  await assert.rejects(chain.listDue(0, 10), /list_due simulation failed/);
});

test("getSchedule: None (void) decodes to null", async () => {
  const { rpc, chain } = setup();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  assert.equal(await chain.getSchedule(42), null);
});

test("getSchedule: Some(Schedule) decodes to a record with bigint amount/time fields", async () => {
  const { rpc, chain } = setup();
  const owner = Keypair.random().publicKey();
  const to = Keypair.random().publicKey();
  const asset = StrKey.encodeContract(Buffer.alloc(32, 9));
  const entry = (k: string, v: xdr.ScVal): xdr.ScMapEntry =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  const address = (pk: string): xdr.ScVal => xdr.ScVal.scvAddress(Address.fromString(pk).toScAddress());
  rpc.sims = [
    okSim(
      xdr.ScVal.scvMap([
        entry("id", u32(7)),
        entry("owner", address(owner)),
        entry("to", address(to)),
        entry("asset", address(asset)),
        entry("amount", nativeToScVal(50_000000n, { type: "i128" })),
        entry("next_run_at", nativeToScVal(1_789_822_495n, { type: "u64" })),
        entry("interval_secs", nativeToScVal(30n, { type: "u64" })),
        entry("runs_left", u32(2)),
        entry("active", xdr.ScVal.scvBool(true)),
      ]),
    ),
  ];
  const s = await chain.getSchedule(7);
  assert.ok(s);
  assert.equal(s.id, 7);
  assert.equal(s.owner, owner);
  assert.equal(s.to, to);
  assert.equal(s.asset, asset);
  assert.equal(s.amount, 50_000000n);
  assert.equal(typeof s.amount, "bigint");
  assert.equal(s.next_run_at, 1_789_822_495n);
  assert.equal(typeof s.next_run_at, "bigint");
  assert.equal(s.interval_secs, 30n);
  assert.equal(typeof s.interval_secs, "bigint");
  assert.equal(s.runs_left, 2);
  assert.equal(s.active, true);
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

test("refuses to sign a restore above the fee cap (the RPC-supplied resource fee is untrusted)", async () => {
  const { rpc, chain } = setup({ maxFeeStroops: 900 });
  const restoreSim = okSim(xdr.ScVal.scvVoid(), {
    restorePreamble: { minResourceFee: "900", transactionData: new SorobanDataBuilder().setResourceFee(900) },
  });
  rpc.sims = [restoreSim];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind === "rejected" && res.error.kind, "keeper_funds");
  assert.equal(res.kind === "rejected" && res.error.name, "FeeAboveCap");
  assert.equal(rpc.sent.length, 0, "nothing was signed or submitted");
});

test("a restore at exactly the cap is still allowed", async () => {
  const { rpc, chain } = setup({ maxFeeStroops: 1000 });
  const restoreSim = okSim(xdr.ScVal.scvVoid(), {
    restorePreamble: { minResourceFee: "900", transactionData: new SorobanDataBuilder().setResourceFee(900) },
  });
  rpc.sims = [restoreSim, okSim(xdr.ScVal.scvVoid(), { transactionData: new SorobanDataBuilder().setResourceFee(900) })];
  rpc.sendResponses = [{ status: "PENDING", hash: "h" }];
  rpc.txResponses = [ok(11)];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "success");
  assert.equal(rpc.sent.length, 2);
});

test("an unresolved restore is reported as restore_pending, not as a pending execution", async () => {
  const { rpc, chain } = setup();
  const restoreSim = okSim(xdr.ScVal.scvVoid(), {
    restorePreamble: { minResourceFee: "900", transactionData: new SorobanDataBuilder().setResourceFee(900) },
  });
  rpc.sims = [restoreSim];
  rpc.sendResponses = [new Error("socket hang up")];
  const res = await chain.execute(3, { dryRun: false });
  assert.equal(res.kind, "restore_pending");
  assert.equal(res.kind === "restore_pending" && res.hash, Buffer.from(rpc.sent[0]!.hash()).toString("hex"));
  assert.equal(rpc.sent.length, 1, "only the restore was submitted; execute_schedule never ran");
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
