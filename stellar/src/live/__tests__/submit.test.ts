import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { resequenceEnvelope, submitClassic, submitSoroban } from "../submit.ts";

const TESTNET = "Test SDF Network ; September 2015";

function signed() {
  const kp = Keypair.random();
  const account = new Account(kp.publicKey(), "100");
  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET })
    .addOperation(
      Operation.payment({ destination: Keypair.random().publicKey(), asset: Asset.native(), amount: "1" }),
    )
    .setTimeout(60)
    .build();
  tx.sign(kp);
  return { kp, signedXdr: tx.toXDR(), hash: Buffer.from(tx.hash()).toString("hex") };
}

function noSleep(): Promise<void> {
  return Promise.resolve();
}

describe("submitSoroban", () => {
  it("polls NOT_FOUND then returns SUCCESS", async () => {
    const { signedXdr, hash } = signed();
    let calls = 0;
    const server = {
      sendTransaction: async () => ({ status: "PENDING", hash, latestLedger: 1 }),
      getTransaction: async () => {
        calls += 1;
        return calls < 2 ? { status: "NOT_FOUND" } : { status: "SUCCESS", ledger: 4242 };
      },
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, { networkPassphrase: TESTNET, sleep: noSleep });
    expect(res.status).toBe("SUCCESS");
    expect(res.ledger).toBe(4242);
    expect(res.hash).toBe(hash);
  });

  it("classifies an ERROR send response", async () => {
    const { signedXdr } = signed();
    const server = {
      sendTransaction: async () => ({ status: "ERROR", hash: "ab", errorResult: { result: { type: "txBadSeq" } } }),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, { networkPassphrase: TESTNET, sleep: noSleep });
    expect(res.status).toBe("FAILED");
    expect(res.error?.name).toBe("txBadSeq");
    expect(res.error?.kind).toBe("bad_seq");
  });

  it("decodes a contract error from FAILED diagnostic events", async () => {
    const { signedXdr } = signed();
    const event = {
      event: {
        body: { v0: { topics: [], data: { type: "scvError", error: { type: "sceContract", contractCode: 103 } } } },
      },
    };
    const server = {
      sendTransaction: async () => ({ status: "PENDING", hash: "cd", latestLedger: 1 }),
      getTransaction: async () => ({ status: "FAILED", ledger: 12, resultXdr: {}, diagnosticEventsXdr: [event] }),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, { networkPassphrase: TESTNET, sleep: noSleep });
    expect(res.status).toBe("FAILED");
    expect(res.error?.name).toBe("OverPerTxLimit");
    expect(res.error?.code).toBe(103);
    expect(res.ledger).toBe(12);
  });

  it("times out with a rpc WaitTimeout error", async () => {
    const { signedXdr } = signed();
    let now = 0;
    const server = {
      sendTransaction: async () => ({ status: "PENDING", hash: "ef", latestLedger: 1 }),
      getTransaction: async () => ({ status: "NOT_FOUND" }),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, {
      networkPassphrase: TESTNET,
      sleep: noSleep,
      waitMs: 10,
      now: () => (now += 1000),
    });
    expect(res.status).toBe("FAILED");
    expect(res.error?.name).toBe("WaitTimeout");
  });
});

describe("submitClassic", () => {
  it("returns SUCCESS with the Horizon hash", async () => {
    const { signedXdr, hash } = signed();
    const horizon = {
      submitTransaction: async () => ({ hash, ledger: 99 }),
    } as unknown as Horizon.Server;
    const res = await submitClassic(horizon, signedXdr, { networkPassphrase: TESTNET });
    expect(res.status).toBe("SUCCESS");
    expect(res.hash).toBe(hash);
    expect(res.ledger).toBe(99);
  });

  it("classifies a Horizon rejection via result codes", async () => {
    const { signedXdr } = signed();
    const horizon = {
      submitTransaction: async () => {
        throw { response: { data: { extras: { result_codes: { transaction: "tx_bad_seq" } } } } };
      },
    } as unknown as Horizon.Server;
    const res = await submitClassic(horizon, signedXdr, { networkPassphrase: TESTNET });
    expect(res.status).toBe("FAILED");
    expect(res.resultXdrSummary).toContain("tx_bad_seq");
  });
});

describe("resequenceEnvelope", () => {
  it("rewrites the sequence to the account's next sequence", async () => {
    const { kp, signedXdr } = signed();
    const reseq = await resequenceEnvelope(signedXdr, TESTNET, kp.publicKey(), async () => ({
      sequenceNumber: () => "500",
    }));
    const parsed = TransactionBuilder.fromXDR(reseq, TESTNET) as Transaction;
    expect(parsed.sequence).toBe("501");
  });

  it("bounds a hanging loadAccount with NetworkTimeout (review #1)", async () => {
    const { kp, signedXdr } = signed();
    await expect(
      resequenceEnvelope(signedXdr, TESTNET, kp.publicKey(), () => new Promise<never>(() => {}), 10),
    ).rejects.toThrowError(/loadAccount did not complete within 10 ms/);
  });
});

describe("uniform timeouts (review non-blocking #1)", () => {
  it("bounds a hanging sendTransaction with NetworkTimeout", async () => {
    const { signedXdr } = signed();
    const server = {
      sendTransaction: () => new Promise<never>(() => {}),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, { networkPassphrase: TESTNET, callTimeoutMs: 10 });
    expect(res.status).toBe("FAILED");
    expect(res.error?.name).toBe("NetworkTimeout");
    expect(res.error?.kind).toBe("rpc");
  });

  it("bounds a hanging getTransaction with NetworkTimeout", async () => {
    const { signedXdr, hash } = signed();
    const server = {
      sendTransaction: async () => ({ status: "PENDING", hash, latestLedger: 1 }),
      getTransaction: () => new Promise<never>(() => {}),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, {
      networkPassphrase: TESTNET,
      callTimeoutMs: 10,
      sleep: noSleep,
    });
    expect(res.error?.name).toBe("NetworkTimeout");
  });

  it("bounds a hanging Horizon submitTransaction with NetworkTimeout", async () => {
    const { signedXdr } = signed();
    const horizon = {
      submitTransaction: () => new Promise<never>(() => {}),
    } as unknown as Horizon.Server;
    const res = await submitClassic(horizon, signedXdr, { networkPassphrase: TESTNET, callTimeoutMs: 10 });
    expect(res.error?.name).toBe("NetworkTimeout");
  });

  it("reports OperationTimeout once the whole-operation deadline passes", async () => {
    const { signedXdr, hash } = signed();
    let now = 0;
    const server = {
      sendTransaction: async () => ({ status: "PENDING", hash, latestLedger: 1 }),
      getTransaction: async () => ({ status: "NOT_FOUND" }),
    } as unknown as StellarRpc.Server;
    const res = await submitSoroban(server, signedXdr, {
      networkPassphrase: TESTNET,
      sleep: noSleep,
      now: () => (now += 1000),
      waitMs: 10_000_000,
      operationTimeoutMs: 10,
    });
    expect(res.status).toBe("FAILED");
    expect(res.error?.name).toBe("OperationTimeout");
  });
});
