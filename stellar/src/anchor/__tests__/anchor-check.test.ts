import { TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../config.ts";
import { AnchorHttpError } from "../http.ts";
import { SDF_TEST_ANCHOR_HOME_DOMAIN, TR_MOCK_HOME_DOMAIN } from "../scenarios.ts";
import {
  buildScenarioPlan,
  looksLikeAccountMissing,
  parseArgs,
  runAnchorCheck,
  summarizeInfoAssets,
  type StepOutcome,
} from "../check.ts";
import type { FetchLike } from "../types.ts";
import { fakeFetch, fakeJwt, jsonResponse, SERVER, USDC_ISSUER } from "./helpers.ts";

const TR = TR_MOCK_HOME_DOMAIN;
const SDF = SDF_TEST_ANCHOR_HOME_DOMAIN;
const JWT_MARKER = "TOPSECRETJWT";
const JWT_SIGNATURE = "RAWSIGNATURE_SENTINEL";

function tomlFor(host: string): string {
  return `
NETWORK_PASSPHRASE="${TESTNET_PASSPHRASE}"
SIGNING_KEY="${SERVER.publicKey()}"
WEB_AUTH_ENDPOINT="https://${host}/auth"
TRANSFER_SERVER="https://${host}/sep6"
KYC_SERVER="https://${host}/sep12"
ANCHOR_QUOTE_SERVER="https://${host}/sep38"
[[CURRENCIES]]
code="USDC"
issuer="${USDC_ISSUER}"
status="test"
anchor_asset="TRY"
anchor_asset_type="fiat"
`;
}

const INFO = {
  authentication_required: true,
  deposit: { USDC: { enabled: true, min_amount: 1, max_amount: 10, fee_percent: 0.5 } },
  withdraw: { USDC: { enabled: true } },
};

function challengeHandler(host: string) {
  return (url: URL): unknown => {
    const account = url.searchParams.get("account") ?? "";
    return { transaction: WebAuth.buildChallengeTx(SERVER, account, host, 300, TESTNET_PASSPHRASE, host) };
  };
}

function tokenHandler(host: string, onIssued?: (jwt: string) => void) {
  return (_url: URL, init: RequestInit): unknown => {
    const body = JSON.parse(String(init.body)) as { transaction: string };
    const account = WebAuth.readChallengeTx(body.transaction, SERVER.publicKey(), TESTNET_PASSPHRASE, host, host).clientAccountID;
    const jwt = fakeJwt({ sub: account, exp: Math.floor(Date.now() / 1000) + 900, marker: JWT_MARKER }, JWT_SIGNATURE);
    onIssued?.(jwt);
    return { token: jwt };
  };
}

function routesFor(host: string): Record<string, unknown> {
  return {
    [`GET ${host}/.well-known/stellar.toml`]: tomlFor(host),
    [`GET ${host}/sep6/info`]: INFO,
    [`GET ${host}/auth`]: challengeHandler(host),
    [`POST ${host}/auth`]: tokenHandler(host),
  };
}

function collect(): { lines: string[]; out: (l: string) => void } {
  const lines: string[] = [];
  return { lines, out: (l) => lines.push(l) };
}

const statusOf = (steps: StepOutcome[], name: string): string | undefined => steps.find((s) => s.name === name)?.status;

describe("anchor:check plan mode", () => {
  it("prints the plan for both scenarios with ZERO network calls", async () => {
    const calls: string[] = [];
    const spy: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error("network must not be used in plan mode");
    };
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR, SDF], out, fetch: spy });
    expect(calls).toHaveLength(0);
    expect(report.live).toBe(false);
    expect(report.results).toEqual([]);
    expect(report.plans).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("PLAN ONLY");
    expect(text).toContain("TR path — SEP-6 only (SEP-24 prohibited in Turkey)");
    expect(text).toContain("NON-TR test scenario");
  });

  it("still makes no network calls when --payout-check is planned", async () => {
    const calls: string[] = [];
    const spy: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error("network must not be used in plan mode");
    };
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], payoutCheck: true, out, fetch: spy });
    expect(calls).toHaveLength(0);
    expect(report.payout).toBeUndefined();
    expect(lines.join("\n")).toContain("TR payout-health (planned)");
  });

  it("N7: with a non-TR --home-domain, --payout-check says it applies to the TR mock only", async () => {
    const calls: string[] = [];
    const spy: FetchLike = async (input) => {
      calls.push(String(input));
      throw new Error("network must not be used in plan mode");
    };
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [SDF], payoutCheck: true, out, fetch: spy });
    expect(calls).toHaveLength(0);
    expect(report.payout).toBeUndefined();
    const text = lines.join("\n");
    expect(text).toContain("payout-check applies to the TR mock only");
    expect(text).not.toContain("read https://tr-mock-anchor.fly.dev/health");
  });

  it("builds the three planned steps per scenario", () => {
    const plan = buildScenarioPlan({ id: "tr-mock", label: "x", sepScope: "SEP-6 only", allowed: [], notes: "" }, TR);
    expect(plan.steps.map((s) => s.name)).toEqual(["SEP-1 discovery", "SEP-6 /info", "SEP-10 login"]);
  });
});

