import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  Account,
  BASE_FEE,
  Contract,
  Horizon,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  xdr,
} from "@stellar/stellar-sdk";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeGuardRpc, okSim, OWNER, PAYEE, ASSET_SAC, makeClient } from "../../guard/__tests__/helpers.ts";
import { payloadHashOf } from "../../payments/summary.ts";
import type { GuardClient, GuardRpcLike } from "../../guard/types.ts";
import { EXPLORER_BASE } from "../e2e.ts";
import { newKeysFile, writeKeys, type KeysFile } from "../keys.ts";
import {
  cancelRequestFromFlags,
  decodedProofLine,
  renderCard,
  runTool,
  type Plan,
  type PlanStep,
  type ToolChain,
  type ToolIO,
} from "../tool.ts";

const TESTNET = "Test SDF Network ; September 2015";
const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";

let dir: string;
let keysPath: string;
let keys: KeysFile;

beforeAll(() => {
  dir = mkdtempSync(join(process.cwd(), ".tmp-live-tool-"));
  keysPath = join(dir, "keys.json");
  keys = newKeysFile();
  writeKeys(keysPath, keys);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
function scAddressToScVal(address: string): xdr.ScVal {
  return nativeToScVal(address, { type: "address" });
}

function xdrFor(source: string, fn: string, args: xdr.ScVal[]): string {
  const account = new Account(source, "100");
  return new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: TESTNET })
    .addOperation(new Contract(GUARD).call(fn, ...args))
    .setTimeout(60)
    .build()
    .toXDR();
}

function planStep(
  role: "owner" | "executor",
  fn: string,
  args: xdr.ScVal[],
  opts: { lines?: string[]; classic?: boolean } = {},
): PlanStep {
  const signerAddress = keys.keys[role].public;
  const unsignedXdr = xdrFor(signerAddress, fn, args);
  const hash = payloadHashOf(unsignedXdr, TESTNET);
  return {
    kind: fn,
    role,
    signerAddress,
    classic: opts.classic ?? false,
    arming: false,
    unsignedXdr,
    title: `polaris_guard: ${fn}`,
    lines: opts.lines ?? [`summary line for ${fn}`],
    warnings: [],
    payloadHash: hash,
    explorerUrl: `${EXPLORER_BASE}/tx/${hash}`,
  };
}

function captureIO(confirm: (card: string) => Promise<boolean>): { io: ToolIO; out: () => string; err: () => string } {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (t) => {
        stdout += `${t}\n`;
      },
      stderr: (t) => {
        stderr += `${t}\n`;
      },
      confirm,
    },
    out: () => stdout,
    err: () => stderr,
  };
}

interface FakeChainSpy {
  sendTransactionCalls: number;
  signedHashes: string[];
}

function fakeChain(config: ToolChain["config"], k: KeysFile, spy: FakeChainSpy): ToolChain {
  const server = {
    getAccount: async (address: string) => new Account(address, "100"),
    sendTransaction: async (tx: Transaction) => {
      spy.sendTransactionCalls += 1;
      spy.signedHashes.push(Buffer.from(tx.hash()).toString("hex"));
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 1 };
    },
    getTransaction: async () => ({ status: "SUCCESS", ledger: 4242 }),
  } as unknown as StellarRpc.Server;
  const horizon = { loadAccount: async () => { throw new Error("unexpected horizon call"); } } as unknown as Horizon.Server;
  return {
    config,
    keys: k,
    server,
    horizon,
    guard: {} as GuardClient,
    rpc: {} as GuardRpcLike,
    sac: ASSET_SAC,
    assetCode: "E2EUSD",
    assetIssuer: Keypair.random().publicKey(),
    aliases: { ada: { address: Keypair.random().publicKey(), network: "testnet" } },
    assets: { get: () => undefined },
  };
}

const baseConfig = (): { keysPath: string; demoEnvText: string } => ({
  keysPath,
  demoEnvText: `GUARD=${GUARD}\n`,
});

