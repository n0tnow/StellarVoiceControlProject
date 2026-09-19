import { describe, expect, it } from "vitest";
import {
  SuggestInputError,
  explainNoSuggestions,
  suggest,
  toLlmSafeEvidence,
  validateSuggestContext,
} from "../suggest.ts";
import type { DisableAutoPay, HistoryRecord, NoChange, RuleDraft, ScheduleDraft, SuggestOptions, Suggestion } from "../types.ts";
import { parseAmount, roundUpToDisplayMultiple } from "../amount.ts";
import { ROUNDING_STEP_DISPLAY } from "../constants.ts";
import { dropAmountOutliers, maxOf, sortBigints } from "../stats.ts";
import {
  DAY,
  DECIMALS,
  NOW,
  addr,
  aliasesOf,
  ctx,
  makeRng,
  pool,
  randInt,
  raw,
  rec,
  workedExampleHistory,
} from "./helpers.ts";

function historyOf(amounts: readonly string[], startOffset = 1): HistoryRecord[] {
  return amounts.map((amount, index) =>
    rec({
      id: `r${String(index).padStart(2, "0")}`,
      ts: NOW - (startOffset + index) * DAY,
      recipientAddress: addr(index),
      amountRaw: raw(amount),
    }),
  );
}

/** 9 public confirmed payments with a p90 of 20 USDC. */
function capPool(): HistoryRecord[] {
  return historyOf(["10", "11", "12", "13", "14", "15", "16", "17", "20"]);
}

const find = (suggestions: readonly Suggestion[], kind: Suggestion["kind"]): Suggestion | undefined =>
  suggestions.find((suggestion) => suggestion.kind === kind);

describe("worked example (docs §6.8)", () => {
  it("produces the auto_pay_threshold 20 suggestion", () => {
    const { history, contacts } = workedExampleHistory();
    const threshold = find(suggest(history, ctx({ knownContacts: contacts })), "auto_pay_threshold");
    expect(threshold).toBeDefined();
    expect(threshold?.id).toBe("auto_pay_threshold:USDC:20");
    expect(threshold?.evidence).toMatchObject({
      windowDays: 30,
      count: 14,
      median: "9.5",
      p90: "18.4",
      max: "22",
    });
    expect((threshold?.proposedChange as RuleDraft).autoApproveLimit).toBe("20");
  });

  it("produces the daily_limit 60 suggestion", () => {
    const { history, contacts } = workedExampleHistory();
    const daily = find(suggest(history, ctx({ knownContacts: contacts })), "daily_limit");
    expect(daily).toBeDefined();
    expect(daily?.id).toBe("daily_limit:USDC:60");
    expect(daily?.evidence.p95DailyTotal).toBe("38");
    expect(daily?.evidence.dailyMedian).toBe("9");
    expect(daily?.evidence.dailyMax).toBe("38");
    expect((daily?.proposedChange as RuleDraft).dailyLimit).toBe("60");
  });

  it("does not fire recurrence or unusual alerts for 14 distinct recipients", () => {
    const { history, contacts } = workedExampleHistory();
    const suggestions = suggest(history, ctx({ knownContacts: contacts }));
    expect(find(suggestions, "schedule_from_recurrence")).toBeUndefined();
    expect(find(suggestions, "unusual_payment_alert")).toBeUndefined();
  });

  it("reports no explanation (there is enough history)", () => {
    const { history, contacts } = workedExampleHistory();
    expect(explainNoSuggestions(history, ctx({ knownContacts: contacts }))).toBeNull();
  });
});

describe("minimum-data guard", () => {
  it("returns [] below minPayments", () => {
    expect(suggest(pool(7), ctx())).toEqual([]);
  });

  it("explains not_enough_history with counts", () => {
    const history = pool(7);
    const explanation = explainNoSuggestions(history, ctx());
    expect(explanation).toMatchObject({
      reason: "not_enough_history",
      count: 7,
      minPayments: 8,
      spanDays: 6,
      minSpanDays: 7,
      windowDays: 30,
    });
  });

  it("returns [] when minPayments is met but the span is too short", () => {
    const sameDay = Array.from({ length: 9 }, (_, index) =>
      rec({ id: `s${index}`, ts: NOW - index, recipientAddress: addr(index) }),
    );
    expect(suggest(sameDay, ctx())).toEqual([]);
    expect(explainNoSuggestions(sameDay, ctx())?.spanDays).toBe(0);
  });

  it("returns suggestions at exactly minPayments over minSpanDays", () => {
    const history = pool(8).map((record, index) =>
      rec({ ...record, ts: NOW - (index + 1) * DAY }),
    );
    expect(suggest(history, ctx()).length).toBeGreaterThan(0);
    expect(explainNoSuggestions(history, ctx())).toBeNull();
  });

  it("honours custom options", () => {
    const options: SuggestOptions = { minPayments: 3, minSpanDays: 1 };
    expect(suggest(pool(3), ctx(), options).length).toBeGreaterThan(0);
  });
});

