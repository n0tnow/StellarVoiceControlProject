import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import { parseSendPayment } from "./payment.ts";

const ctx = { network: "testnet" as const, transcript: "Ahmete 5 USDC gönder" };

test("valid arguments produce a send Intent with the transcript as source", () => {
  const intent = parseSendPayment({ amount: "5", asset: "USDC", recipient: "Ahmet" }, ctx);
  assert.deepEqual(intent, {
    kind: "send",
    asset: "USDC",
    amount: "5",
    recipient: "Ahmet",
    source: "Ahmete 5 USDC gönder",
  });
});

test("a numeric amount is coerced to the decimal-string money rule", () => {
  const intent = parseSendPayment({ amount: 5, asset: "usdc", recipient: "  ada  " }, ctx);
  assert.equal(intent.amount, "5");
  assert.equal(typeof intent.amount, "string");
  assert.equal(intent.asset, "USDC");
  assert.equal(intent.recipient, "ada");
});

test("a missing or blank asset defaults to USDC", () => {
  assert.equal(parseSendPayment({ amount: "1", recipient: "Ahmet" }, ctx).asset, "USDC");
  assert.equal(parseSendPayment({ amount: "1", asset: "   ", recipient: "Ahmet" }, ctx).asset, "USDC");
});

test("colloquial money words canonicalise to the supported stablecoin (step A13)", () => {
  for (const asset of ["USD", "usd", "dollar", "dollars", "dolar", "$"]) {
    assert.equal(
      parseSendPayment({ amount: "1", asset, recipient: "bilal" }, ctx).asset,
      "USDC",
      `${asset} should map to USDC`,
    );
  }
});

test("a supported code is canonicalised regardless of case", () => {
  assert.equal(parseSendPayment({ amount: "1", asset: "xlm", recipient: "bilal" }, ctx).asset, "XLM");
});

test("a genuinely unsupported asset is rejected as bad input (step A13)", () => {
  for (const asset of ["EUR", "BTC", "DOGE"]) {
    try {
      parseSendPayment({ amount: "1", asset, recipient: "bilal" }, ctx);
      assert.fail(`asset ${asset} should be rejected`);
    } catch (error) {
      assert.ok(error instanceof AgentError);
      assert.equal(error.kind, "input");
      assert.match(error.detail, /not supported/i);
    }
  }
});

test("an optional memo is carried through and omitted when absent", () => {
  const withMemo = parseSendPayment({ amount: "1", asset: "XLM", recipient: "a", memo: " rent " }, ctx);
  assert.equal(withMemo.memo, "rent");
  const withoutMemo = parseSendPayment({ amount: "1", asset: "XLM", recipient: "a" }, ctx);
  assert.equal("memo" in withoutMemo, false);
});

test("rejected amounts (missing, non-decimal, zero, negative, NaN)", () => {
  for (const amount of [undefined, "abc", "0", "0.0", "-1", "1e3", Number.NaN]) {
    assert.throws(
      () => parseSendPayment({ amount, asset: "USDC", recipient: "Ahmet" }, ctx),
      (error: unknown) => error instanceof AgentError && error.kind === "input",
      `amount ${String(amount)} should be rejected`,
    );
  }
});

test("a missing or blank recipient is rejected", () => {
  for (const recipient of [undefined, "", "   ", 42]) {
    assert.throws(
      () => parseSendPayment({ amount: "1", asset: "USDC", recipient }, ctx),
      (error: unknown) => error instanceof AgentError && error.kind === "input",
    );
  }
});

test("non-object arguments are rejected", () => {
  assert.throws(
    () => parseSendPayment("not an object", ctx),
    (error: unknown) => error instanceof AgentError && error.kind === "input",
  );
});

test("the error label stays short and the detail explains the field", () => {
  try {
    parseSendPayment({ amount: "abc", asset: "USDC", recipient: "Ahmet" }, ctx);
    assert.fail("expected a rejection");
  } catch (error) {
    assert.ok(error instanceof AgentError);
    assert.equal(error.label, "Bad input");
    assert.match(error.detail, /amount/);
  }
});
