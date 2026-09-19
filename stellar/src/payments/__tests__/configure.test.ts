import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { configurePayments, sendPayment } from "../index.ts";
import { baseIntent, makeDeps, refusalOf } from "./helpers.ts";

describe("default sendPayment configuration", () => {
  it("throws a typed not_configured refusal before configurePayments", async () => {
    const err = await refusalOf(() => sendPayment(baseIntent));
    expect(err.code).toBe("not_configured");
    expect(err.message).toContain("configurePayments");
  });

  it("builds a payment after configurePayments", async () => {
    configurePayments(makeDeps());
    const res = await sendPayment(baseIntent);
    const tx = TransactionBuilder.fromXDR(res.unsignedXdr, TESTNET_PASSPHRASE);
    expect(tx).toBeInstanceOf(Transaction);
    expect(res.summary.title).toBe("Send 10 USDC to ada");
  });
});