describe("record eligibility", () => {
  it("ignores failed records", () => {
    const history = [...pool(9), rec({ id: "failed", ts: NOW - DAY, amountRaw: raw("500"), status: "failed" })];
    const suggestions = suggest(history, ctx());
    expect(find(suggestions, "unusual_payment_alert")).toBeUndefined();
    expect(find(suggestions, "auto_pay_threshold")?.evidence.max).toBe("10");
  });

  it("ignores confidential records", () => {
    const history = [
      ...pool(9),
      rec({ id: "conf", ts: NOW - DAY, amountRaw: raw("500"), mode: "confidential" }),
    ];
    expect(find(suggest(history, ctx()), "unusual_payment_alert")).toBeUndefined();
  });

  it("ignores private records", () => {
    const history = [
      ...pool(9),
      rec({ id: "priv", ts: NOW - DAY, amountRaw: raw("500"), mode: "private" }),
    ];
    expect(find(suggest(history, ctx()), "unusual_payment_alert")).toBeUndefined();
  });

  it("ignores other assets", () => {
    const history = [
      ...pool(9),
      rec({ id: "xlm", ts: NOW - DAY, amountRaw: raw("500"), asset: "XLM" }),
    ];
    expect(find(suggest(history, ctx()), "unusual_payment_alert")).toBeUndefined();
  });

  it("ignores records outside the window", () => {
    const history = [
      ...pool(9),
      rec({ id: "old", ts: NOW - 45 * DAY, amountRaw: raw("500") }),
    ];
    const explanation = explainNoSuggestions(history, ctx());
    expect(explanation).toBeNull();
    expect(find(suggest(history, ctx()), "auto_pay_threshold")?.evidence.count).toBe(9);
  });
});

describe("auto_pay_threshold", () => {
  it("fires with the p90 rounded UP to 5", () => {
    const threshold = find(suggest(capPool(), ctx()), "auto_pay_threshold");
    expect(threshold?.id).toBe("auto_pay_threshold:USDC:20");
    expect((threshold?.proposedChange as RuleDraft).perTxLimit).toBe("20");
  });

  it("is capped by the rule per_tx_limit and says so", () => {
    const context = ctx({ rule: { autoApproveLimit: "15", perTxLimit: "15" } });
    const threshold = find(suggest(capPool(), context), "auto_pay_threshold");
    expect(threshold?.id).toBe("auto_pay_threshold:USDC:15");
    expect(threshold?.rationale).toMatch(/Capped at your existing on-chain per-transaction limit of 15/);
  });

  it("only considers known contacts when a contact list is supplied", () => {
    const known = Array.from({ length: 8 }, (_, index) =>
      rec({
        id: `k${index}`,
        ts: NOW - (index + 1) * DAY,
        recipientAddress: addr(0),
        amountRaw: raw(String(10 + index)),
      }),
    );
    const history = [
      ...known,
      rec({ id: "stranger", ts: NOW - DAY, recipientAddress: addr(500), amountRaw: raw("1000") }),
    ];
    const context = ctx({ knownContacts: new Set([addr(0)]) });
    const threshold = find(suggest(history, context), "auto_pay_threshold");
    expect(threshold?.evidence).toMatchObject({ count: 8, median: "13.5", p90: "17", max: "17" });
  });

  it("returns no threshold when the rule cap is zero or negative", () => {
    const context = ctx({ rule: { perTxLimit: "0" } });
    expect(find(suggest(capPool(), context), "auto_pay_threshold")).toBeUndefined();
  });

  it("does not re-suggest when auto-pay is on and the threshold covers p90", () => {
    const context = ctx({ autoPayEnabled: true, rule: { autoApproveLimit: "20" } });
    expect(find(suggest(capPool(), context), "auto_pay_threshold")).toBeUndefined();
  });

  it("still suggests when auto-pay is on but the threshold is below p90", () => {
    const context = ctx({ autoPayEnabled: true, rule: { autoApproveLimit: "10" } });
    const threshold = find(suggest(capPool(), context), "auto_pay_threshold");
    expect(threshold?.id).toBe("auto_pay_threshold:USDC:20");
  });

  it("never proposes a threshold above the rounded-up maximum observed payment", () => {
    // max = 21 -> rounded-up maximum = 25; the proposal may not exceed it.
    const history = historyOf(["10", "11", "12", "13", "14", "15", "16", "17", "21"]);
    const threshold = find(suggest(history, ctx()), "auto_pay_threshold");
    expect((threshold?.proposedChange as RuleDraft).autoApproveLimit).toBe("25");
  });

  it("defaults to all public recipients when no contacts are known", () => {
    const threshold = find(suggest(pool(9), ctx()), "auto_pay_threshold");
    expect(threshold?.evidence.count).toBe(9);
    expect(threshold?.rationale).toMatch(/9 payments/);
  });
});

