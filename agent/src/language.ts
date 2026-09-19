/**
 * Language reporting for a spoken turn (step A11).
 *
 * Bug: the owner said "can you send 400 dollar to bilal" in English and Polaris
 * replied in **Turkish, spoken by an English voice**. The reply language and the
 * voice must follow the language the user actually spoke.
 *
 * The **model** decides the language — it already knows, so no detection library
 * is bolted on. Two provider-agnostic rules carry that decision out of the
 * model's output:
 *
 * * a tool call may carry an optional `language` field (a BCP-47 code such as
 *   `tr` or `en-US`), read here as structured JSON — never by string-matching a
 *   serialised argument blob;
 * * a plain text answer starts with the same tag in square brackets, e.g.
 *   `[en] Yes, I can hear you.`, which is stripped before the answer is spoken.
 *
 * Both are normalised to a lowercase BCP-47 base code so the TTS layer can pick a
 * per-language voice without guessing.
 */

/** A leading `[xx]` / `(xx)` language tag on a text answer. */
export const LANGUAGE_TAG = /^\s*[[(]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)[\])]\s*/;

/**
 * Normalises a reported language to a lowercase BCP-47 tag, or `undefined` when
 * it is not a plausible tag. `_` is folded to `-` (Fish/Apple-style `en_US`).
 */
export function normalizeLanguage(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase().replace(/_/g, "-");
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(trimmed) ? trimmed : undefined;
}

/** The language base (`en-US` -> `en`) used for the per-language voice lookup. */
export function languageBase(value: string | undefined): string | undefined {
  const normalized = normalizeLanguage(value);
  return normalized?.split("-")[0];
}

/**
 * Splits a leading language tag off a model answer. Text without a tag is
 * returned unchanged; the tag itself is never spoken.
 */
export function stripLanguageTag(text: string | undefined): {
  text?: string;
  language?: string;
} {
  if (text === undefined) {
    return {};
  }
  const match = LANGUAGE_TAG.exec(text);
  if (!match) {
    return { text };
  }
  const language = normalizeLanguage(match[1]);
  const rest = text.slice(match[0].length).trim();
  return { text: rest, ...(language ? { language } : {}) };
}

/**
 * The first `language` field found on a tool call's (already JSON-parsed) input.
 * The loop hands providers `unknown` JSON; this is the one place it is read, so
 * both the OpenAI-compatible and Anthropic clients behave identically.
 */
export function languageFromToolCalls(
  toolCalls: ReadonlyArray<{ input: unknown }>,
): string | undefined {
  for (const call of toolCalls) {
    if (typeof call.input === "object" && call.input !== null) {
      const candidate = normalizeLanguage((call.input as { language?: unknown }).language);
      if (candidate) {
        return candidate;
      }
    }
  }
  return undefined;
}
