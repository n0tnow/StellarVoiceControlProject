/**
 * Shared wiring for the live scenarios: e2e asset registry / alias book, live
 * payment and schedule dependencies, the build -> sign -> submit -> verify
 * pipeline, tx evidence and the results recorder.
 *
 * This module is Node-only and contains no secrets.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Asset,
  Horizon,
  Keypair,
  nativeToScVal,
  Transaction,
  TransactionBuilder,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";
import { createGuardClient } from "../guard/client.ts";
import { getAllowance } from "../guard/allowance.ts";
import { createLiveRpc } from "./rpc.ts";
import type { PaymentDeps, PaymentRoute } from "../payments/sendPayment.ts";
import type { ScheduleDeps } from "../schedule/types.ts";
import type { AssetRegistry, AssetSpec } from "../payments/assets.ts";
import type { AliasBook } from "../payments/aliases.ts";
import type { ApprovalProfile } from "../approval/types.ts";
import type { GuardClient } from "../guard/types.ts";
import type { LiveConfig } from "./config.ts";
import { signEnvelope } from "./signer.ts";
import { resequenceEnvelope, submitClassic, submitSoroban, type SubmitResult } from "./submit.ts";

export const EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

export function txUrl(hash: string): string {
  return `${EXPLORER_BASE}/tx/${hash}`;
}

// ── asset registry / alias book ──────────────────────────────────────────────

export function e2eAsset(code: string, issuer: string): Asset {
  return new Asset(code, issuer);
}

/**
 * A throwaway registry that maps the tool-facing symbol `USDC` (and the real
 * code) to the e2e asset. Production's pinned registry is untouched.
 */
export function e2eAssetRegistry(code: string, issuer: string): AssetRegistry {
  const spec: AssetSpec = { code, issuer, native: false };
  const table: Record<string, AssetSpec> = {
    USDC: spec,
    [code.toUpperCase()]: spec,
  };
  return { get: (input) => table[input.trim().toUpperCase()] };
}

export function e2eAliasBook(recipient: string): AliasBook {
  return { ada: { address: recipient, network: "testnet" } };
}

// ── live dependency wiring ───────────────────────────────────────────────────

export interface LiveDepsInput {
  config: LiveConfig;
  horizon: Horizon.Server;
  server: StellarRpc.Server;
  ownerAddress: string;
  aliases: AliasBook;
  assets: AssetRegistry;
  guard: GuardClient;
  guardAssetContracts: Record<string, string>;
  approvalProfile?: ApprovalProfile;
}

export function liveGuardClient(
  config: LiveConfig,
  server: StellarRpc.Server,
  source: string,
): GuardClient {
  return createGuardClient({
    contractId: config.guardContractId,
    rpc: createLiveRpc(server),
    networkPassphrase: config.networkPassphrase,
    source,
  });
}

/** `GuardClient.getAllowance` wired to the real SAC (mandatory for schedules). */
export function liveAllowanceReader(
  config: LiveConfig,
  server: StellarRpc.Server,
  owner: string,
  guardContractId: string,
): (assetContractId: string) => Promise<bigint> {
  const rpc = createLiveRpc(server);
  return (assetContractId: string) =>
    getAllowance(rpc, {
      assetContractId,
      from: owner,
      spender: guardContractId,
      networkPassphrase: config.networkPassphrase,
    });
}

export function livePaymentDeps(input: LiveDepsInput, route: PaymentRoute): PaymentDeps {
  return {
    ownerAddress: input.ownerAddress,
    aliases: input.aliases,
    loadAccount: (address) => input.horizon.loadAccount(address),
    networkPassphrase: input.config.networkPassphrase,
    horizonUrl: input.config.horizonUrl,
    explorerBase: EXPLORER_BASE,
    assets: input.assets,
    route,
    guard: input.guard,
    guardAssetContracts: input.guardAssetContracts,
    ...(input.approvalProfile ? { approvalProfile: input.approvalProfile } : {}),
  };
}

export function liveScheduleDeps(input: LiveDepsInput): ScheduleDeps {
  return {
    ownerAddress: input.ownerAddress,
    aliases: input.aliases,
    guard: input.guard,
    assets: input.assets,
    guardAssetContracts: input.guardAssetContracts,
    networkPassphrase: input.config.networkPassphrase,
    explorerBase: EXPLORER_BASE,
    getAllowance: liveAllowanceReader(
      input.config,
      input.server,
      input.ownerAddress,
      input.guard.contractId,
    ),
  };
}

/** Rebuild the guard client for a different signer (e.g. the executor). */
export function guardClientAs(
  config: LiveConfig,
  server: StellarRpc.Server,
  source: string,
): GuardClient {
  return liveGuardClient(config, server, source);
}

// ── build -> sign -> submit pipeline ─────────────────────────────────────────

export interface TxEvidence {
  hash: string;
  ledger: number;
  status: string;
  summary: string;
  url: string;
}

export function evidence(result: { hash: string; ledger: number; status: string; resultXdrSummary: string }): TxEvidence {
  return {
    hash: result.hash,
    ledger: result.ledger,
    status: result.status,
    summary: result.resultXdrSummary,
    url: txUrl(result.hash),
  };
}

