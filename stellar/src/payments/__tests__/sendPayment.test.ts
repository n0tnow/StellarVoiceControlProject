import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { TESTNET_USDC_ISSUER } from "../assets.ts";
import { payloadHashOf, toHex } from "../summary.ts";
import { ADA, ALIASES, baseIntent, makeDeps, OWNER, RAW_UNKNOWN, refusalOf, runPayment } from "./helpers.ts";

function decode(xdr: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE);
  if (!(tx instanceof Transaction)) throw new Error("expected a Transaction");
  return tx;
}

function paymentOp(xdr: string) {
  const tx = decode(xdr);
  const op = tx.operations[0];
  if (!op || op.type !== "payment") throw new Error("expected a payment operation");
  return { tx, op };
}

const SHORT_ISSUER = `${TESTNET_USDC_ISSUER.slice(0, 4)}…${TESTNET_USDC_ISSUER.slice(-4)}`;
const EXPLORER = "https://stellar.expert/explorer/testnet";

describe("sendPayment — happy paths", () => {
  it("builds an unsigned USDC payment decodable back to the same operation", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    const { tx, op } = paymentOp(res.unsignedXdr);

    expect(tx.source).toBe(OWNER);
    expect(tx.sequence).toBe("1001");
    expect(tx.fee).toBe("100");
    expect(tx.signatures).toHaveLength(0);
    expect(tx.memo.type).toBe("none");
    expect(tx.operations).toHaveLength(1);
    expect(op.destination).toBe(ADA);
    expect(op.amount).toBe("10.0000000");
    expect(op.asset.isNative()).toBe(false);
    expect(op.asset.code).toBe("USDC");
    expect(op.asset.issuer).toBe(TESTNET_USDC_ISSUER);
  });

  it("sets a 300s time bound from the injected clock", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    const { tx } = paymentOp(res.unsignedXdr);
    const tb = tx.timeBounds;
    expect(tb).toBeDefined();
    expect(Number(tb?.maxTime) - Number(tb?.minTime)).toBe(300);
    expect(new Date(Number(tb?.minTime) * 1000).toISOString()).toBe("2026-09-19T12:00:00.000Z");
  });

  it("builds an XLM payment with the native asset", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, asset: "XLM" });
    const { op } = paymentOp(res.unsignedXdr);
    expect(op.asset.isNative()).toBe(true);
    expect(op.asset.code).toBe("XLM");
    expect(op.destination).toBe(ADA);
  });

  it("uses the injected loadAccount owner, not an agent-supplied address", async () => {
    const loadAccount = vi.fn(async (address: string) => makeDeps().loadAccount(address));
    await runPayment(makeDeps({ loadAccount }), baseIntent);
    expect(loadAccount).toHaveBeenCalledTimes(1);
    expect(loadAccount).toHaveBeenCalledWith(OWNER);
  });

  it("accepts a mixed-case alias and normalises it", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, recipient: "ADA" });
    expect(res.summary.title).toBe("Send 10 USDC to ada");
  });

  it("trims surrounding whitespace on the alias", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, recipient: "  ada  " });
    expect(paymentOp(res.unsignedXdr).op.destination).toBe(ADA);
  });

  it("accepts an alias supplied in the reserved `alias` field", async () => {
    const res = await runPayment(makeDeps(), { kind: "send", asset: "USDC", amount: "5", alias: "ada" });
    expect(res.summary.title).toBe("Send 5 USDC to ada");
    expect(paymentOp(res.unsignedXdr).op.destination).toBe(ADA);
  });
});

