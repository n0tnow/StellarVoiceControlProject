import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContactsClientError,
  buildContactDraft,
  createContactsClient,
  normalizeNickname,
  toContactsClientError,
  validateNickname,
} from "./contactsModel.ts";

test("nicknames are lowercased and validated against the alias charset", () => {
  assert.equal(normalizeNickname("  ALI  "), "ali");
  assert.equal(validateNickname("ali"), null);
  assert.equal(validateNickname("my-alias_1"), null);
  assert.match(validateNickname("1ali") ?? "", /starting with a letter/);
  assert.match(validateNickname("Ali") ?? "", /starting with a letter/);
  assert.match(validateNickname("") ?? "", /starting with a letter/);
  assert.match(validateNickname("send") ?? "", /reserved/);
  assert.match(validateNickname("__proto__") ?? "", /starting with a letter/);
});

test("buildContactDraft rejects a collision and a bad address by field", () => {
  const valid = buildContactDraft(
    { nickname: " ALI ", address: " GAAA " },
    { addressValid: true, existingNicknames: [] },
  );
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.deepEqual(valid.draft, { nickname: "ali", address: "GAAA" });

  const collision = buildContactDraft(
    { nickname: "ali", address: "GAAA" },
    { addressValid: true, existingNicknames: ["ali"] },
  );
  assert.equal(collision.ok, false);
  if (collision.ok) return;
  assert.equal(collision.field, "nickname");

  const badAddress = buildContactDraft(
    { nickname: "ali", address: "GAAA" },
    { addressValid: false, existingNicknames: [] },
  );
  assert.equal(badAddress.ok, false);
  if (badAddress.ok) return;
  assert.equal(badAddress.field, "address");
});

test("the contacts client forwards to the fixed commands", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const client = createContactsClient(async (command, args) => {
    calls.push({ command, ...(args ? { args } : {}) });
    if (command === "contacts_list") return [{ nickname: "ali", address: "GAAA" }];
    return { nickname: "ali", address: "GAAA" };
  });

  assert.deepEqual(await client.list(), [{ nickname: "ali", address: "GAAA" }]);
  await client.add("ali", "GAAA");
  await client.remove("ali");

  assert.deepEqual(
    calls.map((call) => call.command),
    ["contacts_list", "contacts_add", "contacts_remove"],
  );
  assert.deepEqual(calls[1]?.args, { nickname: "ali", address: "GAAA" });
  assert.deepEqual(calls[2]?.args, { nickname: "ali" });
});

test("a structured rejection keeps its kind, a missing command is unavailable", () => {
  assert.equal(toContactsClientError({ kind: "exists", message: "dupe" }).kind, "exists");
  assert.equal(toContactsClientError("Command contacts_list not found").kind, "unavailable");
  assert.ok(toContactsClientError(new Error("boom")) instanceof ContactsClientError);
});
