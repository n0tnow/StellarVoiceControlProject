/** Decimal-string amounts, never floats. Stellar amounts have at most 7 decimals (stroops). */

const DECIMAL = /^\d+(\.\d{1,7})?$/;

/** Rejects numbers-as-strings that are negative, zero, exponent-form, or have more than 7 decimals. */
export function assertAmount(amount: string, label = "amount"): void {
  if (typeof amount !== "string" || !DECIMAL.test(amount) || toStroops(amount) <= 0n) {
    throw new Error(`${label} must be a positive decimal string with at most 7 decimals, got ${JSON.stringify(amount)}`);
  }
}

/** Exact integer stroops of a decimal string (7 decimals); throws on malformed input. */
export function toStroops(amount: string): bigint {
  if (typeof amount !== "string" || !DECIMAL.test(amount)) throw new Error(`not a valid amount: ${JSON.stringify(amount)}`);
  const [whole, frac = ""] = amount.split(".") as [string, string?];
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
}
