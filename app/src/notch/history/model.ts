/**
 * The History page's view model (HISTORY-UI): pure mappers from the local turn
 * log, the owner's Horizon payments, P2P offers and anchor explain records into
 * one rich, comparable row.
 *
 * `HistoryRow` extends the older `HistoryEntryView`, so anything that rendered
 * that shape still compiles, while the page uses the added fields (kind, status
 * chip, signed amount, route, approval mode, counterparty, p2p/anchor detail).
 * Every mapper is React/Tauri-free so it is unit-tested under `node:test`.
 *
 * Amounts never touch `Number`: a decimal string is parsed into raw 7-decimal
 * `bigint` units and formatted back, so no float rounding can change a balance.
 */
import type { HistoryEntry } from "../../lib/mockData.ts";
import { truncateKey } from "../../lib/mockData.ts";
import type { TxStatus } from "../../lib/mockData.ts";
import type { TurnLogEntry } from "../../lib/turnLog.ts";
import type { WalletTransaction } from "../../lib/history.ts";
import type { HistoryEntryView } from "../data/historyModel.ts";

/** The asset precision used across the project (native + credit assets). */
export const ASSET_DECIMALS = 7;

/** What produced a row. */
export type HistoryOrigin = "chain" | "turn" | "p2p" | "anchor";

/** The icon category a row falls into. */
export type HistoryKind =
  | "sent"
  | "received"
  | "scheduled"
  | "p2p"
  | "anchor_deposit"
  | "anchor_withdraw"
  | "rule_change"
  | "other";

/** The status chip shown on the row. */
export type HistoryStatus = "confirmed" | "pending" | "failed" | "cancelled" | "auto_approved";

/** How a turn was routed to the chain. */
export type HistoryRoute = "direct" | "guard" | "p2p" | "anchor";

/** How the action was approved. */
export type ApprovalMode = "touch_id" | "auto" | "wallet";

/** A signed, asset-tagged display amount. */
export interface SignedAmount {
  /** `-10.5`, `+250`, `0` — no thousands separators, 7-decimal aware. */
  text: string;
  /** `-1` outgoing, `1` incoming, `0` informational. */
  direction: -1 | 0 | 1;
  asset: string;
}

/** P2P-specific detail for the drawer. */
export interface P2pDetail {
  offerId: string;
  state: string;
  nextAction: string;
}

/** Anchor-specific detail for the drawer. */
export interface AnchorDetail {
  transactionId: string | null;
  status: string;
}

/** One History row: the old view plus everything the pro timeline shows. */
export interface HistoryRow extends HistoryEntryView {
  /** Epoch milliseconds; the base `timestamp` is seconds. */
  timestampMs: number;
  origin: HistoryOrigin;
  kind: HistoryKind;
  statusChip: HistoryStatus;
  /** The headline, e.g. `Sent 10 XLM to ali`. */
  title: string;
  amount: SignedAmount | null;
  route: HistoryRoute;
  approvalMode: ApprovalMode | null;
  counterparty: string | null;
  counterpartyNickname: string | null;
  memo: string | null;
  fee: string | null;
  network: string | null;
  p2p: P2pDetail | null;
  anchor: AnchorDetail | null;
}

const KINDS: readonly HistoryKind[] = [
  "sent",
  "received",
  "scheduled",
  "p2p",
  "anchor_deposit",
  "anchor_withdraw",
  "rule_change",
  "other",
];

const APPROVAL_MODES: readonly ApprovalMode[] = ["touch_id", "auto", "wallet"];

/** Parses a decimal string into raw units. `null` for anything not a number. */
export function parseAmountRaw(value: string, decimals = ASSET_DECIMALS): bigint | null {
  const text = value.trim();
  if (text === "" || !/^[+-]?\d*\.?\d*$/.test(text)) return null;
  if (!/\d/.test(text)) return null;
  const negative = text.startsWith("-");
  const unsigned = text.replace(/^[+-]/, "");
  const [whole = "", frac = ""] = unsigned.split(".");
  const padded = (frac + "0".repeat(decimals)).slice(0, decimals);
  try {
    const raw = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0");
    return negative ? -raw : raw;
  } catch {
    return null;
  }
}

