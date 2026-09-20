/**
 * The wallet's read-only window onto Horizon (step W6c).
 *
 * Two pure mappers and two small fetchers:
 *
 * - `fetchOwnerAccount` / `fetchOwnerPayments` read the owner's balances and its
 *   most recent payments. They never sign, never submit and follow no links the
 *   caller did not ask for; a network failure is a typed `offline` result, not a
 *   throw, so a panel can show a calm state.
 * - `mapWalletTransactions` turns Horizon records into the direction / alias /
 *   amount / explorer rows the Wallet panel renders.
 * - `mapHistoryRecords` turns the owner's **outgoing** payments into the
 *   `@polaris/stellar` suggestions engine's `HistoryRecord` shape.
 *
 * The fetchers accept an injected `fetch`, so the mapping and the 404/offline
 * branching are unit-tested against fixtures (`history.test.ts`) without a
 * network. Nothing here holds a key or moves value.
 */
import { suggest } from "@polaris/stellar";
import type { StellarConfig } from "@polaris/interfaces";

/** Default testnet block explorer base; the panel passes the configured one. */
export const DEFAULT_EXPLORER_BASE = "https://stellar.expert/explorer/testnet";

/** Testnet native + credit assets all use 7 decimals on this project. */
export const ASSET_DECIMALS = suggest.DEFAULT_ASSET_DECIMALS;

/** The Horizon payment shape, narrowed to the fields this module reads. */
export interface HorizonPaymentRecord {
  id: string;
  /** Horizon's stable paging token, used as the `cursor` for the next page. */
  paging_token?: string;
  type?: string;
  transaction_hash?: string;
  created_at?: string;
  source_account?: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  starting_balance?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  successful?: boolean;
}

/** One trustline / native balance as Horizon reports it. */
export interface WalletBalance {
  asset: string;
  balance: string;
  native: boolean;
}

/** The account endpoint's outcome. `not_found` is an unfunded account (404). */
export type AccountFetchResult =
  | { status: "ok"; balances: WalletBalance[] }
  | { status: "not_found" }
  | { status: "offline"; message: string };

/**
 * The payments endpoint's outcome. `not_found` is an unfunded account (404).
 * `nextCursor` (optional, for callers that paginate) is the paging token of the
 * last record, or `null` on the last page.
 */
export type PaymentsFetchResult =
  | { status: "ok"; payments: HorizonPaymentRecord[]; nextCursor?: string | null }
  | { status: "not_found" }
  | { status: "offline"; message: string };