describe("auto_pay_threshold outlier robustness (B1)", () => {
  /** 9 records: 8 x 10 plus a single 1000 in the last 7 days (span 7d). */
  function outlierFixture(): HistoryRecord[] {
    return [
      ...Array.from({ length: 8 }, (_, index) =>
        rec({
          id: `o${index}`,
          ts: NOW - (index + 1) * DAY,
          recipientAddress: addr(index),
          amountRaw: raw("10"),
        }),
      ),
      rec({ id: "outlier", ts: NOW - DAY, recipientAddress: addr(900), amountRaw: raw("1000") }),
    ];
  }

  it("never lets a single outlier become the auto-approve threshold", () => {
    const threshold = find(suggest(outlierFixture(), ctx()), "auto_pay_threshold");
    expect(threshold).toBeDefined();
    expect(threshold?.id).toBe("auto_pay_threshold:USDC:10");
    expect((threshold?.proposedChange as RuleDraft).autoApproveLimit).toBe("10");
    expect(threshold?.evidence).toMatchObject({ count: 8, median: "10", p90: "10", max: "10" });
  });

  it("fires the unusual alert for the same outlier fixture", () => {
    const alert = find(suggest(outlierFixture(), ctx()), "unusual_payment_alert");
    expect(alert).toBeDefined();
    expect(alert?.evidence.amount).toBe("1000");
    expect(alert?.evidence.p90).toBe("10");
  });

  it("is stable for all-identical amounts (nothing is excluded)", () => {
    const threshold = find(suggest(pool(10), ctx()), "auto_pay_threshold");
    expect(threshold?.evidence).toMatchObject({ count: 10, median: "10", p90: "10", max: "10" });
    expect((threshold?.proposedChange as RuleDraft).autoApproveLimit).toBe("10");
  });

  it("requires minPayments to remain after outlier exclusion", () => {
    // 8 records total, 7 x 10 + 1 x 1000: after exclusion only 7 remain -> no threshold.
    const history = [
      ...Array.from({ length: 7 }, (_, index) =>
        rec({
          id: `s${index}`,
          ts: NOW - (index + 1) * DAY,
          recipientAddress: addr(index),
          amountRaw: raw("10"),
        }),
      ),
      rec({ id: "outlier", ts: NOW - 8 * DAY, recipientAddress: addr(900), amountRaw: raw("1000") }),
    ];
    expect(find(suggest(history, ctx()), "auto_pay_threshold")).toBeUndefined();
  });
});

describe("daily_limit", () => {
  it("rounds p95 daily total x 1.5 UP to 5", () => {
    const daily = find(suggest(capPool(), ctx()), "daily_limit");
    // daily totals are 10..20; p95 = 20; 20 x 1.5 = 30 -> already a multiple of 5.
    expect((daily?.proposedChange as RuleDraft).dailyLimit).toBe("30");
    expect(daily?.evidence.p95DailyTotal).toBe("20");
  });

  it("uses the p95 of active days across timezones safely", () => {
    const history = capPool();
    const dailyUtc = find(suggest(history, ctx({ timeZone: "UTC" })), "daily_limit");
    const dailyTokyo = find(suggest(history, ctx({ timeZone: "Asia/Tokyo" })), "daily_limit");
    expect(dailyUtc).toBeDefined();
    expect(dailyTokyo).toBeDefined();
  });

  it("does not fire without a stable set of active days", () => {
    // Enough history overall (9 payments over a 7-day span) but only 2 active days.
    const history = [
      ...Array.from({ length: 5 }, (_, index) =>
        rec({ id: `d0${index}`, ts: NOW - DAY, recipientAddress: addr(index), amountRaw: raw("10") }),
      ),
      ...Array.from({ length: 4 }, (_, index) =>
        rec({ id: `d1${index}`, ts: NOW - 8 * DAY, recipientAddress: addr(10 + index), amountRaw: raw("10") }),
      ),
    ];
    expect(find(suggest(history, ctx()), "auto_pay_threshold")).toBeDefined();
    expect(find(suggest(history, ctx()), "daily_limit")).toBeUndefined();
  });

  it("does not re-suggest an unchanged daily limit", () => {
    const context = ctx({ rule: { autoApproveLimit: "20", dailyLimit: "30" } });
    expect(find(suggest(capPool(), context), "daily_limit")).toBeUndefined();
  });
});

