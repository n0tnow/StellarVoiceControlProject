/**
 * Wallet asset/account read model for the notch dashboard (task W13b).
 *
 * `history.ts` reads the account only as far as balances; the professional
 * dashboard needs the whole picture — trustlines with their issuer, the
 * subentry count behind the native reserve, and the sequence. The Horizon read
 * and every display decision live here so they are unit-tested without Tauri:
 * amounts are formatted from strings (never a float), the native reserve is
 * `(2 + subentries) * 0.5 XLM`, and natives sort first.
 *
 * Read-only: no key, no signing, no value movement.
 */
import type { FetchLike } from "./history.ts";

/** One Horizon balance line, kept raw so the UI can format without a float. */
export interface HorizonAccountBalance {
  assetType: string;
  /** `"XLM"` for the native balance. */
  code: string;
  issuer: string | null;
  /** The raw Horizon decimal string, e.g. `"100.0000000"`. */
  balance: string;
  native: boolean;
  limit: string | null;
}

/** The account fields the dashboard shows beyond its balances. */
export interface HorizonAccountDetail {
  sequence: string;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  balances: HorizonAccountBalance[];
}

/** The account endpoint's outcome; `not_found` is an unfunded account (404). */
export type HorizonAccountResult =
  | { status: "ok"; detail: HorizonAccountDetail }
  | { status: "not_found" }
  | { status: "offline"; message: string };

/** Reads the full account (trustlines, sequence, subentries) from Horizon. */
export async function fetchAccountDetail(
  horizonUrl: string,
  address: string,
  deps: { fetchImpl?: FetchLike } = {},
): Promise<HorizonAccountResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { status: "offline", message: "no fetch implementation is available" };
  try {
    const response = await fetchImpl(`${horizonUrl.replace(/\/$/, "")}/accounts/${address}`, {
      headers: { accept: "application/json" },
    });
    if (response.status === 404) return { status: "not_found" };
    if (!response.ok) {
      return { status: "offline", message: `Horizon returned HTTP ${response.status}` };
    }
    const body = (await response.json()) as {
      sequence?: string;
      subentry_count?: number;
      num_sponsoring?: number;
      num_sponsored?: number;
      balances?: {
        asset_type?: string;
        asset_code?: string;
        asset_issuer?: string;
        balance?: string;
        limit?: string;
      }[];
    };
    return { status: "ok", detail: mapAccountDetail(body) };
  } catch (error) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return { status: "offline", message: raw.split("\n")[0]?.trim() || "Horizon is unreachable" };
  }
}

/** The Horizon account JSON fields this module reads. */
export interface HorizonAccountBody {
  sequence?: string;
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances?: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    balance?: string;
    limit?: string;
  }[];
}

