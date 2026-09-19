/** Offline test kit for the schedule tools: fake RPC, fixtures, XDR decoders. */
import { xdr } from "@stellar/stellar-sdk";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { createGuardClient } from "../../guard/client.ts";
import type { GuardRpcLike, Rule, Schedule } from "../../guard/types.ts";
import {
  ASSET_SAC,
  EXECUTOR,
  FakeGuardRpc,
  GUARD_ID,
  GUARD_ID_2,
  OWNER,
  PAYEE,
  RULE,
  okSim,
  ruleScVal,
  scheduleScVal,
  u32,
} from "../../guard/__tests__/helpers.ts";
import { defaultAssetRegistry } from "../../payments/assets.ts";
import { ScheduleRefusal } from "../errors.ts";
import type { ScheduleDeps } from "../types.ts";

export { ASSET_SAC, EXECUTOR, FakeGuardRpc, GUARD_ID, GUARD_ID_2, OWNER, PAYEE, RULE };
export { okSim, errSim, invokedCall, scAddress, u32 } from "../../guard/__tests__/helpers.ts";

/** A second SAC used as the XLM contract in fixtures. */
export const XLM_SAC = GUARD_ID_2;
/** The address in the alias book. */
export const ADA = PAYEE;

export const NOW = new Date("2026-09-19T12:00:00.000Z");

/** Generous default allowance so happy-path tests clear the mandatory check. */
export const BIG_ALLOWANCE = 9_223_372_036_854_775_807n;

export const ALIASES = {
  ada: { address: ADA, network: "testnet" as const },
};

export function guardClient(rpc: FakeGuardRpc, contractId: string = GUARD_ID) {
  return createGuardClient({
    contractId,
    rpc: rpc as unknown as GuardRpcLike,
    networkPassphrase: TESTNET_PASSPHRASE,
    source: OWNER,
  });
}

export function makeDeps(rpc: FakeGuardRpc, over: Partial<ScheduleDeps> = {}): ScheduleDeps {
  return {
    ownerAddress: OWNER,
    aliases: ALIASES,
    guard: guardClient(rpc),
    assets: defaultAssetRegistry(),
    guardAssetContracts: { USDC: ASSET_SAC, XLM: XLM_SAC },
    networkPassphrase: TESTNET_PASSPHRASE,
    now: () => new Date(NOW),
    getAllowance: async () => BIG_ALLOWANCE,
    ...over,
  };
}

/** The canonical draft: "send 50 USDC to ada tomorrow at 15:00" (Istanbul). */
export function baseDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    recipient: "ada",
    asset: "USDC",
    amount: "50",
    firstRun: { localDate: "2026-09-20", localTime: "15:00", timeZone: "Europe/Istanbul" },
    ...over,
  };
}

/** Epoch seconds for the default draft's first run (2026-09-20T12:00:00Z). */
export const DEFAULT_FIRST_RUN = Math.floor(Date.UTC(2026, 8, 20, 12, 0, 0) / 1000);

export function schedule(over: Partial<Schedule> = {}): Schedule {
  return {
    id: 7,
    owner: OWNER,
    to: PAYEE,
    asset: ASSET_SAC,
    amount: 50_000000n,
    next_run_at: BigInt(DEFAULT_FIRST_RUN),
    interval_secs: 0n,
    runs_left: 1,
    active: true,
    ...over,
  };
}

export function schedulesScVal(list: Schedule[]): xdr.ScVal {
  return xdr.ScVal.scvVec(list.map(scheduleScVal));
}

/**
 * Script the reads a `create_schedule` call performs (rule, active schedules)
 * followed by the write success. `FakeGuardRpc` reuses the last scripted
 * simulation once only one remains, so this is exactly the 3-call sequence.
 */
export function scriptCreate(
  rpc: FakeGuardRpc,
  opts: { rule?: Rule | null; schedules?: Schedule[] } = {},
): void {
  const rule = opts.rule === undefined ? RULE : opts.rule;
  rpc.sims = [
    okSim(rule === null ? xdr.ScVal.scvVoid() : ruleScVal(rule)),
    okSim(schedulesScVal(opts.schedules ?? [])),
    okSim(u32(1)),
  ];
}

/** Script a `list_schedules` read, then a `cancel_schedule` write. */
export function scriptCancel(rpc: FakeGuardRpc, schedules: Schedule[]): void {
  rpc.sims = [okSim(schedulesScVal(schedules)), okSim(xdr.ScVal.scvVoid())];
}

/** Script a single `list_schedules` read (reused for any extra reads). */
export function scriptList(rpc: FakeGuardRpc, schedules: Schedule[]): void {
  rpc.sims = [okSim(schedulesScVal(schedules))];
}

/** Capture a thrown `ScheduleRefusal`, asserting it was the failure mode. */
export async function refusalOf(fn: () => Promise<unknown>): Promise<ScheduleRefusal> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ScheduleRefusal) return e;
    throw e;
  }
  throw new Error("expected a ScheduleRefusal, but the call succeeded");
}

/** Capture a synchronously thrown `ScheduleRefusal`. */
export function syncRefusal(fn: () => unknown): ScheduleRefusal {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScheduleRefusal) return e;
    throw e;
  }
  throw new Error("expected a ScheduleRefusal, but the call succeeded");
}
