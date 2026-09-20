/**
 * Pure helpers behind the Debug checks.
 *
 * `docs/debug-panel.md` keeps helper modules **outside** `checks/` on purpose:
 * the registry globs every `checks/*.ts` as a `FeatureCheck`, and only the pure,
 * Tauri-free logic can be unit-tested under `node:test`. The check files
 * (`checks/network.ts`, `checks/approval.ts`) are thin wrappers that gather live
 * facts and hand them here; the decisions live here.
 */
import { makeResult } from "./runner.ts";
import type { CheckResult } from "./types.ts";
import type { DebugFeatureHealth } from "./commands.ts";

/* ------------------------------------------------------------------ *
 * Network
 * ------------------------------------------------------------------ */

/** The alias the demo/testnet flow pays by default (`.env.example`). */
export const DEFAULT_RECIPIENT_ALIAS = "acc2";

/** The owner account facts Horizon returns, narrowed to what a check needs. */
export interface OwnerAccountFacts {
  exists: boolean;
  /** Native XLM balance string, when the account exists. */
  xlmBalance?: string;
}

/** Plain facts the network summary is built from (injected, so it is testable). */
export interface NetworkFacts {
  /** The `stellar_config` payload, or `null` when the command is absent. */
  config: {
    network?: string;
    horizonUrl?: string;
    ownerAddress?: string | null;
  } | null;
  /** Whether the alias book parsed without error. */
  aliasBookResolved: boolean;
  recipientAlias: string;
  recipientResolved: boolean;
  /** `null` when Horizon could not be reached at all. */
  horizon: OwnerAccountFacts | null;
}

/** A 56-char `G...` StrKey shape check (the checksum is validated in Rust). */
const ADDRESS = /^G[A-Z2-7]{55}$/;

/**
 * Maps gathered network facts to one Debug result. Severity is the worst
 * finding: a missing command or owner is a `warn`; a wrong network, a malformed
 * owner or a missing/unfunded account is a `fail`; saved contacts are optional
 * (a typed address is payable), so an empty alias book is not a failure; a
 * funded owner on testnet is an `ok` that shows the balance.
 */
export function summarizeNetwork(facts: NetworkFacts): CheckResult {
  const { config } = facts;
  if (config === null) {
    return makeResult("warn", "stellar_config is not present on this build");
  }
  if (config.network && config.network !== "testnet") {
    return makeResult("fail", `network is "${config.network}" but Polaris is testnet-only`);
  }
  const owner = config.ownerAddress;
  if (!owner) {
    return makeResult("warn", "POLARIS_OWNER_ADDRESS is not set; sending is disabled");
  }
  if (!ADDRESS.test(owner)) {
    return makeResult("fail", `owner address is not a valid G… key: ${owner}`);
  }
  if (facts.horizon === null) {
    return makeResult("fail", `Horizon is unreachable at ${config.horizonUrl ?? "the default URL"}`);
  }
  if (!facts.horizon.exists) {
    return makeResult(
      "fail",
      `owner account ${owner} was not found on testnet; fund it (Friendbot) before sending`,
    );
  }
  const balance = facts.horizon.xlmBalance ?? "0";
  if (Number.parseFloat(balance) <= 0) {
    return makeResult("fail", `owner account exists but has ${balance} XLM; fund it before sending`);
  }
  return makeResult(
    "ok",
    `testnet · owner ${owner} · ${balance} XLM`,
  );
}

/**
 * Reads the owner account from Horizon. Returns `null` when Horizon could not be
 * reached at all (a network failure), distinct from `{ exists: false }` (a 404,
 * i.e. the account was never funded).
 */
export async function loadOwnerAccount(
  horizonUrl: string,
  owner: string,
): Promise<OwnerAccountFacts | null> {
  try {
    const response = await fetch(`${horizonUrl}/accounts/${owner}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return { exists: false };
    if (!response.ok) return null;
    const body = (await response.json()) as {
      balances?: { asset_type?: string; balance?: string }[];
    };
    const native = body.balances?.find((entry) => entry.asset_type === "native");
    return native?.balance !== undefined
      ? { exists: true, xlmBalance: native.balance }
      : { exists: true };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Touch ID approval
 * ------------------------------------------------------------------ */

/** Maps a `FeatureHealth` from Rust onto a `CheckResult` (scrubbed by `makeResult`). */
export function mapHealthToResult(health: DebugFeatureHealth): CheckResult {
  return makeResult(health.status, health.detail);
}

/** The result of the Touch ID self-test action, mirroring the Rust status. */
export function approvalSelftestResult(health: DebugFeatureHealth): CheckResult {
  switch (health.status) {
    case "ok":
      return makeResult("ok", "Touch ID self-test passed; no funds were moved");
    case "warn":
      // A cancelled prompt is a user choice, not a broken gate.
      return makeResult("warn", health.detail);
    default:
      return makeResult("fail", health.detail);
  }
}
