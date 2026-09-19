/**
 * TR-mock payout-health: a READ-ONLY heuristic that answers "is the anchor's
 * deposit payout pipeline still paying USDC?".
 *
 * The 2026-09-20 live check found the TR mock anchor accepting every SEP-6 step
 * while its payout worker had stopped submitting outgoing USDC payments (orders
 * stuck in `pending_anchor`). This module looks at the treasury's public Horizon
 * payment history and classifies whether payouts are flowing.
 *
 * It never moves funds and never writes anything. The thresholds are HEURISTIC
 * constants in one place, deliberately loose, and the verdict is advisory.
 */
import { requestJson } from "./http.ts";
import { TR_MOCK_HOME_DOMAIN } from "./scenarios.ts";
import type { AnchorContext } from "./types.ts";

/** Documented treasury of the TR mock anchor (see `stellar/src/anchor/README.md`). */
export const TR_MOCK_TREASURY = "GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6";

/** HEURISTIC: an outgoing payment this recent means payouts are flowing. */
export const PAYOUT_FLOWING_WITHIN_MS = 10 * 60 * 1000;
/** HEURISTIC: no outgoing payment for longer than this (while incoming exist) means stalled. */
export const PAYOUT_STALLED_AFTER_MS = 30 * 60 * 1000;
/** Horizon page size for the treasury payment history. */
export const PAYMENT_HISTORY_LIMIT = 200;
/**
 * HEURISTIC: a newest outgoing payment dated slightly in the future is clock
 * skew between this machine and Horizon, not evidence of a healthy pipeline.
 * Anything beyond this tolerance is treated as `unknown` rather than "flowing".
 */
export const CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

export interface PayoutPayment {
  direction: "incoming" | "outgoing";
  /** ISO timestamp from Horizon. */
  createdAt: string;
  amount?: string;
  assetCode?: string;
}

export type PayoutVerdict = "payouts-flowing" | "payouts-stalled" | "unknown";

export interface PayoutHealth {
  verdict: PayoutVerdict;
  treasury: string;
  treasurySource: "health" | "documented";
  totalPayments: number;
  outgoingCount: number;
  incomingCount: number;
  newestOutgoingAt?: string;
  oldestOutgoingAt?: string;
  newestIncomingAt?: string;
  incomingSinceNewestOutgoing: number;
  ageOfNewestOutgoingMs?: number;
  /** Plain-English explanation of the verdict. */
  reasons: string[];
}

/**
 * Pure, table-driven classification of a treasury's payment history.
 *
 *  - `payouts-flowing`: the newest outgoing payment is within `PAYOUT_FLOWING_WITHIN_MS`.
 *  - `payouts-stalled`: no outgoing payment for more than `PAYOUT_STALLED_AFTER_MS`
 *    (or none at all) while incoming payments exist.
 *  - `unknown`: no payments, only old outgoing with no incoming, the
 *    indeterminate 10-30 min gap, or a newest outgoing dated in the future
 *    beyond `CLOCK_SKEW_TOLERANCE_MS` (a negative age is not "recent").
 *
 * Only `payment` / `path_payment_strict_send` / `path_payment_strict_receive`
 * outflows are counted (`parseHorizonPayments`); `create_claimable_balance` and
 * `account_merge` records are ignored, even though the TR mock advertises
 * `claimable_balances:true`. If the anchor ever starts paying out through those
 * op types, this heuristic would miss it.
 */
export function classifyPayoutHealth(input: {
  payments: PayoutPayment[];
  now: Date;
  treasury: string;
  treasurySource: "health" | "documented";
}): PayoutHealth {
  const nowMs = input.now.getTime();
  let newestOutgoingAt: string | undefined;
  let oldestOutgoingAt: string | undefined;
  let newestIncomingAt: string | undefined;
  let outgoingCount = 0;
  let incomingCount = 0;
  for (const p of input.payments) {
    const ts = Date.parse(p.createdAt);
    if (Number.isNaN(ts)) continue;
    if (p.direction === "outgoing") {
      outgoingCount++;
      if (!newestOutgoingAt || ts > Date.parse(newestOutgoingAt)) newestOutgoingAt = p.createdAt;
      if (!oldestOutgoingAt || ts < Date.parse(oldestOutgoingAt)) oldestOutgoingAt = p.createdAt;
    } else {
      incomingCount++;
      if (!newestIncomingAt || ts > Date.parse(newestIncomingAt)) newestIncomingAt = p.createdAt;
    }
  }
  const totalPayments = outgoingCount + incomingCount;
  const newestOutgoingMs = newestOutgoingAt ? Date.parse(newestOutgoingAt) : undefined;
  const ageOfNewestOutgoingMs = newestOutgoingMs === undefined ? undefined : nowMs - newestOutgoingMs;
  const incomingSinceNewestOutgoing =
    newestOutgoingMs === undefined
      ? incomingCount
      : input.payments.filter((p) => p.direction === "incoming" && Date.parse(p.createdAt) > newestOutgoingMs).length;

  const base = {
    treasury: input.treasury,
    treasurySource: input.treasurySource,
    totalPayments,
    outgoingCount,
    incomingCount,
    incomingSinceNewestOutgoing,
    ...(newestOutgoingAt ? { newestOutgoingAt } : {}),
    ...(oldestOutgoingAt ? { oldestOutgoingAt } : {}),
    ...(newestIncomingAt ? { newestIncomingAt } : {}),
    ...(ageOfNewestOutgoingMs !== undefined ? { ageOfNewestOutgoingMs } : {}),
  };

  if (totalPayments === 0) {
    return { verdict: "unknown", ...base, reasons: ["Horizon returned no payments for the treasury, so there is nothing to judge."] };
  }
  if (ageOfNewestOutgoingMs !== undefined && ageOfNewestOutgoingMs < -CLOCK_SKEW_TOLERANCE_MS) {
    const minutesAhead = Math.round(-ageOfNewestOutgoingMs / 60000);
    return {
      verdict: "unknown",
      ...base,
      reasons: [
        `The newest outgoing payment is dated about ${minutesAhead} min in the future (> ${CLOCK_SKEW_TOLERANCE_MS / 60000} min clock-skew tolerance), ` +
          "so its age cannot be trusted; not treating it as evidence that payouts are flowing.",
      ],
    };
  }
  if (ageOfNewestOutgoingMs !== undefined && ageOfNewestOutgoingMs <= PAYOUT_FLOWING_WITHIN_MS) {
    const minutes = Math.round(ageOfNewestOutgoingMs / 60000);
    return {
      verdict: "payouts-flowing",
      ...base,
      reasons: [`The newest outgoing payment is about ${minutes} min old (within the ${PAYOUT_FLOWING_WITHIN_MS / 60000} min heuristic).`],
    };
  }
  if (incomingCount > 0 && (ageOfNewestOutgoingMs === undefined || ageOfNewestOutgoingMs > PAYOUT_STALLED_AFTER_MS)) {
    const reasons: string[] = [];
    if (ageOfNewestOutgoingMs === undefined) {
      reasons.push(`No outgoing payment appears in the last ${PAYMENT_HISTORY_LIMIT} records while ${incomingCount} incoming payment(s) exist.`);
    } else {
      reasons.push(
        `The newest outgoing payment is about ${Math.round(ageOfNewestOutgoingMs / 60000)} min old ` +
          `(> ${PAYOUT_STALLED_AFTER_MS / 60000} min heuristic) while ${incomingSinceNewestOutgoing} incoming payment(s) arrived after it.`,
      );
    }
    reasons.push("Deposit payouts look stalled; this is advisory evidence for the anchor operators, not proof.");
    return { verdict: "payouts-stalled", ...base, reasons };
  }
  return {
    verdict: "unknown",
    ...base,
    reasons: [
      "The newest outgoing payment is in the indeterminate window (or there is no incoming demand), so the pipeline cannot be judged from this history.",
    ],
  };
}

