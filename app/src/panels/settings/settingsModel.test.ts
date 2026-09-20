import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSettingsView,
  shortId,
  type SettingsInput,
  type SettingSection,
  type VoiceFacts,
} from "./settingsModel.ts";

const OWNER = "GACXOWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNEROWNER";
const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";

function voice(overrides: Partial<VoiceFacts> = {}): VoiceFacts {
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

function input(overrides: Partial<SettingsInput> = {}): SettingsInput {
  return {
    version: "0.1.0",
    voice: voice(),
    chain: {
      network: "testnet",
      ownerAddress: OWNER,
      guardContractId: GUARD,
      p2pContractId: null,
    },
    agentModel: "glm-5.3-flash",
    ...overrides,
  };
}

function find(sections: SettingSection[], id: string) {
  for (const section of sections) {
    const row = section.rows.find((candidate) => candidate.id === id);
    if (row) return row;
  }
  throw new Error(`no row ${id}`);
}

test("shortId keeps head and tail of a 56-char id", () => {
  assert.equal(shortId(GUARD), "CDRLSF…CK4D");
  assert.equal(shortId("short"), "short");
});

test("a missing voice source makes every voice row unknown", () => {
  const sections = buildSettingsView(input({ voice: null }));
  for (const id of ["stt.backend", "stt.language", "tts.backend", "agent.provider"]) {
    assert.equal(find(sections, id).status, "unknown");
  }
});

test("groq without a key fails; on-device warns", () => {
  const missing = buildSettingsView(input({ voice: voice({ groqKey: false }) }));
  assert.equal(find(missing, "stt.backend").status, "fail");
  const ondevice = buildSettingsView(input({ voice: voice({ sttBackend: "ondevice" }) }));
  assert.equal(find(ondevice, "stt.backend").status, "warn");
});

test("fish without a key degrades to warn; local is ok", () => {
  const noKey = buildSettingsView(input({ voice: voice({ fishKey: false }) }));
  assert.equal(find(noKey, "tts.backend").status, "warn");
  const local = buildSettingsView(input({ voice: voice({ ttsBackend: "local" }) }));
  assert.equal(find(local, "tts.backend").status, "ok");
});

test("an unset language is auto-detect, an unreported one is unknown", () => {
  const unset = buildSettingsView(input({ voice: voice({ sttLanguage: "" }) }));
  const row = find(unset, "stt.language");
  assert.equal(row.status, "ok");
  assert.match(row.value, /auto-detect/);

  const unreported = buildSettingsView(input({ voice: voice() }));
  assert.equal(find(unreported, "stt.language").status, "unknown");
});

test("the selected agent provider needs its own key", () => {
  const anthropic = buildSettingsView(
    input({ voice: voice({ agentProvider: "anthropic", anthropicKey: false }) }),
  );
  assert.equal(find(anthropic, "agent.provider").status, "fail");
  const openai = buildSettingsView(
    input({ voice: voice({ agentProvider: "openai", openaiCompatKey: false }) }),
  );
  assert.equal(find(openai, "agent.provider").status, "fail");
  assert.equal(find(buildSettingsView(input()), "agent.provider").status, "ok");
});

test("credential rows report presence only, never a value", () => {
  const sections = buildSettingsView(input({ voice: voice({ groqKey: true, fishKey: false }) }));
  assert.equal(find(sections, "credentials.groq").value, "present");
  assert.equal(find(sections, "credentials.fish").value, "not set");
});

test("network must be testnet", () => {
  const sections = buildSettingsView(input());
  assert.equal(find(sections, "stellar.network").status, "ok");
  const mainnet = buildSettingsView(
    input({ chain: { network: "public", ownerAddress: null, guardContractId: null, p2pContractId: null } }),
  );
  assert.equal(find(mainnet, "stellar.network").status, "fail");
});

test("owner and contract ids are shortened and unset ones warn", () => {
  const sections = buildSettingsView(input());
  assert.equal(find(sections, "stellar.owner").value, shortId(OWNER));
  assert.equal(find(sections, "stellar.p2p").status, "warn");
  assert.equal(find(sections, "stellar.p2p").value, "not set");
});

test("a missing chain source makes every chain row unknown", () => {
  const sections = buildSettingsView(input({ chain: null }));
  assert.equal(find(sections, "stellar.owner").status, "unknown");
  assert.equal(find(sections, "stellar.network").status, "unknown");
});