/**
 * Sign and submit a Soroban call, returning the raw result even on failure
 * (callers that require success use `signAndSubmitSoroban`).
 */
export async function signAndSubmitSorobanResult(
  config: LiveConfig,
  server: StellarRpc.Server,
  unsignedXdr: string,
  secret: string,
  opts: { waitMs?: number } = {},
): Promise<SubmitResult> {
  const keypair = Keypair.fromSecret(secret);
  const fresh = await resequenceEnvelope(unsignedXdr, config.networkPassphrase, keypair.publicKey(), (address) =>
    server.getAccount(address),
  );
  const signed = signEnvelope(fresh, secret, config.networkPassphrase);
  return submitSoroban(server, signed, {
    networkPassphrase: config.networkPassphrase,
    ...(opts.waitMs !== undefined ? { waitMs: opts.waitMs } : {}),
  });
}

export async function signAndSubmitSoroban(
  config: LiveConfig,
  server: StellarRpc.Server,
  unsignedXdr: string,
  secret: string,
): Promise<TxEvidence> {
  const res = await signAndSubmitSorobanResult(config, server, unsignedXdr, secret);
  if (res.status !== "SUCCESS") {
    throw new Error(`transaction ${res.hash} failed: ${res.resultXdrSummary} (${txUrl(res.hash)})`);
  }
  return evidence(res);
}

export async function signAndSubmitClassicResult(
  config: LiveConfig,
  horizon: Horizon.Server,
  unsignedXdr: string,
  secret: string,
): Promise<SubmitResult> {
  const keypair = Keypair.fromSecret(secret);
  const fresh = await resequenceEnvelope(unsignedXdr, config.networkPassphrase, keypair.publicKey(), (address) =>
    horizon.loadAccount(address),
  );
  const signed = signEnvelope(fresh, secret, config.networkPassphrase);
  return submitClassic(horizon, signed, { networkPassphrase: config.networkPassphrase });
}

export async function signAndSubmitClassic(
  config: LiveConfig,
  horizon: Horizon.Server,
  unsignedXdr: string,
  secret: string,
): Promise<TxEvidence> {
  const res = await signAndSubmitClassicResult(config, horizon, unsignedXdr, secret);
  if (res.status !== "SUCCESS") {
    throw new Error(`classic transaction ${res.hash} failed: ${res.resultXdrSummary}`);
  }
  return evidence(res);
}

/**
 * Replace an i128 argument of a built single-invocation XDR WITHOUT
 * re-simulating. Used only to prove that the chain (not our pre-checks) rejects
 * an over-limit payment; the footprint is amount-independent for `pay_*`.
 */
export function patchInvokeI128Arg(
  unsignedXdr: string,
  networkPassphrase: string,
  argIndex: number,
  value: bigint,
): string {
  const parsed = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) throw new Error("cannot patch a fee-bump envelope");
  const op = parsed.operations[0];
  if (!op || op.type !== "invokeHostFunction") throw new Error("the XDR is not a single contract invocation");
  const invoke = op.func;
  if (invoke.type !== "hostFunctionTypeInvokeContract") {
    throw new Error(`the XDR is not an invoke-contract call (${String(invoke.type)})`);
  }
  invoke.invokeContract.args[argIndex] = nativeToScVal(value, { type: "i128" });
  return parsed.toXDR();
}

// ── assertions ───────────────────────────────────────────────────────────────

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
}

export function assertBigEqual(actual: bigint, expected: bigint, label: string): void {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

/** Parse a decimal token string to raw units (7 decimals) for balance deltas. */
export function rawOf(decimal: string): bigint {
  const [whole = "0", frac = ""] = decimal.split(".") as [string, string?];
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0") || "0");
}

// ── scenario recorder ────────────────────────────────────────────────────────

export interface ScenarioResult {
  id: string;
  name: string;
  status: "pass" | "fail";
  detail: string;
  txs: TxEvidence[];
  error?: string;
}

export class Recorder {
  private readonly results: ScenarioResult[] = [];

  record(result: ScenarioResult): void {
    this.results.push(result);
  }

  async run(
    id: string,
    name: string,
    fn: () => Promise<{ detail: string; txs?: TxEvidence[] }>,
  ): Promise<boolean> {
    try {
      const outcome = await fn();
      this.record({ id, name, status: "pass", detail: outcome.detail, txs: outcome.txs ?? [] });
      process.stdout.write(`[PASS] ${id} ${name} — ${outcome.detail}\n`);
      return true;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.record({ id, name, status: "fail", detail: "", txs: [], error: message });
      process.stdout.write(`[FAIL] ${id} ${name} — ${message}\n`);
      return false;
    }
  }

  all(): ScenarioResult[] {
    return [...this.results];
  }

  /** Write the public results JSON (no secrets) and return its path. */
  write(dir: string, extra: Record<string, unknown> = {}): string {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    const payload = { generatedAt: new Date().toISOString(), ...extra, scenarios: this.results };
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    return path;
  }
}
