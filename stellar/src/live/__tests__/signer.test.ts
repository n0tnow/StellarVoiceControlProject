import { Account, Asset, BASE_FEE, Keypair, Operation, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assertTestnetPassphrase, SignRefusal, signEnvelope } from "../signer.ts";

const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";

function unsignedTx(source: string): string {
  const account = new Account(source, "100");
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET })
    .addOperation(
      Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(60)
    .build()
    .toXDR();
}

describe("signer", () => {
  it("refuses a non-testnet passphrase", () => {
    expect(() => assertTestnetPassphrase(MAINNET)).toThrowError(SignRefusal);
    const kp = Keypair.random();
    expect(() => signEnvelope(unsignedTx(kp.publicKey()), kp.secret(), MAINNET)).toThrowError(/not the testnet/);
  });

  it("refuses to sign when the transaction source is not the signer", () => {
    const source = Keypair.random();
    const other = Keypair.random();
    try {
      signEnvelope(unsignedTx(source.publicKey()), other.secret(), TESTNET);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SignRefusal);
      expect((e as SignRefusal).code).toBe("source_mismatch");
    }
  });

  it("signs an envelope whose source matches the signer", () => {
    const kp = Keypair.random();
    const signed = signEnvelope(unsignedTx(kp.publicKey()), kp.secret(), TESTNET);
    const parsed = TransactionBuilder.fromXDR(signed, TESTNET);
    expect(parsed).toBeInstanceOf(Transaction);
    expect((parsed as Transaction).signatures.length).toBeGreaterThan(0);
  });
});
