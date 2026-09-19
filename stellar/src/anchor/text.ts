/**
 * Anchor-provided text is UNTRUSTED DATA: it can carry prompt-injection aimed at
 * the LLM or the text-to-speech voice. Everything an anchor says that reaches an
 * explain record or a step result goes through `sanitizeAnchorText` first.
 */

/**
 * Default hard cap (characters) for any anchor-authored text that can reach
 * narration, the model or a log: explain `anchorSaid`, HTTP error details and
 * TOML parse errors. Callers with a tighter format (memo ≤ 28 bytes, ids)
 * pass their own cap; nothing untrusted is ever echoed uncapped.
 */
export const MAX_ANCHOR_TEXT = 200;
const DEFAULT_MAX = MAX_ANCHOR_TEXT;

// C0/C1 controls, DEL, zero-width and bidi-override characters, line/paragraph separators.
const HIDDEN = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]",
  "g",
);

/** Caps length, removes control/invisible characters and newlines, collapses whitespace. */
export function sanitizeAnchorText(value: unknown, max = DEFAULT_MAX): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;

/** Transaction ids and similar identifiers that we echo in narration: strict charset or rejected. */
export function safeId(value: unknown, what: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`the anchor sent an unusable ${what}`);
  }
  return value;
}

/** Only https URLs survive (used for `more_info_url`); anything else is dropped. */
export function safeHttpsUrl(value: unknown, max = 300): string | undefined {
  if (typeof value !== "string" || value.length > max) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

declare const ANCHOR_OWNED_LINK: unique symbol;

/**
 * A link that has passed the anchor-own-host check (`anchorOwnedLink` in
 * `sep6.ts`): https, no credentials/port, and a host the anchor itself declares.
 * The brand is compile-time only — it stops a plain (unchecked) URL from being
 * passed into `ExplainLog.record`, whose `link` field requires this type.
 */
export type AnchorOwnedLink = string & { readonly [ANCHOR_OWNED_LINK]: true };
