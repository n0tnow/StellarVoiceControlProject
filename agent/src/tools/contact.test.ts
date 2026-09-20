import assert from "node:assert/strict";
import { test } from "node:test";

import {
  containsSecretKey,
  deleteContactTool,
  isStellarAddressShape,
  listContactsTool,
  looksLikeRecoveryPhrase,
  normalizeContactName,
  saveContactTool,
  type Contact,
  type ContactStore,
} from "./contact.ts";

const ADA = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
const BOB = "GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV";
// "S" + 55 base32 characters: the shape of a Stellar secret key.
const SECRET = `S${"A".repeat(55)}`;

function fakeStore(overrides: Partial<ContactStore> = {}): ContactStore {
  return {
    save: async () => ({ status: "saved", nickname: "ada", address: ADA }),
    list: async () => [],
    remove: async () => ({ status: "removed", nickname: "ada" }),
    ...overrides,
  };
}

function ctx(contacts?: ContactStore, transcript = "save Ada as an address") {
  return { network: "testnet" as const, transcript, ...(contacts ? { contacts } : {}) };
}

test("containsSecretKey finds a Stellar secret key, spaced or not", () => {
  assert.equal(containsSecretKey(SECRET), true);
  assert.equal(containsSecretKey(`my key is ${SECRET} ok`), true);
  assert.equal(containsSecretKey(SECRET.split("").join(" ")), true);
  assert.equal(containsSecretKey(ADA), false);
  assert.equal(containsSecretKey("save Ada as a friend"), false);
});

test("looksLikeRecoveryPhrase detects a mnemonic but not a sentence", () => {
  const twelve = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
  assert.equal(looksLikeRecoveryPhrase(twelve), true);
  assert.equal(
    looksLikeRecoveryPhrase("one two three four five six seven eight nine ten eleven twelve thirteen"),
    false,
    "13 words is not a BIP-39 length",
  );
  assert.equal(looksLikeRecoveryPhrase("save this address as Ada please"), false);
  assert.equal(looksLikeRecoveryPhrase(ADA), false);
});

test("normalizeContactName and isStellarAddressShape are strict", () => {
  assert.equal(normalizeContactName("  Ada  "), "ada");
  assert.equal(isStellarAddressShape(ADA), true);
  assert.equal(isStellarAddressShape(` ${ADA} `), true);
  assert.equal(isStellarAddressShape("not-an-address"), false);
  assert.equal(isStellarAddressShape(SECRET), false);
});

test("save_contact saves, normalises the name and speaks the short address", async () => {
  const result = await saveContactTool.run({ name: "Ada", address: ADA, language: "en" }, ctx(fakeStore()));
  assert.equal(result.status, "saved");
  assert.equal(result.nickname, "ada");
  assert.equal(result.spoken, "Saved Ada → GAJW…C25A.");
  assert.equal(saveContactTool.toSpeech?.(result), "Saved Ada → GAJW…C25A.");
});

test("save_contact passes the normalised name and trimmed address to the store", async () => {
  let seen: [string, string] | undefined;
  const store = fakeStore({
    save: async (nickname, address) => {
      seen = [nickname, address];
      return { status: "saved", nickname, address };
    },
  });
  await saveContactTool.run({ name: "  Ada ", address: ` ${ADA} `, language: "en" }, ctx(store));
  assert.deepEqual(seen, ["ada", ADA]);
});

test("save_contact reports a name already taken by another address", async () => {
  const store = fakeStore({ save: async () => ({ status: "nameTaken", nickname: "ada" }) });
  const result = await saveContactTool.run({ name: "Ada", address: BOB, language: "en" }, ctx(store));
  assert.equal(result.status, "nameTaken");
  assert.match(result.spoken, /different address/);
});

test("save_contact says when a name and address are already saved", async () => {
  const store = fakeStore({ save: async () => ({ status: "alreadySaved", nickname: "ada" }) });
  const result = await saveContactTool.run({ name: "Ada", address: ADA, language: "en" }, ctx(store));
  assert.equal(result.status, "alreadySaved");
  assert.equal(result.spoken, "Ada is already saved.");
});

