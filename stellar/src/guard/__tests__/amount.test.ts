import { describe, expect, it } from "vitest";
import { I128_MAX, RAW_UNITS_PER_TOKEN, TOKEN_DECIMALS, fromRawUnits, toRawUnits } from "../amount.ts";
import { GuardClientError } from "../errors.ts";

describe("toRawUnits (7-decimal conversion)", () => {
  it("converts 10.5 to 105000000 raw units", () => {
    expect(toRawUnits("10.5")).toBe(105000000n);
  });

  it("converts an integer amount", () => {
    expect(toRawUnits("1")).toBe(RAW_UNITS_PER_TOKEN);
    expect(RAW_UNITS_PER_TOKEN).toBe(10_000_000n);
    expect(TOKEN_DECIMALS).toBe(7);
  });

  it("converts a one-stroop amount", () => {
    expect(toRawUnits("0.0000001")).toBe(1n);
  });

  it("allows zero", () => {
    expect(toRawUnits("0")).toBe(0n);
    expect(toRawUnits("0.0")).toBe(0n);
  });

  it("accepts up to 12 integer digits", () => {
    expect(toRawUnits("999999999999")).toBe(999999999999n * RAW_UNITS_PER_TOKEN);
  });

  it.each(["-1", "1e3", "1.12345678", " 10", "", "+1", "1.", ".5", "10 ", "0x1", "abc", "1,5"])(
    "rejects %j with InvalidAmount",
    (amount) => {
      let error: unknown;
      try {
        toRawUnits(amount);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(GuardClientError);
      expect((error as GuardClientError).name).toBe("InvalidAmount");
      expect((error as GuardClientError).code).toBe(101);
    },
  );

  it("rejects a non-string input", () => {
    expect(() => toRawUnits(10 as unknown as string)).toThrow(GuardClientError);
  });

  it("never exceeds i128::MAX for a regex-valid input", () => {
    expect(toRawUnits("999999999999.9999999")).toBeLessThan(I128_MAX);
  });
});

describe("fromRawUnits", () => {
  it("trims trailing zeros", () => {
    expect(fromRawUnits(105000000n)).toBe("10.5");
    expect(fromRawUnits(RAW_UNITS_PER_TOKEN)).toBe("1");
    expect(fromRawUnits(1n)).toBe("0.0000001");
    expect(fromRawUnits(12345678n)).toBe("1.2345678");
  });

  it("renders zero", () => {
    expect(fromRawUnits(0n)).toBe("0");
  });

  it("round-trips toRawUnits", () => {
    for (const amount of ["0", "0.0000001", "1", "10.5", "999999999999.9999999"]) {
      expect(fromRawUnits(toRawUnits(amount))).toBe(amount === "0.0" ? "0" : amount);
    }
  });

  it("rejects a negative raw amount", () => {
    expect(() => fromRawUnits(-1n)).toThrow(GuardClientError);
  });
});
