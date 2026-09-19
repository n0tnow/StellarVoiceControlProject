/**
 * Offline test kit for the guard client: a scripted fake RPC, deterministic
 * fixtures and XDR decoders. No network, no signing.
 */
import {
  Account,
  Address,
  Networks,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  type Operation,
} from "@stellar/stellar-sdk";
import { createGuardClient, type GuardClientOptions } from "../client.ts";
import type { GuardClient, GuardRpcLike, Rule, Schedule } from "../types.ts";

export const OWNER = "GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E";
export const EXECUTOR = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";
export const PAYEE = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";

/** Synthetic contract ids: distinct, valid, and deliberately not the deployed one. */
export const GUARD_ID = StrKey.encodeContract(new Uint8Array(32).fill(7));
export const GUARD_ID_2 = StrKey.encodeContract(new Uint8Array(32).fill(8));
export const ASSET_SAC = StrKey.encodeContract(new Uint8Array(32).fill(9));

export type Any = Record<string, unknown>;

/** Scripted stand-in for the three RPC methods the guard client uses. */
export class FakeGuardRpc {
  sims: Any[] = [];
  simulated: Transaction[] = [];
  latestLedger = 1000;
  getAccountCalls = 0;

  async getAccount(address: string): Promise<Account> {
    this.getAccountCalls += 1;
    return new Account(address, "100");
  }

  async simulateTransaction(tx: Transaction): Promise<Any> {
    this.simulated.push(tx);
    const scripted = this.sims.length > 1 ? this.sims.shift() : this.sims[0];
    if (!scripted) throw new Error("FakeGuardRpc: no scripted simulation");
    return scripted;
  }

  async getLatestLedger(): Promise<Any> {
    return { sequence: this.latestLedger, id: "ledger", protocolVersion: 23 };
  }
}

export const okSim = (retval: xdr.ScVal, extra: Any = {}): Any => ({
  _parsed: true,
  id: "1",
  latestLedger: 100,
  events: [],
  transactionData: new SorobanDataBuilder().setResourceFee(5000),
  minResourceFee: "5000",
  result: { auth: [], retval },
  ...extra,
});

export const errSim = (error: string): Any => ({ _parsed: true, id: "1", latestLedger: 100, events: [], error });

export const u32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
export const scAddress = (address: string): xdr.ScVal => nativeToScVal(address, { type: "address" });
const i128 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "i128" });
const u64 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "u64" });
const mapEntry = (k: string, v: xdr.ScVal): xdr.ScMapEntry =>
  new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });

export const RULE: Rule = {
  auto_approve_limit: 100_000000n,
  per_tx_limit: 500_000000n,
  daily_limit: 2_000_000000n,
  allowed_assets: [ASSET_SAC],
  known_recipients_only: false,
};

export const SCHEDULE: Schedule = {
  id: 7,
  owner: OWNER,
  to: PAYEE,
  asset: ASSET_SAC,
  amount: 50_000000n,
  next_run_at: 1_789_822_495n,
  interval_secs: 30n,
  runs_left: 2,
  active: true,
};

/**
 * Rule as an ScVal map, exactly as the contract's derived struct spec returns
 * it. Fields are emitted **alphabetically** because `soroban-sdk`'s
 * `derive_struct` sorts them; `nativeToScVal` does the same for a plain object.
 */
export function ruleScVal(rule: Rule): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("allowed_assets", xdr.ScVal.scvVec(rule.allowed_assets.map(scAddress))),
    mapEntry("auto_approve_limit", i128(rule.auto_approve_limit)),
    mapEntry("daily_limit", i128(rule.daily_limit)),
    mapEntry("known_recipients_only", xdr.ScVal.scvBool(rule.known_recipients_only)),
    mapEntry("per_tx_limit", i128(rule.per_tx_limit)),
  ]);
}

/** Schedule as an ScVal map, exactly as the contract's derived struct spec returns it. */
export function scheduleScVal(schedule: Schedule): xdr.ScVal {
  return xdr.ScVal.scvMap([
    mapEntry("active", xdr.ScVal.scvBool(schedule.active)),
    mapEntry("amount", i128(schedule.amount)),
    mapEntry("asset", scAddress(schedule.asset)),
    mapEntry("id", u32(schedule.id)),
    mapEntry("interval_secs", u64(schedule.interval_secs)),
    mapEntry("next_run_at", u64(schedule.next_run_at)),
    mapEntry("owner", scAddress(schedule.owner)),
    mapEntry("runs_left", u32(schedule.runs_left)),
    mapEntry("to", scAddress(schedule.to)),
  ]);
}

export function makeClient(rpc: FakeGuardRpc, over: Partial<GuardClientOptions> = {}): GuardClient {
  return createGuardClient({
    contractId: GUARD_ID,
    rpc: rpc as unknown as GuardRpcLike,
    networkPassphrase: Networks.TESTNET,
    source: OWNER,
    ...over,
  });
}

export interface InvokedCall {
  contractId: string;
  name: string;
  args: xdr.ScVal[];
  tx: Transaction;
}

/** Decode the contract invocation carried by a (single-op) built transaction. */
export function invokedCall(unsignedXdr: string): InvokedCall {
  const tx = TransactionBuilder.fromXDR(unsignedXdr, Networks.TESTNET);
  if (!(tx instanceof Transaction)) throw new Error("expected a Transaction");
  const op = tx.operations[0] as Operation.InvokeHostFunction;
  if (op.func.type !== "hostFunctionTypeInvokeContract") throw new Error("not an invoke-contract call");
  return {
    contractId: Address.fromScAddress(op.func.invokeContract.contractAddress).toString(),
    name: op.func.invokeContract.functionName.toString(),
    args: op.func.invokeContract.args,
    tx,
  };
}
