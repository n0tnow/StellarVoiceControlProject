/**
 * Language reporting and reconciliation for a spoken turn (steps A11/A12).
 *
 * Bug (A11): the owner said "can you send 400 dollar to bilal" in English and
 * Polaris replied in **Turkish, spoken by an English voice**. A11 made the model
 * report the language, but the real root cause was upstream: the on-device
 * recogniser was pinned to `tr-TR`, so English speech was transcribed as garbled
 * Turkish and every downstream guess was poisoned (A12).
 *
 * Step A12 put the **detected** language — measured from the audio by the STT
 * backend — in charge. Step A14 inverts that: the owner's real run showed the
 * detector is the weaker evidence. Whisper transcribed correct English text and
 * still tagged it `tr`, because a Turkish speaker's short, code-switched
 * utterances (names, currency symbols) are exactly where audio-level language ID
 * fails. `resolveTurnLanguage` is the one place the two are reconciled, and the
 * **model's assessment of the transcript now wins**: the transcript text is the
 * better evidence of which language to answer in, while the STT label is an
 * audio-level guess. The STT label is kept as a hint/tiebreaker and is used only
 * when the model reports nothing.
 *
 * Two provider-agnostic rules carry a model's *own* decision out of its output
 * (kept from A11):
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

/** Which side decided the turn's language, and whether the two disagreed. */
export interface LanguageDecision {
  /** The language used for the reply sentence and the TTS voice. */
  language?: string;
  /** `model` (judging the transcript text) wins over `stt` (the audio detector). */
  source: "stt" | "model" | "none";
  /** The normalized STT-detected language, when the backend reported one. */
  detected?: string;
  /** The normalized model-reported language, when the model reported one. */
  reported?: string;
  /** True when both were known and differed; the model's report won. */
  disagreed: boolean;
}

/**
 * Reconciles the STT-detected language with the model's self-report (steps
 * A12/A14).
 *
 * Rule and rationale (inverted in A14): **the model's report wins**. The model
 * read the transcript text, and the transcript is the stronger evidence of which
 * language to answer in — the A14 real run had Whisper return correct English
 * text tagged `tr`, so trusting the audio label produced a Turkish reply to an
 * English command. The STT label is still kept: it is passed to the model as a
 * hint in the prompt, and it is the fallback when the model reports nothing
 * (e.g. a provider that ignores the language instruction). `disagreed` is
 * surfaced so the caller can log which side won and why rather than silently
 * picking one. The comparison is on the **base** language (`en-US` vs `en` is
 * agreement, not a disagreement), because the region never changes the voice.
 */
export function resolveTurnLanguage(
  detected?: string,
  reported?: string,
): LanguageDecision {
  const normalizedDetected = normalizeLanguage(detected);
  const normalizedReported = normalizeLanguage(reported);
  const detectedBase = languageBase(normalizedDetected);
  const reportedBase = languageBase(normalizedReported);
  const disagreed =
    detectedBase !== undefined && reportedBase !== undefined && detectedBase !== reportedBase;
  if (normalizedReported !== undefined) {
    return {
      language: normalizedReported,
      source: "model",
      ...(normalizedDetected !== undefined ? { detected: normalizedDetected } : {}),
      reported: normalizedReported,
      disagreed,
    };
  }
  if (normalizedDetected !== undefined) {
    return { language: normalizedDetected, source: "stt", detected: normalizedDetected, disagreed: false };
  }
  return { source: "none", disagreed: false };
}