/** Formats raw units as a trimmed decimal string. Pure integer arithmetic. */
export function formatRawAmount(raw: bigint, decimals = ASSET_DECIMALS): string {
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const body = frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${body}` : body;
}

/** Builds a signed amount from a display value, or `null` when there is none. */
export function buildAmount(
  value: string | null | undefined,
  asset: string | null | undefined,
  direction: -1 | 0 | 1,
): SignedAmount | null {
  if (value === null || value === undefined || value === "") return null;
  const raw = parseAmountRaw(value);
  if (raw === null) return null;
  const magnitude = raw < 0n ? -raw : raw;
  const sign = direction === 0 ? (raw < 0n ? "-" : "") : direction < 0 ? "-" : "+";
  return { text: `${sign}${formatRawAmount(magnitude)}`, direction, asset: asset ?? "XLM" };
}

/** The default direction for a kind (P2P sets its own from the viewer's role). */
export function kindDirection(kind: HistoryKind): -1 | 0 | 1 {
  if (kind === "sent" || kind === "anchor_withdraw") return -1;
  if (kind === "received" || kind === "anchor_deposit") return 1;
  return 0;
}

/** The base `TxStatus` (kept for the shared status icon) for a chip. */
export function chipToBaseStatus(chip: HistoryStatus): TxStatus {
  if (chip === "pending") return "pending";
  if (chip === "failed" || chip === "cancelled") return "failed";
  return "success";
}

/** The status chip for a turn outcome. */
export function turnChip(entry: TurnLogEntry): HistoryStatus {
  if (entry.outcome === "superseded") return "cancelled";
  if (entry.outcome.startsWith("failed")) return "failed";
  if (entry.outcome === "in_progress") return "pending";
  if (entry.approvalMode === "auto") return "auto_approved";
  return "confirmed";
}

/** Best-effort kind for a local turn: the declared one, else inferred. */
export function inferTurnKind(entry: TurnLogEntry): HistoryKind {
  if (entry.kind && (KINDS as readonly string[]).includes(entry.kind)) {
    return entry.kind as HistoryKind;
  }
  const text = `${entry.transcript} ${entry.answer}`.toLowerCase();
  if (/schedul|zamanla|every day|every week|her gün|her hafta/.test(text)) return "scheduled";
  if (/rule|kural|limit/.test(text)) return "rule_change";
  if (entry.txHash !== null) {
    return /receiv|aldı|geldi|incoming/.test(text) ? "received" : "sent";
  }
  return "other";
}

function asApproval(value: string | undefined): ApprovalMode | null {
  return value !== undefined && (APPROVAL_MODES as readonly string[]).includes(value)
    ? (value as ApprovalMode)
    : null;
}

function asRoute(value: string | undefined): HistoryRoute {
  return value === "guard" || value === "p2p" || value === "anchor" ? value : "direct";
}

function turnTitle(entry: TurnLogEntry, kind: HistoryKind, amount: SignedAmount | null): string {
  if (amount !== null && (kind === "sent" || kind === "received")) {
    const who = entry.counterpartyNickname ?? (entry.counterparty ? truncateKey(entry.counterparty, 6, 4) : null);
    const verb = kind === "sent" ? "Sent" : "Received";
    const prep = kind === "sent" ? "to" : "from";
    return who ? `${verb} ${formatRawAmount(absOf(amount))} ${amount.asset} ${prep} ${who}` : `${verb} ${formatRawAmount(absOf(amount))} ${amount.asset}`;
  }
  return entry.transcript.length > 0 ? entry.transcript : entry.answer || "Voice turn";
}

function absOf(amount: SignedAmount): bigint {
  const raw = parseAmountRaw(amount.text);
  return raw === null || raw < 0n ? (raw === null ? 0n : -raw) : raw;
}

/** One local turn → one rich History row. */
export function turnToHistoryRow(entry: TurnLogEntry): HistoryRow {
  const kind = inferTurnKind(entry);
  const approvalMode = asApproval(entry.approvalMode);
  const amount = buildAmount(entry.amount, entry.asset, kindDirection(kind));
  const chip = turnChip(entry);
  return {
    id: `turn:${entry.id}`,
    timestamp: Math.floor(entry.timestampMs / 1000),
    timestampMs: entry.timestampMs,
    transcript: entry.transcript,
    response: entry.answer.length > 0 ? entry.answer : "…",
    action: entry.txHash !== null ? "Transaction submitted" : null,
    status: chipToBaseStatus(chip),
    txHash: entry.txHash,
    explorerUrl: entry.explorerUrl,
    origin: "turn",
    kind,
    statusChip: chip,
    title: turnTitle(entry, kind, amount),
    amount,
    route: asRoute(entry.route),
    approvalMode,
    counterparty: entry.counterparty ?? null,
    counterpartyNickname: entry.counterpartyNickname ?? null,
    memo: null,
    fee: null,
    network: null,
    p2p: null,
    anchor: null,
  };
}

/** One Horizon payment → one rich History row. */
export function chainToHistoryRow(tx: WalletTransaction): HistoryRow {
  const sent = tx.direction === "sent";
  const who = tx.counterpartyAlias ?? truncateKey(tx.counterparty, 6, 4);
  const kind: HistoryKind = sent ? "sent" : "received";
  const amount = buildAmount(tx.amount, tx.asset, sent ? -1 : 1);
  const display = amount !== null ? formatRawAmount(absOf(amount)) : tx.amount;
  const summary = `${sent ? "Sent" : "Received"} ${display} ${tx.asset}`;
  return {
    id: `chain:${tx.id}`,
    timestamp: Math.floor(tx.createdAtMs / 1000),
    timestampMs: tx.createdAtMs,
    transcript: summary,
    response: `${sent ? "To" : "From"} ${who}`,
    action: `${summary} ${sent ? "to" : "from"} ${who}`,
    status: "success",
    txHash: tx.hash,
    explorerUrl: tx.explorerUrl,
    origin: "chain",
    kind,
    statusChip: "confirmed",
    title: who ? `${summary} ${sent ? "to" : "from"} ${who}` : summary,
    amount,
    route: "direct",
    approvalMode: null,
    counterparty: tx.counterparty,
    counterpartyNickname: tx.counterpartyAlias ?? null,
    memo: null,
    fee: null,
    network: null,
    p2p: null,
    anchor: null,
  };
}

/** The structural P2P input a row needs (keeps the SDK out of this module). */
export interface P2pRowInput {
  offerId: string;
  seller: string;
  buyer: string | null;
  amount: string;
  asset: string;
  priceTry: string;
  state: string;
  createdAtMs: number;
  role: "seller" | "buyer" | "other";
  nextAction: string;
  nextActionHint: string;
  explorerUrl: string | null;
}

/** The chip for a P2P offer state. */
export function p2pChip(state: string): HistoryStatus {
  if (state === "Settled") return "confirmed";
  if (state === "Cancelled" || state === "Expired") return "cancelled";
  return "pending";
}

/** One P2P offer → one rich History row. The seller's leg is outgoing. */
export function p2pToHistoryRow(input: P2pRowInput): HistoryRow {
  const direction: -1 | 0 | 1 = input.role === "buyer" ? 1 : input.role === "seller" ? -1 : 0;
  const amount = buildAmount(input.amount, input.asset, direction);
  const who = input.role === "buyer" ? input.seller : (input.buyer ?? null);
  const title = `P2P offer #${input.offerId} — ${input.amount} ${input.asset} for ${input.priceTry} TRY`;
  const chip = p2pChip(input.state);
  return {
    id: `p2p:${input.offerId}`,
    timestamp: Math.floor(input.createdAtMs / 1000),
    timestampMs: input.createdAtMs,
    transcript: title,
    response: input.nextActionHint,
    action: input.nextAction === "none" ? null : input.nextActionHint,
    status: chipToBaseStatus(chip),
    txHash: null,
    explorerUrl: input.explorerUrl,
    origin: "p2p",
    kind: "p2p",
    statusChip: chip,
    title,
    amount,
    route: "p2p",
    approvalMode: null,
    counterparty: who,
    counterpartyNickname: null,
    memo: null,
    fee: null,
    network: null,
    p2p: { offerId: input.offerId, state: input.state, nextAction: input.nextActionHint },
    anchor: null,
  };
}