/** The minimal fetch surface the fetchers use; injectable so tests need no network. */
export type FetchLike = (
  input: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** One resolved alias for the wallet's alias book. */
export interface AliasEntryView {
  name: string;
  address: string;
  source: "env" | "committed";
}

/** The committed `aliases.json` shape (address + network per name). */
export type CommittedAliases = Record<string, { address: string; network?: string }>;

/** A wallet transaction row, already resolved for display. */
export interface WalletTransaction {
  id: string;
  hash: string | null;
  direction: "sent" | "received";
  counterparty: string;
  counterpartyAlias?: string;
  amount: string;
  asset: string;
  createdAtMs: number;
  explorerUrl: string | null;
}

/** A 56-char `G...` StrKey shape; the checksum is validated by the chain layer. */
const ADDRESS_SHAPE = /^G[A-Z2-7]{55}$/;

/** Alias names follow the alias-book grammar (`stellar/src/payments/aliases.ts`). */
const ALIAS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

function isNative(record: { asset_type?: string }): boolean {
  return record.asset_type === "native" || record.asset_type === undefined;
}

/** The Horizon record types this module maps; everything else is ignored. */
function isSupportedType(type: string | undefined): boolean {
  return type === "payment" || type === "create_account" || (type?.startsWith("path_payment") ?? false);
}

function assetCode(record: { asset_type?: string; asset_code?: string }): string {
  return isNative(record) ? "XLM" : (record.asset_code ?? "?");
}

/** A Horizon amount string without trailing zeros, e.g. "10.0000000" -> "10". */
export function trimAmount(display: string): string {
  if (!display.includes(".")) return display;
  return display.replace(/0+$/, "").replace(/\.$/, "");
}

/** The explorer link for a transaction hash, or `null` when there is none. */
export function explorerTxUrl(explorerBase: string, hash: string | null): string | null {
  return hash ? `${explorerBase.replace(/\/$/, "")}/tx/${hash}` : null;
}

/** The explorer link for an account. */
export function explorerAccountUrl(explorerBase: string, address: string): string {
  return `${explorerBase.replace(/\/$/, "")}/account/${address}`;
}

/** The testnet Friendbot URL that funds an account with 10 000 XLM. */
export function friendbotUrl(address: string): string {
  return `https://friendbot.stellar.org/?addr=${encodeURIComponent(address)}`;
}

function errorLine(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return raw.split("\n")[0]?.trim() || "Horizon is unreachable";
}

/** Reads the owner's balances from Horizon. Read-only. */
export async function fetchOwnerAccount(
  horizonUrl: string,
  ownerAddress: string,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<AccountFetchResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { status: "offline", message: "no fetch implementation is available" };
  try {
    const response = await fetchImpl(`${horizonUrl.replace(/\/$/, "")}/accounts/${ownerAddress}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "offline", message: `Horizon returned HTTP ${response.status}` };
    const body = (await response.json()) as {
      balances?: { asset_type?: string; balance?: string; asset_code?: string }[];
    };
    const balances: WalletBalance[] = (body.balances ?? []).map((entry) => ({
      asset: assetCode(entry),
      balance: entry.balance ?? "0",
      native: isNative(entry),
    }));
    balances.sort((a, b) => Number(b.native) - Number(a.native) || a.asset.localeCompare(b.asset));
    return { status: "ok", balances };
  } catch (error) {
    return { status: "offline", message: errorLine(error) };
  }
}

/**
 * Reads the owner's most recent payments from Horizon, newest first.
 * `limit` is clamped to 1..200 so a panel cannot ask for an unbounded page.
 */
export async function fetchOwnerPayments(
  horizonUrl: string,
  ownerAddress: string,
  deps: { fetchImpl?: FetchLike; limit?: number; cursor?: string } = {},
): Promise<PaymentsFetchResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { status: "offline", message: "no fetch implementation is available" };
  const limit = Math.min(200, Math.max(1, Math.floor(deps.limit ?? 10)));
  // A cursor pages backwards from a known record; the first page omits it so the
  // request stays identical to the pre-pagination call.
  const cursor = deps.cursor && deps.cursor.length > 0 ? `&cursor=${encodeURIComponent(deps.cursor)}` : "";
  const url =
    `${horizonUrl.replace(/\/$/, "")}/accounts/${ownerAddress}/payments` +
    `?order=desc&limit=${limit}&include_failed=false${cursor}`;
  try {
    const response = await fetchImpl(url, { headers: { accept: "application/json" } });
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) return { status: "offline", message: `Horizon returned HTTP ${response.status}` };
    const body = (await response.json()) as {
      _embedded?: { records?: HorizonPaymentRecord[] };
    };
    const payments = body._embedded?.records ?? [];
    // A short page means Horizon has nothing older; a full one offers its tail
    // as the cursor. Missing tokens fall back to the last record's id.
    const tail = payments[payments.length - 1];
    const nextCursor =
      payments.length >= limit && tail ? (tail.paging_token ?? tail.id ?? null) : null;
    return { status: "ok", payments, nextCursor };
  } catch (error) {
    return { status: "offline", message: errorLine(error) };
  }
}

interface NormalizedPayment {
  id: string;
  hash: string | null;
  direction: "sent" | "received";
  counterparty: string;
  amount: string;
  asset: string;
  createdAtMs: number;
}

/**
 * Normalises one Horizon record from the owner's perspective, or `null` when it
 * is not a payment this panel understands (account merges, failed records, …).
 */
function normalizePayment(
  record: HorizonPaymentRecord,
  ownerAddress: string,
): NormalizedPayment | null {
  if (record.successful === false) return null;
  if (!isSupportedType(record.type)) return null;
  const createdAtMs = record.created_at ? Date.parse(record.created_at) : Number.NaN;
  if (!Number.isFinite(createdAtMs)) return null;
  const id = record.id;
  const hash = record.transaction_hash ?? null;

  if (record.type === "create_account") {
    const funder = record.funder ?? record.source_account;
    const account = record.account;
    if (!funder || !account) return null;
    if (funder === ownerAddress) {
      return { id, hash, direction: "sent", counterparty: account, amount: record.starting_balance ?? "0", asset: "XLM", createdAtMs };
    }
    if (account === ownerAddress) {
      return { id, hash, direction: "received", counterparty: funder, amount: record.starting_balance ?? "0", asset: "XLM", createdAtMs };
    }
    return null;
  }

  const from = record.from ?? record.source_account;
  const to = record.to;
  if (!from || !to) return null;
  const direction = from === ownerAddress ? "sent" : to === ownerAddress ? "received" : null;
  if (direction === null) return null;
  const counterparty = direction === "sent" ? to : from;
  return {
    id,
    hash,
    direction,
    counterparty,
    amount: record.amount ?? "0",
    asset: assetCode(record),
    createdAtMs,
  };
}

/**
 * Builds the Wallet panel's transaction rows. Newest first, aliases resolved
 * from the book, explorer links built from `explorerBase`.
 */
export function mapWalletTransactions(
  payments: readonly HorizonPaymentRecord[],
  options: {
    ownerAddress: string;
    aliasEntries?: readonly AliasEntryView[];
    explorerBase?: string;
  },
): WalletTransaction[] {
  const explorerBase = options.explorerBase ?? DEFAULT_EXPLORER_BASE;
  const rows: WalletTransaction[] = [];
  for (const record of payments) {
    const payment = normalizePayment(record, options.ownerAddress);
    if (!payment) continue;
    const alias = aliasNameForAddress(options.aliasEntries ?? [], payment.counterparty);
    rows.push({
      id: payment.id,
      hash: payment.hash,
      direction: payment.direction,
      counterparty: payment.counterparty,
      ...(alias === undefined ? {} : { counterpartyAlias: alias }),
      amount: trimAmount(payment.amount),
      asset: payment.asset,
      createdAtMs: payment.createdAtMs,
      explorerUrl: explorerTxUrl(explorerBase, payment.hash),
    });
  }
  rows.sort((a, b) => b.createdAtMs - a.createdAtMs || (a.id < b.id ? 1 : -1));
  return rows;
}

/**
 * Maps the owner's **outgoing** payments onto the suggestions engine's
 * `HistoryRecord` shape. Only public, successful, direct payments are included;
 * every amount is parsed to raw units with the asset's 7 decimals.
 */
export function mapHistoryRecords(
  payments: readonly HorizonPaymentRecord[],
  ownerAddress: string,
): suggest.HistoryRecord[] {
  const records: suggest.HistoryRecord[] = [];
  for (const record of payments) {
    const payment = normalizePayment(record, ownerAddress);
    if (!payment || payment.direction !== "sent") continue;
    let amountRaw: bigint;
    try {
      amountRaw = suggest.parseAmount(payment.amount, ASSET_DECIMALS);
    } catch {
      continue;
    }
    if (amountRaw <= 0n) continue;
    records.push({
      id: payment.id,
      ts: Math.floor(payment.createdAtMs / 1000),
      recipientAddress: payment.counterparty,
      asset: payment.asset,
      amountRaw,
      mode: "public",
      route: "direct",
      status: "confirmed",
    });
  }
  return records;
}

/**
 * Merges the env alias book over the committed `aliases.json`, keeping only
 * well-formed names and testnet `G...` addresses. Env wins on a name clash.
 */
export function buildAliasEntries(
  envAliases: StellarConfig["aliases"] | undefined,
  committed: CommittedAliases | undefined,
): AliasEntryView[] {
  const entries = new Map<string, AliasEntryView>();
  for (const [name, value] of Object.entries(committed ?? {})) {
    if (!ALIAS_NAME.test(name) || !ADDRESS_SHAPE.test(value.address)) continue;
    entries.set(name, { name, address: value.address, source: "committed" });
  }
  for (const [name, address] of Object.entries(envAliases ?? {})) {
    if (!ALIAS_NAME.test(name) || !ADDRESS_SHAPE.test(address)) continue;
    entries.set(name, { name, address, source: "env" });
  }
  return [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The alias name that resolves to `address`, if any. */
export function aliasNameForAddress(
  entries: readonly AliasEntryView[],
  address: string,
): string | undefined {
  return entries.find((entry) => entry.address === address)?.name;
}
