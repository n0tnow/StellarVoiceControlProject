/**
 * Conversation memory for spoken turns (voice-dialog).
 *
 * Before this module each utterance was a standalone model turn: the model never
 * saw what it had just asked, so "send 10 XLM" -> "to whom?" -> "acc2" could not
 * work. This keeps the last few exchanges plus **one** pending clarification and
 * hands both to the model, so a follow-up fills the missing slot instead of
 * restarting the request.
 *
 * The state is in memory only, never persisted, and never holds a secret. It is
 * deliberately small and pure (no timers, no Tauri, no clock of its own — callers
 * pass `now`), so the expiry and reset rules are unit-testable. It is discarded on
 * a timeout, after an intent (produced or refused), and on an explicit cancel.
 */
import { languageBase } from "./language.ts";

/** How long a pending clarification survives without an answer (voice-dialog). */
export const DIALOG_TTL_MS = 90_000;

/** Maximum kept exchanges (user+assistant pairs); older ones are dropped. */
export const MAX_EXCHANGES = 4;

/** One line of the recent dialogue. */
export interface DialogExchange {
  role: "user" | "assistant";
  text: string;
}

/**
 * A clarification the agent asked and is still waiting to have answered. `kind`
 * is the action being built (e.g. `send`/`sell`), `filledSlots` the values already
 * known and `missing` the ones a follow-up must supply.
 */
export interface PendingClarification {
  kind: string;
  filledSlots: Record<string, string>;
  missing: string[];
  /** Epoch ms after which the pending state is stale and dropped. */
  expiresAt: number;
}

/** The short questions the loop can ask when a tool cannot build the intent. */
export type ClarificationQuestion = "send_recipient" | "sell_route" | "sell_price" | "rule_asset";

/** What a tool reports when one slot is still missing (see `AgentError.pending`). */
export interface PendingClarificationDraft {
  kind: string;
  filledSlots: Record<string, string>;
  missing: string[];
  question: ClarificationQuestion;
}

const QUESTIONS: Record<ClarificationQuestion, { en: string; tr: string }> = {
  send_recipient: { en: "Who should I send it to?", tr: "Kime göndereyim?" },
  sell_route: {
    en: "Via the bank (anchor) or peer-to-peer?",
    tr: "Bankadan mı (anchor), yoksa P2P olarak mı?",
  },
  sell_price: { en: "What price in TRY?", tr: "Kaç liradan?" },
  rule_asset: { en: "Which asset for the limit, USDC or XLM?", tr: "Limit hangi varlık için, USDC mi XLM mi?" },
};

/** The localized one-line question for a missing slot, tagged for TTS. */
export function clarificationSentence(question: ClarificationQuestion, language?: string): string {
  const entry = QUESTIONS[question];
  const base = languageBase(language) === "tr" ? "tr" : "en";
  return entry[base];
}

/** Lower-cases and strips Turkish diacritics, so "vazgeç" matches "vazgec". */
function fold(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ı/g, "i")
    .replace(/\s+/g, " ")
    .trim();
}

/** Utterances that abandon whatever is in flight (Turkish and English). */
const CANCEL = /\b(cancel|iptal|vazgec|never mind|nevermind|forget it|bosver)\b/;

/** Whether an utterance cancels the pending clarification / recent context. */
export function isCancelUtterance(text: string): boolean {
  return CANCEL.test(fold(text));
}

/**
 * The in-memory dialogue for one shell instance. The loop reads it before the
 * model call (to build the context block) and updates it afterwards.
 */
export class DialogMemory {
  #exchanges: DialogExchange[] = [];
  #pending: PendingClarification | null = null;

  /** Records the user's utterance for the current turn. Blank text is ignored. */
  recordUser(text: string): void {
    this.#push("user", text);
  }

  /** Records the agent's answer for the current turn. Blank text is ignored. */
  recordAssistant(text: string): void {
    this.#push("assistant", text);
  }

  /**
   * Arms a pending clarification for the next utterance. Replaces any earlier
   * one: only one slot-fill can be open at a time.
   */
  setPending(draft: PendingClarificationDraft, now: number = Date.now()): void {
    this.#pending = {
      kind: draft.kind,
      filledSlots: { ...draft.filledSlots },
      missing: [...draft.missing],
      expiresAt: now + DIALOG_TTL_MS,
    };
  }

  /**
   * The live pending clarification, or `null` when there is none or it has
   * expired. An expired one is dropped on read, so a stale slot never leaks into
   * a later, unrelated request.
   */
  pending(now: number = Date.now()): PendingClarification | null {
    if (this.#pending && this.#pending.expiresAt <= now) {
      this.#pending = null;
    }
    return this.#pending;
  }

  /** Drops the pending clarification and the recent exchanges. */
  reset(): void {
    this.#exchanges = [];
    this.#pending = null;
  }

  get isEmpty(): boolean {
    return this.#exchanges.length === 0 && this.#pending === null;
  }

  /**
   * The context block appended to the system prompt. Empty when there is nothing
   * to remember, so a first turn pays no tokens.
   */
  contextBlock(now: number = Date.now()): string {
    const pending = this.pending(now);
    if (this.#exchanges.length === 0 && !pending) {
      return "";
    }
    const lines = ["Conversation so far (most recent last):"];
    for (const exchange of this.#exchanges) {
      lines.push(`${exchange.role}: ${exchange.text}`);
    }
    if (pending) {
      lines.push(
        `Pending clarification: the last request was a "${pending.kind}" action with ` +
          `missing slot(s) ${pending.missing.join(", ")}.`,
        `Already known: ${formatSlots(pending.filledSlots)}.`,
        "If the user's new utterance answers this question, fill the slot and call the " +
          "matching tool. Otherwise start a fresh request.",
      );
    }
    return lines.join("\n");
  }

  #push(role: DialogExchange["role"], text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    this.#exchanges.push({ role, text: trimmed });
    // One exchange is a user+assistant pair; keep at most 2*MAX_EXCHANGES lines.
    const max = MAX_EXCHANGES * 2;
    if (this.#exchanges.length > max) {
      this.#exchanges = this.#exchanges.slice(-max);
    }
  }
}

function formatSlots(slots: Record<string, string>): string {
  const entries = Object.entries(slots);
  return entries.length === 0 ? "nothing yet" : entries.map(([key, value]) => `${key}=${value}`).join(", ");
}
