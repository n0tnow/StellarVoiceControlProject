/**
 * The local voice-turn log (NW4): the last 50 turns the user spoke or typed.
 *
 * The History page merges two sources into one timeline: the owner's on-chain
 * payments (`@/lib/history`) and these local turns. A turn is recorded at the
 * three moments that matter — start, answer, outcome — so an abandoned turn is
 * still visible, and the outcome carries an optional transaction hash + explorer
 * link.
 *
 * ## What is stored, and what is not
 *
 * Only the transcript, the agent's answer, a short stage/outcome label and an
 * optional **public** tx hash / explorer URL. The log deliberately whitelists
 * these fields on read, so a tampered store cannot smuggle an unsigned or signed
 * XDR (or any secret) back into the UI. The store is `localStorage`, best-effort:
 * a private-mode/disabled storage failure never breaks a turn — the turn simply
 * is not persisted.
 *
 * The pure part (`parse` / `serialize` / `upsert` / `supersedeInProgress`) is
 * exported and unit-tested without a browser (`turnLog.test.ts`).
 */

/** `localStorage` key. Bumping the suffix invalidates older shapes. */
export const TURN_LOG_KEY = "polaris.turn-log.v1";

/** Ring-buffer size: the newest this many turns are kept. */
export const TURN_LOG_LIMIT = 50;

/** Longest transcript/answer we persist, so one huge turn cannot bloat the store. */
const MAX_TEXT = 2_000;

/** Longest outcome label we persist. */
const MAX_OUTCOME = 120;

/**
 * Outcome labels. `in_progress` is the only non-terminal value; `answered` means
 * a conversational turn finished, `tx_submitted` means value settled, and a
 * failure is `failed: <short reason>`. `superseded` marks a turn the user talked
 * over (the turn flow's latest-wins policy).
 */
export type TurnOutcome =
  | "in_progress"
  | "answered"
  | "tx_submitted"
  | "superseded"
  | `failed: ${string}`;

