import { Asset, Keypair, StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { sacContractId } from "../assets.ts";

const TESTNET = "Test SDF Network ; September 2015";

describe("SAC id derivation", () => {
  it("is deterministic and a valid contract id", () => {
    const issuer = Keypair.random().publicKey();
    const asset = new Asset("E2EUSD", issuer);
    const sac = sacContractId(asset, TESTNET);
    expect(StrKey.isValidContract(sac)).toBe(true);
    expect(sacContractId(asset, TESTNET)).toBe(sac);
  });

  it("is network-dependent", () => {
    const asset = new Asset("E2EUSD", Keypair.random().publicKey());
    expect(sacContractId(asset, TESTNET)).not.toBe(
      sacContractId(asset, "Public Global Stellar Network ; September 2015"),
    );
  });
});
