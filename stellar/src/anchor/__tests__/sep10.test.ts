import { Account, Asset, Keypair, Memo, Networks, Operation, Transaction, TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../config.ts";
import { authenticate, ChallengeError, decodeJwt, isExpired, MAX_CHALLENGE_WINDOW_SECONDS, validateChallenge } from "../sep10.ts";
import { EnvSigner } from "../testing.ts";
import type { Signer } from "../types.ts";
import { CLIENT, fakeFetch, fakeJwt, HOME, jsonResponse, makeChallenge, makeCtx, SERVER, TOML } from "./helpers.ts";

const validate = (challengeXdr: string, extra: Partial<Parameters<typeof validateChallenge>[0]> = {}) =>
  validateChallenge({
    challengeXdr,
    toml: TOML,
    networkPassphrase: TESTNET_PASSPHRASE,
    clientAccount: CLIENT.publicKey(),
    ...extra,
  });

describe("SEP-10 challenge validation", () => {
  it("accepts a genuine challenge", () => {
    const r = validate(makeChallenge());
    expect(r.clientAccount).toBe(CLIENT.publicKey());
    expect(r.webAuthDomain).toBe(HOME);
  });

  it("rejects a challenge signed by someone other than the anchor's SIGNING_KEY", () => {
    expect(() => validate(makeChallenge({ server: Keypair.random() }))).toThrow(ChallengeError);
  });

  it("rejects a challenge for a different home domain", () => {
    expect(() => validate(makeChallenge({ homeDomain: "evil.example" }))).toThrow(/rejected/);
  });

  it("rejects a challenge with a different web_auth_domain", () => {
    expect(() => validate(makeChallenge({ webAuthDomain: "evil.example" }))).toThrow(ChallengeError);
  });

  it("rejects a challenge issued for another account", () => {
    expect(() => validate(makeChallenge({ client: Keypair.random().publicKey() }))).toThrow(/not for our account/);
  });

  it("rejects a challenge for another network", () => {
    expect(() => validate(makeChallenge({ passphrase: Networks.PUBLIC }))).toThrow(ChallengeError);
    expect(() => validate(makeChallenge(), { reportedPassphrase: Networks.PUBLIC })).toThrow(/network/);
  });

  it("rejects a TAMPERED challenge (bytes changed after the anchor signed it)", () => {
    const good = makeChallenge();
    const tx = TransactionBuilder.fromXDR(good, TESTNET_PASSPHRASE) as Transaction;
    // Rebuild the same body plus one extra payment, then copy the anchor's ORIGINAL signature onto it.
    const evil = TransactionBuilder.cloneFrom(tx, { fee: "100", networkPassphrase: TESTNET_PASSPHRASE })
      .addOperation(Operation.payment({ destination: SERVER.publicKey(), asset: Asset.native(), amount: "1000" }))
      .build();
    for (const sig of tx.signatures) evil.signatures.push(sig);
    expect(() => validate(evil.toXDR())).toThrow(ChallengeError);
  });

  it("rejects garbage and truncated XDR", () => {
    expect(() => validate("not-xdr")).toThrow(ChallengeError);
    expect(() => validate(makeChallenge().slice(0, -12))).toThrow(ChallengeError);
  });

  it("rejects a challenge with a non-zero sequence number (a real, submittable transaction)", () => {
    const account = new Account(SERVER.publicKey(), "41"); // builder increments -> sequence 42
    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: TESTNET_PASSPHRASE, timebounds: { minTime: now - 10, maxTime: now + 300 } })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48, 1).toString("base64"), source: CLIENT.publicKey() }))
      .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: SERVER.publicKey() }))
      .build();
    tx.sign(SERVER);
    expect(() => validate(tx.toXDR())).toThrow(/sequence/i);
  });

  it("rejects a challenge that lacks the web_auth_domain operation", () => {
    const account = new Account(SERVER.publicKey(), "-1"); // -> sequence 0
    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: TESTNET_PASSPHRASE, timebounds: { minTime: now - 10, maxTime: now + 300 } })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48, 1).toString("base64"), source: CLIENT.publicKey() }))
      .build();
    tx.sign(SERVER);
    expect(() => validate(tx.toXDR())).toThrow(/web_auth_domain/);
  });

  it("rejects a challenge carrying a memo we never asked for", () => {
    const account = new Account(SERVER.publicKey(), "-1");
    const now = Math.floor(Date.now() / 1000);
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: TESTNET_PASSPHRASE, timebounds: { minTime: now - 10, maxTime: now + 300 } })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48, 1).toString("base64"), source: CLIENT.publicKey() }))
      .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: SERVER.publicKey() }))
      .addMemo(Memo.id("7"))
      .build();
    tx.sign(SERVER);
    expect(() => validate(tx.toXDR())).toThrow(/memo/);
  });

  it("checks expiry and the validity window against the injected clock", () => {
    const challenge = makeChallenge(); // 300 s window from "now"
    const now = new Date();
    expect(() => validate(challenge, { now })).not.toThrow();
    expect(() => validate(challenge, { now: new Date(now.getTime() + 600_000) })).toThrow(/expired/);
    expect(() => validate(challenge, { now: new Date(now.getTime() - 120_000) })).toThrow(/not valid yet/);

    const account = new Account(SERVER.publicKey(), "-1");
    const nowSec = Math.floor(now.getTime() / 1000);
    const long = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
      timebounds: { minTime: nowSec - 10, maxTime: nowSec + MAX_CHALLENGE_WINDOW_SECONDS + 600 },
    })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48, 1).toString("base64"), source: CLIENT.publicKey() }))
      .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: SERVER.publicKey() }))
      .build();
    long.sign(SERVER);
    expect(() => validate(long.toXDR(), { now })).toThrow(/unreasonably long/);
  });

  // Regression for the live failure: both anchors issue `minTime = now + 1` with a
  // 900 s `maxTime`, so the old `maxTime - now` check saw 901 s and tripped an exact
  // 900 s bound. The declared window (`maxTime - minTime`) is what must be bounded.
  function challengeWithBounds(minTime: number, maxTime: number): string {
    const account = new Account(SERVER.publicKey(), "-1"); // -> sequence 0
    const tx = new TransactionBuilder(account, { fee: "100", networkPassphrase: TESTNET_PASSPHRASE, timebounds: { minTime, maxTime } })
      .addOperation(Operation.manageData({ name: `${HOME} auth`, value: Buffer.alloc(48, 1).toString("base64"), source: CLIENT.publicKey() }))
      .addOperation(Operation.manageData({ name: "web_auth_domain", value: HOME, source: SERVER.publicKey() }))
      .build();
    tx.sign(SERVER);
    return tx.toXDR();
  }

  it("accepts the real anchor shape: minTime = now + 1, 900 s maxTime", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(() => validate(challengeWithBounds(nowSec + 1, nowSec + 901), { now })).not.toThrow();
  });

  it("accepts an unset minTime when the remaining window is short", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(() => validate(challengeWithBounds(0, nowSec + 300), { now })).not.toThrow();
  });

  it("refuses an unbounded maxTime = 0 (infinite validity)", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    expect(() => validate(challengeWithBounds(nowSec - 10, 0), { now })).toThrow(ChallengeError);
  });

  it("refuses a declared window one second over the maximum", () => {
    const now = new Date();
    const nowSec = Math.floor(now.getTime() / 1000);
    const over = challengeWithBounds(nowSec, nowSec + MAX_CHALLENGE_WINDOW_SECONDS + 1);
    expect(() => validate(over, { now })).toThrow(/unreasonably long/);
  });
});

