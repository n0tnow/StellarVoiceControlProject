/**
 * Spoken output (step A4) — the agent's answer, turned into speech.
 *
 * The agent owns *what it means to answer*, so the sentence it will say is built
 * here, in TypeScript, and the finished string is handed to the shell's `speak`
 * command. Rust never formats an intent: there is exactly one place that turns a
 * structured result into words.
 *
 * Two rules from the task drive the shape below:
 *
 * * A produced intent is spoken as a short **confirmation sentence** — the user
 *   hears what is about to happen and is asked to confirm. The raw JSON is never
 *   read aloud.
 * * A turn without an intent is spoken as its **answer** (the clarification the
 *   model asked for, e.g. for off-topic or ambiguous input). Internal errors are
 *   *not* spoken at all; they already surface as a short UI label.
 *
 * `SpeechQueue` carries the overlap policy: utterances never overlap. At most one
 * is in flight and at most one is waiting; a newer waiting utterance replaces an
 * older one (latest-wins), while audio already playing is never interrupted —
 * the Rust player has no cancellation seam, and cutting a confirmation sentence
 * off mid-word is worse than letting it finish.
 */
import type { Intent } from "@polaris/interfaces";
import { languageBase } from "./language.ts";

/** The part of a turn result that can be spoken. */
export interface SpokenResult {
  answer: string;
  intent?: Intent;
  /** Model-reported BCP-47 language of the turn (step A11). */
  language?: string;
}

/**
 * The confirmation templates. The confirmation sentence is built here, in
 * TypeScript, so it must exist in every language Polaris can answer in — the
 * A11 bug was an English sentence (and voice) for a Turkish speaker and vice
 * versa. English is the fallback for an unknown or unsupported language.
 *
 * Only `tr` and `en` are wired because those are the two the product hears; a
 * new language means adding one entry, not new code paths.
 */
type Confirmation = (intent: Intent) => string;

const CONFIRMATIONS: Record<string, Confirmation> = {
  en: (intent) => {
    switch (intent.kind) {
      case "send": {
        const recipient = intent.recipient ?? intent.alias ?? "the recipient";
        return `Sending ${intent.amount} ${intent.asset} to ${recipient}. Do you confirm?`;
      }
      case "deposit":
        return `Depositing ${intent.amount} ${intent.asset}. Do you confirm?`;
      case "swap":
        return `Swapping ${intent.amount} ${intent.asset}. Do you confirm?`;
      case "guard_policy":
        return "Updating your spending policy. Do you confirm?";
      case "raw_tx":
        return "Preparing a transaction. Do you confirm?";
      default:
        return `Preparing a ${String(intent.kind).replace(/_/g, " ")}. Do you confirm?`;
    }
  },
  tr: (intent) => {
    switch (intent.kind) {
      case "send": {
        const recipient = intent.recipient ?? intent.alias ?? "alıcıya";
        return `${recipient} adresine ${intent.amount} ${intent.asset} gönderiyorum. Onaylıyor musun?`;
      }
      case "deposit":
        return `${intent.amount} ${intent.asset} yatırıyorum. Onaylıyor musun?`;
      case "swap":
        return `${intent.amount} ${intent.asset} takas ediyorum. Onaylıyor musun?`;
      case "guard_policy":
        return "Harcama politikanı güncelliyorum. Onaylıyor musun?";
      case "raw_tx":
        return "Bir işlem hazırlıyorum. Onaylıyor musun?";
      default:
        return `Bir ${String(intent.kind).replace(/_/g, " ")} işlemi hazırlıyorum. Onaylıyor musun?`;
    }
  },
};

/**
 * A short, natural confirmation sentence for a parsed intent, in `language`
 * when a template exists and in English otherwise.
 *
 * Deliberately one or two short sentences: this is a confirmation prompt read
 * aloud before an approval, not a paragraph. `recipient` falls back to the
 * address-book `alias` and then to a neutral phrase, so a spoken sentence never
 * contains an empty gap.
 */
export function confirmationSentence(intent: Intent, language?: string): string {
  const template = CONFIRMATIONS[languageBase(language) ?? ""] ?? CONFIRMATIONS.en;
  return template!(intent);
}

/**
 * The hard ceiling on how many characters may ever reach TTS (step A12).
 *
 * The owner's real log showed the model rambling and Fish TTS cost scaling
 * linearly with length: 49 chars → 7.4 s, 103 → 15.8 s, 261 → 30.2 s. A
 * confirmation should be ~40 characters, so 120 is a generous "one or two short
 * sentences" bound — long enough for a real clarification, short enough that no
 * utterance can run away. The prompt asks the model to stay short; this cap is
 * the code guarantee that it cannot ramble past the bound.
 */
export const MAX_SPOKEN_CHARS = 120;

/** The last index in `chars` whose value satisfies `predicate`, or -1. */
function lastIndexWhere(chars: string[], predicate: (char: string) => boolean): number {
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    const char = chars[index];
    if (char !== undefined && predicate(char)) {
      return index;
    }
  }
  return -1;
}

/**
 * Truncates `text` to at most `max` characters without ever cutting a word in
 * half (step A12). Whitespace-only input is returned as an empty string.
 *
 * Preference order, so the result still reads like a sentence:
 * 1. the last sentence terminator inside the window (`. ! ? …`) — a complete
 *    thought, no ellipsis needed;
 * 2. otherwise the last word boundary, with a trailing `…` to mark the cut;
 * 3. otherwise (a single token longer than the cap) a hard cut plus `…`.
 */
