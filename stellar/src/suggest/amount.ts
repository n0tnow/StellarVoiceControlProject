/**
 * Float-free amount helpers. Amounts are `bigint` raw token units; the only place a decimal appears
 * is the **display string** produced here (and parsed back for rule caps). No `Number` is ever used
 * for an amount, so i128-scale values are exact.
 */
import { ROUNDING_STEP_DISPLAY } from "./constants.ts";

/** `10 ** decimals` as a bigint. */
export function unitScale(decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 100) {
    throw new Error(`invalid asset decimals: ${decimals}`);
  }
  return 10n ** BigInt(decimals);
}

/**
 * Canonical decimal display string for `raw` raw units. Trailing fractional zeros (and a trailing
 * dot) are trimmed: `184000000n / 7 -> "18.4"`, `220000000n / 7 -> "22"`.
 */
export function formatAmount(raw: bigint, decimals: number): string {
  unitScale(decimals); // validate
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const digits = abs.toString();
  let integerPart: string;
  let fractionPart: string;
  if (decimals === 0) {
    integerPart = digits;
    fractionPart = "";
  } else if (digits.length <= decimals) {
    integerPart = "0";
    fractionPart = digits.padStart(decimals, "0");
  } else {
    integerPart = digits.slice(0, digits.length - decimals);
    fractionPart = digits.slice(digits.length - decimals);
  }
  fractionPart = fractionPart.replace(/0+$/, "");
  const body = fractionPart.length > 0 ? `${integerPart}.${fractionPart}` : integerPart;
  return negative ? `-${body}` : body;
}

/**
 * Parse a decimal display string into raw units. Rejects malformed input and any fractional digit
 * beyond the asset's precision (fail closed — never round money silently).
 */
export function parseAmount(display: string, decimals: number): bigint {
  unitScale(decimals); // validate
  const text = display.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`invalid decimal amount: ${JSON.stringify(display)}`);
  const sign = match[1] === "-" ? -1n : 1n;
  const integerPart = match[2] ?? "0";
  const fractionPart = match[3] ?? "";
  if (fractionPart.length > decimals) {
    throw new Error(`amount ${JSON.stringify(display)} has more than ${decimals} decimal places`);
  }
  const padded = fractionPart.padEnd(decimals, "0");
  return sign * BigInt(integerPart + padded);
}

/** Ceil division for non-negative bigints: `ceil(a / b)`. */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv: divisor must be positive");
  if (a <= 0n) return 0n;
  return (a + b - 1n) / b;
}

/** Round `raw` UP to the next multiple of `step` (never down). `raw <= 0` -> 0. */
export function roundUpToStep(raw: bigint, step: bigint): bigint {
  if (step <= 0n) throw new Error("roundUpToStep: step must be positive");
  if (raw <= 0n) return 0n;
  return ceilDiv(raw, step) * step;
}

/** Raw units in `multiple` display units, e.g. `displayStepRaw(5, 7) = 50000000n`. */
export function displayStepRaw(multiple: number, decimals: number): bigint {
  if (!Number.isInteger(multiple) || multiple <= 0) {
    throw new Error(`invalid display multiple: ${multiple}`);
  }
  return BigInt(multiple) * unitScale(decimals);
}

/**
 * Round `raw` UP to the nearest multiple of `multiple` display units (docs §6.3 default 5).
 * Computed entirely in integers.
 */
export function roundUpToDisplayMultiple(
  raw: bigint,
  decimals: number,
  multiple: number = ROUNDING_STEP_DISPLAY,
): bigint {
  return roundUpToStep(raw, displayStepRaw(multiple, decimals));
}

/** Exact `ceil(a * numerator / denominator)` in integers (e.g. p95 × 1.5 = `ceil(a * 3 / 2)`). */
export function mulDivCeil(a: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("mulDivCeil: denominator must be positive");
  if (numerator < 0n || a < 0n) throw new Error("mulDivCeil: negative values are not supported");
  return ceilDiv(a * numerator, denominator);
}