test("save_contact asks for the address when it is missing and never calls the store", async () => {
  let called = false;
  const store = fakeStore({ save: async () => ((called = true), { status: "saved", nickname: "ada", address: ADA }) });
  const result = await saveContactTool.run({ name: "Ada", language: "en" }, ctx(store));
  assert.equal(result.status, "addressNeeded");
  assert.match(result.spoken, /type the full Stellar address/);
  assert.equal(called, false);
});

test("save_contact rejects a malformed address before the store", async () => {
  let called = false;
  const store = fakeStore({ save: async () => ((called = true), { status: "saved", nickname: "ada", address: ADA }) });
  const result = await saveContactTool.run({ name: "Ada", address: "Gbad", language: "en" }, ctx(store));
  assert.equal(result.status, "invalidAddress");
  assert.equal(called, false);
});

test("save_contact refuses a secret key in the address and never echoes it", async () => {
  let called = false;
  const store = fakeStore({ save: async () => ((called = true), { status: "saved", nickname: "ada", address: ADA }) });
  const result = await saveContactTool.run({ name: "Ada", address: SECRET, language: "en" }, ctx(store, "save this key"));
  assert.equal(result.status, "secret");
  assert.equal(called, false);
  assert.ok(!result.spoken.includes(SECRET));
  assert.match(result.spoken, /Wallet screen/);
});

test("save_contact refuses a recovery phrase in the address", async () => {
  const phrase = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
  const result = await saveContactTool.run({ name: "Ada", address: phrase, language: "en" }, ctx(fakeStore()));
  assert.equal(result.status, "secret");
});

test("save_contact refuses a secret key read in the transcript", async () => {
  const result = await saveContactTool.run(
    { name: "Ada", address: ADA, language: "en" },
    ctx(fakeStore(), `save my key ${SECRET} as Ada`),
  );
  assert.equal(result.status, "secret");
});

test("save_contact says it is unavailable without a store", async () => {
  const result = await saveContactTool.run({ name: "Ada", address: ADA, language: "en" }, ctx());
  assert.equal(result.status, "unavailable");
  assert.match(result.spoken, /isn't available/);
});

test("save_contact speaks Turkish for a Turkish turn", async () => {
  const result = await saveContactTool.run({ name: "Ada", address: ADA, language: "tr" }, ctx(fakeStore()));
  assert.equal(result.spoken, "Kaydedildi: Ada → GAJW…C25A.");
});

test("list_contacts speaks the names, or an empty line", async () => {
  const contacts: Contact[] = [
    { nickname: "ada", address: ADA },
    { nickname: "bob", address: BOB },
  ];
  const some = await listContactsTool.run({ language: "en" }, ctx(fakeStore({ list: async () => contacts })));
  assert.equal(some.contacts.length, 2);
  assert.equal(some.spoken, "You have 2 saved contacts: ada, bob.");
  assert.equal(listContactsTool.toSpeech?.(some), some.spoken);

  const none = await listContactsTool.run({ language: "en" }, ctx(fakeStore({ list: async () => [] })));
  assert.equal(none.spoken, "You have no saved contacts.");
});

test("list_contacts reports unavailability instead of crashing", async () => {
  const failing = fakeStore({ list: async () => { throw new Error("boom"); } });
  const result = await listContactsTool.run({ language: "en" }, ctx(failing));
  assert.equal(result.contacts.length, 0);
  assert.match(result.spoken, /can't read/);
  const missing = await listContactsTool.run({ language: "en" }, ctx());
  assert.match(missing.spoken, /can't read/);
});

test("delete_contact reports removed and missing", async () => {
  const removed = await deleteContactTool.run({ name: "Ada", language: "en" }, ctx(fakeStore()));
  assert.equal(removed.status, "removed");
  assert.equal(removed.spoken, "Removed Ada.");

  const missing = await deleteContactTool.run(
    { name: "Ada", language: "en" },
    ctx(fakeStore({ remove: async () => ({ status: "missing" }) })),
  );
  assert.equal(missing.status, "missing");
  assert.equal(missing.spoken, "I don't have a contact named Ada.");
});

test("the contact tools are read-only: no approval and no intent", () => {
  for (const tool of [saveContactTool, listContactsTool, deleteContactTool]) {
    assert.equal(tool.requiresApproval, undefined);
    assert.equal(tool.toIntent, undefined);
  }
});
