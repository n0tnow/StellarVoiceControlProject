import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { buildPaymentSummary, formatAmount, payloadHashOf, stroopsToXlm, toHex } from "../summary.ts";
import { baseIntent, makeDeps, runPayment } from "./helpers.ts";

describe("summary helpers", () => {
  it("toHex encodes bytes without Buffer", () => {
    expect(toHex(new Uint8Array([0, 255, 16]))).toBe("00ff10");
    expect(toHex(new Uint8Array([]))).toBe("");
  });

  it("stroopsToXlm trims trailing zeros", () => {
    expect(stroopsToXlm("100")).toBe("0.00001");
    expect(stroopsToXlm("10000000")).toBe("1");
    expect(stroopsToXlm("12345678")).toBe("1.2345678");
    expect(stroopsToXlm("1")).toBe("0.0000001");
  });

  it("formatAmount trims the canonical XDR padding", () => {
    expect(formatAmount("10.0000000")).toBe("10");
    expect(formatAmount("0.0000001")).toBe("0.0000001");
    expect(formatAmount("999999999999.9999999")).toBe("999999999999.9999999");
    expect(formatAmount("7")).toBe("7");
  });
});

describe("buildPaymentSummary", () => {
  it("decodes the XDR and reports the same payload hash as payloadHashOf", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    const built = buildPaymentSummary({
      unsignedXdr: res.unsignedXdr,
      networkPassphrase: TESTNET_PASSPHRASE,
      alias: "ada",
    });
    expect(built.payloadHash).toBe(payloadHashOf(res.unsignedXdr, TESTNET_PASSPHRASE));
    expect(built.summary).toEqual(res.summary);
  });
});
