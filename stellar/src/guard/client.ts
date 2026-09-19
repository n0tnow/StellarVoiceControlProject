/**
 * The owner-side / executor-side `polaris_guard` client.
 *
 * Every state-changing method returns an **unsigned, assembled** invocation
 * (`unsignedXdr`) plus a summary decoded from that exact XDR and the payload
 * hash the shell's Touch ID gate approves. Nothing is signed or submitted
 * here. Read methods simulate and decode the return value.
 *
 * The contract id is a required option — never a constant — so a future
 * `polaris_guard_v2` can run side by side (decision D9).
 */
import { Address, nativeToScVal } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import { buildGuardCallSummary } from "./describe.ts";
import { buildUnsignedInvoke, simulateReadValue, DEFAULT_TX_TIMEOUT_SECONDS } from "./invoke.ts";
import type { GuardCall, GuardClient, GuardRpcLike, Rule, Schedule } from "./types.ts";

export interface GuardClientOptions {
  /** Deployed guard contract id (e.g. from `GUARD_CONTRACT_ID`). Never hard-coded. */
  contractId: string;
  /** Minimal injected RPC (`getAccount` / `simulateTransaction` / `getLatestLedger`). */
  rpc: GuardRpcLike;
  networkPassphrase: string;
  /** Account used to simulate read-only calls (reads require no auth). */
  source: string;
  txTimeoutSeconds?: number;
  explorerBase?: string;
}

const scAddress = (address: string): xdr.ScVal => nativeToScVal(address, { type: "address" });
const scI128 = (amount: bigint): xdr.ScVal => nativeToScVal(amount, { type: "i128" });
const scU32 = (n: number): xdr.ScVal => nativeToScVal(n, { type: "u32" });
const scU64 = (n: bigint): xdr.ScVal => nativeToScVal(n, { type: "u64" });
const scString = (s: string): xdr.ScVal => nativeToScVal(s, { type: "string" });

/**
 * Encode the `Rule` struct exactly as the contract's derived `ScSpecEntry`
 * expects: `scvSymbol` keys, `scvI128` limits, a `Vec<scvAddress>` allowlist
 * and `scvBool`. An untyped `nativeToScVal(rule)` silently produces
 * `scvString` keys / `scvU64` values / `scvString` addresses, which the host
 * rejects on-chain.
 */
const ruleToScVal = (rule: Rule): xdr.ScVal =>
  nativeToScVal(
    { ...rule, allowed_assets: rule.allowed_assets.map((asset) => new Address(asset)) },
    {
      type: {
        auto_approve_limit: ["symbol", "i128"],
        per_tx_limit: ["symbol", "i128"],
        daily_limit: ["symbol", "i128"],
        allowed_assets: ["symbol", "address"],
        known_recipients_only: ["symbol", "bool"],
      },
    },
  );

/** The v0.1 ABI as a class. Construct with `createGuardClient`. */
class SorobanGuardClient implements GuardClient {
  readonly contractId: string;
  private readonly rpc: GuardRpcLike;
  private readonly networkPassphrase: string;
  private readonly source: string;
  private readonly txTimeoutSeconds: number;
  private readonly explorerBase: string | undefined;

  constructor(options: GuardClientOptions) {
    this.contractId = options.contractId;
    this.rpc = options.rpc;
    this.networkPassphrase = options.networkPassphrase;
    this.source = options.source;
    this.txTimeoutSeconds = options.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS;
    this.explorerBase = options.explorerBase;
  }

  // -- internal -------------------------------------------------------------

  /** Build + simulate + assemble an unsigned write, decoded back into a summary. */
  private async write(source: string, method: string, args: xdr.ScVal[]): Promise<GuardCall> {
    const { unsignedXdr } = await buildUnsignedInvoke(this.rpc, {
      contractId: this.contractId,
      method,
      args,
      source,
      networkPassphrase: this.networkPassphrase,
      txTimeoutSeconds: this.txTimeoutSeconds,
    });
    const { summary, payloadHash } = buildGuardCallSummary({
      unsignedXdr,
      networkPassphrase: this.networkPassphrase,
      ...(this.explorerBase ? { explorerBase: this.explorerBase } : {}),
    });
    return { unsignedXdr, summary, payloadHash };
  }