/** A structural anchor explain record (keeps the SDK out of this module). */
export interface AnchorRowInput {
  step: string;
  what: string;
  why: string;
  at: string;
  anchorSaid?: string;
  link?: string;
}

/** True for explain steps that represent a value-moving anchor action. */
export function isAnchorActionStep(step: string): boolean {
  return /sep6|sep24|deposit|withdraw|trust|payment|payout/i.test(step);
}

/** One anchor explain record → one rich History row. */
export function anchorToHistoryRow(record: AnchorRowInput): HistoryRow | null {
  if (!isAnchorActionStep(record.step)) return null;
  const at = Date.parse(record.at);
  const timestampMs = Number.isFinite(at) ? at : Date.now();
  const kind: HistoryKind = /withdraw|payout/i.test(record.step) ? "anchor_withdraw" : "anchor_deposit";
  return {
    id: `anchor:${record.step}:${timestampMs}`,
    timestamp: Math.floor(timestampMs / 1000),
    timestampMs,
    transcript: record.what,
    response: record.anchorSaid ?? record.why,
    action: record.what,
    status: "success",
    txHash: null,
    explorerUrl: record.link ?? null,
    origin: "anchor",
    kind,
    statusChip: "confirmed",
    title: record.what,
    amount: null,
    route: "anchor",
    approvalMode: null,
    counterparty: null,
    counterpartyNickname: null,
    memo: null,
    fee: null,
    network: null,
    p2p: null,
    anchor: { transactionId: record.link ?? null, status: record.step },
  };
}