describe("renderCard proofs are decoded from the XDR", () => {
  const EXECUTOR_ADDR = "GDFX76I436JEQW5XWHATLQAJT6LF62TJRTI6YCFEEDHRUEKE5XQXU4OK";
  const cases: Array<[string, "owner" | "executor", xdr.ScVal[]]> = [
    ["pay_owner", "owner", [scAddressToScVal(OWNER), scAddressToScVal(PAYEE), scAddressToScVal(ASSET_SAC), nativeToScVal(500_000_000n, { type: "i128" })]],
    ["pay_executor", "executor", [scAddressToScVal(EXECUTOR_ADDR), scAddressToScVal(OWNER), scAddressToScVal(PAYEE), scAddressToScVal(ASSET_SAC), nativeToScVal(30_000_000n, { type: "i128" })]],
    ["set_alias", "owner", [scAddressToScVal(OWNER), nativeToScVal("ada", { type: "string" }), scAddressToScVal(PAYEE)]],
    ["remove_alias", "owner", [scAddressToScVal(OWNER), nativeToScVal("ada", { type: "string" })]],
    ["set_rule", "owner", [scAddressToScVal(OWNER), nativeToScVal(1n, { type: "i128" })]],
    ["set_executor", "owner", [scAddressToScVal(OWNER), scAddressToScVal(EXECUTOR_ADDR)]],
    ["revoke_executor", "owner", [scAddressToScVal(OWNER)]],
    ["create_schedule", "owner", [scAddressToScVal(OWNER), scAddressToScVal(PAYEE), scAddressToScVal(ASSET_SAC), nativeToScVal(20_000_000n, { type: "i128" }), nativeToScVal(1_789_851_780n, { type: "u64" }), nativeToScVal(0n, { type: "u64" }), nativeToScVal(1, { type: "u32" })]],
    ["cancel_schedule", "owner", [scAddressToScVal(OWNER), nativeToScVal(13, { type: "u32" })]],
    ["approve", "owner", [scAddressToScVal(OWNER), scAddressToScVal(GUARD), nativeToScVal(5_000_000_000n, { type: "i128" }), nativeToScVal(5_284_002, { type: "u32" })]],
  ];

  it.each(cases)("decodes %s from the signed XDR (not the summary lines)", (fn, role, args) => {
    const step = planStep(role, fn, args, { lines: ["SENTINEL-NOT-DECODED"] });
    const proof = decodedProofLine(step, TESTNET);
    expect(proof).toContain(fn);
    expect(proof).not.toContain("SENTINEL-NOT-DECODED");
    const card = renderCard({ command: fn, title: fn, steps: [step], notes: [], verify: async () => "" }, TESTNET);
    expect(card).toContain(fn);
    expect(card).toContain(`Signer: ${role} (${step.signerAddress})`);
    expect(card).toContain(step.payloadHash);
    expect(card).toContain("SENTINEL-NOT-DECODED");
  });

  it("changes the decoded proof when the XDR argument changes", () => {
    const a = planStep("owner", "cancel_schedule", [scAddressToScVal(OWNER), nativeToScVal(1, { type: "u32" })]);
    const b = planStep("owner", "cancel_schedule", [scAddressToScVal(OWNER), nativeToScVal(2, { type: "u32" })]);
    expect(decodedProofLine(a, TESTNET)).not.toBe(decodedProofLine(b, TESTNET));
  });

  it("renders the production set_alias XDR produced by the guard client", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [okSim(xdr.ScVal.scvVoid())];
    const client = makeClient(rpc);
    const call = await client.setAlias(OWNER, "ada", PAYEE);
    const hash = payloadHashOf(call.unsignedXdr, TESTNET);
    const step: PlanStep = {
      kind: "set_alias",
      role: "owner",
      signerAddress: OWNER,
      classic: false,
      arming: false,
      unsignedXdr: call.unsignedXdr,
      title: call.summary.title,
      lines: call.summary.lines,
      warnings: [],
      payloadHash: hash,
      explorerUrl: `${EXPLORER_BASE}/tx/${hash}`,
    };
    const proof = decodedProofLine(step, TESTNET);
    expect(proof).toContain("set_alias");
    expect(proof).toContain("ada");
    expect(proof).toContain(PAYEE);
  });
});

describe("cancelRequestFromFlags", () => {
  it("maps --to to the schedule tool's recipient field", () => {
    expect(cancelRequestFromFlags({ to: "ada" })).toEqual({ recipient: "ada" });
  });

  it("maps --id to an id request", () => {
    expect(cancelRequestFromFlags({ id: "16" })).toEqual({ id: 16 });
  });

  it("requires exactly one of --id / --to", () => {
    expect(() => cancelRequestFromFlags({})).toThrowError(/needs --id or --to/);
    expect(() => cancelRequestFromFlags({ id: "1", to: "ada" })).toThrowError(/not both/);
  });
});

