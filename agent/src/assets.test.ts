import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASSET_SYNONYMS,
  DEFAULT_ASSET,
  normalizeAsset,
  SUPPORTED_ASSETS,
} from "./assets.ts";
import { POLARIS_SYSTEM_PROMPT } from "./prompt.ts";

test("the prompt names every supported asset from the single list (step A13)", () => {
  // If an asset is added to `assets.ts`, the prompt follows without a second
  // edit — this asserts there is no other list to keep in sync.
  for (const asset of SUPPORTED_ASSETS) {
    assert.ok(POLARIS_SYSTEM_PROMPT.includes(asset), `prompt must mention ${asset}`);
  }
  assert.match(POLARIS_SYSTEM_PROMPT, new RegExp(`defaults to ${DEFAULT_ASSET}`));
  for (const word of Object.keys(ASSET_SYNONYMS)) {
    assert.ok(POLARIS_SYSTEM_PROMPT.includes(word), `prompt must mention the word ${word}`);
  }
});

test("normalizeAsset returns a canonical code, a synonym's target, or undefined", () => {
  assert.equal(normalizeAsset("usdc"), "USDC");
  assert.equal(normalizeAsset("  xlm "), "XLM");
  assert.equal(normalizeAsset("USD"), DEFAULT_ASSET);
  assert.equal(normalizeAsset("dollar"), DEFAULT_ASSET);
  // A blank value is the user's omission, not an error.
  assert.equal(normalizeAsset(undefined), DEFAULT_ASSET);
  assert.equal(normalizeAsset(null), DEFAULT_ASSET);
  assert.equal(normalizeAsset("   "), DEFAULT_ASSET);
  // Genuinely unsupported, or not a string: no guess.
  assert.equal(normalizeAsset("EUR"), undefined);
  assert.equal(normalizeAsset("BTC"), undefined);
  assert.equal(normalizeAsset(42), undefined);
});