/** Pure: Horizon JSON → the dashboard's account detail. */
export function mapAccountDetail(body: HorizonAccountBody): HorizonAccountDetail {
  return {
    sequence: body.sequence ?? "0",
    subentryCount: body.subentry_count ?? 0,
    numSponsoring: body.num_sponsoring ?? 0,
    numSponsored: body.num_sponsored ?? 0,
    balances: (body.balances ?? []).map((entry) => {
      const native = entry.asset_type === "native" || entry.asset_type === undefined;
      return {
        assetType: entry.asset_type ?? "native",
        code: native ? "XLM" : (entry.asset_code ?? "?"),
        issuer: native ? null : (entry.asset_issuer ?? null),
        balance: entry.balance ?? "0",
        native,
        limit: entry.limit ?? null,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Pure formatting
 * ------------------------------------------------------------------ */

/** The number of decimals the project renders for every Stellar asset. */
export const ASSET_DECIMALS = 7;

/**
 * Formats a Horizon decimal string without ever converting it to a float:
 * the integer part is grouped, the fraction is trimmed of trailing zeros and
 * capped at 7 places. `"1234.5678900"` → `"1,234.56789"`.
 */
export function formatStellarAmount(raw: string): string {
  const trimmed = raw.trim();
  const sign = trimmed.startsWith("-") ? "-" : "";
  const unsigned = sign ? trimmed.slice(1) : trimmed;
  const [integer = "0", fraction = ""] = unsigned.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const capped = fraction.slice(0, ASSET_DECIMALS).replace(/0+$/, "");
  return `${sign}${grouped}${capped.length > 0 ? `.${capped}` : ""}`;
}

/**
 * The native balance the network locks up, in tenths of XLM: the account base
 * (2 entries) plus one entry per subentry, at 0.5 XLM each. No float.
 */
export function reservedTenths(subentryCount: number): number {
  return 10 + 5 * Math.max(0, Math.trunc(subentryCount));
}

/** `"1 XLM reserved"` / `"1.5 XLM reserved"` from a tenths count. */
export function formatReserved(tenths: number): string {
  const whole = Math.floor(tenths / 10);
  const rest = tenths % 10;
  return `${rest === 0 ? `${whole}` : `${whole}.${rest}`} XLM reserved`;
}

/** `"GABC…WXYZ"` for a trustline issuer; `null` stays `null`. */
export function shortIssuer(issuer: string | null): string | null {
  if (issuer === null || issuer.length <= 10) return issuer;
  return `${issuer.slice(0, 4)}…${issuer.slice(-4)}`;
}

/** Natives first, then by code, then by issuer — the dashboard's asset order. */
export function sortAccountBalances(
  balances: readonly HorizonAccountBalance[],
): HorizonAccountBalance[] {
  return [...balances].sort((a, b) => {
    if (a.native !== b.native) return a.native ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return (a.issuer ?? "") < (b.issuer ?? "") ? -1 : 1;
  });
}

/** One asset row, pre-formatted for the dashboard. */
export interface AssetRow {
  key: string;
  code: string;
  issuer: string | null;
  balance: string;
  note: string;
  native: boolean;
}

/** Pure: native + trustlines → the ordered, formatted asset rows. */
export function deriveAssetRows(detail: HorizonAccountDetail): AssetRow[] {
  const reserve = formatReserved(reservedTenths(detail.subentryCount));
  return sortAccountBalances(detail.balances).map((balance) => ({
    key: balance.native ? "native" : `${balance.code}:${balance.issuer ?? ""}`,
    code: balance.code,
    issuer: shortIssuer(balance.issuer),
    balance: formatStellarAmount(balance.balance),
    note: balance.native ? reserve : "credit",
    native: balance.native,
  }));
}

/** The account status chip: funded as soon as Horizon knows the account. */
export function accountStatusLabel(result: HorizonAccountResult): "Funded" | "Not funded" {
  return result.status === "ok" ? "Funded" : "Not funded";
}

/* ------------------------------------------------------------------ *
 * "Add asset" catalog (task W18)
 * ------------------------------------------------------------------ */

/**
 * The assets the Wallet's "Add asset" list offers. Display-only: the issuer
 * pins (Circle's USDC, the SDF test anchor's SRT) live in `@polaris/stellar`.
 */
export const TRUSTLINE_ASSETS: readonly { code: string; label: string }[] = [
  { code: "USDC", label: "USDC — Circle testnet" },
  { code: "SRT", label: "SRT — SDF test anchor" },
];

/** Circle's testnet USDC faucet; opened through the allow-listed `open_external`. */
export const USDC_FAUCET_URL = "https://faucet.circle.com/";

/** The one-line hint shown once USDC is enabled on the account. */
export const USDC_FAUCET_HINT =
  "Get test USDC: copy your address and request it at faucet.circle.com";

/** One asset row on the wallet: its code/label and whether the trustline exists. */
export interface TrustlineRow {
  code: string;
  label: string;
  added: boolean;
}

/** True when a credit trustline for `code` is already present. */
export function hasTrustline(detail: HorizonAccountDetail | null, code: string): boolean {
  if (!detail) return false;
  const wanted = code.trim().toUpperCase();
  return detail.balances.some(
    (balance) => !balance.native && balance.code.toUpperCase() === wanted,
  );
}

/** The catalog annotated with the account's current trustline state. */
export function trustlineRows(detail: HorizonAccountDetail | null): TrustlineRow[] {
  return TRUSTLINE_ASSETS.map((asset) => ({
    ...asset,
    added: hasTrustline(detail, asset.code),
  }));
}

/* ------------------------------------------------------------------ *
 * Testnet funding (task W15b)
 * ------------------------------------------------------------------ */

/** The testnet faucet the app calls in-process, so no browser is opened. */
export const FRIENDBOT_ENDPOINT = "https://friendbot.stellar.org";

export type FriendbotResult = { status: "ok" } | { status: "failed"; message: string };

/**
 * Asks Friendbot to credit a public testnet address. This runs inside the app
 * (the Wallet page's "Fund account" button) instead of linking out. It only
 * sends the public `G…` address to the faucet; no key, no signing.
 */
export async function requestFriendbotFund(
  address: string,
  deps: { fetchImpl?: FetchLike; endpoint?: string } = {},
): Promise<FriendbotResult> {
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { status: "failed", message: "no fetch implementation is available" };
  const base = (deps.endpoint ?? FRIENDBOT_ENDPOINT).replace(/\/$/, "");
  try {
    const response = await fetchImpl(`${base}/?addr=${encodeURIComponent(address)}`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return { status: "failed", message: `Friendbot returned HTTP ${response.status}` };
    return { status: "ok" };
  } catch (error) {
    const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return { status: "failed", message: raw.split("\n")[0]?.trim() || "Friendbot is unreachable" };
  }
}
