/**
 * Anchor selection: pick the first HEALTHY anchor before any money moves.
 *
 * The owner's rule: try the first anchor, and if it is not reachable try the
 * second; if neither answers, show one plain line (with per-anchor reasons
 * behind "Details") and move nothing. Selection is deliberately cheap and
 * happens UP FRONT — never as a retry after the bank was debited or a payment
 * was sent, because a retry then would move value twice.
 *
 * Healthy means: SEP-1 discovery succeeds, the scenario's asset is listed in the
 * toml (with the pinned issuer when we know one), and SEP-6 `/info` advertises
 * that asset for deposit or withdraw. SEP-24 is never used by this project.
 */
import { DEFAULT_ASSET_CODE, KNOWN_ISSUERS, TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "./config.ts";
import { ExplainLog } from "./explain.ts";
import { discoverAnchor, findAsset } from "./sep1.ts";
import { getInfo, type Sep6Info } from "./sep6.ts";
import { demoCustomerFields, describeAnchorScenario, SDF_TEST_ANCHOR_HOME_DOMAIN, TR_MOCK_HOME_DOMAIN, type ScenarioId } from "./scenarios.ts";
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, FetchLike } from "./types.ts";

/** Per-candidate network budget: long enough for a real anchor, short enough to fail over. */
export const ANCHOR_PREFLIGHT_TIMEOUT_MS = 6000;

/** The one plain line shown when no candidate is healthy. */
export const NO_ANCHOR_MESSAGE = "No anchor is reachable right now — try again in a minute";

/** One anchor we may use, with the scenario's asset/currency/KYC defaults. */
export interface AnchorCandidate {
  homeDomain: string;
  scenarioId: ScenarioId;
  label: string;
  /** On-chain asset code this scenario moves (e.g. "SRT", "USDC"). */
  assetCode: string;
  /** Off-chain currency this scenario quotes in (e.g. "USD", "TRY"). */
  fiatCode?: string;
  /** SEP-38 delivery method, omitted when the anchor quotes without one. */
  sep38DeliveryMethod?: string;
  /** Clearly-fake TEST KYC fields (only the SDF scenario has any). */
  customerFields: Record<string, string>;
}

/**
 * The approved scenarios in preference order (SDF test anchor first, TR mock
 * second). A configured home domain, when it is one of them, is tried first so
 * an explicit override is respected; the rest keep their order.
 */
export function approvedAnchorCandidates(preferredHomeDomain?: string): AnchorCandidate[] {
  const order = [SDF_TEST_ANCHOR_HOME_DOMAIN, TR_MOCK_HOME_DOMAIN];
  if (preferredHomeDomain && order.includes(preferredHomeDomain)) {
    order.splice(0, order.length, preferredHomeDomain, ...order.filter((d) => d !== preferredHomeDomain));
  }
  return order.map((homeDomain) => {
    const scenario = describeAnchorScenario(homeDomain);
    return {
      homeDomain,
      scenarioId: scenario.id,
      label: scenario.label,
      assetCode: scenario.assetCode ?? DEFAULT_ASSET_CODE,
      ...(scenario.fiat ? { fiatCode: scenario.fiat } : {}),
      ...(scenario.sep38DeliveryMethod ? { sep38DeliveryMethod: scenario.sep38DeliveryMethod } : {}),
      customerFields: demoCustomerFields(homeDomain),
    };
  });
}

export interface AnchorPreflightDeps {
  /** Injected so the check is testable without the network. */
  fetch: FetchLike;
  now?: () => Date;
  requestTimeoutMs?: number;
  networkPassphrase?: string;
  horizonUrl?: string;
  friendbotUrl?: string;
}

/** The outcome of one candidate's cheap health check. */
export interface AnchorHealth {
  homeDomain: string;
  assetCode: string;
  ok: boolean;
  /** Present when `ok`: discovery + SEP-6 info the flow may reuse. */
  toml?: AnchorToml;
  info?: Sep6Info;
  /** Present when `!ok`: a short, sanitised reason for the "Details" list. */
  reason?: string;
}

export interface AnchorSelection {
  chosen: AnchorCandidate;
  /** Every candidate probed, in order (healthy ones before the chosen one). */
  health: AnchorHealth[];
}

/** Thrown when no candidate is healthy; carries one reason per anchor. */
export class NoHealthyAnchorError extends Error {
  readonly health: AnchorHealth[];
  constructor(health: AnchorHealth[]) {
    super(NO_ANCHOR_MESSAGE);
    this.name = "NoHealthyAnchorError";
    this.health = health;
  }
}

function makeCtx(deps: AnchorPreflightDeps): AnchorContext {
  const now = deps.now ?? (() => new Date());
  return {
    fetch: deps.fetch,
    explain: new ExplainLog(now),
    horizonUrl: deps.horizonUrl ?? TESTNET_HORIZON_URL,
    friendbotUrl: deps.friendbotUrl ?? TESTNET_FRIENDBOT_URL,
    networkPassphrase: deps.networkPassphrase ?? TESTNET_PASSPHRASE,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now,
    requestTimeoutMs: deps.requestTimeoutMs ?? ANCHOR_PREFLIGHT_TIMEOUT_MS,
  };
}

/** First line of an error, sanitised and capped for the Details list. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const first = message.split("\n")[0]?.trim() || "unhealthy";
  return sanitizeAnchorText(first, 160) ?? "unhealthy";
}

/**
 * Cheaply checks one candidate: SEP-1 discovery, the asset listing (with the
 * pinned issuer when we know it) and SEP-6 `/info` support for that asset.
 * Never throws; a failure is a `reason`.
 */
export async function preflightAnchor(
  candidate: AnchorCandidate,
  deps: AnchorPreflightDeps,
): Promise<AnchorHealth> {
  const ctx = makeCtx(deps);
  const base = { homeDomain: candidate.homeDomain, assetCode: candidate.assetCode };
  try {
    const toml = await discoverAnchor(ctx, candidate.homeDomain);
    const expectedIssuer = KNOWN_ISSUERS[candidate.homeDomain]?.[candidate.assetCode];
    findAsset(toml, candidate.assetCode, { expectedIssuer });
    const info = await getInfo(ctx, toml, candidate.assetCode);
    const supported =
      info.deposit[candidate.assetCode]?.enabled === true ||
      info.withdraw[candidate.assetCode]?.enabled === true;
    if (!supported) {
      throw new Error(`SEP-6 /info does not enable ${candidate.assetCode} for deposit or withdraw`);
    }
    return { ...base, ok: true, toml, info };
  } catch (error) {
    return { ...base, ok: false, reason: reasonOf(error) };
  }
}

/**
 * Probes candidates in order and returns the first healthy one. When none is
 * healthy it throws [`NoHealthyAnchorError`] (carrying each reason) so the UI
 * can show one plain line and put the reasons behind "Details".
 */
export async function selectAnchor(
  candidates: AnchorCandidate[],
  deps: AnchorPreflightDeps,
): Promise<AnchorSelection> {
  const health: AnchorHealth[] = [];
  for (const candidate of candidates) {
    const result = await preflightAnchor(candidate, deps);
    health.push(result);
    if (result.ok) return { chosen: candidate, health };
  }
  throw new NoHealthyAnchorError(health);
}
