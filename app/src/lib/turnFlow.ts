/**
 * Admission and freshness policy for spoken turns (fixes M1/M2).
 *
 * Before this module the shell used one boolean, `agentBusyRef`, to keep a
 * single utterance from producing two agent turns. That guard was correct for
 * what it was meant to do — swallow a re-emitted transcript — but it silently
 * **dropped** a genuine second utterance: the shell had already moved to a new
 * recording session, yet nothing would ever advance it, so the notch sat on
 * "Thinking" until the 60 s watchdog. The owner speaks twice in a row, so this
 * had to stop being a drop.
 *
 * The policy here is **latest-wins supersede**, deliberately the same policy the
 * speech queue already uses (`agent/src/speech.ts`): a newer utterance is the one
 * the user still cares about. A different transcript admitted while a turn is in
 * flight starts immediately and *supersedes* it; the older turn's async results
 * are then ignored because they are no longer the current generation. An
 * identical transcript is treated as a duplicate re-emit of the in-flight turn
 * and ignored, which is exactly the StrictMode/re-emit protection the old boolean
 * provided. Once the current turn settles, the same words may be spoken again as
 * a fresh turn.
 *
 * The class is pure (no React, no timers, no Tauri), so the policy is
 * deterministic and unit-testable (`turnFlow.test.ts`).
 */

import type { Intent } from "@polaris/interfaces";

import type { WalletSessionState } from "./walletSession.ts";

/** A turn that was admitted to run: its generation plus the trimmed transcript. */
export interface TurnTicket {
  /** Monotonic; a newer admitted turn always has a strictly larger generation. */
  readonly generation: number;
  /** The transcript this ticket belongs to, already trimmed. */
  readonly transcript: string;
}

/** Why an offered transcript did not start a turn. */
export type IgnoreReason = "blank" | "duplicate";

/** What the flow decided to do with an offered transcript. */
export type TurnAdmission =
  | { readonly kind: "start"; readonly ticket: TurnTicket }
  | { readonly kind: "ignore"; readonly reason: IgnoreReason };

/**
 * Serializes the admission of spoken turns for one shell instance.
 *
 * Guarantees, each pinned by a test in `turnFlow.test.ts`:
 * - a blank transcript is ignored;
 * - an identical re-emit of the in-flight transcript is ignored (dedupe);
 * - a *different* transcript supersedes the in-flight turn and starts at once;
 * - a superseded ticket is never current, so its late results cannot touch the
 *   newer turn;
 * - a superseded turn settling cannot clear the newer turn's in-flight guard.
 */
export class TurnFlow {
  #generation = 0;
  #inFlight: string | null = null;

  /**
   * Offers a transcript. Blank input and an identical re-emit of the in-flight
   * transcript are ignored; anything else is admitted as the newest turn.
   */
  offer(raw: string): TurnAdmission {
    const transcript = raw.trim();
    if (transcript.length === 0) {
      return { kind: "ignore", reason: "blank" };
    }
    if (transcript === this.#inFlight) {
      return { kind: "ignore", reason: "duplicate" };
    }
    this.#inFlight = transcript;
    this.#generation += 1;
    return { kind: "start", ticket: { generation: this.#generation, transcript } };
  }

  /** Whether `ticket` is still the newest admitted turn. */
  isCurrent(ticket: TurnTicket): boolean {
    return ticket.generation === this.#generation;
  }

  /**
   * Marks the ticket's turn finished. A superseded ticket is ignored on purpose:
   * an older turn completing late must not clear the newer turn's in-flight
   * guard (which would let a second transcript start a third turn).
   */
  settle(ticket: TurnTicket): void {
    if (ticket.generation === this.#generation) {
      this.#inFlight = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * W10b onboarding gate
 * ------------------------------------------------------------------ */

/**
 * The intent kinds that actually move value (or lock it in escrow). A missing
 * wallet must refuse these before any chain call; `guard_policy` only changes a
 * rule and is deliberately excluded.
 */
const VALUE_MOVING_KINDS: ReadonlySet<Intent["kind"]> = new Set([
  "send",
  "deposit",
  "withdraw",
  "swap",
  "raw_tx",
  "schedule_payment",
  "cancel_schedule",
  "p2p_offer",
  "p2p_accept",
  "p2p_confirm",
  "p2p_cancel",
  "p2p_reclaim",
]);

export function isValueMovingIntent(intent: Intent): boolean {
  return VALUE_MOVING_KINDS.has(intent.kind);
}

/** The one short sentence spoken when a value-moving intent has no wallet. */
export const CONNECT_WALLET_SENTENCE = "Connect your wallet first.";

export interface WalletGateDecision {
  /** When true, the caller must speak `sentence`, open `page`, and stop. */
  block: boolean;
  sentence: string;
  /** The notch page to open; `null` when the intent is allowed through. */
  page: "wallet" | null;
}

/**
 * Refuses a value-moving intent when no wallet is active. Pure, so the
 * no-chain-call rule is pinned by a test instead of by App's control flow.
 */
export function decideWalletGate(intent: Intent, hasActiveWallet: boolean): WalletGateDecision {
  if (hasActiveWallet || !isValueMovingIntent(intent)) {
    return { block: false, sentence: "", page: null };
  }
  return { block: true, sentence: CONNECT_WALLET_SENTENCE, page: "wallet" };
}

/** The one short sentence spoken when a value-moving intent meets a locked wallet. */
export const UNLOCK_WALLET_SENTENCE = "Please unlock your wallet first.";

/**
 * W13b: the session-aware gate. A `locked` wallet answers "Please unlock your
 * wallet first."; a `none` wallet keeps the onboarding line. Either way the
 * intent is refused before any chain call and the Wallet page is pinned.
 */
export function decideWalletGateForSession(
  intent: Intent,
  session: WalletSessionState,
): WalletGateDecision {
  if (session === "unlocked" || !isValueMovingIntent(intent)) {
    return { block: false, sentence: "", page: null };
  }
  return {
    block: true,
    sentence: session === "locked" ? UNLOCK_WALLET_SENTENCE : CONNECT_WALLET_SENTENCE,
    page: "wallet",
  };
}
