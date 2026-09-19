import { Account, BASE_FEE, Contract, Keypair, TransactionBuilder, nativeToScVal } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeInvocation } from "../../guard/describe.ts";
import { resolveAlias } from "../../payments/aliases.ts";
import { e2eAliasBook, e2eAssetRegistry, patchInvokeI128Arg, rawOf, txUrl } from "../e2e.ts";

const TESTNET = "Test SDF Network ; September 2015";
const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";

describe("e2eAssetRegistry", () => {
  it("maps the tool-facing USDC symbol (and the real code) to the e2e asset", () => {
    const issuer = Keypair.random().publicKey();
    const registry = e2eAssetRegistry("E2EUSD", issuer);
    expect(registry.get("USDC")).toEqual({ code: "E2EUSD", issuer, native: false });
    expect(registry.get("e2eusd")).toEqual({ code: "E2EUSD", issuer, native: false });
    expect(registry.get("XLM")).toBeUndefined();
  });
});

describe("e2eAliasBook", () => {
  it("resolves ada to the throwaway recipient", () => {
    const recipient = Keypair.random().publicKey();
    expect(resolveAlias(e2eAliasBook(recipient), "ada")?.address).toBe(recipient);
  });
});

describe("patchInvokeI128Arg", () => {
  it("replaces the amount argument without touching the call target", () => {
    const owner = Keypair.random().publicKey();
    const to = Keypair.random().publicKey();
    const asset = Keypair.random().publicKey();
    const account = new Account(owner, "100");
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET })
      .addOperation(
        new Contract(GUARD).call(
          "pay_owner",
          nativeToScVal(owner, { type: "address" }),
          nativeToScVal(to, { type: "address" }),
          nativeToScVal(asset, { type: "address" }),
          nativeToScVal(1n, { type: "i128" }),
        ),
      )
      .setTimeout(60)
      .build();
    const patched = patchInvokeI128Arg(tx.toXDR(), TESTNET, 3, 600_000_000n);
    const decoded = decodeInvocation(patched, TESTNET);
    expect(decoded.functionName).toBe("pay_owner");
    expect(decoded.contractId).toBe(GUARD);
    expect(decoded.args[3]).toBe(600_000_000n);
  });
});

describe("rawOf / txUrl", () => {
  it("converts decimal token strings to raw units", () => {
    expect(rawOf("25")).toBe(250_000_000n);
    expect(rawOf("0.0000001")).toBe(1n);
    expect(rawOf("10000")).toBe(100_000_000_000n);
  });

  it("builds a stellar.expert testnet link", () => {
    expect(txUrl("abc")).toBe("https://stellar.expert/explorer/testnet/tx/abc");
  });
});