  /** Simulate a read from the configured read source and decode its value. */
  private read(method: string, args: xdr.ScVal[]): Promise<unknown> {
    return simulateReadValue(this.rpc, {
      contractId: this.contractId,
      method,
      args,
      source: this.source,
      networkPassphrase: this.networkPassphrase,
      txTimeoutSeconds: this.txTimeoutSeconds,
    });
  }

  // -- owner: policy --------------------------------------------------------

  setRule(owner: string, rule: Rule): Promise<GuardCall> {
    return this.write(owner, "set_rule", [scAddress(owner), ruleToScVal(rule)]);
  }

  async getRule(owner: string): Promise<Rule | null> {
    const value = await this.read("get_rule", [scAddress(owner)]);
    return value === null || value === undefined ? null : (value as Rule);
  }

  // -- owner: executor ------------------------------------------------------

  setExecutor(owner: string, executor: string): Promise<GuardCall> {
    return this.write(owner, "set_executor", [scAddress(owner), scAddress(executor)]);
  }

  revokeExecutor(owner: string): Promise<GuardCall> {
    return this.write(owner, "revoke_executor", [scAddress(owner)]);
  }

  async getExecutor(owner: string): Promise<string | null> {
    const value = await this.read("get_executor", [scAddress(owner)]);
    return value === null || value === undefined ? null : String(value);
  }

  // -- owner: alias book ----------------------------------------------------

  setAlias(owner: string, alias: string, address: string): Promise<GuardCall> {
    return this.write(owner, "set_alias", [scAddress(owner), scString(alias), scAddress(address)]);
  }

  removeAlias(owner: string, alias: string): Promise<GuardCall> {
    return this.write(owner, "remove_alias", [scAddress(owner), scString(alias)]);
  }

  async getAlias(owner: string, alias: string): Promise<string | null> {
    const value = await this.read("get_alias", [scAddress(owner), scString(alias)]);
    return value === null || value === undefined ? null : String(value);
  }

  async isKnownRecipient(owner: string, to: string): Promise<boolean> {
    return Boolean(await this.read("is_known_recipient", [scAddress(owner), scAddress(to)]));
  }

  // -- payments -------------------------------------------------------------

  payOwner(owner: string, to: string, asset: string, amount: bigint): Promise<GuardCall> {
    return this.write(owner, "pay_owner", [scAddress(owner), scAddress(to), scAddress(asset), scI128(amount)]);
  }

  payExecutor(executor: string, owner: string, to: string, asset: string, amount: bigint): Promise<GuardCall> {
    return this.write(executor, "pay_executor", [
      scAddress(executor),
      scAddress(owner),
      scAddress(to),
      scAddress(asset),
      scI128(amount),
    ]);
  }

  async spentToday(owner: string): Promise<bigint> {
    const value = await this.read("spent_today", [scAddress(owner)]);
    return BigInt(value as bigint);
  }

  // -- schedules ------------------------------------------------------------

  createSchedule(
    owner: string,
    to: string,
    asset: string,
    amount: bigint,
    firstRunAt: bigint,
    intervalSecs: bigint,
    runs: number,
  ): Promise<GuardCall> {
    return this.write(owner, "create_schedule", [
      scAddress(owner),
      scAddress(to),
      scAddress(asset),
      scI128(amount),
      scU64(firstRunAt),
      scU64(intervalSecs),
      scU32(runs),
    ]);
  }

  cancelSchedule(owner: string, id: number): Promise<GuardCall> {
    return this.write(owner, "cancel_schedule", [scAddress(owner), scU32(id)]);
  }

  async getSchedule(id: number): Promise<Schedule | null> {
    const value = await this.read("get_schedule", [scU32(id)]);
    return value === null || value === undefined ? null : (value as Schedule);
  }

  async listSchedules(owner: string): Promise<Schedule[]> {
    const value = await this.read("list_schedules", [scAddress(owner)]);
    return Array.isArray(value) ? (value as Schedule[]) : [];
  }

  async nextScheduleId(): Promise<number> {
    const value = await this.read("next_schedule_id", []);
    return Number(value);
  }
}

/**
 * Build a guard client for one contract id. The id is mandatory: the client
 * never falls back to a deployed constant, so v0.1 and a future v2 can be
 * targeted side by side.
 */
export function createGuardClient(options: GuardClientOptions): GuardClient {
  if (typeof options.contractId !== "string" || options.contractId.length === 0) {
    throw new Error("createGuardClient requires a contractId");
  }
  return new SorobanGuardClient(options);
}