export function capSpokenText(text: string, max: number = MAX_SPOKEN_CHARS): string {
  const trimmed = text.trim();
  if (max <= 0) {
    return "";
  }
  const chars = Array.from(trimmed);
  if (chars.length <= max) {
    return trimmed;
  }
  const window = chars.slice(0, max);

  const sentence = lastIndexWhere(window, (char) => ".!?…".includes(char));
  if (sentence !== -1) {
    return window.slice(0, sentence + 1).join("").trim();
  }
  const word = lastIndexWhere(window, (char) => /\s/.test(char));
  if (word !== -1) {
    return `${window.slice(0, word).join("").trim()}…`;
  }
  return `${window.join("").trim()}…`;
}

/**
 * The sentence to speak for one agent turn.
 *
 * An intent becomes its confirmation sentence (in the turn's language); anything
 * else becomes the turn's answer text, which the model already produced in the
 * user's language. The result is always passed through [`capSpokenText`], so
 * nothing longer than [`MAX_SPOKEN_CHARS`] can reach TTS. Callers pass a
 * successful turn only — a failure is never spoken.
 */
export function spokenText(result: SpokenResult): string {
  if (result.intent) {
    return capSpokenText(confirmationSentence(result.intent, result.language));
  }
  return capSpokenText(result.answer.trim());
}

/**
 * Whether a completed turn has anything to say.
 *
 * The rule is intentionally independent of `intent`: a conversational turn (no
 * tool call) is spoken as its answer, exactly like an intent is spoken as its
 * confirmation. Only a blank answer is silent. The A5 end-to-end driver once
 * treated "no intent" as "nothing to speak" and dropped real answers; this
 * predicate is the regression seam the unit test pins.
 */
export function isSpeakable(result: SpokenResult): boolean {
  return spokenText(result).length > 0;
}

/**
 * Plays one utterance; resolves once the audio has finished. `language` is the
 * model-reported BCP-47 tag (step A11) and lets the backend pick a per-language
 * voice; `undefined` means "use the pinned voice".
 */
export type SpeakFn = (text: string, language?: string) => Promise<void>;

/**
 * Serializes utterances so two of them never play at once.
 *
 * Policy (chosen for the ~3.3 s Fish latency measured in A3): never overlap; one
 * in flight plus one pending; a newer pending utterance supersedes an older one.
 * A superseded utterance that never started is dropped, not queued behind — the
 * newest command is the one the user still cares about. In-flight audio is not
 * interrupted.
 */
interface PendingUtterance {
  text: string;
  /** Model-reported language of the turn that produced this utterance. */
  language?: string;
  /** Per-utterance failure hook, for the caller that enqueued it. */
  onError?: (error: unknown) => void;
}

export class SpeechQueue {
  #busy = false;
  #pending: PendingUtterance | null = null;
  #idleWaiters: Array<() => void> = [];
  readonly #speak: SpeakFn;
  readonly #onError: (error: unknown) => void;

  constructor(speak: SpeakFn, onError: (error: unknown) => void = () => {}) {
    this.#speak = speak;
    this.#onError = onError;
  }

  /** Whether an utterance is currently playing. */
  get speaking(): boolean {
    return this.#busy;
  }

  /** Whether an utterance is waiting behind the one in flight (0 or 1). */
  get queued(): number {
    return this.#pending === null ? 0 : 1;
  }

  /**
   * Requests an utterance. Blank text is ignored. Never throws and never blocks
   * the caller: playback is awaited internally, so a slow or failed backend
   * cannot delay the visible result.
   *
   * `onError` is called only if *this* utterance fails, in addition to the
   * queue-wide handler. It exists for the shell: with step A9, a synthesis
   * failure emits no `speech_status: speaking`, so the turn's caller needs a
   * direct signal that no audio will arrive (otherwise the turn lingers on
   * "thinking" until the watchdog). A superseded pending utterance is dropped,
   * so its `onError` is never called — the newer utterance owns the turn.
   *
   * `language` is the turn's model-reported BCP-47 tag (step A11); it is passed
   * through to the backend so a per-language voice can be selected. It is the
   * third parameter so the existing `(text, onError)` call sites keep working.
   */
  enqueue(text: string, onError?: (error: unknown) => void, language?: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    const utterance: PendingUtterance = {
      text: trimmed,
      ...(language ? { language } : {}),
      ...(onError ? { onError } : {}),
    };
    if (this.#busy) {
      this.#pending = utterance;
      return;
    }
    this.#busy = true;
    void this.#drain(utterance);
  }

  /** Resolves once the queue is empty. Used by tests and shutdown paths. */
  whenIdle(): Promise<void> {
    if (!this.#busy) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(first: PendingUtterance): Promise<void> {
    let current: PendingUtterance | null = first;
    while (current !== null) {
      try {
        await this.#speak(current.text, current.language);
      } catch (error) {
        this.#onError(error);
        current.onError?.(error);
      }
      current = this.#pending;
      this.#pending = null;
    }
    this.#busy = false;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) {
      resolve();
    }
  }
}
