import assert from "node:assert/strict";
import { test } from "node:test";

import { isPanelName } from "../panels/panelRoutes.ts";
import { MORE_MENU } from "../lib/panels.ts";

test("the menu lists the removed tray's panels plus Quit, in order", () => {
  assert.deepEqual(
    MORE_MENU.map((entry) => entry.label),
    [
      "Security & rules",
      "Schedules",
      "Suggestions",
      "Anchor",
      "P2P",
      "Privacy",
      "Settings",
      "Debug",
      "Quit Polaris",
    ],
  );
});

test("every panel entry names a registered panel and none repeats", () => {
  const panels = MORE_MENU.filter((entry) => "panel" in entry).map((entry) => entry.panel);
  for (const panel of panels) assert.equal(isPanelName(panel), true, panel);
  assert.equal(new Set(panels).size, panels.length);
});

test("Quit is present exactly once and is the last entry", () => {
  const quits = MORE_MENU.filter((entry) => "quit" in entry);
  assert.equal(quits.length, 1);
  assert.equal("quit" in MORE_MENU[MORE_MENU.length - 1]!, true);
});
