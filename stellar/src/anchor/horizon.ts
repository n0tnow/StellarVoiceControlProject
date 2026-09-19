/**
 * Minimal Horizon access (plain fetch): read an account, submit a transaction.
 * Horizon is used for account state + submission because it gives immediate,
 * synchronous results for classic transactions.
 */
import { AnchorHttpError, requestJson } from "./http.ts";
import type { AnchorAsset, AnchorContext } from "./types.ts";

export interface HorizonBalance {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
}

export interface HorizonAccount {
  id: string;
  sequence: string;
  balances: HorizonBalance[];
}

/** Returns undefined when the account does not exist on the ledger yet. */
export async function loadAccount(ctx: AnchorContext, account: string): Promise<HorizonAccount | undefined> {
  try {
    return await requestJson<HorizonAccount>(ctx, `${ctx.horizonUrl}/accounts/${account}`);
  } catch (e) {
    if (e instanceof AnchorHttpError && e.status === 404) return undefined;
    throw e;
  }
}

export function balanceOf(acct: HorizonAccount | undefined, asset: AnchorAsset | "native"): string {
  if (!acct) return "0";
  const b = acct.balances.find((x) =>
    asset === "native" ? x.asset_type === "native" : x.asset_code === asset.code && x.asset_issuer === asset.issuer,
  );
  return b?.balance ?? "0";
}

export function hasTrustline(acct: HorizonAccount | undefined, asset: AnchorAsset): boolean {
  return !!acct?.balances.some((x) => x.asset_code === asset.code && x.asset_issuer === asset.issuer);
}

export interface SubmitOutcome {
  hash: string;
  ledger?: number;
}

/** Submits a signed envelope. Throws with Horizon's result codes on failure. */
export async function submitEnvelope(ctx: AnchorContext, signedXdr: string): Promise<SubmitOutcome> {
  try {
    const res = await requestJson<{ hash: string; ledger?: number }>(ctx, `${ctx.horizonUrl}/transactions`, {
      method: "POST",
      form: { tx: signedXdr },
    });
    const out: SubmitOutcome = { hash: res.hash };
    if (typeof res.ledger === "number") out.ledger = res.ledger;
    return out;
  } catch (e) {
    if (e instanceof AnchorHttpError && e.body && typeof e.body === "object") {
      const extras = (e.body as { extras?: { result_codes?: unknown } }).extras;
      if (extras?.result_codes) {
        throw new Error(`Stellar rejected the transaction: ${JSON.stringify(extras.result_codes)}`);
      }
    }
    throw e;
  }
}

export function explorerTxUrl(hash: string, passphrase: string): string {
  const net = passphrase.startsWith("Test") ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

export function explorerAccountUrl(account: string, passphrase: string): string {
  const net = passphrase.startsWith("Test") ? "testnet" : "public";
  return `https://stellar.expert/explorer/${net}/account/${account}`;
}