describe("daily_limit cap invariant (B2)", () => {
  it("clamps the fallback to the rule perTxLimit and carries the cap into the draft", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts, rule: { perTxLimit: "15" } });
    const daily = find(suggest(history, context), "daily_limit");
    expect(daily).toBeDefined();
    const draft = daily?.proposedChange as RuleDraft;
    expect(draft.autoApproveLimit).toBe("15");
    expect(draft.perTxLimit).toBe("15");
    expect(draft.dailyLimit).toBe("60");
    expect(daily?.rationale).toMatch(/capped at your existing on-chain per-transaction limit of 15/);
  });

  it("drops the daily suggestion when the rule ordering cannot hold", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts, rule: { autoApproveLimit: "50", perTxLimit: "15" } });
    expect(find(suggest(history, context), "daily_limit")).toBeUndefined();
  });
});

describe("daily_limit outlier robustness (B1-residual)", () => {
  /** 9 records: 8 x 10 plus a single 1000 (on one of the 10-days); no rule. */
  function singleOutlier(): HistoryRecord[] {
    return [
      ...Array.from({ length: 8 }, (_, index) =>
        rec({
          id: `o${index}`,
          ts: NOW - (index + 1) * DAY,
          recipientAddress: addr(index),
          amountRaw: raw("10"),
        }),
      ),
      rec({ id: "outlier", ts: NOW - DAY, recipientAddress: addr(900), amountRaw: raw("1000") }),
    ];
  }

  /** `tens` x 10 plus two 1000 outliers, spread over distinct days. */
  function twoOutliers(tens: number): HistoryRecord[] {
    const records = Array.from({ length: tens }, (_, index) =>
      rec({ id: `t${index}`, ts: NOW - (index + 1) * DAY, recipientAddress: addr(index), amountRaw: raw("10") }),
    );
    records.push(
      rec({ id: "out-a", ts: NOW - (tens + 1) * DAY, recipientAddress: addr(900), amountRaw: raw("1000") }),
    );
    records.push(
      rec({ id: "out-b", ts: NOW - (tens + 2) * DAY, recipientAddress: addr(901), amountRaw: raw("1000") }),
    );
    return records;
  }

  it("never carries the full-pool p90/max (1000) as the required autoApproveLimit", () => {
    const history = singleOutlier();
    const daily = find(suggest(history, ctx()), "daily_limit");
    expect(daily).toBeDefined();
    const draft = daily?.proposedChange as RuleDraft;
    expect(draft.autoApproveLimit).toBe("10");
    expect(draft.autoApproveLimit).not.toBe("1000");
    // The robust fallback agrees with the auto_pay_threshold proposal (single source of truth).
    const threshold = find(suggest(history, ctx()), "auto_pay_threshold");
    expect((threshold?.proposedChange as RuleDraft).autoApproveLimit).toBe("10");
  });

  it("drops the daily suggestion when no robust value survives exclusion", () => {
    // 8 records total, 7 x 10 + 1 x 1000: after robust exclusion only 7 remain (< minPayments).
    const history = [
      ...Array.from({ length: 7 }, (_, index) =>
        rec({
          id: `s${index}`,
          ts: NOW - (index + 1) * DAY,
          recipientAddress: addr(index),
          amountRaw: raw("10"),
        }),
      ),
      rec({ id: "outlier", ts: NOW - 8 * DAY, recipientAddress: addr(900), amountRaw: raw("1000") }),
    ];
    expect(find(suggest(history, ctx()), "auto_pay_threshold")).toBeUndefined();
    expect(find(suggest(history, ctx()), "daily_limit")).toBeUndefined();
  });

  it("stays robust with 10 records and two outliers", () => {
    const daily = find(suggest(twoOutliers(8), ctx()), "daily_limit");
    expect((daily?.proposedChange as RuleDraft).autoApproveLimit).toBe("10");
  });

  it("stays robust with 11 records and two outliers", () => {
    const daily = find(suggest(twoOutliers(9), ctx()), "daily_limit");
    expect((daily?.proposedChange as RuleDraft).autoApproveLimit).toBe("10");
  });

  it("property: every RuleDraft is outlier-bounded and correctly ordered (300 seeded histories)", () => {
    const rng = makeRng(20260920);
    let ruleDrafts = 0;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const count = randInt(rng, 8, 40);
      const history: HistoryRecord[] = [];
      for (let index = 0; index < count; index += 1) {
        // The first record is pinned to day 29 so the window span is (almost) always >= minSpanDays.
        const offset = index === 0 ? 29 : randInt(rng, 1, 29);
        const amount = rng() < 0.1 ? String(randInt(rng, 200, 2000)) : String(randInt(rng, 1, 50));
        history.push(
          rec({
            id: `h${iteration}-${index}`,
            ts: NOW - offset * DAY,
            recipientAddress: addr(index),
            amountRaw: raw(amount),
          }),
        );
      }
      // Rule shapes never carry `autoApproveLimit`, so every draft's threshold is engine-derived.
      const roll = rng();
      const rule =
        roll < 0.4
          ? undefined
          : roll < 0.7
            ? { perTxLimit: String(randInt(rng, 1, 60)) }
            : { perTxLimit: String(randInt(rng, 1, 60)), dailyLimit: String(randInt(rng, 60, 200)) };
      const suggestions = suggest(history, ctx({ rule }));

      // Independent oracle: robust pool over the eligible (all public/confirmed/USDC, in window) amounts.
      const amounts = sortBigints(history.map((record) => record.amountRaw));
      const robust = dropAmountOutliers(amounts, 3);
      const robustMaxRounded = roundUpToDisplayMultiple(maxOf(robust), DECIMALS, ROUNDING_STEP_DISPLAY);

      for (const suggestion of suggestions) {
        if (suggestion.kind !== "auto_pay_threshold" && suggestion.kind !== "daily_limit") continue;
        const draft = suggestion.proposedChange as RuleDraft;
        ruleDrafts += 1;
        const autoApprove = parseAmount(draft.autoApproveLimit, DECIMALS);
        expect(autoApprove).toBeGreaterThanOrEqual(0n);
        expect(autoApprove).toBeLessThanOrEqual(robustMaxRounded);
        if (rule?.perTxLimit !== undefined) {
          expect(autoApprove).toBeLessThanOrEqual(parseAmount(rule.perTxLimit, DECIMALS));
        }
        if (draft.perTxLimit !== undefined) {
          const perTx = parseAmount(draft.perTxLimit, DECIMALS);
          expect(autoApprove).toBeLessThanOrEqual(perTx);
          if (rule?.perTxLimit !== undefined) {
            expect(perTx).toBeLessThanOrEqual(parseAmount(rule.perTxLimit, DECIMALS));
          }
        }
        if (draft.dailyLimit !== undefined) {
          const daily = parseAmount(draft.dailyLimit, DECIMALS);
          if (draft.perTxLimit !== undefined) {
            expect(parseAmount(draft.perTxLimit, DECIMALS)).toBeLessThanOrEqual(daily);
          } else {
            expect(autoApprove).toBeLessThanOrEqual(daily);
          }
        }
        expect(() => JSON.stringify(suggestion.proposedChange)).not.toThrow();
      }
    }
    // The generator must actually exercise both kinds, not trivially pass with zero drafts.
    expect(ruleDrafts).toBeGreaterThan(50);
  });
});

