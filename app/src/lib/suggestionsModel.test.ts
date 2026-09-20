import assert from "node:assert/strict";
import { test } from "node:test";

import { suggest } from "@polaris/stellar";

import { computeSuggestions, DEFAULT_DISPLAY_ASSET, pickDisplayAsset } from "./suggestionsModel.ts";

const DAY = 86_400;
const NOW = 1_700_000_000;
const OWNER_ASSET = "XLM";

/** A deterministic payment at `dayOffset` days before `NOW`. */
function rec(id: string, dayOffset: number, amount: string, asset = OWNER_ASSET): suggest.HistoryRecord {
  return {
    id,
    ts: NOW - dayOffset * DAY,
    recipientAddress: `G${id.toUpperCase().padEnd(55, "A")}`,
    asset,
    amountRaw: suggest.parseAmount(amount, 7),
    mode: "public",
    route: "direct",
    status: "confirmed",
  };
}

/** Eight payments over distinct days: enough for the engine to propose a threshold. */
function enoughHistory(): suggest.HistoryRecord[] {
  return Array.from({ length: 8 }, (_, index) => rec(`h${index}`, index + 1, "10"));
}

test("pickDisplayAsset chooses the busiest asset and prefers XLM on a tie", () => {
  assert.equal(pickDisplayAsset([rec("a", 1, "1", "USDC"), rec("b", 2, "1", "USDC")]), "USDC");
  assert.equal(
    pickDisplayAsset([rec("a", 1, "1", "USDC"), rec("b", 2, "1", "XLM")]),
    DEFAULT_DISPLAY_ASSET,
  );
  assert.equal(pickDisplayAsset([]), DEFAULT_DISPLAY_ASSET);
});

test("computeSuggestions runs the engine and reports an explanation when short", () => {
  const run = computeSuggestions({
    history: enoughHistory(),
    now: NOW,
    timeZone: "UTC",
    displayAsset: OWNER_ASSET,
    dismissed: [],
  });
  assert.ok(run.suggestions.length >= 1);
  assert.equal(run.noSuggestions, null);

  const short = computeSuggestions({
    history: [rec("only", 1, "10")],
    now: NOW,
    timeZone: "UTC",
    displayAsset: OWNER_ASSET,
    dismissed: [],
  });
  assert.equal(short.suggestions.length, 0);
  assert.equal(short.noSuggestions?.reason, "not_enough_history");
});

test("a dismissed suggestion is filtered out of the next run", () => {
  const base = {
    history: enoughHistory(),
    now: NOW,
    timeZone: "UTC",
    displayAsset: OWNER_ASSET,
  };
  const first = computeSuggestions({ ...base, dismissed: [] });
  assert.ok(first.suggestions.length > 0);
  const id = first.suggestions[0]!.id;
  const second = computeSuggestions({ ...base, dismissed: [id] });
  assert.equal(
    second.suggestions.some((suggestion) => suggestion.id === id),
    false,
  );
});
