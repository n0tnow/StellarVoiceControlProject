import { describe, expect, it } from "vitest";
import { I128_MAX } from "../../guard/amount.ts";
import { EXECUTOR, RULE } from "../../guard/__tests__/helpers.ts";
import {
  ApprovalError,
  DEFAULT_ALLOWANCE_DAYS,
  MAX_ALLOWED_ASSETS,
  assertAssetMatchesRule,
  makeAutoPayDraft,
  ruleFromDraft,
  validateAutoPayDraft,
  type AutoPayDraft,
} from "../types.ts";
import { ASSET_SAC, DRAFT, USDC_SAC } from "./fixtures.ts";

function expectCode(fn: () => void, code: string): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ApprovalError);
    expect((e as ApprovalError).code).toBe(code);
    return;
  }
  throw new Error(`expected ApprovalError(${code})`);
}

function draftWith(over: Partial<AutoPayDraft>): AutoPayDraft {
  return { ...DRAFT, ...over };
}

describe("makeAutoPayDraft — decimal strings to raw units", () => {
  it("converts every amount through toRawUnits (7-dp fixed point)", () => {
    const draft = makeAutoPayDraft({
      executor: EXECUTOR,
      threshold: "25",
      perTxLimit: "0.5",
      dailyLimit: "100.1234567",
      allowedAssets: [ASSET_SAC],
      knownRecipientsOnly: false,
      allowance: "300.0000001",
      allowanceDays: 7,
    });
    expect(draft.thresholdRaw).toBe(250_000000n);
    expect(draft.perTxLimitRaw).toBe(5_000000n);
    expect(draft.dailyLimitRaw).toBe(1_001_234_567n);
    expect(draft.allowanceRaw).toBe(3_000_000_001n);
    expect(draft.allowanceDays).toBe(7);
  });

  it("defaults the allowance to daily * 7 and the window to 30 days", () => {
    const draft = makeAutoPayDraft({
      executor: EXECUTOR,
      threshold: "1",
      perTxLimit: "1",
      dailyLimit: "10",
      allowedAssets: [ASSET_SAC],
      knownRecipientsOnly: true,
    });
    expect(draft.allowanceRaw).toBe(70_0000000n);
    expect(draft.allowanceDays).toBe(DEFAULT_ALLOWANCE_DAYS);
  });

  it("throws invalid_amount_string for a non-decimal amount", () => {
    expectCode(
      () =>
        makeAutoPayDraft({
          executor: EXECUTOR,
          threshold: "abc",
          perTxLimit: "1",
          dailyLimit: "1",
          allowedAssets: [ASSET_SAC],
          knownRecipientsOnly: true,
        }),
      "invalid_amount_string",
    );
  });

  it("throws invalid_amount_string for too many fraction digits", () => {
    expectCode(
      () =>
        makeAutoPayDraft({
          executor: EXECUTOR,
          threshold: "1.00000001",
          perTxLimit: "1",
          dailyLimit: "1",
          allowedAssets: [ASSET_SAC],
          knownRecipientsOnly: true,
        }),
      "invalid_amount_string",
    );
  });

  it("ruleFromDraft maps snake_case field-by-field", () => {
    expect(ruleFromDraft(DRAFT)).toEqual({
      auto_approve_limit: 250_000000n,
      per_tx_limit: 500_000000n,
      daily_limit: 1_000_000000n,
      allowed_assets: [ASSET_SAC],
      known_recipients_only: true,
    });
  });
});

describe("validateAutoPayDraft — contract mirror + app-stricter rules", () => {
  it("accepts a valid draft", () => {
    expect(() => validateAutoPayDraft(DRAFT)).not.toThrow();
  });

  it("accepts auto_approve_limit == 0 (the contract's 'always ask me')", () => {
    expect(() => validateAutoPayDraft(draftWith({ thresholdRaw: 0n }))).not.toThrow();
  });

  it("rejects a malformed executor", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ executor: "not-an-address" })), "invalid_executor");
  });

  it("rejects a negative threshold", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ thresholdRaw: -1n })), "threshold_negative");
  });

  it("rejects a zero per_tx_limit", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ perTxLimitRaw: 0n, thresholdRaw: 0n })),
      "non_positive_limit",
    );
  });

  it("rejects a negative daily_limit", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ dailyLimitRaw: -5n })),
      "non_positive_limit",
    );
  });

  it("rejects a zero allowance", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowanceRaw: 0n })), "non_positive_limit");
  });

  it("rejects threshold > per_tx", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ thresholdRaw: 600_000000n })),
      "limit_order",
    );
  });

  it("rejects per_tx > daily", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ perTxLimitRaw: 2_000_000000n })),
      "limit_order",
    );
  });

  it("rejects more than one allowed asset (contract effective max)", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ allowedAssets: [ASSET_SAC, ASSET_SAC] })),
      "too_many_assets",
    );
    expect(MAX_ALLOWED_ASSETS).toBe(1);
  });

  it("rejects an empty allowed-asset list", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowedAssets: [] })), "no_assets");
  });

  it("rejects an allowance below the daily limit", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowanceRaw: 50_000000n })), "allowance_too_small");
  });

  it("rejects allowanceDays below 1", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowanceDays: 0 })), "invalid_allowance_days");
  });

  it("rejects allowanceDays above 90", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowanceDays: 91 })), "invalid_allowance_days");
  });

  it("rejects a non-integer allowanceDays", () => {
    expectCode(() => validateAutoPayDraft(draftWith({ allowanceDays: 1.5 })), "invalid_allowance_days");
  });

  it("rejects an amount above i128::MAX", () => {
    expectCode(
      () => validateAutoPayDraft(draftWith({ dailyLimitRaw: I128_MAX + 1n })),
      "amount_out_of_range",
    );
  });

  it("rejects a non-bigint amount at the type boundary", () => {
    expectCode(
      () =>
        validateAutoPayDraft(draftWith({ thresholdRaw: "25" as unknown as bigint })),
      "amount_out_of_range",
    );
  });

  it("names and codes the error for the app to switch on", () => {
    const err = new ApprovalError("limit_order", "boom");
    expect(err.name).toBe("ApprovalError");
    expect(err.code).toBe("limit_order");
    expect(err.message).toBe("boom");
  });
});

describe("assertAssetMatchesRule — allowance target vs rule allowlist (NB4)", () => {
  it("accepts the matching first allowed asset", () => {
    expect(() => assertAssetMatchesRule(RULE.allowed_assets[0], RULE)).not.toThrow();
  });

  it("accepts an unknown target (nothing to cross-check)", () => {
    expect(() => assertAssetMatchesRule(undefined, RULE)).not.toThrow();
  });

  it("rejects a valid C... that differs from rule.allowed_assets[0]", () => {
    expectCode(() => assertAssetMatchesRule(USDC_SAC, RULE), "invalid_asset");
  });

  it("the enable draft cross-check passes for its own (matching) asset", () => {
    expect(() => validateAutoPayDraft(DRAFT)).not.toThrow();
  });
});