describe("schedule_from_recurrence", () => {
  const repeated = addr(999);
  const filler = pool(9);

  function recurring(offsets: number[], amounts: string[]): HistoryRecord[] {
    return offsets.map((offset, index) =>
      rec({
        id: `g${index}`,
        ts: NOW - offset * DAY,
        recipientAddress: repeated,
        recipientAlias: "ada",
        amountRaw: raw(amounts[index] ?? "10"),
      }),
    );
  }

  it("fires for a weekly cadence with 4 occurrences", () => {
    const history = [...filler, ...recurring([28, 21, 14, 7], ["10", "10", "10", "10"])];
    const schedule = find(suggest(history, ctx()), "schedule_from_recurrence");
    expect(schedule).toBeDefined();
    expect(schedule?.evidence.occurrences).toBe(4);
    expect(schedule?.evidence.intervalSecs).toBe(7 * DAY);
    const draft = schedule?.proposedChange as ScheduleDraft;
    expect(draft.recipient).toBe(repeated);
    expect(draft.amount).toBe("10");
    expect(draft.intervalSecs).toBe(7 * DAY);
    expect(draft.runs).toBe(12);
    // B3: strictly after `now` (the next regular slot, not the already-due one).
    expect(draft.firstRunAt).toBe(NOW + 7 * DAY);
  });

  function recurringSeconds(offsets: number[], amounts: string[]): HistoryRecord[] {
    return offsets.map((offset, index) =>
      rec({
        id: `s${index}`,
        ts: NOW - offset,
        recipientAddress: repeated,
        recipientAlias: "ada",
        amountRaw: raw(amounts[index] ?? "10"),
      }),
    );
  }

  it("accepts interval jitter at exactly 10% (boundary)", () => {
    // intervals 19s, 20s, 21s -> range 2s, mean 20s -> jitter exactly 10%.
    const history = [...filler, ...recurringSeconds([60, 41, 21, 0], ["10", "10", "10", "10"])];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeDefined();
  });

  it("rejects interval jitter just above 10% (boundary)", () => {
    // intervals 9s, 10s, 10s -> range 1s, mean 29/3s -> jitter ~10.34%.
    const history = [...filler, ...recurringSeconds([29, 20, 10, 0], ["10", "10", "10", "10"])];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeUndefined();
  });

  it("never proposes a firstRunAt in the past (B3)", () => {
    // Weekly recurrence whose last payment was 16 days ago (still inside the 30-day window).
    const history = [...filler, ...recurring([30, 23, 16], ["10", "10", "10"])];
    const schedule = find(suggest(history, ctx()), "schedule_from_recurrence");
    expect(schedule).toBeDefined();
    const draft = schedule?.proposedChange as ScheduleDraft;
    expect(draft.firstRunAt).toBeGreaterThan(NOW);
  });

  it("does not propose a zero-amount schedule", () => {
    const history = [...filler, ...recurring([28, 21, 14], ["0", "0", "0"])];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeUndefined();
  });

  it("accepts interval jitter within 10%", () => {
    const history = [
      ...filler,
      ...recurring([28, 21, 14, 7], ["10", "10", "10", "10"]).map((record, index) =>
        index === 2 ? rec({ ...record, ts: record.ts + 7200 }) : record,
      ),
    ];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeDefined();
  });

  it("rejects interval jitter above 10%", () => {
    const irregular = [
      rec({ id: "g0", ts: NOW - 28 * DAY, recipientAddress: repeated, amountRaw: raw("10"), recipientAlias: "ada" }),
      rec({ id: "g1", ts: NOW - 21 * DAY, recipientAddress: repeated, amountRaw: raw("10"), recipientAlias: "ada" }),
      rec({ id: "g2", ts: NOW - 11 * DAY, recipientAddress: repeated, amountRaw: raw("10"), recipientAlias: "ada" }),
      rec({ id: "g3", ts: NOW - 4 * DAY, recipientAddress: repeated, amountRaw: raw("10"), recipientAlias: "ada" }),
    ];
    const schedule = find(suggest([...filler, ...irregular], ctx()), "schedule_from_recurrence");
    expect(schedule).toBeUndefined();
  });

  it("rejects amounts outside the tolerance", () => {
    const history = [...filler, ...recurring([28, 21, 14, 7], ["10", "10", "10", "20"])];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeUndefined();
  });

  it("does not fire below 3 occurrences", () => {
    const history = [...filler, ...recurring([14, 7], ["10", "10"])];
    expect(find(suggest(history, ctx()), "schedule_from_recurrence")).toBeUndefined();
  });

  it("always proposes a finite, positive number of runs", () => {
    const history = [...filler, ...recurring([28, 21, 14, 7], ["10", "10", "10", "10"])];
    const draft = find(suggest(history, ctx()), "schedule_from_recurrence")?.proposedChange as ScheduleDraft;
    expect(Number.isFinite(draft.runs)).toBe(true);
    expect(draft.runs).toBeGreaterThan(0);
    expect(draft.runs).toBeLessThanOrEqual(52);
  });
});

