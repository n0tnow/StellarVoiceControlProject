/**
 * SEP-1: stellar.toml discovery. From ONE input (the anchor home domain) we learn
 * where to authenticate, deposit, do KYC and get quotes — nothing is hard-coded.
 */
import { parse } from "smol-toml";
import { requestText } from "./http.ts";
import { shortKey } from "./explain.ts";
import type { AnchorContext, AnchorToml, TomlCurrency } from "./types.ts";

export class TomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlError";
  }
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Pure parser (unit-tested). Only the programmatic SEP endpoints are read. */
export function parseStellarToml(homeDomain: string, text: string): AnchorToml {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new TomlError(`stellar.toml of ${homeDomain} is not valid TOML: ${(e as Error).message}`);
  }
  const webAuth = str(doc.WEB_AUTH_ENDPOINT);
  const transfer = str(doc.TRANSFER_SERVER);
  const signingKey = str(doc.SIGNING_KEY);
  const passphrase = str(doc.NETWORK_PASSPHRASE);
  if (!webAuth) throw new TomlError(`${homeDomain} does not publish WEB_AUTH_ENDPOINT (SEP-10)`);
  if (!transfer) throw new TomlError(`${homeDomain} does not publish TRANSFER_SERVER (SEP-6)`);
  if (!signingKey || !STELLAR_ADDRESS.test(signingKey)) {
    throw new TomlError(`${homeDomain} does not publish a valid SIGNING_KEY (needed to verify SEP-10 challenges)`);
  }
  if (!passphrase) throw new TomlError(`${homeDomain} does not publish NETWORK_PASSPHRASE`);

  const rawCurrencies = Array.isArray(doc.CURRENCIES) ? doc.CURRENCIES : [];
  const currencies: TomlCurrency[] = [];
  for (const c of rawCurrencies) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const code = str(rec.code);
    if (!code) continue;
    const cur: TomlCurrency = { code };
    const issuer = str(rec.issuer);
    if (issuer) cur.issuer = issuer;
    const status = str(rec.status);
    if (status) cur.status = status;
    const anchorAsset = str(rec.anchor_asset);
    if (anchorAsset) cur.anchorAsset = anchorAsset;
    const anchorAssetType = str(rec.anchor_asset_type);
    if (anchorAssetType) cur.anchorAssetType = anchorAssetType;
    currencies.push(cur);
  }

  const out: AnchorToml = {
    homeDomain,
    networkPassphrase: passphrase,
    signingKey,
    webAuthEndpoint: webAuth,
    transferServer: transfer.replace(/\/$/, ""),
    currencies,
  };
  const kyc = str(doc.KYC_SERVER);
  if (kyc) out.kycServer = kyc.replace(/\/$/, "");
  const quote = str(doc.ANCHOR_QUOTE_SERVER);
  if (quote) out.quoteServer = quote.replace(/\/$/, "");
  return out;
}

/** Normalises `https://host/` or `host` into a bare host name. */
export function normaliseHomeDomain(input: string): string {
  return input.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

/** Fetches and parses `https://<homeDomain>/.well-known/stellar.toml`. */
export async function discoverAnchor(ctx: AnchorContext, homeDomainInput: string): Promise<AnchorToml> {
  const homeDomain = normaliseHomeDomain(homeDomainInput);
  const url = `https://${homeDomain}/.well-known/stellar.toml`;
  const text = await requestText(ctx, url);
  const toml = parseStellarToml(homeDomain, text);
  if (toml.networkPassphrase !== ctx.networkPassphrase) {
    throw new TomlError(
      `${homeDomain} runs on "${toml.networkPassphrase}" but this wallet is on "${ctx.networkPassphrase}" — refusing to talk to it`,
    );
  }
  ctx.explain.record(
    "sep1.discover",
    `SEP-1: read ${homeDomain}'s public stellar.toml and learned where to log in (${new URL(toml.webAuthEndpoint).pathname}), ` +
      `move money (${new URL(toml.transferServer).pathname}), do KYC and fetch quotes. The anchor's signing key is ${shortKey(toml.signingKey)}.`,
    "Everything about an anchor is published in one standard file, so all we need from you is the anchor's domain name.",
  );
  return toml;
}

/** Finds the on-chain asset for `code` in the toml. */
export function findAsset(toml: AnchorToml, code: string): { code: string; issuer: string; anchorAsset?: string } {
  const cur = toml.currencies.find((c) => c.code === code && c.issuer);
  if (!cur || !cur.issuer) throw new TomlError(`${toml.homeDomain} does not list ${code} with an issuer in its stellar.toml`);
  const out: { code: string; issuer: string; anchorAsset?: string } = { code: cur.code, issuer: cur.issuer };
  if (cur.anchorAsset) out.anchorAsset = cur.anchorAsset;
  return out;
}
