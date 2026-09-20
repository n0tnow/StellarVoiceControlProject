import assert from "node:assert/strict";
import { test } from "node:test";

import type { VoiceHealth } from "@/debug/commands";

import {
  buildStatusRows,
  horizonHost,
  shortId,
  type ChainFacts,
  type StatusRow,
  type StatusInput,
} from "./statusModel.ts";

const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";
const ESCROW = "CCM5G4FCOV7PLKFMEJBCYM5R7JOTZVUXKWBDR3SWCW2IM2LKNNBO4TH5";

function voice(overrides: Partial<VoiceHealth> = {}): VoiceHealth {
  return {
    sttBackend: "groq",
    ttsBackend: "fish",
    agentProvider: "openai",
    groqKey: true,
    fishKey: true,
    anthropicKey: false,
    openaiCompatKey: true,
    ...overrides,
  };
}

function chain(overrides: Partial<ChainFacts> = {}): ChainFacts {
  return {
    network: "testnet",
    horizonUrl: "https://horizon-testnet.stellar.org",
    guardContractId: GUARD,
    p2pContractId: ESCROW,
    ...overrides,
  };
}

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return { voice: voice(), chain: chain(), touchId: { status: "ok", detail: "Touch ID ready" }, ...overrides };
}

function row(rows: StatusRow[], id: string): StatusRow {
  const found = rows.find((candidate) => candidate.id === id);
  assert.ok(found, `no row ${id}`);
  return found;
}

test("shortId keeps head and tail of a 56-char id", () => {
  assert.equal(shortId(GUARD), "CDRLSF…CK4D");
  assert.equal(shortId("short"), "short");
});

test("horizonHost extracts the host and tolerates a bad URL", () => {
  assert.equal(horizonHost("https://horizon-testnet.stellar.org/x"), "horizon-testnet.stellar.org");
  assert.equal(horizonHost("not a url"), "not a url");
});

test("a missing voice source makes the Voice row unknown", () => {
  assert.equal(row(buildStatusRows(input({ voice: null })), "voice").level, "unknown");
});

test("missing cloud keys fail, local fallbacks warn", () => {
  assert.equal(row(buildStatusRows(input({ voice: voice({ groqKey: false }) })), "voice").level, "fail");
  assert.equal(
    row(buildStatusRows(input({ voice: voice({ sttBackend: "ondevice" }) })), "voice").level,
    "warn",
  );
  assert.equal(
    row(buildStatusRows(input({ voice: voice({ agentProvider: "anthropic", anthropicKey: false }) })), "voice").level,
    "fail",
  );
});

test("network must be testnet and have a Horizon URL", () => {
  assert.equal(row(buildStatusRows(input()), "network").level, "ok");
  assert.equal(
    row(buildStatusRows(input({ chain: chain({ network: "public" }) })), "network").level,
    "fail",
  );
  assert.equal(
    row(buildStatusRows(input({ chain: chain({ horizonUrl: "" }) })), "network").level,
    "warn",
  );
});

test("the live Horizon probe refines the Network row", () => {
  const up = row(buildStatusRows(input({ horizonReachable: true })), "network");
  assert.equal(up.level, "ok");
  assert.match(up.detail, /reachable/);

  const down = row(buildStatusRows(input({ horizonReachable: false })), "network");
  assert.equal(down.level, "fail");
  assert.match(down.detail, /unreachable/);
});

test("contracts warn until both guard and escrow are set", () => {
  const ok = row(buildStatusRows(input()), "contracts");
  assert.equal(ok.level, "ok");
  assert.match(ok.detail, /guard CDRLSF…CK4D/);
  assert.equal(
    row(buildStatusRows(input({ chain: chain({ p2pContractId: null }) })), "contracts").level,
    "warn",
  );
});

test("a missing chain source makes the chain rows unknown", () => {
  const rows = buildStatusRows(input({ chain: null }));
  assert.equal(row(rows, "network").level, "unknown");
  assert.equal(row(rows, "contracts").level, "unknown");
});

test("the Touch ID row echoes biometric_health", () => {
  const rows = buildStatusRows(input({ touchId: { status: "warn", detail: "password only" } }));
  assert.equal(row(rows, "touchId").level, "warn");
  assert.equal(row(rows, "touchId").detail, "password only");
});
