/**
 * Live end-to-end configuration (TESTNET ONLY).
 *
 * This module is the single gate that refuses to run against anything other
 * than the three pinned testnet hosts and the testnet network passphrase. The
 * guard contract id is never hard-coded here: it is read from the environment
 * or from `contracts/scripts/demo.env` (the same source the shell demo uses).
 *
 * Node-only: `node:fs` / `node:os` imports are fine here because `live/**` is
 * never bundled for the browser.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StrKey } from "@stellar/stellar-sdk";
import { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "../anchor/config.ts";
import { DEFAULT_RPC_URL } from "../keeper/config.ts";

/** The only hosts this run may ever contact. */
export const TESTNET_HOSTS: Readonly<TestnetEndpoints> = Object.freeze({
  rpcUrl: DEFAULT_RPC_URL,
  horizonUrl: TESTNET_HORIZON_URL,
  friendbotUrl: TESTNET_FRIENDBOT_URL,
  networkPassphrase: TESTNET_PASSPHRASE,
});

export const E2E_DEFAULTS = Object.freeze({
  network: "testnet" as const,
  networkPassphrase: TESTNET_PASSPHRASE,
  /** Throwaway asset minted by the e2e issuer. */
  assetCode: "E2EUSD",
  /** Decimal amount minted to the owner by `e2e:setup`. */
  mintAmount: "10000",
  /** Path used only when a caller does not override it. */
  keysPath: join(homedir(), ".polaris-e2e", "keys.json"),
  resultsDir: join(homedir(), ".polaris-e2e"),
});

export type LiveConfigErrorCode = "not_testnet" | "missing_guard" | "invalid_guard";

/** Typed refusal so a misconfiguration can never silently reach another network. */
export class LiveConfigError extends Error {
  readonly code: LiveConfigErrorCode;
  constructor(code: LiveConfigErrorCode, message: string) {
    super(message);
    this.name = "LiveConfigError";
    this.code = code;
  }
}

export interface TestnetEndpoints {
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
}

/** Throws unless every endpoint is the pinned testnet one. */
export function assertTestnet(input: TestnetEndpoints): void {
  const wrong: string[] = [];
  if (input.rpcUrl !== TESTNET_HOSTS.rpcUrl) wrong.push(`rpcUrl=${input.rpcUrl}`);
  if (input.horizonUrl !== TESTNET_HOSTS.horizonUrl) wrong.push(`horizonUrl=${input.horizonUrl}`);
  if (input.friendbotUrl !== TESTNET_HOSTS.friendbotUrl) wrong.push(`friendbotUrl=${input.friendbotUrl}`);
  if (input.networkPassphrase !== TESTNET_HOSTS.networkPassphrase) {
    wrong.push(`networkPassphrase=${JSON.stringify(input.networkPassphrase)}`);
  }
  if (wrong.length > 0) {
    throw new LiveConfigError(
      "not_testnet",
      `refusing to run: only Stellar testnet is allowed, got ${wrong.join(", ")}`,
    );
  }
}

/** Parse a `KEY=VALUE` file (`contracts/scripts/demo.env`). Comments/blank lines ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

export interface LiveConfig {
  network: "testnet";
  rpcUrl: string;
  horizonUrl: string;
  friendbotUrl: string;
  networkPassphrase: string;
  guardContractId: string;
  keysPath: string;
  resultsDir: string;
}

export interface LoadLiveConfigOptions {
  argv?: readonly string[];
  env?: Record<string, string | undefined>;
  /** Raw text of `contracts/scripts/demo.env`; read from disk when omitted. */
  demoEnvText?: string;
  /** Overrides `~/.polaris-e2e/keys.json` (tests, CI). */
  keysPath?: string;
  resultsDir?: string;
  repoRoot?: string;
}

/**
 * Build the live config, refusing to continue unless the endpoints are testnet.
 * The guard id comes from `GUARD_CONTRACT_ID` or `demo.env`'s `GUARD=`; a
 * malformed/missing id is a typed error, never a default.
 */
export function loadLiveConfig(options: LoadLiveConfigOptions = {}): LiveConfig {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? fileURLToPath(new URL("../../../", import.meta.url));
  const demoEnvText = options.demoEnvText ?? readDemoEnv(repoRoot);
  const demoEnv = parseEnvFile(demoEnvText);

  const rpcUrl = env.SOROBAN_RPC_URL ?? env.STELLAR_RPC_URL ?? TESTNET_HOSTS.rpcUrl;
  const horizonUrl = env.HORIZON_URL ?? env.STELLAR_HORIZON_URL ?? TESTNET_HOSTS.horizonUrl;
  const friendbotUrl = env.FRIENDBOT_URL ?? TESTNET_HOSTS.friendbotUrl;
  const networkPassphrase =
    env.NETWORK_PASSPHRASE ?? env.STELLAR_NETWORK_PASSPHRASE ?? TESTNET_HOSTS.networkPassphrase;

  const guardContractId = env.GUARD_CONTRACT_ID ?? demoEnv.GUARD;
  if (!guardContractId) {
    throw new LiveConfigError(
      "missing_guard",
      "GUARD_CONTRACT_ID is required (env or contracts/scripts/demo.env GUARD=)",
    );
  }
  if (!StrKey.isValidContract(guardContractId)) {
    throw new LiveConfigError("invalid_guard", `GUARD_CONTRACT_ID is not a valid contract id: ${guardContractId}`);
  }

  assertTestnet({ rpcUrl, horizonUrl, friendbotUrl, networkPassphrase });

  return {
    network: "testnet",
    rpcUrl,
    horizonUrl,
    friendbotUrl,
    networkPassphrase,
    guardContractId,
    keysPath: options.keysPath ?? env.E2E_KEYS_PATH ?? E2E_DEFAULTS.keysPath,
    resultsDir: options.resultsDir ?? env.E2E_RESULTS_DIR ?? E2E_DEFAULTS.resultsDir,
  };
}

function readDemoEnv(repoRoot: string): string {
  try {
    return readFileSync(join(repoRoot, "contracts", "scripts", "demo.env"), "utf8");
  } catch {
    return "";
  }
}
