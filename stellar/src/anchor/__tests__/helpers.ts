/** Test kit: fake fetch router, deterministic clock, fixtures. No network access. */
import { Keypair, WebAuth } from "@stellar/stellar-sdk";
import { ExplainLog } from "../explain.ts";
import type { AnchorContext, AnchorToml, AuthToken, FetchLike } from "../types.ts";
import { TESTNET_PASSPHRASE } from "../config.ts";

export const HOME = "anchor.example.test";
export const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const SERVER = Keypair.random();
export const CLIENT = Keypair.random();

export const TOML_TEXT = `
VERSION="2.7.0"
NETWORK_PASSPHRASE="${TESTNET_PASSPHRASE}"
SIGNING_KEY="${SERVER.publicKey()}"
WEB_AUTH_ENDPOINT="https://${HOME}/auth"
TRANSFER_SERVER="https://${HOME}/sep6/"
KYC_SERVER="https://${HOME}/sep12"
ANCHOR_QUOTE_SERVER="https://${HOME}/sep38"
ACCOUNTS=["${SERVER.publicKey()}"]

[DOCUMENTATION]
ORG_NAME="Example Anchor"

[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
status="test"
anchor_asset="TRY"
anchor_asset_type="fiat"
`;

export const TOML: AnchorToml = {
  homeDomain: HOME,
  networkPassphrase: TESTNET_PASSPHRASE,
  signingKey: SERVER.publicKey(),
  webAuthEndpoint: `https://${HOME}/auth`,
  transferServer: `https://${HOME}/sep6`,
  kycServer: `https://${HOME}/sep12`,
  quoteServer: `https://${HOME}/sep38`,
  currencies: [{ code: "USDC", issuer: USDC_ISSUER, anchorAsset: "TRY" }],
};

export const TOKEN: AuthToken = { jwt: "header.payload.sig", account: CLIENT.publicKey() };

export type Handler = (url: URL, init: RequestInit) => unknown;
export interface Call {
  method: string;
  url: string;
  body?: string;
}

/** Router keyed by "METHOD pathname". A handler returns JSON, a Response, or throws. */
export function fakeFetch(routes: Record<string, Handler | unknown>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const call: Call = { method, url: url.toString() };
    if (typeof init.body === "string") call.body = init.body;
    calls.push(call);
    const key = `${method} ${url.host}${url.pathname}`;
    let route = routes[key];
    if (route === undefined) route = routes[`${method} ${url.pathname}`];
    if (route === undefined) return new Response(JSON.stringify({ error: `no route ${key}` }), { status: 599 });
    const out = typeof route === "function" ? (route as Handler)(url, init) : route;
    if (out instanceof Response) return out;
    return new Response(typeof out === "string" ? out : JSON.stringify(out), {
      status: 200,
      headers: { "content-type": typeof out === "string" ? "text/plain" : "application/json" },
    });
  };
  return { fetch, calls };
}

export function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fake clock whose `sleep` advances time, so polling tests run instantly.
 * Starts at the real clock so SEP-10 challenges (built with real time bounds)
 * validate; tests that need another "now" pass one explicitly.
 */
export function fakeClock(startMs = Date.now()): { now: () => Date; sleep: (ms: number) => Promise<void>; t: () => number } {
  let t = startMs;
  return {
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    t: () => t,
  };
}

export function makeCtx(fetchFn: FetchLike, extra: Partial<AnchorContext> = {}): AnchorContext {
  const clock = fakeClock();
  return {
    fetch: fetchFn,
    explain: new ExplainLog(clock.now),
    horizonUrl: "https://horizon.example.test",
    friendbotUrl: "https://friendbot.example.test",
    networkPassphrase: TESTNET_PASSPHRASE,
    sleep: clock.sleep,
    now: clock.now,
    requestTimeoutMs: 5000,
    ...extra,
  };
}

/** A genuine SEP-10 challenge signed by `SERVER` for `CLIENT`. */
export function makeChallenge(opts: { client?: string; homeDomain?: string; webAuthDomain?: string; server?: Keypair; passphrase?: string } = {}): string {
  return WebAuth.buildChallengeTx(
    opts.server ?? SERVER,
    opts.client ?? CLIENT.publicKey(),
    opts.homeDomain ?? HOME,
    300,
    opts.passphrase ?? TESTNET_PASSPHRASE,
    opts.webAuthDomain ?? HOME,
  );
}

/** Builds a JWT-shaped string with the given claims (unsigned; the client never verifies it). */
export function fakeJwt(claims: Record<string, unknown>): string {
  const b = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "HS256" })}.${b(claims)}.sig`;
}

/** Stateful fake Horizon + Friendbot for the preflight/session tests. */
export function fakeChain(opts: { account: string; exists?: boolean; trustline?: boolean; usdc?: string }) {
  const state = { exists: opts.exists ?? false, trustline: opts.trustline ?? false, usdc: opts.usdc ?? "0", submitted: [] as string[], friendbotCalls: 0 };
  const account = () => ({
    id: opts.account,
    sequence: "1000",
    balances: [
      ...(state.trustline ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER, balance: state.usdc }] : []),
      { asset_type: "native", balance: "10000.0000000" },
    ],
  });
  const handle = (input: string, init: RequestInit = {}): Response | undefined => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    if (url.host === "friendbot.example.test") {
      state.friendbotCalls++;
      state.exists = true;
      return jsonResponse({ successful: true }, 200);
    }
    if (url.host === "horizon.example.test") {
      if (method === "GET" && url.pathname === `/accounts/${opts.account}`) {
        return state.exists ? jsonResponse(account(), 200) : jsonResponse({ status: 404 }, 404);
      }
      if (method === "POST" && url.pathname === "/transactions") {
        const tx = new URLSearchParams(String(init.body)).get("tx")!;
        state.submitted.push(tx);
        state.trustline = true; // the only tx the preflight tests submit is changeTrust
        return jsonResponse({ hash: "ab".repeat(32), ledger: 123 }, 200);
      }
    }
    return undefined;
  };
  return { state, handle };
}

/** Chains a stateful chain fake with a route table; the chain wins for its hosts. */
export function combine(chain: ReturnType<typeof fakeChain>, routes: Record<string, Handler | unknown>): { fetch: FetchLike; calls: Call[] } {
  const inner = fakeFetch(routes);
  const fetch: FetchLike = async (input, init) => {
    const r = chain.handle(input, init);
    if (r) {
      inner.calls.push({ method: (init?.method ?? "GET").toUpperCase(), url: input, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
      return r;
    }
    return inner.fetch(input, init);
  };
  return { fetch, calls: inner.calls };
}
