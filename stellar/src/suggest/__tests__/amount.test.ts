import { describe, expect, it } from "vitest";
import {
  ceilDiv,
  displayStepRaw,
  formatAmount,
  mulDivCeil,
  parseAmount,
  roundUpToDisplayMultiple,
  roundUpToStep,
  unitScale,
} from "../amount.ts";

describe("formatAmount (float-free display)", () => {
  it("formats zero", () => {
    expect(formatAmount(0n, 7)).toBe("0");
  });

  it("formats a sub-unit raw amount", () => {
    expect(formatAmount(1n, 7)).toBe("0.0000001");
  });

  it("formats a whole display unit", () => {
    expect(formatAmount(10_000_000n, 7)).toBe("1");
  });

  it("formats the worked-example p90", () => {
    expect(formatAmount(184_000_000n, 7)).toBe("18.4");
  });

  it("formats the worked-example median", () => {
    expect(formatAmount(95_000_000n, 7)).toBe("9.5");
  });

  it("trims a trailing fractional zero", () => {
    expect(formatAmount(220_000_000n, 7)).toBe("22");
  });

  it("formats negatives", () => {
    expect(formatAmount(-15_000_000n, 7)).toBe("-1.5");
  });

  it("formats with zero decimals", () => {
    expect(formatAmount(123n, 0)).toBe("123");
  });

  it("formats with two decimals", () => {
    expect(formatAmount(12345n, 2)).toBe("123.45");
  });

  it("survives an i128-maximum amount without floats", () => {
    const i128Max = (1n << 127n) - 1n;
    const text = formatAmount(i128Max, 7);
    expect(text).not.toMatch(/e/i);
    expect(text).not.toContain("Infinity");
    expect(text).toBe("17014118346046923173168730371588.4105727");
    expect(parseAmount(text, 7)).toBe(i128Max);
  });

  it("rejects invalid decimals", () => {
    expect(() => formatAmount(1n, -1)).toThrow(/decimals/);
    expect(() => formatAmount(1n, 1.5)).toThrow(/decimals/);
  });
});

describe("parseAmount", () => {
  it("parses a decimal into raw units", () => {
    expect(parseAmount("18.4", 7)).toBe(184_000_000n);
  });

  it("parses a whole number", () => {
    expect(parseAmount("22", 7)).toBe(220_000_000n);
  });

  it("parses the smallest unit", () => {
    expect(parseAmount("0.0000001", 7)).toBe(1n);
  });

  it("parses negatives", () => {
    expect(parseAmount("-1.5", 7)).toBe(-15_000_000n);
  });

  it("parses with zero decimals", () => {
    expect(parseAmount("42", 0)).toBe(42n);
  });

  it("rejects empty input", () => {
    expect(() => parseAmount("", 7)).toThrow(/invalid decimal/);
  });

  it("rejects malformed input", () => {
    expect(() => parseAmount("1.2.3", 7)).toThrow(/invalid decimal/);
    expect(() => parseAmount("abc", 7)).toThrow(/invalid decimal/);
  });

  it("rejects more decimals than the asset supports", () => {
    expect(() => parseAmount("1.12345678", 7)).toThrow(/decimal places/);
  });

  it("round-trips through formatAmount", () => {
    for (const display of ["0", "1", "18.4", "9.5", "22", "0.0000001", "170141183460469231731687303715884105727"]) {
      expect(formatAmount(parseAmount(display, 7), 7)).toBe(display);
    }
  });
});

describe("rounding", () => {
  it("unitScale is 10^decimals", () => {
    expect(unitScale(7)).toBe(10_000_000n);
    expect(unitScale(0)).toBe(1n);
  });

  it("displayStepRaw(5,7) is five display units in raw units", () => {
    expect(displayStepRaw(5, 7)).toBe(50_000_000n);
  });

  it("rounds 18.4 UP to 20", () => {
    expect(formatAmount(roundUpToDisplayMultiple(184_000_000n, 7), 7)).toBe("20");
  });

  it("leaves an exact multiple unchanged", () => {
    expect(roundUpToDisplayMultiple(200_000_000n, 7)).toBe(200_000_000n);
  });

  it("rounds a value just above a multiple UP to the next", () => {
    expect(roundUpToDisplayMultiple(200_000_001n, 7)).toBe(250_000_000n);
  });

  it("returns zero for zero and negatives", () => {
    expect(roundUpToDisplayMultiple(0n, 7)).toBe(0n);
    expect(roundUpToDisplayMultiple(-5n, 7)).toBe(0n);
  });

  it("rounds 1 UP to 5", () => {
    expect(formatAmount(roundUpToDisplayMultiple(10_000_000n, 7), 7)).toBe("5");
  });

  it("roundUpToStep rejects a non-positive step", () => {
    expect(() => roundUpToStep(1n, 0n)).toThrow(/step/);
  });

  it("ceilDiv rounds up", () => {
    expect(ceilDiv(5n, 2n)).toBe(3n);
    expect(ceilDiv(4n, 2n)).toBe(2n);
    expect(ceilDiv(0n, 2n)).toBe(0n);
  });
});

describe("mulDivCeil", () => {
  it("computes p95 daily total x 1.5 exactly (38 -> 57)", () => {
    expect(mulDivCeil(380_000_000n, 3n, 2n)).toBe(570_000_000n);
  });

  it("rounds a fractional product up", () => {
    expect(mulDivCeil(1n, 3n, 2n)).toBe(2n);
  });

  it("rejects a non-positive denominator", () => {
    expect(() => mulDivCeil(1n, 3n, 0n)).toThrow(/denominator/);
  });
});
