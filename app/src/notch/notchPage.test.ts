import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_NOTCH_PAGE,
  NOTCH_PAGES,
  coerceNotchPage,
  isNotchPage,
} from "./notchPage.ts";

test("the page list is exactly the four mock-data pages", () => {
  assert.deepEqual(NOTCH_PAGES, ["history", "tasks", "rules", "wallet"]);
});

test("the default page is a member of the page list", () => {
  assert.equal(NOTCH_PAGES.includes(DEFAULT_NOTCH_PAGE), true);
});

test("isNotchPage accepts every known page and rejects anything else", () => {
  for (const page of NOTCH_PAGES) {
    assert.equal(isNotchPage(page), true);
  }
  assert.equal(isNotchPage("settings"), false);
  assert.equal(isNotchPage(""), false);
  assert.equal(isNotchPage("History"), false); // case-sensitive: intents are normalized upstream
});

test("coerceNotchPage passes known pages through unchanged", () => {
  for (const page of NOTCH_PAGES) {
    assert.equal(coerceNotchPage(page), page);
  }
});

test("coerceNotchPage falls back to the default for an unknown request", () => {
  // The voice seam: a mis-heard "geçmişi aç" must not strand the panel.
  assert.equal(coerceNotchPage("gecmis"), DEFAULT_NOTCH_PAGE);
  assert.equal(coerceNotchPage("anything-else"), DEFAULT_NOTCH_PAGE);
});
