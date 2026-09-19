/**
 * SEP-1: stellar.toml discovery. From ONE input (the anchor home domain) we learn
 * where to authenticate, deposit, do KYC and get quotes — nothing is hard-coded.
 */
import { parse } from "smol-toml";
import { MAX_TOML_BYTES, requestText } from "./http.ts";
import { shortKey } from "./explain.ts";
import { assertSafeEndpoint, parseHomeDomain, type NetPolicy } from "./net.ts";
import { MAX_ANCHOR_TEXT, sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, TomlCurrency } from "./types.ts";

export class TomlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TomlError";
  }
}

const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
const ASSET_CODE = /^[A-Za-z0-9]{1,12}$/;
const FIAT_CODE = /^[A-Z0-9]{2,12}$/;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Pure parser (unit-tested). Only the programmatic SEP endpoints are read. */
export function parseStellarToml(homeDomain: string, text: string, policy: NetPolicy = {}): AnchorToml {
  let doc: Record<string, unknown>;
  try {
    doc = parse(text) as Record<string, unknown>;
  } catch (e) {
    // The parser message quotes the offending line, i.e. anchor-authored bytes:
    // sanitise and cap it before it can reach the model or the voice.
    const detail = sanitizeAnchorText((e as Error).message, MAX_ANCHOR_TEXT);
    throw new TomlError(`${homeDomain} does not publish a valid stellar.toml${detail ? ` (parser said: ${detail})` : ""}`);
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

  // Every endpoint the toml names is untrusted input: https only, on the anchor's own domain.
  const endpoint = (v: string, label: string): string => assertSafeEndpoint(v, label, homeDomain, policy);

  const rawCurrencies = Array.isArray(doc.CURRENCIES) ? doc.CURRENCIES : [];
  const currencies: TomlCurrency[] = [];
  for (const c of rawCurrencies) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const code = str(rec.code);
    if (!code || !ASSET_CODE.test(code)) continue; // codes are echoed in narration: strict charset
    const cur: TomlCurrency = { code };
    const issuer = str(rec.issuer);
    if (issuer && STELLAR_ADDRESS.test(issuer)) cur.issuer = issuer;
    const status = str(rec.status);
    if (status && /^[a-z]{1,16}$/.test(status)) cur.status = status;
    const anchorAsset = str(rec.anchor_asset);
    if (anchorAsset && FIAT_CODE.test(anchorAsset)) cur.anchorAsset = anchorAsset;
    const anchorAssetType = str(rec.anchor_asset_type);
    if (anchorAssetType && /^[a-z_]{1,16}$/.test(anchorAssetType)) cur.anchorAssetType = anchorAssetType;
    currencies.push(cur);
  }

  const out: AnchorToml = {
    homeDomain,
    networkPassphrase: passphrase,
    signingKey,
    webAuthEndpoint: endpoint(webAuth, "WEB_AUTH_ENDPOINT"),
    transferServer: endpoint(transfer, "TRANSFER_SERVER"),
    currencies,
  };
  const kyc = str(doc.KYC_SERVER);
  if (kyc) out.kycServer = endpoint(kyc, "KYC_SERVER");
  const quote = str(doc.ANCHOR_QUOTE_SERVER);
  if (quote) out.quoteServer = endpoint(quote, "ANCHOR_QUOTE_SERVER");
  return out;
}

/**
 * Fetches and parses `https://<homeDomain>/.well-known/stellar.toml`.
 * The domain is validated first (hostname only), the file is capped at 100 KB
 * (SEP-1) and redirects are refused.
 */
export async function discoverAnchor(ctx: AnchorContext, homeDomainInput: string): Promise<AnchorToml> {
  const policy: NetPolicy = { allowInsecure: ctx.allowInsecure, allowedEndpointHosts: ctx.allowedEndpointHosts };
  const homeDomain = parseHomeDomain(homeDomainInput, policy);
  const scheme = ctx.allowInsecure && /^http:\/\//i.test(homeDomainInput.trim()) ? "http" : "https";
  const url = `${scheme}://${homeDomain}/.well-known/stellar.toml`;
  const text = await requestText(ctx, url, MAX_TOML_BYTES);
  const toml = parseStellarToml(homeDomain, text, policy);
  if (toml.networkPassphrase !== ctx.networkPassphrase) {
    throw new TomlError(
      `${homeDomain} runs on a different Stellar network than this wallet (${sanitizeAnchorText(toml.networkPassphrase, 60)}) — refusing to talk to it`,
    );
  }
  // Endpoint paths are anchor-authored too: sanitise (and cap) before narrating them.
  const path = (u: string): string => sanitizeAnchorText(new URL(u).pathname, 120) ?? "/";
  ctx.explain.record(
    "sep1.discover",
    `SEP-1: read ${homeDomain}'s public stellar.toml and learned where to log in (${path(toml.webAuthEndpoint)}), ` +
      `move money (${path(toml.transferServer)}), do KYC and fetch quotes. The anchor's signing key is ${shortKey(toml.signingKey)}. ` +
      `All of its endpoints use https on ${homeDomain}.`,
    "Everything about an anchor is published in one standard file, so all we need from you is the anchor's domain name. We only accept https endpoints on that same domain.",
  );
  return toml;
}

/**
 * Finds the on-chain asset for `code` in the toml. Currencies marked `dead` are
 * skipped. With `expectedIssuer` (pinned) only that issuer is accepted, and a
 * toml that lists a different issuer for the code is refused.
 */
export function findAsset(
  toml: AnchorToml,
  code: string,
  opts: { expectedIssuer?: string | undefined } = {},
): { code: string; issuer: string; anchorAsset?: string } {
  const candidates = toml.currencies.filter((c) => c.code === code && c.issuer && c.status !== "dead");
  if (candidates.length === 0) throw new TomlError(`${toml.homeDomain} does not list ${code} with an issuer in its stellar.toml`);
  let cur = candidates[0] as TomlCurrency;
  if (opts.expectedIssuer) {
    const match = candidates.find((c) => c.issuer === opts.expectedIssuer);
    if (!match) {
      throw new TomlError(
        `${toml.homeDomain} lists ${code} issued by ${candidates.map((c) => shortKey(c.issuer as string)).join(", ")}, ` +
          `but this wallet only accepts ${code} from ${shortKey(opts.expectedIssuer)} — refusing (possible look-alike asset)`,
      );
    }
    cur = match;
  } else if (new Set(candidates.map((c) => c.issuer)).size > 1) {
    throw new TomlError(`${toml.homeDomain} lists several issuers for ${code}; pin the one to trust with expectedIssuer`);
  }
  const out: { code: string; issuer: string; anchorAsset?: string } = { code: cur.code, issuer: cur.issuer as string };
  if (cur.anchorAsset) out.anchorAsset = cur.anchorAsset;
  return out;
}