/** One local turn as persisted. No XDR, no signature, no secret material. */
export interface TurnLogEntry {
  id: string;
  /** Unix epoch milliseconds (matches the chain fetch's `createdAtMs`). */
  timestampMs: number;
  transcript: string;
  answer: string;
  outcome: string;
  /** Public transaction hash; never the XDR. */
  txHash: string | null;
  explorerUrl: string | null;
  /**
   * History-view metadata, all optional and additive (older rows simply lack it).
   * `kind`/`route`/`approvalMode`/`asset`/`amount`/`counterparty` feed the History
   * page's icon, filters and signed amount; `counterpartyNickname` is the contact
   * name a value-moving turn resolved. None of these is secret.
   */
  kind?: string;
  route?: string;
  approvalMode?: string;
  asset?: string;
  amount?: string;
  counterparty?: string;
  counterpartyNickname?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asText(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function asOptionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Coerces one stored value to a well-formed entry, **rebuilding only the known
 * fields**. Anything else (an `xdr` field, a secret) is dropped here.
 */
function toEntry(value: unknown): TurnLogEntry | null {
  if (!isRecord(value)) return null;
  const { id, timestampMs, transcript, outcome } = value;
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) return null;
  if (typeof transcript !== "string") return null;
  // Optional metadata keys are only added when present, so a parsed entry is
  // deep-equal to the original when it carried none of them.
  const kind = asOptionalText(value.kind);
  const route = asOptionalText(value.route);
  const approvalMode = asOptionalText(value.approvalMode);
  const asset = asOptionalText(value.asset);
  const amount = asOptionalText(value.amount);
  const counterparty = asOptionalText(value.counterparty);
  const counterpartyNickname = asOptionalText(value.counterpartyNickname);
  return {
    id,
    timestampMs,
    transcript: transcript.slice(0, MAX_TEXT),
    answer: asText(value.answer, MAX_TEXT),
    outcome: asText(outcome, MAX_OUTCOME) || "in_progress",
    txHash: asOptionalText(value.txHash),
    explorerUrl: asOptionalText(value.explorerUrl),
    ...(kind !== null ? { kind } : {}),
    ...(route !== null ? { route } : {}),
    ...(approvalMode !== null ? { approvalMode } : {}),
    ...(asset !== null ? { asset } : {}),
    ...(amount !== null ? { amount } : {}),
    ...(counterparty !== null ? { counterparty } : {}),
    ...(counterpartyNickname !== null ? { counterpartyNickname } : {}),
  };
}

/** Parses the stored JSON into entries; malformed or foreign data is dropped. */
export function parseTurnLog(raw: string | null): TurnLogEntry[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const entries: TurnLogEntry[] = [];
  for (const value of parsed) {
    const entry = toEntry(value);
    if (entry) entries.push(entry);
    if (entries.length >= TURN_LOG_LIMIT) break;
  }
  return entries;
}

/** Serializes the log, newest first, capped at the ring-buffer size. */
export function serializeTurnLog(entries: readonly TurnLogEntry[]): string {
  return JSON.stringify(entries.slice(0, TURN_LOG_LIMIT));
}

/** Inserts or replaces one entry (by id), newest first, capped. */
export function upsertTurn(
  entries: readonly TurnLogEntry[],
  entry: TurnLogEntry,
): TurnLogEntry[] {
  const rest = entries.filter((existing) => existing.id !== entry.id);
  return [entry, ...rest].slice(0, TURN_LOG_LIMIT);
}

/**
 * Marks every still-running entry as `superseded`. The turn flow is
 * latest-wins, so starting a new turn is the signal that an older in-progress
 * one was talked over.
 */
export function supersedeInProgress(entries: readonly TurnLogEntry[]): TurnLogEntry[] {
  return entries.map((entry) =>
    entry.outcome === "in_progress" ? { ...entry, outcome: "superseded" } : entry,
  );
}

/** The browser store, or `null` when it is unavailable (SSR, private mode). */
function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the log; a storage failure reads as empty. */
export function readTurnLog(): TurnLogEntry[] {
  const store = storage();
  if (!store) return [];
  try {
    return parseTurnLog(store.getItem(TURN_LOG_KEY));
  } catch {
    return [];
  }
}

/** Writes the log; persistence is best-effort and never throws. */
function writeTurnLog(entries: readonly TurnLogEntry[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(TURN_LOG_KEY, serializeTurnLog(entries));
  } catch {
    // Storage full or disabled: the turn still happened, it just is not persisted.
  }
}

let idCounter = 0;

/** A process-unique turn id; monotonic within a session. */
export function newTurnId(nowMs: number = Date.now()): string {
  idCounter += 1;
  return `t${nowMs.toString(36)}-${idCounter.toString(36)}`;
}

/** Applies `patch` to the entry with `id`, if it is still in the log. */
function updateTurn(
  id: string,
  patch: (entry: TurnLogEntry) => TurnLogEntry,
): void {
  const entries = readTurnLog();
  if (!entries.some((entry) => entry.id === id)) return;
  writeTurnLog(entries.map((entry) => (entry.id === id ? patch(entry) : entry)));
}

/**
 * Records a turn as it starts and returns its id. Any older running turn is
 * marked `superseded` first (see `supersedeInProgress`).
 */
export function recordTurnStart(transcript: string, nowMs: number = Date.now()): string {
  const id = newTurnId(nowMs);
  const entry: TurnLogEntry = {
    id,
    timestampMs: nowMs,
    transcript: transcript.slice(0, MAX_TEXT),
    answer: "",
    outcome: "in_progress",
    txHash: null,
    explorerUrl: null,
  };
  writeTurnLog(upsertTurn(supersedeInProgress(readTurnLog()), entry));
  return id;
}

/** Records the agent's answer; leaves a later outcome label untouched. */
export function recordTurnAnswer(id: string, answer: string): void {
  updateTurn(id, (entry) => ({
    ...entry,
    answer: answer.slice(0, MAX_TEXT),
    outcome: entry.outcome === "in_progress" ? "answered" : entry.outcome,
  }));
}

/** Records the terminal outcome, with the public tx hash/explorer link if any. */
export function recordTurnOutcome(
  id: string,
  outcome: { label: string; txHash?: string | null; explorerUrl?: string | null },
): void {
  updateTurn(id, (entry) => ({
    ...entry,
    outcome: outcome.label.slice(0, MAX_OUTCOME),
    txHash: outcome.txHash ?? entry.txHash,
    explorerUrl: outcome.explorerUrl ?? entry.explorerUrl,
  }));
}

/** The optional History-view metadata one turn may carry. */
export interface TurnLogMeta {
  kind?: string;
  route?: string;
  approvalMode?: string;
  asset?: string;
  amount?: string;
  counterparty?: string;
  counterpartyNickname?: string;
}

/**
 * Records the History-view metadata (kind/route/approval/asset/amount/
 * counterparty) on a turn. Additive: fields already present are not cleared by
 * an omitted one, so the flows can patch metadata as they learn it.
 */
export function recordTurnMeta(id: string, meta: TurnLogMeta): void {
  const text = (value: string | undefined): string | undefined =>
    value && value.length > 0 ? value.slice(0, MAX_OUTCOME) : undefined;
  updateTurn(id, (entry) => ({
    ...entry,
    ...(text(meta.kind) !== undefined ? { kind: text(meta.kind) } : {}),
    ...(text(meta.route) !== undefined ? { route: text(meta.route) } : {}),
    ...(text(meta.approvalMode) !== undefined ? { approvalMode: text(meta.approvalMode) } : {}),
    ...(text(meta.asset) !== undefined ? { asset: text(meta.asset) } : {}),
    ...(text(meta.amount) !== undefined ? { amount: text(meta.amount) } : {}),
    ...(text(meta.counterparty) !== undefined ? { counterparty: text(meta.counterparty) } : {}),
    ...(text(meta.counterpartyNickname) !== undefined
      ? { counterpartyNickname: text(meta.counterpartyNickname) }
      : {}),
  }));
}

/** Clears the local log. Best-effort; a storage failure is ignored. */
export function clearTurnLog(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(TURN_LOG_KEY);
  } catch {
    // Nothing to do: the log is already unreadable.
  }
}
