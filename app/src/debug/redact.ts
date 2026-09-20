/**
 * Defensive secret scrubbing for Debug-panel copy (step W0b).
 *
 * Check details and the event tail are meant to be readable, copyable and
 * pasteable into an issue. This module is the last line of defence: if a backend
 * ever puts a credential in a string, redact it before it reaches the DOM or the
 * clipboard. It is deliberately conservative and over-redacts rather than
 * under-redacts.
 *
 * Public Stellar keys (`G…`, 56 chars) are **not** secrets and must survive; the
 * scrubber recognises them before its long-blob rule and leaves them intact.
 * Stellar **seeds** start with `S` and are redacted.
 */

/** Placeholder written in place of anything that looks like a secret. */
export const REDACTED = "[redacted]";

/**
 * Ordered alternatives, first match wins:
 *
 * 1. `gsk_…` — Groq keys.
 * 2. `sk-…` — OpenAI/Anthropic-style keys.
 * 3. `S…` — a 56-char Stellar secret seed (base32).
 * 4. `G…` — a 56-char Stellar public key (recognised so it can be preserved).
 * 5. 12–24 consecutive lowercase words — a BIP-39 recovery phrase (W10).
 * 6. A ≥40-char base64/hex run — the catch-all for opaque tokens.
 */
const SECRET_TOKEN =
  /\bgsk_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{8,}|\bS[A-Z2-7]{55}\b|\bG[A-Z2-7]{55}\b|\b(?:[a-z]{2,8}\s+){11,23}[a-z]{2,8}\b|[A-Za-z0-9+/]{40,}={0,2}/g;

/** A full Stellar public key: public, so it must not be scrubbed. */
const PUBLIC_KEY = /^G[A-Z2-7]{55}$/;

/**
 * Replaces anything that looks like a credential with [`REDACTED`]. Safe on any
 * string, including one that already contains the placeholder.
 */
export function redact(text: string): string {
  return text.replace(SECRET_TOKEN, (match) =>
    PUBLIC_KEY.test(match) ? match : REDACTED,
  );
}
