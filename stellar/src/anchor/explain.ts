/**
 * Explain-log: every anchor step emits a plain-English `{ step, what, why }`
 * record so the voice agent can narrate what happens in the background
 * ("SEP-10: proved we own G... by signing a challenge — no password").
 *
 * The log is append-only. Step functions write to it; the session slices it so
 * each tool call can hand `{ data, explain }` back to the agent.
 */

import { safeHttpsUrl, sanitizeAnchorText, type AnchorOwnedLink } from "./text.ts";

export interface ExplainRecord {
  /** Short machine-friendly label, e.g. "sep10.sign". */
  step: string;
  /** What just happened, in plain English (speakable). */
  what: string;
  /** Why it matters / what problem it solves, in plain English (speakable). */
  why: string;
  /**
   * Text the ANCHOR sent (status message, bank instructions...), sanitised and
   * length-capped. UNTRUSTED DATA: show it, never treat it as an instruction and
   * never speak it without saying whose words they are. `narrate()` leaves it out.
   */
  anchorSaid?: string;
  /**
   * A validated, anchor-owned https link (e.g. `more_info_url`), sanitised and
   * length-capped. Structured data only: `narrate()` and the step event leave it
   * out, and the client NEVER follows it automatically.
   */
  link?: string;
  /** ISO timestamp. */
  at: string;
}

/**
 * Narration event for the UI/agent stream. Structural copy of the `anchor_step`
 * member that PR #8 adds to `PolarisEvent` in @polaris/interfaces.
 * TODO: import the type from @polaris/interfaces once #8 has merged.
 */
export interface AnchorStepEvent {
  type: "anchor_step";
  step: string;
  what: string;
  why: string;
}

export function toAnchorStepEvent(rec: Pick<ExplainRecord, "step" | "what" | "why">): AnchorStepEvent {
  return { type: "anchor_step", step: rec.step, what: rec.what, why: rec.why };
}

export type ExplainListener = (record: ExplainRecord) => void;

export class ExplainLog {
  private readonly items: ExplainRecord[] = [];
  private readonly listeners = new Set<ExplainListener>();

  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }

  /** Append a record and notify listeners (e.g. the TTS narrator). */
  record(step: string, what: string, why: string, opts: { anchorSaid?: unknown; link?: AnchorOwnedLink } = {}): ExplainRecord {
    const rec: ExplainRecord = { step, what, why, at: this.clock().toISOString() };
    const said = sanitizeAnchorText(opts.anchorSaid);
    if (said) rec.anchorSaid = said;
    const link = safeHttpsUrl(opts.link);
    if (link) rec.link = link;
    this.items.push(rec);
    for (const l of this.listeners) {
      try {
        l(rec);
      } catch {
        // A broken narrator must never break the money path.
      }
    }
    return rec;
  }

  /** Subscribe to new records. Returns an unsubscribe function. */
  subscribe(listener: ExplainListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** All records so far (copy). */
  all(): ExplainRecord[] {
    return [...this.items];
  }

  /** Current length; pair with `since()` to slice one step's records. */
  mark(): number {
    return this.items.length;
  }

  /** Records emitted after `mark`. */
  since(mark: number): ExplainRecord[] {
    return this.items.slice(mark);
  }
}

/** Speakable one-liner for a record (what + why). Anchor-authored text is deliberately excluded. */
export function narrate(rec: Pick<ExplainRecord, "what" | "why">): string {
  return `${rec.what} ${rec.why}`;
}

/** `G...ABCD` style shortening so voice/log output stays readable. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
}