/** A cheap mock `HistoryEntry` → row, used only for the labelled demo timeline. */
export function demoToHistoryRow(entry: HistoryEntry): HistoryRow {
  const kind: HistoryKind = entry.action?.toLowerCase().includes("schedule")
    ? "scheduled"
    : entry.action?.toLowerCase().startsWith("send")
      ? "sent"
      : "other";
  const chip: HistoryStatus =
    entry.status === "pending" ? "pending" : entry.status === "failed" ? "failed" : "confirmed";
  return {
    id: `demo:${entry.id}`,
    timestamp: entry.timestamp,
    timestampMs: entry.timestamp * 1000,
    transcript: entry.transcript,
    response: entry.response,
    action: entry.action,
    status: entry.status,
    txHash: entry.txHash,
    explorerUrl: null,
    origin: "turn",
    kind,
    statusChip: chip,
    title: entry.action ?? entry.transcript,
    amount: null,
    route: "direct",
    approvalMode: null,
    counterparty: null,
    counterpartyNickname: null,
    memo: null,
    fee: null,
    network: null,
    p2p: null,
    anchor: null,
  };
}

/** Merges any number of row lists, newest first, de-duplicated by id and hash. */
export function mergeRows(...lists: readonly HistoryRow[][]): HistoryRow[] {
  const seenIds = new Set<string>();
  const seenHashes = new Set<string>();
  const rows: HistoryRow[] = [];
  for (const list of lists) {
    for (const row of list) {
      if (seenIds.has(row.id)) continue;
      if (row.txHash !== null && seenHashes.has(row.txHash)) continue;
      seenIds.add(row.id);
      if (row.txHash !== null) seenHashes.add(row.txHash);
      rows.push(row);
    }
  }
  return rows.sort((a, b) => b.timestampMs - a.timestampMs || a.id.localeCompare(b.id));
}
