import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../config.ts";
import {
  approvedAnchorCandidates,
  NO_ANCHOR_MESSAGE,
  NoHealthyAnchorError,
  preflightAnchor,
  selectAnchor,
  type AnchorHealth,
} from "../selection.ts";
import { SDF_TEST_ANCHOR_HOME_DOMAIN, TR_MOCK_HOME_DOMAIN } from "../scenarios.ts";
import type { FetchLike } from "../types.ts";

const SRT_ISSUER = "GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function tomlFor(host: string, code: string, issuer: string): string {
  return [
    `NETWORK_PASSPHRASE="${TESTNET_PASSPHRASE}"`,
    `SIGNING_KEY="${issuer}"`,
    `WEB_AUTH_ENDPOINT="https://${host}/auth"`,
    `TRANSFER_SERVER="https://${host}/sep6"`,
    `ANCHOR_QUOTE_SERVER="https://${host}/sep38"`,
    "[[CURRENCIES]]",
    `code="${code}"`,
    `issuer="${issuer}"`,
  ].join("\n");
}

function infoFor(...codes: string[]): unknown {
  const map: Record<string, { enabled: boolean }> = {};
  for (const code of codes) map[code] = { enabled: true };
  return { deposit: { ...map }, withdraw: { ...map } };
}

/** A fake fetch serving a stellar.toml and a SEP-6 /info per host. */
function router(hosts: Record<string, { toml?: string; info?: unknown }>): FetchLike {
  return async (input) => {
    const url = new URL(input);
    const host = hosts[url.hostname];
    if (!host) return new Response("unknown host", { status: 400 });
    if (url.pathname === "/.well-known/stellar.toml") {
      return host.toml
        ? new Response(host.toml, { status: 200 })
        : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/sep6/info") {
      return host.info
        ? new Response(JSON.stringify(host.info), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
}

const HEALTHY_SDF = { toml: tomlFor(SDF_TEST_ANCHOR_HOME_DOMAIN, "SRT", SRT_ISSUER), info: infoFor("SRT") };
const HEALTHY_TR = { toml: tomlFor(TR_MOCK_HOME_DOMAIN, "USDC", USDC_ISSUER), info: infoFor("USDC") };

describe("anchor candidates", () => {
  it("orders the approved scenarios SDF first, then the TR mock", () => {
    expect(approvedAnchorCandidates().map((c) => c.homeDomain)).toEqual([
      SDF_TEST_ANCHOR_HOME_DOMAIN,
      TR_MOCK_HOME_DOMAIN,
    ]);
  });

  it("tries a configured home domain first without mixing scenario defaults", () => {
    expect(approvedAnchorCandidates(TR_MOCK_HOME_DOMAIN).map((c) => c.homeDomain)).toEqual([
      TR_MOCK_HOME_DOMAIN,
      SDF_TEST_ANCHOR_HOME_DOMAIN,
    ]);
    const [sdf, tr] = approvedAnchorCandidates();
    expect(sdf).toMatchObject({ assetCode: "SRT", fiatCode: "USD", scenarioId: "sdf-test" });
    expect(sdf?.sep38DeliveryMethod).toBeUndefined();
    expect(sdf?.customerFields.id_number).toBe("TEST-0000001");
    expect(tr).toMatchObject({ assetCode: "USDC", fiatCode: "TRY", sep38DeliveryMethod: "bank_account" });
    expect(tr?.customerFields).toEqual({});
  });
});

describe("anchor preflight", () => {
  it("passes when the toml lists the asset and SEP-6 enables it", async () => {
    const [sdf] = approvedAnchorCandidates();
    const health = await preflightAnchor(sdf!, { fetch: router({ [SDF_TEST_ANCHOR_HOME_DOMAIN]: HEALTHY_SDF }) });
    expect(health.ok).toBe(true);
    expect(health.toml?.homeDomain).toBe(SDF_TEST_ANCHOR_HOME_DOMAIN);
    expect(health.info?.deposit.SRT?.enabled).toBe(true);
  });

  it("fails when SEP-6 does not enable the scenario's asset", async () => {
    const [sdf] = approvedAnchorCandidates();
    const health = await preflightAnchor(sdf!, {
      fetch: router({ [SDF_TEST_ANCHOR_HOME_DOMAIN]: { toml: HEALTHY_SDF.toml, info: infoFor("USDC") } }),
    });
    expect(health.ok).toBe(false);
    expect(health.reason).toMatch(/does not enable SRT/);
  });

  it("fails when discovery fails", async () => {
    const [sdf] = approvedAnchorCandidates();
    const health = await preflightAnchor(sdf!, { fetch: router({}) });
    expect(health.ok).toBe(false);
    expect(health.reason).toBeTruthy();
  });
});

describe("anchor selection", () => {
  it("picks the first healthy anchor", async () => {
    const fetch = router({ [SDF_TEST_ANCHOR_HOME_DOMAIN]: HEALTHY_SDF, [TR_MOCK_HOME_DOMAIN]: HEALTHY_TR });
    const selection = await selectAnchor(approvedAnchorCandidates(), { fetch });
    expect(selection.chosen.homeDomain).toBe(SDF_TEST_ANCHOR_HOME_DOMAIN);
    expect(selection.chosen.assetCode).toBe("SRT");
    expect(selection.health).toHaveLength(1);
  });

  it("falls back to the second anchor when the first is unhealthy", async () => {
    const fetch = router({ [TR_MOCK_HOME_DOMAIN]: HEALTHY_TR });
    const selection = await selectAnchor(approvedAnchorCandidates(), { fetch });
    expect(selection.chosen.homeDomain).toBe(TR_MOCK_HOME_DOMAIN);
    expect(selection.chosen.assetCode).toBe("USDC");
    expect(selection.health.map((h) => h.ok)).toEqual([false, true]);
    expect(selection.health[0]?.reason).toBeTruthy();
  });

  it("throws one plain error with per-anchor reasons when nothing is healthy", async () => {
    const fetch = router({});
    const error = (await selectAnchor(approvedAnchorCandidates(), { fetch }).catch((e: unknown) => e)) as NoHealthyAnchorError;
    expect(error).toBeInstanceOf(NoHealthyAnchorError);
    expect(error.message).toBe(NO_ANCHOR_MESSAGE);
    expect(error.health).toHaveLength(2);
    const reasons = error.health.map((h: AnchorHealth) => h.reason);
    expect(reasons.every((r) => typeof r === "string" && r.length > 0)).toBe(true);
  });
});
