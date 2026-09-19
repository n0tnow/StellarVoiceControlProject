import { describe, expect, it } from "vitest";
import {
  assertTestnet,
  LiveConfigError,
  loadLiveConfig,
  parseEnvFile,
  TESTNET_HOSTS,
} from "../config.ts";

const GUARD = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";

describe("parseEnvFile", () => {
  it("parses KEY=VALUE, ignores comments and quotes", () => {
    const env = parseEnvFile(
      ["# comment", "NETWORK=testnet", "", 'GUARD="CDRL..."', "BADLINE"].join("\n"),
    );
    expect(env.NETWORK).toBe("testnet");
    expect(env.GUARD).toBe("CDRL...");
    expect(env.BADLINE).toBeUndefined();
  });
});

describe("assertTestnet", () => {
  it("accepts the pinned testnet endpoints", () => {
    expect(() => assertTestnet(TESTNET_HOSTS)).not.toThrow();
  });

  it("refuses a mainnet passphrase", () => {
    expect(() =>
      assertTestnet({ ...TESTNET_HOSTS, networkPassphrase: "Public Global Stellar Network ; September 2015" }),
    ).toThrowError(LiveConfigError);
  });

  it("refuses a non-testnet RPC host", () => {
    expect(() => assertTestnet({ ...TESTNET_HOSTS, rpcUrl: "https://soroban-mainnet.stellar.org" })).toThrowError(
      /not_testnet|only Stellar testnet/,
    );
  });

  it("refuses a non-testnet Horizon host", () => {
    expect(() => assertTestnet({ ...TESTNET_HOSTS, horizonUrl: "https://horizon.stellar.org" })).toThrowError(
      LiveConfigError,
    );
  });
});

describe("loadLiveConfig", () => {
  it("reads the guard id from demo.env when the env does not set it", () => {
    const config = loadLiveConfig({ env: {}, demoEnvText: `GUARD=${GUARD}\n` });
    expect(config.guardContractId).toBe(GUARD);
    expect(config.network).toBe("testnet");
    expect(config.rpcUrl).toBe(TESTNET_HOSTS.rpcUrl);
  });

  it("prefers GUARD_CONTRACT_ID from the environment", () => {
    const other = "CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY";
    const config = loadLiveConfig({ env: { GUARD_CONTRACT_ID: other }, demoEnvText: `GUARD=${GUARD}` });
    expect(config.guardContractId).toBe(other);
  });

  it("throws missing_guard when no id is available", () => {
    try {
      loadLiveConfig({ env: {}, demoEnvText: "" });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(LiveConfigError);
      expect((e as LiveConfigError).code).toBe("missing_guard");
    }
  });

  it("throws invalid_guard for a malformed contract id", () => {
    expect(() => loadLiveConfig({ env: { GUARD_CONTRACT_ID: "GABC" }, demoEnvText: "" })).toThrowError(
      LiveConfigError,
    );
  });

  it("refuses a mainnet RPC URL from the environment", () => {
    expect(() =>
      loadLiveConfig({ env: { GUARD_CONTRACT_ID: GUARD, SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org" }, demoEnvText: "" }),
    ).toThrowError(LiveConfigError);
  });
});
