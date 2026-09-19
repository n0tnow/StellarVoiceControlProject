import { describe, expect, it } from "vitest";
import { ExplainLog, narrate, shortKey } from "../explain.ts";
import { parseHomeDomain } from "../net.ts";
import { discoverAnchor, findAsset, parseStellarToml, TomlError } from "../sep1.ts";
import { fakeFetch, HOME, makeCtx, SERVER, TOML_TEXT, USDC_ISSUER } from "./helpers.ts";

describe("SEP-1 stellar.toml", () => {
  it("parses the SEP endpoints, signing key and currencies", () => {
    const t = parseStellarToml(HOME, TOML_TEXT);
    expect(t.homeDomain).toBe(HOME);
    expect(t.signingKey).toBe(SERVER.publicKey());
    expect(t.webAuthEndpoint).toBe(`https://${HOME}/auth`);
    expect(t.transferServer).toBe(`https://${HOME}/sep6`); // trailing slash trimmed
    expect(t.kycServer).toBe(`https://${HOME}/sep12`);
    expect(t.quoteServer).toBe(`https://${HOME}/sep38`);
    expect(t.currencies).toEqual([{ code: "USDC", issuer: USDC_ISSUER, status: "test", anchorAsset: "TRY", anchorAssetType: "fiat" }]);
    expect(findAsset(t, "USDC")).toEqual({ code: "USDC", issuer: USDC_ISSUER, anchorAsset: "TRY" });
  });

  it("rejects a toml without SEP-10 / SEP-6 / a valid signing key", () => {
    expect(() =>
      parseStellarToml(HOME, `NETWORK_PASSPHRASE="x"\nTRANSFER_SERVER="https://${HOME}/s"\nSIGNING_KEY="${SERVER.publicKey()}"`),
    ).toThrow(/WEB_AUTH_ENDPOINT/);
    expect(() =>
      parseStellarToml(HOME, `NETWORK_PASSPHRASE="x"\nWEB_AUTH_ENDPOINT="https://${HOME}/auth"\nSIGNING_KEY="${SERVER.publicKey()}"`),
    ).toThrow(/TRANSFER_SERVER/);
    expect(() =>
      parseStellarToml(HOME, `NETWORK_PASSPHRASE="x"\nWEB_AUTH_ENDPOINT="https://${HOME}/auth"\nTRANSFER_SERVER="https://${HOME}/s"\nSIGNING_KEY="nope"`),
    ).toThrow(/SIGNING_KEY/);
    expect(() => parseStellarToml(HOME, "this is = = not toml")).toThrow(TomlError);
  });

  it("normalises home domains", () => {
    expect(parseHomeDomain("https://tr-mock-anchor.fly.dev/")).toBe("tr-mock-anchor.fly.dev");
    expect(parseHomeDomain(" tr-mock-anchor.fly.dev ")).toBe("tr-mock-anchor.fly.dev");
    expect(parseHomeDomain("TR-MOCK-ANCHOR.FLY.DEV")).toBe("tr-mock-anchor.fly.dev");
  });

  it("discovers over HTTPS from /.well-known and explains it", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${HOME}/.well-known/stellar.toml`]: TOML_TEXT });
    const ctx = makeCtx(fetch);
    const toml = await discoverAnchor(ctx, `https://${HOME}`);
    expect(calls[0]?.url).toBe(`https://${HOME}/.well-known/stellar.toml`);
    expect(toml.signingKey).toBe(SERVER.publicKey());
    const rec = ctx.explain.all()[0];
    expect(rec?.step).toBe("sep1.discover");
    expect(rec?.what).toContain("SEP-1");
    expect(rec?.what).toContain(HOME);
  });

  it("refuses an anchor on another network", async () => {
    const other = TOML_TEXT.replace("Test SDF Network ; September 2015", "Public Global Stellar Network ; September 2015");
    const { fetch } = fakeFetch({ [`GET ${HOME}/.well-known/stellar.toml`]: other });
    await expect(discoverAnchor(makeCtx(fetch), HOME)).rejects.toThrow(/refusing to talk/);
  });

  it("fails clearly when the asset is not listed", () => {
    expect(() => findAsset(parseStellarToml(HOME, TOML_TEXT), "EURC")).toThrow(/does not list EURC/);
  });
});

describe("explain-log", () => {
  it("records { step, what, why } with a timestamp and lets the agent slice per step", () => {
    const log = new ExplainLog(() => new Date("2026-09-19T12:00:00Z"));
    const m = log.mark();
    log.record("a", "did A.", "because A.");
    const m2 = log.mark();
    log.record("b", "did B.", "because B.");
    expect(log.since(m).map((r) => r.step)).toEqual(["a", "b"]);
    expect(log.since(m2).map((r) => r.step)).toEqual(["b"]);
    expect(log.all()[0]).toEqual({ step: "a", what: "did A.", why: "because A.", at: "2026-09-19T12:00:00.000Z" });
    expect(narrate({ what: "did A.", why: "because A." })).toBe("did A. because A.");
  });

  it("notifies subscribers, supports unsubscribe, and survives a throwing narrator", () => {
    const log = new ExplainLog();
    const seen: string[] = [];
    const off = log.subscribe((r) => seen.push(r.step));
    log.subscribe(() => {
      throw new Error("narrator crashed");
    });
    log.record("x", "w", "y");
    off();
    log.record("z", "w", "y");
    expect(seen).toEqual(["x"]);
    expect(log.all()).toHaveLength(2);
  });

  it("shortens keys for speech", () => {
    expect(shortKey("GB3EIJMIGWZZ5FTGZJF3Q4VVJXHQKJKKCHEQCHKZDK42YBURIH7BV275")).toBe("GB3E...V275");
    expect(shortKey("short")).toBe("short");
  });
});
