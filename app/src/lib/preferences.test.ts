import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_PREFERENCES,
  MAX_THRESHOLD_USD,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  saveApprovalThresholdUsd,
  type PreferenceStore,
} from "./preferences.ts";

/** A `Map`-backed store with the same get/set surface as `localStorage`. */
function fakeStore(initial: Record<string, string> = {}): PreferenceStore & {
  data: Map<string, string>;
} {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? (data.get(key) as string) : null),
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

test("a missing store or key yields the defaults (always ask)", () => {
  assert.deepEqual(loadPreferences(null), DEFAULT_PREFERENCES);
  assert.deepEqual(loadPreferences(fakeStore()), DEFAULT_PREFERENCES);
});

test("a stored value round-trips", () => {
  const store = fakeStore();
  saveApprovalThresholdUsd(25, store);
  assert.equal(loadPreferences(store).approvalThresholdUsd, 25);
});

test("a corrupt blob falls back to the default, never to a stored partial", () => {
  const store = fakeStore({ [PREFERENCES_STORAGE_KEY]: "{not json" });
  assert.equal(loadPreferences(store).approvalThresholdUsd, 0);
});

test("non-number, negative, NaN and Infinity all sanitize to 0", () => {
  for (const bad of ['"25"', "{}", "-5", "null", "NaN"]) {
    const store = fakeStore({
      [PREFERENCES_STORAGE_KEY]: `{"approvalThresholdUsd":${bad}}`,
    });
    assert.equal(loadPreferences(store).approvalThresholdUsd, 0, `input ${bad}`);
  }
});

test("save clamps an out-of-range value before it is stored", () => {
  const store = fakeStore();
  saveApprovalThresholdUsd(-10, store);
  assert.equal(loadPreferences(store).approvalThresholdUsd, 0);
  saveApprovalThresholdUsd(Number.POSITIVE_INFINITY, store);
  assert.equal(loadPreferences(store).approvalThresholdUsd, 0);
  saveApprovalThresholdUsd(MAX_THRESHOLD_USD * 10, store);
  assert.equal(loadPreferences(store).approvalThresholdUsd, MAX_THRESHOLD_USD);
});
