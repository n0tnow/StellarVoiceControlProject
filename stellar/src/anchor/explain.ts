/**
 * Explain-log: every anchor step emits a plain-English `{ step, what, why }`
 * record so the voice agent can narrate what happens in the background
 * ("SEP-10: proved we own G... by signing a challenge — no password").
 *
 * The log is append-only. Step functions write to it; the session slices it so
 * each tool call can hand `{ data, explain }` back to the agent.
 */

export interface ExplainRecord {
  /** Short machine-friendly label, e.g. "sep10.sign". */
  step: string;
  /** What just happened, in plain English (speakable). */
  what: string;
  /** Why it matters / what problem it solves, in plain English (speakable). */
  why: string;
  /** ISO timestamp. */
  at: string;
}

export type ExplainListener = (record: ExplainRecord) => void;

export class ExplainLog {
  private readonly items: ExplainRecord[] = [];
  private readonly listeners = new Set<ExplainListener>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  /** Append a record and notify listeners (e.g. the TTS narrator). */
  record(step: string, what: string, why: string): ExplainRecord {
    const rec: ExplainRecord = { step, what, why, at: this.clock().toISOString() };
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

/** Speakable one-liner for a record (what + why). */
export function narrate(rec: Pick<ExplainRecord, "what" | "why">): string {
  return `${rec.what} ${rec.why}`;
}

/** `G...ABCD` style shortening so voice/log output stays readable. */
export function shortKey(key: string): string {
  return key.length > 12 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key;
}