describe("SEP-10 authenticate()", () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = fakeJwt({ iss: `https://${HOME}/auth`, sub: CLIENT.publicKey(), iat: 1, exp });
  const signer = new EnvSigner(CLIENT.secret());

  function routes(challenge: string, token: string = jwt) {
    const posted: string[] = [];
    const f = fakeFetch({
      [`GET ${HOME}/auth`]: () => ({ transaction: challenge, network_passphrase: TESTNET_PASSPHRASE }),
      [`POST ${HOME}/auth`]: (_u: URL, init: RequestInit) => {
        posted.push(String(init.body));
        return { token };
      },
    });
    return { ...f, posted };
  }

  it("runs challenge -> validate -> sign -> JWT and explains each step", async () => {
    const { fetch, calls, posted } = routes(makeChallenge());
    const ctx = makeCtx(fetch);
    const token = await authenticate(ctx, TOML, signer);
    expect(token.jwt).toBe(jwt);
    expect(token.account).toBe(CLIENT.publicKey());
    expect(token.expiresAt?.getTime()).toBe(exp * 1000);
    // GET carried account + home_domain
    const get = new URL(calls[0]!.url);
    expect(get.searchParams.get("account")).toBe(CLIENT.publicKey());
    expect(get.searchParams.get("home_domain")).toBe(HOME);
    // The POSTed envelope carries the client's signature in addition to the server's.
    const body = JSON.parse(posted[0]!) as { transaction: string };
    const signed = TransactionBuilder.fromXDR(body.transaction, TESTNET_PASSPHRASE);
    expect(signed.signatures.length).toBe(2);
    expect(WebAuth.verifyChallengeTxSigners(body.transaction, SERVER.publicKey(), TESTNET_PASSPHRASE, [CLIENT.publicKey()], HOME, HOME)).toEqual([CLIENT.publicKey()]);
    const steps = ctx.explain.all().map((r) => r.step);
    expect(steps).toEqual(["sep10.challenge", "sep10.verify", "sep10.sign", "sep10.token"]);
    const sign = ctx.explain.all().find((r) => r.step === "sep10.sign")!;
    expect(sign.what).toMatch(/proved we own G[A-Z0-9]{3}\.\.\.[A-Z0-9]{4} by signing the challenge — no password/);
  });

  it("never asks the signer to sign a tampered challenge", async () => {
    let signed = 0;
    const spy: Signer = {
      publicKey: () => signer.publicKey(),
      signTransaction: (x, o) => {
        signed++;
        return signer.signTransaction(x, o);
      },
    };
    const { fetch } = routes(makeChallenge({ server: Keypair.random() }));
    await expect(authenticate(makeCtx(fetch), TOML, spy)).rejects.toThrow(ChallengeError);
    expect(signed).toBe(0);
  });

  it("rejects a signer that returns a different transaction than the challenge", async () => {
    const other = makeChallenge({ homeDomain: HOME }); // a second, distinct challenge (random nonce)
    const swap: Signer = {
      publicKey: () => signer.publicKey(),
      signTransaction: (_x, o) => signer.signTransaction(other, o),
    };
    const { fetch } = routes(makeChallenge());
    await expect(authenticate(makeCtx(fetch), TOML, swap)).rejects.toThrow(/different transaction/);
  });

  it("rejects a token issued for a different account", async () => {
    const bad = fakeJwt({ sub: Keypair.random().publicKey(), exp });
    const { fetch } = routes(makeChallenge(), bad);
    await expect(authenticate(makeCtx(fetch), TOML, signer)).rejects.toThrow(/not for us/);
  });

  it("rejects a token whose subject merely STARTS WITH our account (memo smuggling)", async () => {
    const bad = fakeJwt({ sub: `${CLIENT.publicKey()}0`, exp });
    const { fetch } = routes(makeChallenge(), bad);
    await expect(authenticate(makeCtx(fetch), TOML, signer)).rejects.toThrow(/not for us/);
  });

  it("surfaces an anchor-side auth failure", async () => {
    const f = fakeFetch({
      [`GET ${HOME}/auth`]: () => ({ transaction: makeChallenge() }),
      [`POST ${HOME}/auth`]: () => jsonResponse({ error: "bad signature" }, 400),
    });
    await expect(authenticate(makeCtx(f.fetch), TOML, signer)).rejects.toThrow(/400/);
  });

  it("decodes JWT expiry and reports staleness", () => {
    expect(decodeJwt(jwt).exp).toBe(exp);
    expect(() => decodeJwt("garbage")).toThrow(ChallengeError);
    const now = new Date();
    expect(isExpired(undefined, now)).toBe(true);
    expect(isExpired({ jwt, account: "G", expiresAt: new Date(now.getTime() + 3_600_000) }, now)).toBe(false);
    expect(isExpired({ jwt, account: "G", expiresAt: new Date(now.getTime() + 10_000) }, now)).toBe(true); // inside skew
  });
});
