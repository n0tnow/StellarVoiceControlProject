import { scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";

import { createP2pClient } from "../client.ts";
import { decodeOffer, normalizeOfferState } from "../describe.ts";
import { P2pRefusal } from "../errors.ts";
import type { Offer } from "../types.ts";
import {
  BUYER,
  FakeP2pRpc,
  OFFER,
  OWNER,
  P2P_ID,
  P2P_ID_2,
  SELLER,
  TOKEN_SAC,
  errSim,
  invokedCall,
  makeClient,
  offerScVal,
  okSim,
} from "./helpers.ts";

function writeRpc(): FakeP2pRpc {
  const rpc = new FakeP2pRpc();
  rpc.sims = [okSim(xdr.ScVal.scvVoid())];
  return rpc;
}

describe("p2p client — writes build the exact ABI invocation", () => {
  it("createOffer -> create_offer(seller, token, amount, price, ttl), signed by the seller", async () => {
    const call = invokedCall(
      (await makeClient(writeRpc()).createOffer(SELLER, TOKEN_SAC, 100_0000000n, 340_000n, 86_400n)).unsignedXdr,
    );
    expect(call.name).toBe("create_offer");
    expect(call.args.map((a) => a.type)).toEqual([
      "scvAddress",
      "scvAddress",
      "scvI128",
      "scvI128",
      "scvU64",
    ]);
    expect(call.tx.source).toBe(SELLER);
    expect(call.tx.signatures).toHaveLength(0);
  });

  it("accept -> accept(buyer, offer_id), signed by the buyer", async () => {
    const call = invokedCall((await makeClient(writeRpc()).accept(BUYER, 3n)).unsignedXdr);
    expect(call.name).toBe("accept");
    expect(call.args.map((a) => a.type)).toEqual(["scvAddress", "scvU64"]);
    expect(call.tx.source).toBe(BUYER);
    expect(call.tx.source).not.toBe(SELLER);
  });

  it("confirmFiat / cancel / reclaim -> (seller, offer_id), signed by the seller", async () => {
    for (const [method, call] of [
      ["confirm_fiat", (await makeClient(writeRpc()).confirmFiat(SELLER, 3n)).unsignedXdr],
      ["cancel", (await makeClient(writeRpc()).cancel(SELLER, 3n)).unsignedXdr],
      ["reclaim", (await makeClient(writeRpc()).reclaim(SELLER, 3n)).unsignedXdr],
    ] as const) {
      const decoded = invokedCall(call);
      expect(decoded.name).toBe(method);
      expect(decoded.args.map((a) => a.type)).toEqual(["scvAddress", "scvU64"]);
      expect(decoded.tx.source).toBe(SELLER);
    }
  });

  it("returns a decoded summary + payload hash and never signs", async () => {
    const res = await makeClient(writeRpc()).createOffer(SELLER, TOKEN_SAC, 100_0000000n, 340_000n, 86_400n);
    expect(res.summary.title).toContain("100");
    expect(res.summary.title).toContain("3400");
    expect(res.summary.lines.some((l) => l.includes("outside Autonomy"))).toBe(true);
    expect(res.summary.explorerUrl).toMatch(/\/tx\/[0-9a-f]{64}$/);
    expect(res.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(invokedCall(res.unsignedXdr).tx.signatures).toHaveLength(0);
  });

  it("surfaces a write simulation failure as a typed refusal", async () => {
    const rpc = new FakeP2pRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #5)")];
    await expect(makeClient(rpc).accept(BUYER, 3n)).rejects.toMatchObject({
      name: "P2pRefusal",
      code: "simulation_failed",
    });
  });

  it("parameterises the contract id: two ids produce different, correctly targeted XDR", async () => {
    const [a, b] = await Promise.all([
      makeClient(writeRpc(), { contractId: P2P_ID }).cancel(SELLER, 3n),
      makeClient(writeRpc(), { contractId: P2P_ID_2 }).cancel(SELLER, 3n),
    ]);
    expect(a.unsignedXdr).not.toBe(b.unsignedXdr);
    expect(invokedCall(a.unsignedXdr).contractId).toBe(P2P_ID);
    expect(invokedCall(b.unsignedXdr).contractId).toBe(P2P_ID_2);
  });

  it("refuses to build without a contract id", () => {
    expect(() => makeClient(writeRpc(), { contractId: "" })).toThrow(/contractId/);
    expect(() =>
      createP2pClient({
        contractId: "",
        rpc: new FakeP2pRpc() as never,
        networkPassphrase: "x",
        source: OWNER,
      }),
    ).toThrow(P2pRefusal);
  });
});

describe("p2p client — reads decode contract values", () => {
  function readRpc(retval: xdr.ScVal): FakeP2pRpc {
    const rpc = new FakeP2pRpc();
    rpc.sims = [okSim(retval)];
    return rpc;
  }

  it("getOffer decodes an Offer and returns null for None", async () => {
    const offer = await makeClient(readRpc(offerScVal(OFFER))).getOffer(3n);
    expect(offer).toEqual(OFFER);
    expect(await makeClient(readRpc(xdr.ScVal.scvVoid())).getOffer(3n)).toBeNull();
  });

  it("decodes the real union-encoded state from a snapshot-shaped map", () => {
    // `OfferState` is a `#[contracttype]` enum -> `scvVec([scvSymbol(name)])`,
    // and `Option<Address>` -> void/address. This is the exact live shape.
    const accepted: Offer = {
      ...OFFER,
      id: 1n,
      state: "Accepted",
      buyer: BUYER,
      accepted_at: 1_700_000_000n,
      pay_deadline: 1_700_001_800n,
    };
    const native = scValToNative(offerScVal(accepted)) as { state: unknown };
    expect(native.state).toEqual(["Accepted"]);
    expect(decodeOffer(native)).toEqual(accepted);
  });

  it("normalises a bare state symbol and rejects malformed states", () => {
    expect(normalizeOfferState("Open")).toBe("Open");
    expect(normalizeOfferState(["Settled"])).toBe("Settled");
    expect(() => normalizeOfferState(["Open", "Accepted"])).toThrow(P2pRefusal);
    expect(() => normalizeOfferState("Nope")).toThrow(P2pRefusal);
  });

  it("listOpen decodes a Vec<Offer> and an empty Vec to []", async () => {
    const vec = xdr.ScVal.scvVec([offerScVal(OFFER)]);
    expect(await makeClient(readRpc(vec)).listOpen(0n, 10)).toEqual([OFFER]);
    expect(await makeClient(readRpc(xdr.ScVal.scvVec([]))).listOpen(0n, 10)).toEqual([]);
  });

  it("nextOfferId decodes a u64 to bigint", async () => {
    const value = await makeClient(readRpc(xdr.ScVal.scvU64(7n))).nextOfferId();
    expect(value).toBe(7n);
    expect(typeof value).toBe("bigint");
  });

  it("simulates reads from the configured source and never signs or submits", async () => {
    const rpc = readRpc(offerScVal(OFFER));
    await makeClient(rpc, { source: SELLER }).getOffer(3n);
    expect(rpc.simulated).toHaveLength(1);
    expect(rpc.simulated[0]?.source).toBe(SELLER);
    expect(rpc.simulated[0]?.signatures).toHaveLength(0);
  });

  it("surfaces a read simulation failure as a typed refusal", async () => {
    const rpc = new FakeP2pRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #2)")];
    await expect(makeClient(rpc).getOffer(3n)).rejects.toMatchObject({ code: "simulation_failed" });
  });
});
