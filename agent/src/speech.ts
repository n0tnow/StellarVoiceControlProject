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

/** The part of a turn result that can be spoken. */
export interface SpokenResult {
  answer: string;
  intent?: Intent;
}

/**
 * A short, natural confirmation sentence for a parsed intent.
 *
 * Deliberately one or two short sentences: this is a confirmation prompt read
 * aloud before an approval, not a paragraph. `recipient` falls back to the
 * address-book `alias` and then to a neutral phrase, so a spoken sentence never
 * contains an empty gap.
 */
export function confirmationSentence(intent: Intent): string {
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
      // Unreachable for the current union; kept so an intent kind added later
      // still speaks something rather than throwing.
      return `Preparing a ${String(intent.kind).replace(/_/g, " ")}. Do you confirm?`;
  }
}

/**
 * The sentence to speak for one agent turn.
 *
 * An intent becomes its confirmation sentence; anything else becomes the turn's
 * answer text. Callers pass a successful turn only — a failure is never spoken.
 */
export function spokenText(result: SpokenResult): string {
  if (result.intent) {
    return confirmationSentence(result.intent);
  }
  return result.answer.trim();
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

/** Plays one utterance; resolves once the audio has finished. */
export type SpeakFn = (text: string) => Promise<void>;

/**
 * Serializes utterances so two of them never play at once.
 *
 * Policy (chosen for the ~3.3 s Fish latency measured in A3): never overlap; one
 * in flight plus one pending; a newer pending utterance supersedes an older one.
 * A superseded utterance that never started is dropped, not queued behind — the
 * newest command is the one the user still cares about. In-flight audio is not
 * interrupted.
 */
export class SpeechQueue {
  #busy = false;
  #pending: string | null = null;
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
   */
  enqueue(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      return;
    }
    if (this.#busy) {
      this.#pending = trimmed;
      return;
    }
    this.#busy = true;
    void this.#drain(trimmed);
  }

  /** Resolves once the queue is empty. Used by tests and shutdown paths. */
  whenIdle(): Promise<void> {
    if (!this.#busy) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(first: string): Promise<void> {
    let current: string | null = first;
    while (current !== null) {
      try {
        await this.#speak(current);
      } catch (error) {
        this.#onError(error);
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