/** Reads the treasury address from a `/health` body, if it exposes one. */
export function findTreasuryAddress(health: unknown): string | undefined {
  if (!health || typeof health !== "object") return undefined;
  const h = health as Record<string, unknown>;
  const t = h.treasury;
  if (t && typeof t === "object") {
    const obj = t as Record<string, unknown>;
    for (const key of ["address", "account", "account_id", "accountId"]) {
      const v = obj[key];
      if (typeof v === "string" && STELLAR_ACCOUNT.test(v)) return v;
    }
  }
  for (const key of ["treasury_address", "treasuryAddress"]) {
    const v = h[key];
    if (typeof v === "string" && STELLAR_ACCOUNT.test(v)) return v;
  }
  return undefined;
}

/** Maps Horizon payment records into the classifier's shape, relative to `treasury`. */
export function parseHorizonPayments(raw: unknown, treasury: string): PayoutPayment[] {
  const records = (raw as { _embedded?: { records?: unknown[] } } | undefined)?._embedded?.records;
  const out: PayoutPayment[] = [];
  if (!Array.isArray(records)) return out;
  for (const r of records) {
    if (!r || typeof r !== "object") continue;
    const rec = r as Record<string, unknown>;
    if (rec.type !== "payment" && rec.type !== "path_payment_strict_send" && rec.type !== "path_payment_strict_receive") continue;
    const from = rec.from;
    const to = rec.to;
    if (typeof from !== "string" || typeof to !== "string") continue;
    const direction = from === treasury ? "outgoing" : to === treasury ? "incoming" : undefined;
    if (!direction) continue;
    const createdAt = typeof rec.created_at === "string" ? rec.created_at : undefined;
    if (!createdAt || Number.isNaN(Date.parse(createdAt))) continue;
    const p: PayoutPayment = { direction, createdAt };
    if (typeof rec.amount === "string") p.amount = rec.amount;
    if (typeof rec.asset_code === "string") p.assetCode = rec.asset_code;
    out.push(p);
  }
  return out;
}

export interface PayoutHealthResult extends PayoutHealth {
  /** Whether `/health` responded at all. */
  healthReachable: boolean;
}

/**
 * Reads `/health` (for a treasury address, if it exposes one) and the treasury's
 * public Horizon payments, then classifies. READ-ONLY: no writes, no signing.
 */
export async function readPayoutHealth(
  ctx: AnchorContext,
  opts: { homeDomain?: string; now?: Date } = {},
): Promise<PayoutHealthResult> {
  const homeDomain = opts.homeDomain ?? TR_MOCK_HOME_DOMAIN;
  const now = opts.now ?? ctx.now();
  let treasury = TR_MOCK_TREASURY;
  let treasurySource: "health" | "documented" = "documented";
  let healthReachable = false;
  try {
    const health = await requestJson<unknown>(ctx, `https://${homeDomain}/health`);
    healthReachable = true;
    const fromHealth = findTreasuryAddress(health);
    if (fromHealth) {
      treasury = fromHealth;
      treasurySource = "health";
    }
  } catch {
    // A health failure is itself evidence, but the documented treasury still lets us read Horizon.
  }
  const raw = await requestJson<unknown>(
    ctx,
    `${ctx.horizonUrl}/accounts/${treasury}/payments?order=desc&limit=${PAYMENT_HISTORY_LIMIT}`,
  );
  const payments = parseHorizonPayments(raw, treasury);
  return { ...classifyPayoutHealth({ payments, now, treasury, treasurySource }), healthReachable };
}