describe("tighten_dormant", () => {
  it("fires when auto-pay has been enabled longer than 30 days with no use", () => {
    const context = ctx({ autoPayEnabled: true, autoPayEnabledSince: NOW - 40 * DAY });
    const dormant = find(suggest(pool(9), context), "tighten_dormant");
    expect(dormant).toBeDefined();
    expect(dormant?.evidence.unusedDays).toBe(40);
    expect(dormant?.evidence.lastUsedDays).toBeUndefined();
    expect((dormant?.proposedChange as DisableAutoPay).kind).toBe("disable_auto_pay");
  });

  it("does not fire 'never used' without autoPayEnabledSince (conservative)", () => {
    expect(find(suggest(pool(9), ctx({ autoPayEnabled: true })), "tighten_dormant")).toBeUndefined();
  });

  it("does not fire when auto-pay was just enabled", () => {
    const context = ctx({ autoPayEnabled: true, autoPayEnabledSince: NOW - 5 * DAY });
    expect(find(suggest(pool(9), context), "tighten_dormant")).toBeUndefined();
  });

  it("honours a recent lastAutoPayUse hint for confidential usage", () => {
    const context = ctx({
      autoPayEnabled: true,
      autoPayEnabledSince: NOW - 40 * DAY,
      lastAutoPayUse: NOW - 3 * DAY,
    });
    expect(find(suggest(pool(9), context), "tighten_dormant")).toBeUndefined();
  });

  it("fires when the lastAutoPayUse hint is older than 30 days", () => {
    const context = ctx({
      autoPayEnabled: true,
      autoPayEnabledSince: NOW - 40 * DAY,
      lastAutoPayUse: NOW - 35 * DAY,
    });
    const dormant = find(suggest(pool(9), context), "tighten_dormant");
    expect(dormant).toBeDefined();
    expect(dormant?.evidence.unusedDays).toBe(35);
  });

  it("fires when the last pay_executor use is older than 30 days (larger window)", () => {
    const history = [
      ...pool(9),
      rec({ id: "auto", ts: NOW - 40 * DAY, amountRaw: raw("8"), route: "pay_executor" }),
    ];
    const dormant = find(suggest(history, ctx({ autoPayEnabled: true }), { windowDays: 60 }), "tighten_dormant");
    expect(dormant?.evidence.unusedDays).toBe(40);
    expect(dormant?.evidence.lastUsedDays).toBe(40);
  });

  it("does not fire when pay_executor was used recently", () => {
    const history = [
      ...pool(9),
      rec({ id: "auto", ts: NOW - 5 * DAY, amountRaw: raw("8"), route: "pay_executor" }),
    ];
    expect(find(suggest(history, ctx({ autoPayEnabled: true })), "tighten_dormant")).toBeUndefined();
  });

  it("does not fire when auto-pay is disabled", () => {
    expect(find(suggest(pool(9), ctx({ autoPayEnabled: false })), "tighten_dormant")).toBeUndefined();
  });
});

