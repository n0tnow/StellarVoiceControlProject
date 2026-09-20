import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalSelftestResult,
  mapHealthToResult,
  summarizeNetwork,
  type NetworkFacts,
} from "./checkHelpers.ts";
import type { DebugFeatureHealth } from "./commands.ts";

/** A valid testnet G-address (the committed `ada` alias; public, never a secret). */
const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";

function facts(overrides: Partial<NetworkFacts> = {}): NetworkFacts {
  return {
    config: {
      network: "testnet",
      horizonUrl: "https://horizon-testnet.stellar.org",
      ownerAddress: OWNER,
    },
    aliasBookResolved: true,
    recipientAlias: "acc2",
    recipientResolved: true,
    horizon: { exists: true, xlmBalance: "1000.0000000" },
    ...overrides,
  };
}

test("network ok: testnet, funded owner and a resolved alias show the balance", () => {
  const result = summarizeNetwork(facts());
  assert.equal(result.status, "ok");
  assert.match(result.detail, /testnet/);
  assert.match(result.detail, /1000\.0000000 XLM/);
  assert.match(result.detail, new RegExp(OWNER));
});

test("network warn: a missing command is not a failure", () => {
  const result = summarizeNetwork(
    facts({
      config: null,
      aliasBookResolved: false,
      recipientResolved: false,
      horizon: null,
    }),
  );
  assert.equal(result.status, "warn");
});

test("network warn: no owner address tells the user what to set", () => {
  const result = summarizeNetwork(
    facts({ config: { network: "testnet", ownerAddress: null }, horizon: null }),
  );
  assert.equal(result.status, "warn");
  assert.match(result.detail, /POLARIS_OWNER_ADDRESS/);
});

test("network fail: a non-testnet network is refused", () => {
  const result = summarizeNetwork(facts({ config: { network: "public", ownerAddress: OWNER } }));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /testnet-only/);
});

test("network fail: a malformed owner address is caught", () => {
  const result = summarizeNetwork(facts({ config: { network: "testnet", ownerAddress: "Gbad" } }));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /valid G/);
});

test("network ok: an empty alias book is not a failure (typed addresses are payable)", () => {
  const result = summarizeNetwork(
    facts({ aliasBookResolved: false, recipientResolved: false }),
  );
  assert.equal(result.status, "ok");
});

test("network fail: Horizon unreachable and account missing are distinct messages", () => {
  const unreachable = summarizeNetwork(facts({ horizon: null }));
  assert.equal(unreachable.status, "fail");
  assert.match(unreachable.detail, /unreachable/);

  const missing = summarizeNetwork(facts({ horizon: { exists: false } }));
  assert.equal(missing.status, "fail");
  assert.match(missing.detail, /not found/);
});

test("network fail: an unfunded account is a fail with the 0 balance", () => {
  const result = summarizeNetwork(facts({ horizon: { exists: true, xlmBalance: "0.0000000" } }));
  assert.equal(result.status, "fail");
  assert.match(result.detail, /0\.0000000 XLM/);
});

function health(status: DebugFeatureHealth["status"], detail = "d"): DebugFeatureHealth {
  return { id: "x", title: "X", milestone: "W3", status, detail, checkedAt: 1 };
}

test("health maps straight through for the non-prompting probe", () => {
  assert.equal(mapHealthToResult(health("ok", "enrolled")).status, "ok");
  assert.equal(mapHealthToResult(health("warn", "password only")).status, "warn");
  assert.equal(mapHealthToResult(health("fail", "unavailable")).status, "fail");
});

test("a cancelled Touch ID self-test is a warn, not a fail", () => {
  assert.equal(approvalSelftestResult(health("warn", "cancelled")).status, "warn");
  assert.equal(approvalSelftestResult(health("ok")).status, "ok");
  assert.equal(approvalSelftestResult(health("fail", "hardware")).status, "fail");
});