describe("sendPayment — summary is decoded from the XDR", () => {
  it("renders exact USDC summary lines", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    expect(res.summary.title).toBe("Send 10 USDC to ada");
    expect(res.summary.lines).toEqual([
      `Pay 10 USDC (issuer ${SHORT_ISSUER})`,
      `To ada (${ADA})`,
      `Network: ${TESTNET_PASSPHRASE}`,
      "Fee: 0.00001 XLM",
    ]);
    expect(res.summary.estimatedFee).toBe("0.00001 XLM");
  });

  it("renders native XLM summary lines", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, asset: "XLM" });
    expect(res.summary.title).toBe("Send 10 XLM to ada");
    expect(res.summary.lines[0]).toBe("Pay 10 XLM (native)");
    expect(res.summary.lines[1]).toBe(`To ada (${ADA})`);
  });

  it("sets an explorerUrl for the transaction hash", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    const hash = payloadHashOf(res.unsignedXdr, TESTNET_PASSPHRASE);
    expect(res.summary.explorerUrl).toBe(`${EXPLORER}/tx/${hash}`);
  });

  it("honours an injected explorerBase", async () => {
    const res = await runPayment(makeDeps({ explorerBase: "https://example.test/explorer" }), baseIntent);
    expect(res.summary.explorerUrl?.startsWith("https://example.test/explorer/tx/")).toBe(true);
  });

  it("payloadHash equals the hash of the decoded transaction", async () => {
    const res = await runPayment(makeDeps(), baseIntent);
    const tx = decode(res.unsignedXdr);
    expect(payloadHashOf(res.unsignedXdr, TESTNET_PASSPHRASE)).toBe(toHex(tx.hash()));
    expect(payloadHashOf(res.unsignedXdr, TESTNET_PASSPHRASE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sendPayment — amount validation", () => {
  const bad = ["0", "-1", "1e3", "1.12345678", " 10", "", "1234567890123", "0.0", "+1", "1.", "10 ", ".5", "999999999999"];
  for (const amount of bad) {
    it(`refuses amount ${JSON.stringify(amount)} with invalid_amount`, async () => {
      const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, amount }));
      expect(err.code).toBe("invalid_amount");
      expect(err.message).toMatch(/amount/);
    });
  }

  it("accepts a one-stroop amount", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, amount: "0.0000001" });
    expect(paymentOp(res.unsignedXdr).op.amount).toBe("0.0000001");
  });

  it("accepts the maximum representable amount", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, amount: "922337203685.4775807" });
    expect(paymentOp(res.unsignedXdr).op.amount).toBe("922337203685.4775807");
  });
});

describe("sendPayment — asset and recipient refusals", () => {
  it("refuses an unsupported asset", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, asset: "EURC" }));
    expect(err.code).toBe("unsupported_asset");
    expect(err.message).toContain("EURC");
  });

  it("refuses an unknown alias", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, recipient: "nobody" }));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses a raw G address even when it is a known alias's address", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, recipient: ADA }));
    expect(err.code).toBe("unknown_recipient");
    expect(err.message).toContain("raw addresses are not accepted");
  });

  it("refuses an unknown raw G address", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, recipient: RAW_UNKNOWN }));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses a missing alias field", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { kind: "send", asset: "USDC", amount: "10" }));
    expect(err.code).toBe("unknown_recipient");
  });
});

describe("sendPayment — modes and routes (fail-closed)", () => {
  it("refuses confidential mode without downgrading", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, mode: "confidential" }));
    expect(err.code).toBe("mode_not_supported");
    expect(err.message).toBe("Privacy modes are not available yet; the payment was NOT sent");
  });

  it("refuses private mode", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, mode: "private" }));
    expect(err.code).toBe("mode_not_supported");
  });

  it("accepts an explicit public mode", async () => {
    const res = await runPayment(makeDeps(), { ...baseIntent, mode: "public" });
    expect(res.unsignedXdr).toMatch(/^[A-Za-z0-9+/=]+$/);
  });

  it("refuses the guarded route", async () => {
    const err = await refusalOf(() => runPayment(makeDeps({ route: "guarded" }), baseIntent));
    expect(err.code).toBe("guarded_route_not_available");
  });

  it("accepts the direct route", async () => {
    const res = await runPayment(makeDeps({ route: "direct" }), baseIntent);
    expect(paymentOp(res.unsignedXdr).op.amount).toBe("10.0000000");
  });
});

describe("sendPayment — account and trustline prechecks", () => {
  it("refuses a non-native asset with no recipient trustline", async () => {
    const checkTrustline = vi.fn(async () => false);
    const err = await refusalOf(() => runPayment(makeDeps({ checkTrustline }), baseIntent));
    expect(err.code).toBe("recipient_no_trustline");
    expect(checkTrustline).toHaveBeenCalledWith(ADA, expect.objectContaining({ code: "USDC", native: false }));
  });

  it("does not check a trustline for native XLM", async () => {
    const checkTrustline = vi.fn(async () => false);
    await runPayment(makeDeps({ checkTrustline }), { ...baseIntent, asset: "XLM" });
    expect(checkTrustline).not.toHaveBeenCalled();
  });

  it("maps a loadAccount failure to account_not_found", async () => {
    const err = await refusalOf(() =>
      runPayment(makeDeps({ loadAccount: async () => { throw new Error("horizon 404"); } }), baseIntent),
    );
    expect(err.code).toBe("account_not_found");
    expect(err.message).toContain("horizon 404");
  });
});

describe("sendPayment — intent kind", () => {
  it("refuses a non-send intent", async () => {
    const err = await refusalOf(() => runPayment(makeDeps(), { ...baseIntent, kind: "swap" }));
    expect(err.code).toBe("invalid_intent");
    expect(err.message).toContain("send");
  });
});

describe("sendPayment — alias book fixtures are valid", () => {
  it("resolves ada from the fixture book", () => {
    expect(ALIASES.ada.address).toBe(ADA);
  });
});