describe("unusual_payment_alert", () => {
  function outlierPool(outlier: string, outlierOffset = 0): HistoryRecord[] {
    const base = Array.from({ length: 19 }, (_, index) =>
      rec({
        id: `u${String(index).padStart(2, "0")}`,
        ts: NOW - (index + 1) * DAY,
        recipientAddress: addr(index),
        amountRaw: raw("10"),
      }),
    );
    return [
      ...base,
      rec({ id: "outlier", ts: NOW - outlierOffset * DAY, recipientAddress: addr(900), amountRaw: raw(outlier) }),
    ];
  }

  it("fires for a payment greater than 3x p90 in the last 7 days", () => {
    const alert = find(suggest(outlierPool("50"), ctx()), "unusual_payment_alert");
    expect(alert).toBeDefined();
    expect(alert?.evidence.amount).toBe("50");
    expect(alert?.evidence.p90).toBe("10");
    expect(alert?.evidence.ratio).toBe("5.0");
    expect(alert?.evidence.ratioWindowDays).toBe(7);
    expect((alert?.proposedChange as NoChange).kind).toBe("none");
  });

  it("does not fire at exactly 3x p90", () => {
    expect(find(suggest(outlierPool("30"), ctx()), "unusual_payment_alert")).toBeUndefined();
  });

  it("does not fire outside the 7-day window", () => {
    expect(find(suggest(outlierPool("50", 10), ctx()), "unusual_payment_alert")).toBeUndefined();
  });
});

describe("dismissal", () => {
  it("omits a suggestion dismissed by id", () => {
    const { history, contacts } = workedExampleHistory();
    const id = "auto_pay_threshold:USDC:20";
    const suggestions = suggest(history, ctx({ knownContacts: contacts, dismissed: new Set([id]) }));
    expect(find(suggestions, "auto_pay_threshold")).toBeUndefined();
    expect(find(suggestions, "daily_limit")).toBeDefined();
  });

  it("omits a suggestion dismissed by kind", () => {
    const { history, contacts } = workedExampleHistory();
    const suggestions = suggest(history, ctx({ knownContacts: contacts, dismissed: new Set(["daily_limit"]) }));
    expect(find(suggestions, "daily_limit")).toBeUndefined();
    expect(find(suggestions, "auto_pay_threshold")).toBeDefined();
  });

  it("can dismiss everything", () => {
    const { history, contacts } = workedExampleHistory();
    const dismissed = new Set(["auto_pay_threshold", "daily_limit"]);
    expect(suggest(history, ctx({ knownContacts: contacts, dismissed }))).toEqual([]);
  });
});

describe("sorting", () => {
  it("orders by kind priority then id", () => {
    const repeated = addr(999);
    const records: HistoryRecord[] = [];
    for (let index = 0; index < 16; index += 1) {
      records.push(
        rec({ id: `f${index}`, ts: NOW - (index + 1) * DAY, recipientAddress: addr(index), amountRaw: raw("10") }),
      );
    }
    for (const offset of [28, 21, 14]) {
      records.push(
        rec({ id: `g${offset}`, ts: NOW - offset * DAY, recipientAddress: repeated, amountRaw: raw("10") }),
      );
    }
    records.push(rec({ id: "outlier", ts: NOW - DAY, recipientAddress: addr(900), amountRaw: raw("50") }));

    const context = ctx({
      autoPayEnabled: true,
      autoPayEnabledSince: NOW - 40 * DAY,
      rule: { autoApproveLimit: "0" },
    });
    const kinds = suggest(records, context).map((suggestion) => suggestion.kind);
    expect(kinds).toEqual([
      "auto_pay_threshold",
      "daily_limit",
      "schedule_from_recurrence",
      "tighten_dormant",
      "unusual_payment_alert",
    ]);
  });
});

