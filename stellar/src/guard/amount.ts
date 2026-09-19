/**
 * Decimal <-> raw-unit conversion for the guard.
 *
 * The guard moves **raw token units** (i128). USDC (and the demo `PGUSD`) use
 * 7 decimals, so `1 USDC = 10_000_000` raw units:
 *
 *     toRawUnits("10.5")     // -> 105000000n
 *     fromRawUnits(105000000n) // -> "10.5"
 *
 * This is the only conversion point: every amount handed to `pay_owner`,
 * `pay_executor`, `create_schedule` or the SAC `approve` goes through
 * `toRawUnits`, and every amount decoded from the chain comes back through
 * `fromRawUnits` for display.
 */
import { GuardClientError } from "./errors.ts";

/** Token decimals the guard assumes (USDC / PGUSD). */
export const TOKEN_DECIMALS = 7;
export const RAW_UNITS_PER_TOKEN = 10n ** BigInt(TOKEN_DECIMALS);

/** `i128::MAX`, the largest amount any contract call accepts. */
export const I128_MAX = (1n << 127n) - 1n;
/** `i128::MIN`, for symmetry in validation helpers. */
export const I128_MIN = -(1n << 127n);

/** Positive decimal, at most 7 fraction digits, no sign/exponent/whitespace. */
const AMOUNT_RE = /^\d{1,12}(\.\d{1,7})?$/;

function invalidAmount(message: string): GuardClientError {
  return new GuardClientError({ name: "InvalidAmount", kind: "rule_violated", code: 101, message });
}

/**
 * Strict decimal string -> raw units. Zero is allowed; negatives are not.
 * The integer part is capped at 12 digits (stricter than i128::MAX, and
 * consistent with `sendPayment`'s `MAX_STROOPS`); the 7-fraction-digit cap is
 * the token's. Anything else is a typed `InvalidAmount`.
 */
export function toRawUnits(amount: string): bigint {
  if (typeof amount !== "string" || !AMOUNT_RE.test(amount)) {
    throw invalidAmount(
      `amount must be a non-negative decimal string with at most 7 fraction digits, got ${JSON.stringify(amount)}`,
    );
  }
  const [whole = "0", frac = ""] = amount.split(".") as [string, string?];
  const raw = BigInt(whole) * RAW_UNITS_PER_TOKEN + BigInt(frac.padEnd(TOKEN_DECIMALS, "0") || "0");
  if (raw > I128_MAX) throw invalidAmount(`amount ${JSON.stringify(amount)} exceeds i128::MAX`);
  return raw;
}

/** Raw units -> decimal string with trailing zeros trimmed (`0n` -> `"0"`). */
export function fromRawUnits(raw: bigint): string {
  if (typeof raw !== "bigint") throw invalidAmount(`raw amount must be a bigint, got ${typeof raw}`);
  if (raw < 0n) throw invalidAmount(`raw amount must not be negative, got ${raw}`);
  const whole = raw / RAW_UNITS_PER_TOKEN;
  const frac = (raw % RAW_UNITS_PER_TOKEN).toString().padStart(TOKEN_DECIMALS, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}
