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
