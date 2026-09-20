import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import type { ToolContext } from "./registry.ts";
import { buyAssetTool, normalizeRoute, parseBuyAsset, parseSellAsset } from "./sell.ts";

const ctx: ToolContext = { transcript: "test", network: "testnet" };

test("sell + anchor maps to a withdraw of USDC", () => {
  const intent = parseSellAsset({ asset: "USDC", amount: "50", route: "bank" }, ctx);
  assert.deepEqual(intent, {
    kind: "withdraw",
    asset: "USDC",
    amount: "50",
    route: "anchor",
    source: "test",
  });
});

test("selling a non-USDC asset through the bank is refused politely", () => {
  assert.throws(
    () => parseSellAsset({ asset: "XLM", amount: "50", route: "anchor" }, ctx),
    (error: unknown) => error instanceof AgentError && /peer-to-peer/.test(error.detail),
  );
});

test("sell + p2p maps to a p2p_offer with the TRY price", () => {
  const intent = parseSellAsset({ asset: "USDC", amount: "100", route: "p2p", priceTry: "3400" }, ctx);
  assert.equal(intent.kind, "p2p_offer");
  assert.equal(intent.priceTry, "3400");
  assert.equal(intent.route, "p2p");
});

test("a missing route asks the one short question and remembers the slots", () => {
  assert.throws(
    () => parseSellAsset({ asset: "USDC", amount: "all" }, ctx),
    (error: unknown) => {
      assert.ok(error instanceof AgentError);
      assert.equal(error.pending?.question, "sell_route");
      assert.deepEqual(error.pending?.filledSlots, { asset: "USDC", amount: "all" });
      return true;
    },
  );
});

test("a p2p sale with no price asks for one", () => {
  assert.throws(
    () => parseSellAsset({ asset: "USDC", amount: "100", route: "p2p" }, ctx),
    (error: unknown) =>
      error instanceof AgentError && error.pending?.question === "sell_price",
  );
});

test("buy + anchor maps to a TRY deposit", () => {
  const intent = parseBuyAsset({ asset: "USDC", amount: "50", route: "anchor" }, ctx);
  assert.equal(intent.kind, "deposit");
  assert.equal(intent.asset, "TRY");
  assert.equal(intent.amount, "50");
});

test("buy + p2p with an offer number maps to p2p_accept", () => {
  const intent = parseBuyAsset({ route: "p2p", offerId: 3 }, ctx);
  assert.equal(intent.kind, "p2p_accept");
  assert.equal(intent.offerId, 3);
});

test("buy + p2p with no offer number opens the offers list instead of signing", () => {
  const nav = buyAssetTool.toNavigationFor?.({ route: "p2p", language: "en" }, ctx);
  assert.equal(nav?.target, "p2p");
  assert.equal(nav?.spoken, "Opening P2P offers.");
});

test("route synonyms fold to anchor or p2p", () => {
  assert.equal(normalizeRoute("banka"), "anchor");
  assert.equal(normalizeRoute("peer to peer"), "p2p");
  assert.equal(normalizeRoute("somewhere"), undefined);
});
