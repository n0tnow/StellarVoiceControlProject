import assert from "node:assert/strict";
import { test } from "node:test";

import { createAgentContactStore } from "./contacts.ts";
import { ContactsClientError, type Contact, type ContactsClient } from "./contactsModel.ts";

const ADA = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
const BOB = "GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV";

interface Harness {
  store: ReturnType<typeof createAgentContactStore>;
  calls: string[];
  added: Contact[];
  state: { announced: number };
}

function harness(existing: Contact[] = [], overrides: Partial<ContactsClient> = {}): Harness {
  const calls: string[] = [];
  const added: Contact[] = [];
  const state = { announced: 0 };
  const client: ContactsClient = {
    list: async () => existing,
    add: async (nickname, address) => {
      const contact = { nickname, address };
      added.push(contact);
      return contact;
    },
    remove: async (nickname) => ({ nickname, address: ADA }),
    ...overrides,
  };
  const store = createAgentContactStore({
    client,
    isValidAddress: async (address) => {
      calls.push(`checksum:${address}`);
      return address === ADA || address === BOB;
    },
    announce: () => {
      state.announced += 1;
    },
  });
  return { store, calls, added, state };
}

test("save validates the name before anything else", async () => {
  const h = harness();
  const result = await h.store.save("Send", ADA);
  assert.equal(result.status, "invalidName");
  assert.equal(h.calls.length, 0);
});

test("save refuses an address that fails the checksum", async () => {
  const h = harness();
  const result = await h.store.save("ada", "Gbad");
  assert.equal(result.status, "invalidAddress");
  assert.equal(h.added.length, 0);
});

test("save never overwrites a name mapped to a different address", async () => {
  const h = harness([{ nickname: "ada", address: ADA }]);
  const same = await h.store.save("Ada", ADA);
  assert.deepEqual(same, { status: "alreadySaved", nickname: "ada" });
  const other = await h.store.save("Ada", BOB);
  assert.deepEqual(other, { status: "nameTaken", nickname: "ada" });
  assert.equal(h.added.length, 0);
});

test("save stores a new contact and announces the change", async () => {
  const h = harness();
  const result = await h.store.save("  Ada ", ADA);
  assert.deepEqual(result, { status: "saved", nickname: "ada", address: ADA });
  assert.deepEqual(h.added, [{ nickname: "ada", address: ADA }]);
  assert.equal(h.state.announced, 1);
});

test("save fails closed when the store rejects the add as a duplicate", async () => {
  const h = harness([], {
    add: async () => {
      throw new ContactsClientError("exists", "ada is already saved");
    },
  });
  const result = await h.store.save("Ada", ADA);
  assert.deepEqual(result, { status: "nameTaken", nickname: "ada" });
  assert.equal(h.state.announced, 0);
});

test("remove reports a missing name and announces a real removal", async () => {
  const missing = harness([], {
    remove: async () => {
      throw new ContactsClientError("notFound", "no recipient");
    },
  });
  assert.equal((await missing.store.remove("ada")).status, "missing");
  assert.equal(missing.state.announced, 0);

  const h = harness();
  const result = await h.store.remove("Ada");
  assert.deepEqual(result, { status: "removed", nickname: "ada" });
  assert.equal(h.state.announced, 1);
});
