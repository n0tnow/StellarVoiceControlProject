import { describe, expect, it } from "vitest";
import {
  classifyPayoutHealth,
  CLOCK_SKEW_TOLERANCE_MS,
  findTreasuryAddress,
  parseHorizonPayments,
  PAYOUT_FLOWING_WITHIN_MS,
  PAYOUT_STALLED_AFTER_MS,
  readPayoutHealth,
  TR_MOCK_TREASURY,
  type PayoutPayment,
} from "../payoutHealth.ts";
import { fakeFetch, jsonResponse, makeCtx } from "./helpers.ts";

const NOW = new Date("2026-09-20T02:00:00Z");
const TREASURY = TR_MOCK_TREASURY;

function at(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

const out = (minutesAgo: number): PayoutPayment => ({ direction: "outgoing", createdAt: at(minutesAgo) });
const inc = (minutesAgo: number): PayoutPayment => ({ direction: "incoming", createdAt: at(minutesAgo) });

describe("payout-health classification (heuristic, table-driven)", () => {
  const classify = (payments: PayoutPayment[]) =>
    classifyPayoutHealth({ payments, now: NOW, treasury: TREASURY, treasurySource: "documented" });

  it.each<[string, PayoutPayment[], string]>([
    ["no payments at all", [], "unknown"],
    ["only incoming (no outgoing ever)", [inc(5), inc(20)], "payouts-stalled"],
    ["only outgoing, recent", [out(5)], "payouts-flowing"],
    ["only outgoing, old, no incoming", [out(60)], "unknown"],
    ["recent outgoing with incoming", [inc(2), out(5), inc(30)], "payouts-flowing"],
    ["old outgoing with later incoming", [inc(2), out(60), inc(90)], "payouts-stalled"],
    ["boundary: outgoing exactly 10 min old", [out(10), inc(1)], "payouts-flowing"],
    ["boundary: outgoing 10 min + 1ms old", [out(10.0001), inc(1)], "unknown"],
    ["boundary: outgoing exactly 30 min old", [out(30), inc(1)], "unknown"],
    ["boundary: outgoing 30 min + 1ms old with incoming", [out(30.0001), inc(1)], "payouts-stalled"],
    ["old outgoing with only earlier incoming still counts incoming", [inc(120), out(60)], "payouts-stalled"],
    ["N3: future-dated newest outgoing (30 min ahead) is not 'flowing'", [out(-30), inc(1)], "unknown"],
    ["N3: future-dated newest outgoing beyond skew tolerance (no incoming)", [out(-30)], "unknown"],
    ["N3: future-dated newest outgoing within the 2 min skew tolerance", [out(-1), inc(1)], "payouts-flowing"],
    ["N3: boundary: outgoing exactly at the skew tolerance (2 min ahead)", [out(-2)], "payouts-flowing"],
    ["N3: boundary: outgoing just beyond the skew tolerance", [out(-2.0001)], "unknown"],
  ])("%s -> %s", (_name, payments, expected) => {
    expect(classify(payments).verdict).toBe(expected);
  });

  it("N3: explains a future-dated newest outgoing as clock skew, not a healthy pipeline", () => {
    const h = classify([out(-30), inc(1)]);
    expect(h.verdict).toBe("unknown");
    expect(h.reasons.join(" ")).toMatch(/future/i);
    expect(h.reasons.join(" ")).toMatch(/clock-skew|clock skew/i);
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(2 * 60 * 1000);
  });

  it("reports the newest/oldest outgoing, incoming count and incoming since the newest outgoing", () => {
    const h = classify([inc(2), out(60), inc(90), out(120), inc(200)]);
    expect(h.newestOutgoingAt).toBe(at(60));
    expect(h.oldestOutgoingAt).toBe(at(120));
    expect(h.outgoingCount).toBe(2);
    expect(h.incomingCount).toBe(3);
    expect(h.incomingSinceNewestOutgoing).toBe(1); // only the inc(2) is newer than out(60)
    expect(h.ageOfNewestOutgoingMs).toBe(60 * 60_000);
    expect(h.verdict).toBe("payouts-stalled");
    expect(h.reasons.join(" ")).toMatch(/stalled/i);
  });

  it("ignores records with an unparsable timestamp", () => {
    const h = classify([{ direction: "outgoing", createdAt: "not-a-date" }, inc(5)]);
    expect(h.outgoingCount).toBe(0);
    expect(h.verdict).toBe("payouts-stalled");
  });

  it("documents the thresholds in one place", () => {
    expect(PAYOUT_FLOWING_WITHIN_MS).toBe(10 * 60 * 1000);
    expect(PAYOUT_STALLED_AFTER_MS).toBe(30 * 60 * 1000);
  });
});

describe("Horizon payment parsing", () => {
  it("maps payment direction relative to the treasury and skips other types", () => {
    const raw = {
      _embedded: {
        records: [
          { type: "payment", from: TREASURY, to: "GOTHER", created_at: at(1), amount: "1.0", asset_code: "USDC" },
          { type: "payment", from: "GOTHER", to: TREASURY, created_at: at(2), amount: "2.0" },
          { type: "create_account", account: "GNEW", funder: TREASURY, created_at: at(3) },
          { type: "create_claimable_balance", source_account: TREASURY, created_at: at(3.5), amount: "5.0" },
          { type: "account_merge", account: TREASURY, into: "GOTHER", created_at: at(3.6) },
          { type: "payment", from: "GA", to: "GB", created_at: at(4) },
          { type: "payment", from: TREASURY, to: "GOTHER", created_at: "bad" },
        ],
      },
    };
    const p = parseHorizonPayments(raw, TREASURY);
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ direction: "outgoing", amount: "1.0", assetCode: "USDC" });
    expect(p[1]?.direction).toBe("incoming");
  });

  it("returns an empty list for a malformed body", () => {
    expect(parseHorizonPayments(null, TREASURY)).toEqual([]);
    expect(parseHorizonPayments({}, TREASURY)).toEqual([]);
  });

  it("finds the treasury address in a /health body and never mistakes the asset issuer for it", () => {
    expect(findTreasuryAddress({ asset: { issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" }, treasury: { address: TREASURY } })).toBe(TREASURY);
    expect(findTreasuryAddress({ treasury: { account_id: TREASURY } })).toBe(TREASURY);
    expect(findTreasuryAddress({ asset: { issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" } })).toBeUndefined();
    expect(findTreasuryAddress({ treasury: { usdc_balance: "1" } })).toBeUndefined();
    expect(findTreasuryAddress(null)).toBeUndefined();
  });
});

describe("readPayoutHealth (read-only)", () => {
  it("uses the treasury from /health when exposed and classifies Horizon payments", async () => {
    const { fetch, calls } = fakeFetch({
      "GET tr-mock-anchor.fly.dev/health": { ok: true, treasury: { address: TREASURY, usdc_balance: "1" } },
      [`GET horizon.example.test/accounts/${TREASURY}/payments`]: {
        _embedded: { records: [{ type: "payment", from: "GX", to: TREASURY, created_at: at(2) }] },
      },
    });
    const h = await readPayoutHealth(makeCtx(fetch), { now: NOW });
    expect(h.healthReachable).toBe(true);
    expect(h.treasury).toBe(TREASURY);
    expect(h.treasurySource).toBe("health");
    expect(h.verdict).toBe("payouts-stalled");
    const paymentsCall = calls.find((c) => c.url.includes("/payments"));
    expect(paymentsCall?.url).toContain("order=desc");
    expect(paymentsCall?.url).toContain("limit=200");
  });

  it("falls back to the documented treasury when /health does not expose one", async () => {
    const { fetch } = fakeFetch({
      "GET tr-mock-anchor.fly.dev/health": { ok: true, treasury: { usdc_balance: "1" } },
      [`GET horizon.example.test/accounts/${TR_MOCK_TREASURY}/payments`]: { _embedded: { records: [] } },
    });
    const h = await readPayoutHealth(makeCtx(fetch), { now: NOW });
    expect(h.treasury).toBe(TR_MOCK_TREASURY);
    expect(h.treasurySource).toBe("documented");
    expect(h.verdict).toBe("unknown");
  });

  it("still reads Horizon (documented treasury) when /health is unreachable", async () => {
    const { fetch } = fakeFetch({
      "GET tr-mock-anchor.fly.dev/health": () => jsonResponse({ error: "down" }, 503),
      [`GET horizon.example.test/accounts/${TR_MOCK_TREASURY}/payments`]: { _embedded: { records: [{ type: "payment", from: TR_MOCK_TREASURY, to: "GX", created_at: at(1) }] } },
    });
    const h = await readPayoutHealth(makeCtx(fetch), { now: NOW });
    expect(h.healthReachable).toBe(false);
    expect(h.treasurySource).toBe("documented");
    expect(h.verdict).toBe("payouts-flowing");
  });
});