describe("runTool confirmation gate and pipeline", () => {
  function syntheticPlan(spy: FakeChainSpy): Plan {
    void spy;
    return {
      command: "alias-add",
      title: "polaris_guard: set_alias",
      steps: [planStep("owner", "set_alias", [scAddressToScVal(OWNER), nativeToScVal("bob", { type: "string" }), scAddressToScVal(PAYEE)])],
      notes: [],
      verify: async () => "VERIFIED-OK",
    };
  }

  it("defaults to DENY when the tester does not type y/yes (nothing is signed)", async () => {
    const spy: FakeChainSpy = { sendTransactionCalls: 0, signedHashes: [] };
    const cap = captureIO(async () => false);
    const code = await runTool(["alias-add", "--live", "--name", "bob", "--address", PAYEE], {
      io: cap.io,
      config: baseConfig(),
      createChain: (config, k) => fakeChain(config, k, spy),
      buildPlan: async () => syntheticPlan(spy),
    });
    expect(code).toBe(0);
    expect(spy.sendTransactionCalls).toBe(0);
    expect(cap.out()).toContain("aborted");
  });

  it("with --yes signs the exact displayed XDR and reports the read-back", async () => {
    const spy: FakeChainSpy = { sendTransactionCalls: 0, signedHashes: [] };
    const plan = syntheticPlan(spy);
    const displayed = plan.steps[0]!.payloadHash;
    const cap = captureIO(async () => {
      throw new Error("confirm must not be called with --yes");
    });
    const code = await runTool(["alias-add", "--live", "--yes", "--name", "bob", "--address", PAYEE], {
      io: cap.io,
      config: baseConfig(),
      createChain: (config, k) => fakeChain(config, k, spy),
      buildPlan: async () => plan,
    });
    expect(code).toBe(0);
    expect(spy.sendTransactionCalls).toBe(1);
    expect(spy.signedHashes[0]).toBe(displayed);
    expect(cap.out()).toContain("VERIFIED-OK");
    expect(cap.out()).toContain("SUCCESS");
    expect(cap.out()).toContain(`${EXPLORER_BASE}/tx/${displayed}`);
  });

  it("refuses to submit when the displayed payload hash is for a different XDR (B2)", async () => {
    const spy: FakeChainSpy = { sendTransactionCalls: 0, signedHashes: [] };
    const honest = planStep("owner", "set_alias", [
      scAddressToScVal(OWNER),
      nativeToScVal("bob", { type: "string" }),
      scAddressToScVal(PAYEE),
    ]);
    // A DIFFERENT XDR than the one on the card: the hash check must catch it.
    const otherXdr = xdrFor(honest.signerAddress, "set_alias", [
      scAddressToScVal(OWNER),
      nativeToScVal("eve", { type: "string" }),
      scAddressToScVal(PAYEE),
    ]);
    const otherHash = payloadHashOf(otherXdr, TESTNET);
    expect(otherHash).not.toBe(honest.payloadHash);
    const tampered: Plan = {
      command: "alias-add",
      title: "polaris_guard: set_alias",
      steps: [{ ...honest, payloadHash: otherHash }],
      notes: [],
      verify: async () => "SHOULD-NOT-VERIFY",
    };
    const cap = captureIO(async () => true);
    const code = await runTool(["alias-add", "--live", "--yes", "--name", "bob", "--address", PAYEE], {
      io: cap.io,
      config: baseConfig(),
      createChain: (config, k) => fakeChain(config, k, spy),
      buildPlan: async () => tampered,
    });
    expect(code).toBe(1);
    expect(spy.sendTransactionCalls).toBe(0);
    expect(cap.err()).toMatch(/does not equal the displayed payload hash/);
  });

  it("never prints a secret seed", async () => {
    const spy: FakeChainSpy = { sendTransactionCalls: 0, signedHashes: [] };
    const cap = captureIO(async () => false);
    await runTool(["alias-add", "--live", "--yes", "--name", "bob", "--address", PAYEE], {
      io: cap.io,
      config: baseConfig(),
      createChain: (config, k) => fakeChain(config, k, spy),
      buildPlan: async () => syntheticPlan(spy),
    });
    const combined = `${cap.out()}\n${cap.err()}`;
    expect(combined).not.toMatch(/S[A-Z2-7]{55}/);
    // Every role secret really is absent from the output.
    for (const role of Object.keys(keys.keys) as Array<keyof KeysFile["keys"]>) {
      expect(combined).not.toContain(keys.keys[role].secret);
    }
  });
});

describe("runTool safety and usage", () => {
  it("without --live prints the plan and touches no network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const cap = captureIO(async () => true);
    const code = await runTool(["pay", "--to", "ada", "--amount", "5"], {
      io: cap.io,
      config: baseConfig(),
      createChain: () => {
        throw new Error("network must not be used without --live");
      },
    });
    expect(code).toBe(0);
    expect(cap.out()).toContain("plan (no network");
    expect(cap.out()).toContain("pay");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("rejects an unknown flag with a usage error (exit 2)", async () => {
    const cap = captureIO(async () => true);
    const code = await runTool(["pay", "--to", "ada", "--bogus"], {
      io: cap.io,
      createChain: () => {
        throw new Error("must not build a chain");
      },
    });
    expect(code).toBe(2);
    expect(cap.err()).toContain("unknown flag");
  });

  it("refuses a non-testnet RPC URL before doing anything", async () => {
    const cap = captureIO(async () => true);
    const code = await runTool(["rule", "--live"], {
      io: cap.io,
      config: {
        keysPath,
        env: { GUARD_CONTRACT_ID: GUARD, SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org" },
        demoEnvText: "",
      },
      createChain: () => {
        throw new Error("must not build a chain");
      },
    });
    expect(code).toBe(1);
    expect(cap.err()).toContain("only Stellar testnet");
  });

  it("needs a value for --to", async () => {
    const cap = captureIO(async () => true);
    const code = await runTool(["pay", "--to", "--amount", "5"], { io: cap.io, config: baseConfig() });
    expect(code).toBe(2);
    expect(cap.err()).toContain("needs a value");
  });
});
