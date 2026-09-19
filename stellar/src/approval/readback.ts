/**
 * Voice read-back sentences for auto-pay changes (D10c).
 *
 * Pure and deterministic: amount formatting comes from `fromRawUnits`, the
 * guard's single raw -> decimal conversion point, so there is no float math and
 * no artifacts like `0.30000000000000004`.
 *
 * The read-back is only a sentence. The dates shown on the approval card come
 * from the builder's `exposure` block, which is why `timeZone`/`now` are
 * accepted here for callers that want the same clock in one place.
 */
import { fromRawUnits } from "../guard/amount.ts";
import type { AutoPayDraft } from "./types.ts";

export interface ReadBackOptions {
  /** Human asset code, e.g. "USDC". */
  assetSymbol: string;
  /** IANA time zone reserved for the surrounding card; the sentence is clock-free. */
  timeZone?: string;
  /** Injected clock reserved for the surrounding card; the sentence is clock-free. */
  now?: Date;
}

/** Raw units -> display decimal. Exported so card copy and tests share one path. */
export function formatRawAmount(raw: bigint): string {
  return fromRawUnits(raw);
}

/**
 * Exact sentence pattern (source notes D10c):
 *
 *   Allow automatic payments up to 25 USDC, max 100 USDC per day, to saved
 *   contacts only, for 30 days? This needs your approval.
 *
 * `knownRecipientsOnly: false` renders "to anyone"; an empty asset list would
 * render an empty symbol (validation forbids that before signing).
 */
export function readBack(draft: AutoPayDraft, opts: ReadBackOptions): string {
  const threshold = formatRawAmount(draft.thresholdRaw);
  const daily = formatRawAmount(draft.dailyLimitRaw);
  const recipients = draft.knownRecipientsOnly ? "to saved contacts only" : "to anyone";
  return (
    `Allow automatic payments up to ${threshold} ${opts.assetSymbol}, ` +
    `max ${daily} ${opts.assetSymbol} per day, ${recipients}, ` +
    `for ${draft.allowanceDays} days? This needs your approval.`
  );
}

export interface DisableReadBackInput {
  /** Human asset code, e.g. "USDC". */
  assetSymbol: string;
  /** Whether the SAC allowance is revoked as well as the executor. */
  revokeAllowance: boolean;
}

/**
 * Read-back for disabling auto-pay. Tightening/disabling only needs the lighter
 * confirmation, but is still read back so a voice request cannot act silently.
 */
export function readBackDisable(input: DisableReadBackInput): string {
  return input.revokeAllowance
    ? `Stop automatic payments and revoke the remaining ${input.assetSymbol} allowance? This needs your confirmation.`
    : "Stop automatic payments? This needs your confirmation.";
}
