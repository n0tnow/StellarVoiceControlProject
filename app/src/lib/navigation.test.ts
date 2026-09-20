import assert from "node:assert/strict";
import { test } from "node:test";

import { notchPageFor, panelFor } from "./navigation.ts";

test("notch targets map to their notch page", () => {
  assert.equal(notchPageFor("wallet"), "wallet");
  assert.equal(notchPageFor("rules"), "rules");
  assert.equal(notchPageFor("tasks"), "tasks");
  assert.equal(notchPageFor("history"), "history");
});

test("panel targets map to their panel window", () => {
  assert.equal(panelFor("security"), "security");
  assert.equal(panelFor("schedules"), "schedules");
  assert.equal(panelFor("suggestions"), "suggestions");
  assert.equal(panelFor("anchor"), "anchor");
  assert.equal(panelFor("p2p"), "p2p");
  assert.equal(panelFor("privacy"), "privacy");
  assert.equal(panelFor("settings"), "settings");
  assert.equal(panelFor("debug"), "debug");
});

test("the two surfaces do not overlap", () => {
  assert.equal(notchPageFor("settings"), null);
  assert.equal(panelFor("wallet"), null);
  assert.equal(notchPageFor("close"), null);
  assert.equal(panelFor("close"), null);
});
