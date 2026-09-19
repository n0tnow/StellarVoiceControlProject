import { describe, expect, it } from "vitest";
import { formatRawAmount, readBack, readBackDisable } from "../readback.ts";
import { makeAutoPayDraft } from "../types.ts";
import { ASSET_SAC, DRAFT, EXECUTOR, FIXED_NOW } from "./fixtures.ts";

describe("readBack — exact D10c sentence", () => {
  it("matches the documented sentence for saved-contacts-only", () => {
    const draft = makeAutoPayDraft({
      executor: EXECUTOR,
      threshold: "25",
      perTxLimit: "50",
      dailyLimit: "100",
      allowedAssets: [ASSET_SAC],
      knownRecipientsOnly: true,
      allowanceDays: 30,
    });
    expect(readBack(draft, { assetSymbol: "USDC" })).toBe(
      "Allow automatic payments up to 25 USDC, max 100 USDC per day, to saved contacts only, for 30 days? This needs your approval.",
    );
  });

  it("renders 'to anyone' when known_recipients_only is off", () => {
    const draft = { ...DRAFT, knownRecipientsOnly: false };
    expect(readBack(draft, { assetSymbol: "USDC" })).toBe(
      "Allow automatic payments up to 25 USDC, max 100 USDC per day, to anyone, for 30 days? This needs your approval.",
    );
  });

  it("accepts the clock/time zone options without changing the sentence", () => {
    const a = readBack(DRAFT, { assetSymbol: "USDC", now: FIXED_NOW, timeZone: "Europe/Istanbul" });
    const b = readBack(DRAFT, { assetSymbol: "USDC" });
    expect(a).toBe(b);
  });

  it("formats 7-dp raw units without float artifacts", () => {
    const draft = makeAutoPayDraft({
      executor: EXECUTOR,
      threshold: "0.3",
      perTxLimit: "0.3",
      dailyLimit: "0.3",
      allowedAssets: [ASSET_SAC],
      knownRecipientsOnly: true,
      allowance: "2.1",
      allowanceDays: 30,
    });
    const sentence = readBack(draft, { assetSymbol: "USDC" });
    expect(sentence).toContain("up to 0.3 USDC, max 0.3 USDC per day");
    expect(sentence).not.toContain("0.30000000000000004");
  });

  it("trims trailing zeros from whole amounts", () => {
    expect(formatRawAmount(25_0000000n)).toBe("25");
    expect(formatRawAmount(105_0000000n)).toBe("105");
    expect(formatRawAmount(1n)).toBe("0.0000001");
  });
});

describe("readBackDisable", () => {
  it("mentions the allowance revoke when requested", () => {
    expect(readBackDisable({ assetSymbol: "USDC", revokeAllowance: true })).toBe(
      "Stop automatic payments and revoke the remaining USDC allowance? This needs your confirmation.",
    );
  });

  it("is a plain stop when the allowance is kept", () => {
    expect(readBackDisable({ assetSymbol: "USDC", revokeAllowance: false })).toBe(
      "Stop automatic payments? This needs your confirmation.",
    );
  });
});