describe("bigint safety", () => {
  it("handles amounts near i128 max without floats or overflow", () => {
    const huge = (1n << 127n) - 1n;
    const history = Array.from({ length: 9 }, (_, index) =>
      rec({
        id: `b${index}`,
        ts: NOW - (index + 1) * DAY,
        recipientAddress: addr(index),
        amountRaw: huge - BigInt(index),
      }),
    );
    const threshold = find(suggest(history, ctx()), "auto_pay_threshold");
    expect(threshold).toBeDefined();
    expect(threshold?.evidence.max).not.toMatch(/e/i);
    expect(threshold?.evidence.p90).not.toContain("Infinity");
  });
});

describe("determinism", () => {
  it("returns a deep-equal result for the same input twice", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts });
    expect(suggest(history, context)).toEqual(suggest(history, context));
  });

  it("is independent of input array order", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts });
    const reversed = [...history].reverse();
    expect(suggest(reversed, context)).toEqual(suggest(history, context));
  });

  it("is deterministic for a seeded random fixture", () => {
    const build = (): HistoryRecord[] => {
      const rng = makeRng(20260919);
      return Array.from({ length: 12 }, (_, index) =>
        rec({
          id: `x${index}`,
          ts: NOW - randInt(rng, 1, 25) * DAY,
          recipientAddress: addr(randInt(rng, 0, 5)),
          amountRaw: raw(String(randInt(rng, 1, 40))),
        }),
      );
    };
    const context = ctx();
    expect(suggest(build(), context)).toEqual(suggest(build(), context));
  });

  it("keeps ids stable across shuffled input", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts });
    const ids = suggest(history, context).map((suggestion) => suggestion.id);
    const shuffled = suggest([...history].reverse(), context).map((suggestion) => suggestion.id);
    expect(shuffled).toEqual(ids);
  });
});

describe("aliases in evidence", () => {
  it("does not put aliases into aggregate evidence", () => {
    const history = [
      ...pool(9),
      rec({ id: "alias", recipientAddress: addr(42), recipientAlias: "ada", amountRaw: raw("10") }),
    ];
    const suggestions = suggest(history, ctx());
    for (const alias of aliasesOf(history)) {
      for (const suggestion of suggestions) {
        expect(JSON.stringify(suggestion.evidence)).not.toContain(alias);
      }
    }
  });
});

describe("data hygiene", () => {
  it("de-duplicates history records by id (keeps the first occurrence)", () => {
    const base = pool(9);
    const first = base[0] as HistoryRecord;
    const duplicate = rec({ ...first, amountRaw: raw("10") });
    const history = [...base, duplicate];
    const threshold = find(suggest(history, ctx()), "auto_pay_threshold");
    // Without de-duplication this would count 10 records.
    expect(threshold?.evidence.count).toBe(9);
  });

  it("toLlmSafeEvidence returns a deep copy", () => {
    const { history, contacts } = workedExampleHistory();
    const suggestion = find(
      suggest(history, ctx({ knownContacts: contacts })),
      "auto_pay_threshold",
    ) as Suggestion;
    const safe = toLlmSafeEvidence(suggestion);
    safe.evidence.count = 12345;
    (safe.proposal as Record<string, number | string>).autoApproveLimit = "999";
    expect(suggestion.evidence.count).toBe(14);
    expect((suggestion.proposedChange as RuleDraft).autoApproveLimit).toBe("20");
  });

  it("does not throw on a malformed rule string and drops the affected kind", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts, rule: { perTxLimit: "not-a-number" } });
    expect(() => suggest(history, context)).not.toThrow();
    expect(find(suggest(history, context), "auto_pay_threshold")).toBeUndefined();
    expect(find(suggest(history, context), "daily_limit")).toBeUndefined();
  });

  it("drops only the daily suggestion when rule.dailyLimit is malformed", () => {
    const { history, contacts } = workedExampleHistory();
    const context = ctx({ knownContacts: contacts, rule: { dailyLimit: "oops" } });
    expect(find(suggest(history, context), "daily_limit")).toBeUndefined();
    expect(find(suggest(history, context), "auto_pay_threshold")).toBeDefined();
  });

  it("exposes a typed SuggestInputError only from the explicit validator", () => {
    expect(() => validateSuggestContext(ctx({ rule: { perTxLimit: "x" } }))).toThrow(SuggestInputError);
    expect(() => validateSuggestContext(ctx())).not.toThrow();
  });
});
