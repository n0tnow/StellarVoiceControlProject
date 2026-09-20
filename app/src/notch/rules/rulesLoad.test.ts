import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_LIMITS, ruleFromFields, type SecurityState } from "../../lib/guardState.ts";
import { rulesFormFromState } from "./rulesModel.ts";
import {
  EMPTY_FORM,
  UNSUPPORTED_EXECUTOR,
  editorSnapshotFrom,
  ownerGuardAllows,
  probeExecutor,
} from "./rulesLoad.ts";

/** Public testnet keys (the committed fixtures; never secrets). */
const EXECUTOR = "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5";
const OWNER = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
const SAC = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

function state(overrides: Partial<SecurityState> = {}): SecurityState {
  return {
    owner: OWNER,
    guardContractId: SAC,
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    assetSymbol: "XLM",
    assetContractId: SAC,
    rule: ruleFromFields(DEFAULT_LIMITS, SAC),
    executor: EXECUTOR,
    spentTodayRaw: 3_0000000n,
    allowanceRaw: 140_0000000n,
    aliases: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * ownerGuardAllows — env-only builds stay usable, account switches block
 * ------------------------------------------------------------------ */

test("ownerGuardAllows lets a snapshot through when no live owner is known", () => {
  assert.equal(ownerGuardAllows(null, OWNER), true);
  assert.equal(ownerGuardAllows(null, null), true);
});

test("ownerGuardAllows lets a snapshot through for the same owner, blocks another", () => {
  assert.equal(ownerGuardAllows(OWNER, OWNER), true);
  assert.equal(ownerGuardAllows(OWNER, EXECUTOR), false);
});

/* ------------------------------------------------------------------ *
 * probeExecutor — ONE executor_status call, not two
 * ------------------------------------------------------------------ */

test("probeExecutor reports support and funding from one call", async () => {
  let calls = 0;
  const probe = await probeExecutor({
    async executorStatus() {
      calls += 1;
      return { funded: true };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(probe, { supported: true, funded: true });
});

test("probeExecutor treats a missing command as unsupported, not an error", async () => {
  const probe = await probeExecutor({
    async executorStatus() {
      throw new Error("command executor_status not found");
    },
  });
  assert.deepEqual(probe, UNSUPPORTED_EXECUTOR);
});

test("probeExecutor rethrows a real failure so it is surfaced", async () => {
  await assert.rejects(
    probeExecutor({
      async executorStatus() {
        throw new Error("keychain locked");
      },
    }),
    /keychain locked/,
  );
});

/* ------------------------------------------------------------------ *
 * editorSnapshotFrom — the five states, never a mock for a real owner
 * ------------------------------------------------------------------ */

test("outside Tauri the editor is unconfigured with the preview hint", () => {
  const snap = editorSnapshotFrom({
    offTauri: true,
    ownerAddress: null,
    contacts: [],
    executor: UNSUPPORTED_EXECUTOR,
    load: null,
  });
  assert.equal(snap.state, "unconfigured");
  assert.match(snap.detail, /Open Autonomy/);
  assert.equal(snap.security, null);
  assert.deepEqual(snap.form, EMPTY_FORM);
});

test("a configured app without an owner is unconfigured", () => {
  const snap = editorSnapshotFrom({
    offTauri: false,
    ownerAddress: null,
    contacts: [],
    executor: UNSUPPORTED_EXECUTOR,
    load: null,
  });
  assert.equal(snap.state, "unconfigured");
  assert.match(snap.detail, /POLARIS_OWNER_ADDRESS/);
});

test("an unconfigured guard read keeps the owner in the editor", () => {
  const snap = editorSnapshotFrom({
    offTauri: false,
    ownerAddress: OWNER,
    contacts: [],
    executor: { supported: true, funded: true },
    load: { kind: "unconfigured", detail: "GUARD_CONTRACT_ID is not set" },
  });
  assert.equal(snap.state, "unconfigured");
  assert.match(snap.detail, /GUARD_CONTRACT_ID/);
  assert.equal(snap.security, null);
});

test("a failed read becomes error with the detail, not a mock rule", () => {
  const snap = editorSnapshotFrom({
    offTauri: false,
    ownerAddress: OWNER,
    contacts: [],
    executor: { supported: true, funded: null },
    load: { kind: "unreachable", detail: "rpc down" },
  });
  assert.equal(snap.state, "error");
  assert.equal(snap.detail, "rpc down");
  assert.equal(snap.security, null);
});

test("a configured owner with no rule is not set up, with the live security", () => {
  const security = state({ rule: null, executor: null });
  const snap = editorSnapshotFrom({
    offTauri: false,
    ownerAddress: OWNER,
    contacts: [{ alias: "ada", address: EXECUTOR }],
    executor: { supported: true, funded: false },
    load: { kind: "ok", state: security },
  });
  assert.equal(snap.state, "not_set_up");
  assert.equal(snap.security, security);
  assert.equal(snap.executorFunded, false);
  assert.equal(snap.autoPaySupported, true);
  assert.deepEqual(snap.form, rulesFormFromState(security));
});

test("a published rule becomes ready and seeds the form from chain state", () => {
  const security = state();
  const snap = editorSnapshotFrom({
    offTauri: false,
    ownerAddress: OWNER,
    contacts: [],
    executor: { supported: true, funded: true },
    load: { kind: "ok", state: security },
  });
  assert.equal(snap.state, "ready");
  assert.deepEqual(snap.form, rulesFormFromState(security));
});
