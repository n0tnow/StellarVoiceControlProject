import { describe, expect, it } from "vitest";
import { toLlmSafeEvidence } from "../suggest.ts";
import { suggest } from "../suggest.ts";
import type { HistoryRecord, ScheduleDraft, SuggestionKind } from "../types.ts";
import { DAY, NOW, addr, aliasesOf, addressesOf, ctx, raw, rec } from "./helpers.ts";

const ALL_KINDS: SuggestionKind[] = [
  "auto_pay_threshold",
  "daily_limit",
  "schedule_from_recurrence",
  "tighten_dormant",
  "unusual_payment_alert",
];

/** A fixture that fires every suggestion kind and contains addresses + aliases. */
function allKindsFixture(): HistoryRecord[] {
  const repeated = addr(999);
  const history: HistoryRecord[] = [];
  for (let index = 0; index < 16; index += 1) {
    history.push(
      rec({
        id: `f${index}`,
        ts: NOW - (index + 1) * DAY,
        recipientAddress: addr(index),
        recipientAlias: `contact-${index}`,
        amountRaw: raw("10"),
      }),
    );
  }
  for (const offset of [28, 21, 14]) {
    history.push(
      rec({
        id: `g${offset}`,
        ts: NOW - offset * DAY,
        recipientAddress: repeated,
        recipientAlias: "ada",
        amountRaw: raw("10"),
      }),
    );
  }
  history.push(rec({ id: "outlier", ts: NOW - DAY, recipientAddress: addr(900), amountRaw: raw("50") }));
  return history;
}

function allKindsContext() {
  return ctx({
    autoPayEnabled: true,
    autoPayEnabledSince: NOW - 40 * DAY,
    rule: { autoApproveLimit: "0" },
  });
}

describe("toLlmSafeEvidence", () => {
  it("has a fixture that fires every kind", () => {
    const kinds = suggest(allKindsFixture(), allKindsContext()).map((suggestion) => suggestion.kind);
    expect([...kinds].sort()).toEqual([...ALL_KINDS].sort());
  });

  it("never leaks an address or alias for any kind", () => {
    const history = allKindsFixture();
    const addresses = addressesOf(history);
    const aliases = aliasesOf(history);
    const suggestions = suggest(history, allKindsContext());
    expect(suggestions.length).toBeGreaterThanOrEqual(ALL_KINDS.length);
    for (const suggestion of suggestions) {
      const safeJson = JSON.stringify(toLlmSafeEvidence(suggestion));
      for (const address of addresses) expect(safeJson).not.toContain(address);
      for (const alias of aliases) expect(safeJson).not.toContain(alias);
    }
  });

  it("is not vacuously safe: the proposals do contain a recipient", () => {
    const history = allKindsFixture();
    const schedule = suggest(history, allKindsContext()).find(
      (suggestion) => suggestion.kind === "schedule_from_recurrence",
    );
    expect(JSON.stringify(schedule)).toContain(addr(999));
  });

  it("returns only kind, evidence and proposal", () => {
    for (const suggestion of suggest(allKindsFixture(), allKindsContext())) {
      const safe = toLlmSafeEvidence(suggestion);
      expect(Object.keys(safe).sort()).toEqual(["evidence", "kind", "proposal"]);
      expect(safe).not.toHaveProperty("id");
      expect(safe).not.toHaveProperty("rationale");
      expect(safe).not.toHaveProperty("title");
      expect(safe).not.toHaveProperty("proposedChange");
    }
  });

  it("keeps the recurrence proposal numeric (no recipient)", () => {
    const schedule = suggest(allKindsFixture(), allKindsContext()).find(
      (suggestion) => suggestion.kind === "schedule_from_recurrence",
    );
    const safe = toLlmSafeEvidence(schedule!);
    expect(Object.keys(safe.proposal).sort()).toEqual(["amount", "intervalSecs", "runs"]);
    expect((schedule?.proposedChange as ScheduleDraft).recipient).toBe(addr(999));
  });

  it("exposes the numeric threshold proposal", () => {
    const threshold = suggest(allKindsFixture(), allKindsContext()).find(
      (suggestion) => suggestion.kind === "auto_pay_threshold",
    );
    expect(toLlmSafeEvidence(threshold!).proposal).toEqual({ autoApproveLimit: "10" });
  });

  it("exposes a daily-limit proposal", () => {
    const daily = suggest(allKindsFixture(), allKindsContext()).find(
      (suggestion) => suggestion.kind === "daily_limit",
    );
    expect(toLlmSafeEvidence(daily!).proposal).toHaveProperty("dailyLimit");
  });

  it("describes the dormant action without any identifier", () => {
    const dormant = suggest(allKindsFixture(), allKindsContext()).find(
      (suggestion) => suggestion.kind === "tighten_dormant",
    );
    expect(toLlmSafeEvidence(dormant!).proposal).toEqual({ action: "disable_auto_pay" });
  });

  it("describes the unusual-payment action without any identifier", () => {
    const unusual = suggest(allKindsFixture(), allKindsContext()).find(
      (suggestion) => suggestion.kind === "unusual_payment_alert",
    );
    expect(toLlmSafeEvidence(unusual!).proposal).toEqual({ action: "require_extra_confirmation" });
  });

  it("does not include per-payment timestamps", () => {
    for (const suggestion of suggest(allKindsFixture(), allKindsContext())) {
      const safeJson = JSON.stringify(toLlmSafeEvidence(suggestion));
      expect(safeJson).not.toContain(String(NOW));
    }
  });
});
