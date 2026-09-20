import { Account, Asset, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { TESTNET_USDC_ISSUER, toSdkAsset } from "../assets.ts";
import { payloadHashOf } from "../summary.ts";
import {
  createAddTrustline,
  defaultTrustlineAssets,
  resolveTrustlineAsset,
  TESTNET_SRT_ISSUER,
  TrustlineRefusal,
  type TrustlineDeps,
} from "../trustline.ts";

const OWNER = "GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E";
const FIXED_NOW = new Date("2026-09-19T12:00:00.000Z");
/** Circle's testnet USDC Stellar Asset Contract id (verified against the SDK). */
const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";

function makeDeps(overrides: Partial<TrustlineDeps> = {}): TrustlineDeps {
  return {
    ownerAddress: OWNER,
    loadAccount: async (address: string) => new Account(address, "1000"),
    networkPassphrase: TESTNET_PASSPHRASE,
    now: () => new Date(FIXED_NOW),
    ...overrides,
  };
}

function decode(xdr: string): Transaction {
  const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE);
  if (!(tx instanceof Transaction)) throw new Error("expected a Transaction");
  return tx;
}

function changeTrustOp(xdr: string) {
  const tx = decode(xdr);
  const op = tx.operations[0];
  if (!op || op.type !== "changeTrust") throw new Error("expected a changeTrust operation");
  return { tx, op, line: op.line as Asset };
}

describe("createAddTrustline", () => {
  it("builds an unsigned USDC changeTrust decodable back to the same operation", async () => {
    const res = await createAddTrustline(makeDeps())("USDC");
    const { tx, op, line } = changeTrustOp(res.unsignedXdr);

    expect(tx.source).toBe(OWNER);
    expect(tx.sequence).toBe("1001");
    expect(tx.fee).toBe("100");
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations).toHaveLength(1);
    expect(op.type).toBe("changeTrust");
    expect(line.isNative()).toBe(false);
    expect(line.code).toBe("USDC");
    expect(line.issuer).toBe(TESTNET_USDC_ISSUER);
  });

  it("sets a 300s upper time bound from the injected clock and no lower bound", async () => {
    const res = await createAddTrustline(makeDeps())("USDC");
    const { tx } = changeTrustOp(res.unsignedXdr);
    expect(Number(tx.timeBounds?.minTime)).toBe(0);
    expect(new Date(Number(tx.timeBounds?.maxTime) * 1000).toISOString()).toBe(
      "2026-09-19T12:05:00.000Z",
    );
  });

  it("builds the SDF test anchor's SRT with its pinned issuer", async () => {
    const res = await createAddTrustline(makeDeps())("srt");
    const { line } = changeTrustOp(res.unsignedXdr);
    expect(line.code).toBe("SRT");
    expect(line.issuer).toBe(TESTNET_SRT_ISSUER);
  });

  it("pins the testnet USDC issuer to Circle's SAC contract id", () => {
    const spec = defaultTrustlineAssets().find((asset) => asset.code === "USDC");
    expect(spec).toBeDefined();
    expect(toSdkAsset(spec!).contractId(TESTNET_PASSPHRASE)).toBe(USDC_SAC);
  });

  it("uses the injected loadAccount owner, not an agent-supplied address", async () => {
    const loadAccount = vi.fn(async (address: string) => new Account(address, "1000"));
    await createAddTrustline(makeDeps({ loadAccount }))("USDC");
    expect(loadAccount).toHaveBeenCalledTimes(1);
    expect(loadAccount).toHaveBeenCalledWith(OWNER);
  });

  it("decodes the summary from the XDR with the real tx hash", async () => {
    const res = await createAddTrustline(makeDeps())("USDC");
    expect(res.summary.title).toBe("Add USDC to your wallet");
    expect(res.summary.lines.some((line) => line.includes(TESTNET_USDC_ISSUER.slice(0, 4)))).toBe(true);
    const hash = payloadHashOf(res.unsignedXdr, TESTNET_PASSPHRASE);
    expect(res.summary.explorerUrl).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`);
  });

  it("refuses an asset that is not in the pinned catalog", async () => {
    const build = createAddTrustline(makeDeps());
    await expect(build("EURC")).rejects.toBeInstanceOf(TrustlineRefusal);
    try {
      await build("EURC");
    } catch (error) {
      expect((error as TrustlineRefusal).code).toBe("unsupported_asset");
    }
  });

  it("refuses a native or unknown asset via the resolver", () => {
    expect(resolveTrustlineAsset(defaultTrustlineAssets(), "XLM")).toBeUndefined();
    expect(resolveTrustlineAsset(defaultTrustlineAssets(), "usdc")?.issuer).toBe(TESTNET_USDC_ISSUER);
  });

  it("refuses when the owner account cannot be loaded", async () => {
    const build = createAddTrustline(
      makeDeps({
        loadAccount: async () => {
          throw new Error("404 not found");
        },
      }),
    );
    try {
      await build("USDC");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(TrustlineRefusal);
      expect((error as TrustlineRefusal).code).toBe("account_not_found");
    }
  });
});
