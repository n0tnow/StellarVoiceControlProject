import assert from "node:assert/strict";
import { test } from "node:test";

import { applyNavigation, notchPageFor } from "./navigation.ts";

test("every navigation target maps to the notch page that owns its subject", () => {
  assert.equal(notchPageFor("wallet"), "wallet");
  assert.equal(notchPageFor("history"), "history");
  assert.equal(notchPageFor("tasks"), "tasks");
  assert.equal(notchPageFor("schedules"), "tasks");
  assert.equal(notchPageFor("suggestions"), "tasks");
  assert.equal(notchPageFor("rules"), "rules");
  assert.equal(notchPageFor("security"), "rules");
  assert.equal(notchPageFor("anchor"), "trade");
  assert.equal(notchPageFor("p2p"), "trade");
  assert.equal(notchPageFor("settings"), "settings");
  assert.equal(notchPageFor("privacy"), "settings");
  assert.equal(notchPageFor("debug"), "settings");
});

test("close has no page: it collapses the panel instead", () => {
  assert.equal(notchPageFor("close"), null);
});

test("applyNavigation opens no window and resolves", async () => {
  await applyNavigation({ target: "settings", spoken: "Opening settings" });
});
