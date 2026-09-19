import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { ConfigError, DEFAULT_NETWORK_PASSPHRASE, DEFAULT_RPC_URL, loadConfig, redactedConfig } from "./config.ts";

const kp = Keypair.random();
const base = { KEEPER_SECRET: kp.secret(), GUARD_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32, 1)) };

test("defaults", () => {
  const c = loadConfig(base);
  assert.equal(c.rpcUrl, DEFAULT_RPC_URL);
  assert.equal(c.networkPassphrase, DEFAULT_NETWORK_PASSPHRASE);
  assert.equal(c.pollSeconds, 15);
  assert.equal(c.dryRun, false);
  assert.equal(c.keypair.publicKey(), kp.publicKey());
});

test("env overrides and STELLAR_* fallbacks", () => {
  const c = loadConfig({
    ...base,
    STELLAR_RPC_URL: "https://rpc.example",
    KEEPER_POLL_SECONDS: "3",
    KEEPER_MAX_PER_TICK: "2",
    KEEPER_DRY_RUN: "true",
  });
  assert.equal(c.rpcUrl, "https://rpc.example");
  assert.equal(c.pollSeconds, 3);
  assert.equal(c.maxPerTick, 2);
  assert.equal(c.dryRun, true);
  assert.equal(loadConfig({ ...base, SOROBAN_RPC_URL: "https://a", STELLAR_RPC_URL: "https://b" }).rpcUrl, "https://a");
});

test("the --dry-run flag override wins over the environment", () => {
  assert.equal(loadConfig({ ...base, KEEPER_DRY_RUN: "false" }, { dryRun: true }).dryRun, true);
});

test("rejects missing or malformed values without echoing the secret", () => {
  assert.throws(() => loadConfig({ GUARD_CONTRACT_ID: base.GUARD_CONTRACT_ID }), ConfigError);
  assert.throws(() => loadConfig({ KEEPER_SECRET: base.KEEPER_SECRET }), ConfigError);
  assert.throws(() => loadConfig({ ...base, GUARD_CONTRACT_ID: "GNOTACONTRACT" }), ConfigError);
  assert.throws(() => loadConfig({ ...base, KEEPER_POLL_SECONDS: "0" }), /KEEPER_POLL_SECONDS/);
  assert.throws(() => loadConfig({ ...base, KEEPER_DRY_RUN: "maybe" }), /KEEPER_DRY_RUN/);
  try {
    loadConfig({ ...base, KEEPER_SECRET: "SBADSECRET" });
    assert.fail("should throw");
  } catch (e) {
    assert.ok(e instanceof ConfigError);
    assert.ok(!(e as Error).message.includes("SBADSECRET"));
  }
});

test("redactedConfig never contains the secret", () => {
  const json = JSON.stringify(redactedConfig(loadConfig(base)));
  assert.ok(!json.includes(kp.secret()));
  assert.ok(json.includes(kp.publicKey()));
});
