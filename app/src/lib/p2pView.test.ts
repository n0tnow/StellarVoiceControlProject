import assert from "node:assert/strict";
import { test } from "node:test";

import type { Offer, OfferState } from "@polaris/stellar";
import type { HorizonAccountDetail } from "./walletAssets.ts";
import {
  actionHint,
  actionLabel,
  checkHeldBalance,
  formatExpiresIn,
  formatRate,
  formatTokenAmount,
  formatTry,
  heldP2pAssets,
  nextActions,
  offerView,
  rawFromDecimal,
  roleOf,
  shortAddress,
} from "./p2pView.ts";

const OWNER = "G" + "A".repeat(55);
const OTHER = "G" + "B".repeat(55);

function offer(over: Partial<Offer> & { state: OfferState }): Offer {
  return {
    id: 3n,
    seller: OWNER,
    token: "C" + "A".repeat(55),
    amount: 100_0000000n,
    price_try_kurus: 340_000n,
    created_at: 1_700_000_000n,
    expires_at: 1_700_086_400n,
    buyer: null,
    accepted_at: 0n,
    pay_deadline: 0n,
    ...over,
  };
}

test("formats token amounts, TRY and the TRY-per-token rate", () => {
  assert.equal(formatTokenAmount(100_0000000n), "100");
  assert.equal(formatTokenAmount(1_0000000n), "1");
  assert.equal(formatTry(340_000n), "3400");
  assert.equal(formatTry(340_050n), "3400.5");
  assert.equal(formatRate(100_0000000n, 340_000n), "34 TRY/token");
  assert.equal(formatRate(0n, 340_000n), "?");
});

test("formats the expiry countdown and reports expired", () => {
  assert.equal(formatExpiresIn(1_000_000 + 90_000, 1_000_000), "1d 1h");
  assert.equal(formatExpiresIn(1_000_000 + 3_600, 1_000_000), "1h 0m");
  assert.equal(formatExpiresIn(1_000_000 + 120, 1_000_000), "2m");
  assert.equal(formatExpiresIn(1_000_000, 1_000_000), "expired");
});

test("role is seller, buyer or other", () => {
  assert.equal(roleOf(offer({ state: "Open" }), OWNER), "seller");
  assert.equal(roleOf(offer({ state: "Accepted", buyer: OTHER }), OTHER), "buyer");
  assert.equal(roleOf(offer({ state: "Open" }), "G" + "C".repeat(55)), "other");
});

test("an open offer: seller may cancel, anyone else may accept", () => {
  assert.deepEqual(nextActions(offer({ state: "Open" }), OWNER, 1), ["cancel"]);
  assert.deepEqual(nextActions(offer({ state: "Open" }), OTHER, 1), ["accept"]);
});

test("an expired open offer offers no accept and only reclaim to the seller", () => {
  const expired = offer({ state: "Open", expires_at: 1_000n });
  assert.deepEqual(nextActions(expired, OTHER, 1_000), []);
  assert.deepEqual(nextActions(expired, OWNER, 1_000), ["reclaim"]);
});

test("an accepted offer: seller confirms, and after the deadline may also reclaim", () => {
  const accepted = offer({ state: "Accepted", buyer: OTHER, pay_deadline: 2_000n });
  assert.deepEqual(nextActions(accepted, OWNER, 1_500), ["confirm"]);
  // At exactly the deadline reclaim is still rejected by the contract (strict >).
  assert.deepEqual(nextActions(accepted, OWNER, 2_000), ["confirm"]);
  assert.deepEqual(nextActions(accepted, OWNER, 2_001), ["confirm", "reclaim"]);
  assert.deepEqual(nextActions(accepted, OTHER, 1_500), ["wait"]);
});

test("settled, cancelled and expired offers offer no action", () => {
  for (const state of ["Settled", "Cancelled", "Expired"] as const) {
    assert.deepEqual(nextActions(offer({ state }), OWNER, 1), []);
  }
});

test("labels and hints are human sentences", () => {
  assert.equal(actionLabel("confirm"), "Confirm payment received");
  assert.match(actionHint("confirm", "Accepted"), /ONLY after the TRY arrived/);
  assert.match(actionHint("accept", "Open"), /off-chain/);
});

test("offerView assembles the row and resolves the seller label", () => {
  const view = offerView(offer({ state: "Open" }), OWNER, 1_700_000_000);
  assert.equal(view.amount, "100");
  assert.equal(view.priceTry, "3400");
  assert.equal(view.rate, "34 TRY/token");
  assert.equal(view.sellerLabel, shortAddress(OWNER));
  assert.equal(view.role, "seller");
  assert.deepEqual(view.actions, ["cancel"]);
  assert.equal(view.expiresIn, "1d 0h");
});

/* ------------------------------------------------------------------ *
 * Seller preflight (task W17b)
 * ------------------------------------------------------------------ */

const ISSUER = "G" + "C".repeat(55);

/** A Horizon account detail with the given balance lines, no float. */
function account(balances: { code: string; balance: string }[]): HorizonAccountDetail {
  return {
    sequence: "1",
    subentryCount: balances.length,
    numSponsoring: 0,
    numSponsored: 0,
    balances: balances.map((line) => ({
      assetType: line.code === "XLM" ? "native" : "credit_alphanum4",
      code: line.code,
      issuer: line.code === "XLM" ? null : ISSUER,
      balance: line.balance,
      native: line.code === "XLM",
      limit: line.code === "XLM" ? null : "922337203685.4775807",
    })),
  };
}

test("rawFromDecimal parses a Horizon string without a float", () => {
  assert.equal(rawFromDecimal("100.0000000"), 100_0000000n);
  assert.equal(rawFromDecimal("0.0000001"), 1n);
  assert.equal(rawFromDecimal("0"), 0n);
  assert.equal(rawFromDecimal("not a number"), 0n);
});

test("heldP2pAssets lists positive pinned balances, natives first, else XLM", () => {
  assert.deepEqual(heldP2pAssets(null), ["XLM"]);
  assert.deepEqual(
    heldP2pAssets(account([{ code: "XLM", balance: "5.0000000" }, { code: "USDC", balance: "0.0000000" }])),
    ["XLM"],
  );
  assert.deepEqual(
    heldP2pAssets(account([{ code: "USDC", balance: "10.0000000" }, { code: "XLM", balance: "5" }])),
    ["XLM", "USDC"],
  );
  assert.deepEqual(heldP2pAssets(account([{ code: "W8USD", balance: "3" }])), ["XLM"]);
});

test("checkHeldBalance refuses a missing trustline, a short balance, and an unsupported asset", () => {
  const onlyXlm = account([{ code: "XLM", balance: "5" }]);
  assert.deepEqual(checkHeldBalance(onlyXlm, "USDC", 100_0000000n), {
    ok: false,
    asset: "USDC",
    message: "Your wallet has no USDC trustline yet.",
  });

  const someUsdc = account([{ code: "USDC", balance: "10" }]);
  assert.deepEqual(checkHeldBalance(someUsdc, "usdc", 100_0000000n), {
    ok: false,
    asset: "USDC",
    message: "Not enough USDC in your wallet.",
  });
  assert.deepEqual(checkHeldBalance(someUsdc, "USDC", 5_0000000n), { ok: true, asset: "USDC" });
  assert.equal(checkHeldBalance(someUsdc, "W8USD", 1n).ok, false);
});