describe("anchor:check live mode", () => {
  it("runs SEP-1, SEP-6 info and SEP-10 login for both scenarios and never prints the JWT", async () => {
    const { fetch } = fakeFetch({ ...routesFor(TR), ...routesFor(SDF) });
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR, SDF], live: true, fetch, out });
    expect(report.ok).toBe(true);
    expect(report.results).toHaveLength(2);
    for (const r of report.results) {
      expect(r.steps.map((s) => s.status)).toEqual(["PASS", "PASS", "PASS"]);
    }
    const tr = report.results.find((r) => r.homeDomain === TR)!;
    expect(statusOf(tr.steps, "SEP-1 discovery")).toBe("PASS");
    expect(statusOf(tr.steps, "SEP-10 login")).toBe("PASS");
    const sdf = report.results.find((r) => r.homeDomain === SDF)!;
    expect(sdf.finalLine).toContain("clearly-fake TEST data");
    expect(sdf.finalLine).toContain("first_name, last_name, email_address");
    const text = lines.join("\n");
    expect(text).toContain("Anchor check (LIVE)");
    expect(text).toContain("jwt length=");
    expect(text).toContain("challenge validated before signing");
    expect(text).not.toContain("TOPSECRETJWT");
  });

  it("reports a FAIL row when discovery fails and skips the dependent steps", async () => {
    const { fetch } = fakeFetch({ [`GET ${TR}/.well-known/stellar.toml`]: jsonResponse({ error: "nope" }, 500) });
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], live: true, fetch, out });
    expect(report.ok).toBe(false);
    const tr = report.results[0]!;
    expect(statusOf(tr.steps, "SEP-1 discovery")).toBe("FAIL");
    expect(statusOf(tr.steps, "SEP-6 /info")).toBe("SKIP");
    expect(statusOf(tr.steps, "SEP-10 login")).toBe("SKIP");
    expect(lines.join("\n")).toContain("FAIL");
  });

  it("B1: always prints the SDF KYC final line, even when discovery fails", async () => {
    const { fetch } = fakeFetch({ [`GET ${SDF}/.well-known/stellar.toml`]: jsonResponse({ error: "nope" }, 500) });
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [SDF], live: true, fetch, out });
    expect(report.ok).toBe(false);
    const sdf = report.results[0]!;
    expect(statusOf(sdf.steps, "SEP-1 discovery")).toBe("FAIL");
    expect(sdf.finalLine).toContain("per-transaction identity fields");
    expect(sdf.finalLine).toContain("first_name, last_name, email_address");
    expect(lines.join("\n")).toContain("per-transaction identity fields");
  });

  it("N1: never leaks the JWT — raw signature sentinel and decoded payload marker absent from stdout, errors and JSON", async () => {
    let issued = "";
    const routes: Record<string, unknown> = { ...routesFor(TR) };
    routes[`POST ${TR}/auth`] = tokenHandler(TR, (jwt) => {
      issued = jwt;
    });
    const { fetch } = fakeFetch(routes);
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], live: true, fetch, out });
    expect(report.ok).toBe(true);
    expect(issued).toContain(JWT_SIGNATURE);
    const decodedPayload = JSON.parse(Buffer.from(issued.split(".")[1] as string, "base64url").toString()) as { marker?: string };
    expect(decodedPayload.marker).toBe(JWT_MARKER);
    const rendered = [
      ...lines,
      JSON.stringify(report),
      JSON.stringify(report.results),
      ...report.results.flatMap((r) => r.steps.map((s) => s.detail)),
    ].join("\n");
    expect(rendered).not.toContain(issued);
    expect(rendered).not.toContain(JWT_SIGNATURE);
    expect(rendered).not.toContain(JWT_MARKER);
  });

  it("funds the SDF throwaway account via Friendbot when the anchor needs an existing account", async () => {
    let authCalls = 0;
    const routes: Record<string, unknown> = {
      ...routesFor(SDF),
      [`GET ${SDF}/auth`]: (url: URL) => {
        authCalls++;
        if (authCalls === 1) return jsonResponse({ error: "account not found" }, 404);
        return challengeHandler(SDF)(url);
      },
      "GET friendbot.stellar.org/": { successful: true },
    };
    const { fetch } = fakeFetch(routes);
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [SDF], live: true, fetch, out });
    expect(report.ok).toBe(true);
    expect(authCalls).toBe(2);
    expect(lines.join("\n")).toContain("Friendbot");
  });

  it("N2: reports the per-asset authentication_required flag from SEP-6 /info (real TR shape)", async () => {
    const { fetch } = fakeFetch({
      ...routesFor(TR),
      [`GET ${TR}/sep6/info`]: {
        deposit: { USDC: { enabled: true, authentication_required: true, min_amount: 1, max_amount: 10 } },
        withdraw: { USDC: { enabled: true } },
      },
    });
    const { out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], live: true, fetch, out });
    const info = report.results[0]!.steps.find((s) => s.name === "SEP-6 /info")!;
    expect(info.detail).toContain("authentication_required(top)=absent");
    expect(info.detail).toContain("deposit: USDC(enabled=true, auth=true, min=1, max=10, fee_percent=absent)");
    expect(info.detail).toContain("withdraw: USDC(enabled=true, auth=absent, min=absent, max=absent, fee_percent=absent)");
  });

  it("classifies TR payout-health when --payout-check is set", async () => {
    const { fetch } = fakeFetch({
      ...routesFor(TR),
      [`GET ${TR}/health`]: { ok: true, treasury: { usdc_balance: "1" } },
      [`GET horizon-testnet.stellar.org/accounts/GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6/payments`]: {
        _embedded: { records: [{ type: "payment", from: "GX", to: "GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6", created_at: new Date().toISOString() }] },
      },
    });
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], live: true, payoutCheck: true, fetch, out });
    expect(report.payout?.verdict).toBe("payouts-stalled");
    expect(lines.join("\n")).toContain("TR payout-health (read-only)");
    expect(lines.join("\n")).toContain("verdict        : payouts-stalled");
  });

  it("reports ok=false when the payout check itself fails", async () => {
    const { fetch } = fakeFetch({
      ...routesFor(TR),
      [`GET ${TR}/health`]: jsonResponse({ error: "down" }, 503),
      "GET horizon-testnet.stellar.org/accounts/GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6/payments": () =>
        jsonResponse({ error: "horizon down" }, 503),
    });
    const { lines, out } = collect();
    const report = await runAnchorCheck({ homeDomains: [TR], live: true, payoutCheck: true, fetch, out });
    expect(report.payout).toBeUndefined();
    expect(report.payoutError).toBeTruthy();
    expect(report.ok).toBe(false);
    expect(lines.join("\n")).toContain("FAILED:");
  });
});

describe("anchor:check helpers", () => {
  it("parses repeated --home-domain, --live and --payout-check", () => {
    expect(parseArgs(["--live", "--home-domain", TR, "--payout-check", "--home-domain", SDF])).toEqual({
      homeDomains: [TR, SDF],
      live: true,
      payoutCheck: true,
    });
    expect(parseArgs([])).toEqual({ homeDomains: [], live: false, payoutCheck: false });
  });

  it("summarises which SEP-6 /info fields are present, including per-asset auth", () => {
    expect(summarizeInfoAssets({ USDC: { enabled: true, min_amount: 1, fee_percent: 0.5 } })).toBe(
      "USDC(enabled=true, auth=absent, min=1, max=absent, fee_percent=0.5)",
    );
    expect(summarizeInfoAssets({ USDC: { enabled: true, authentication_required: true } })).toBe(
      "USDC(enabled=true, auth=true, min=absent, max=absent, fee_percent=absent)",
    );
    expect(summarizeInfoAssets({ USDC: { enabled: true, authentication_required: false } })).toBe(
      "USDC(enabled=true, auth=false, min=absent, max=absent, fee_percent=absent)",
    );
    expect(summarizeInfoAssets(undefined)).toBe("none");
    expect(summarizeInfoAssets({ "bad code!": { enabled: true } })).toBe("none");
  });

  it("recognises an account-missing failure", () => {
    expect(looksLikeAccountMissing(new AnchorHttpError("GET /auth failed (404): not found", 404, "u", ""))).toBe(true);
    expect(looksLikeAccountMissing(new AnchorHttpError("GET /auth failed (400): account not funded", 400, "u", ""))).toBe(true);
    expect(looksLikeAccountMissing(new AnchorHttpError("GET /info failed (500): boom", 500, "u", ""))).toBe(false);
    expect(looksLikeAccountMissing(new Error("network down"))).toBe(false);
  });

  it("refuses to run an unapproved domain (no custom escape hatch in the CLI path)", async () => {
    await expect(runAnchorCheck({ homeDomains: ["evil.example.com"], live: true })).rejects.toThrow(/not an approved anchor scenario/);
  });
});

describe("TransactionBuilder sanity (test fixtures)", () => {
  it("decodes the fake challenge it built", () => {
    const account = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    const xdr = WebAuth.buildChallengeTx(SERVER, account, TR, 300, TESTNET_PASSPHRASE, TR);
    const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE);
    expect(tx.operations.length).toBeGreaterThan(0);
  });
});
