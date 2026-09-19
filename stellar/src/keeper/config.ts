/**
 * Keeper configuration, read from environment variables only.
 *
 * The keeper key (`KEEPER_SECRET`) is deliberately *not* the user's key: it
 * only pays network fees, so it should hold a small XLM balance and nothing
 * else. It never appears in logs — `KeeperConfig` exposes the derived public
 * key for that purpose (see `redactedConfig`).
 */
import { Keypair, StrKey } from "@stellar/stellar-sdk";

export const DEFAULT_RPC_URL = "https://soroban-testnet.stellar.org";
export const DEFAULT_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

export interface KeeperConfig {
  /** Keypair that pays fees for `execute_schedule` transactions. */
  keypair: Keypair;
  guardContractId: string;
  rpcUrl: string;
  networkPassphrase: string;
  /** Seconds between polls of `list_due`. */
  pollSeconds: number;
  /** Max schedules executed per tick. */
  maxPerTick: number;
  /** Simulate only; never sign or submit. */
  dryRun: boolean;
  /** Transaction validity window (timebounds), in seconds. */
  txTimeoutSeconds: number;
  /** Refuse to sign a transaction whose fee exceeds this many stroops. */
  maxFeeStroops: number;
  /** getTransaction polling interval while waiting for a final status. */
  pollIntervalMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function parseBool(name: string, v: string | undefined, fallback: boolean): boolean {
  const t = nonEmpty(v)?.toLowerCase();
  if (t === undefined) return fallback;
  if (["1", "true", "yes", "on"].includes(t)) return true;
  if (["0", "false", "no", "off"].includes(t)) return false;
  throw new ConfigError(`${name} must be a boolean (true/false), got "${v}"`);
}

function parsePositiveInt(name: string, v: string | undefined, fallback: number): number {
  const t = nonEmpty(v);
  if (t === undefined) return fallback;
  if (!/^\d+$/.test(t) || Number(t) < 1) {
    throw new ConfigError(`${name} must be a positive integer, got "${v}"`);
  }
  return Number(t);
}

/**
 * Build the config from an env map. `overrides.dryRun` lets the CLI flag
 * `--dry-run` win over the environment. Throws `ConfigError` with a message
 * that never contains the secret.
 */
export function loadConfig(env: Env, overrides: { dryRun?: boolean } = {}): KeeperConfig {
  const secret = nonEmpty(env.KEEPER_SECRET);
  if (!secret) throw new ConfigError("KEEPER_SECRET is required (a funded testnet key that only pays fees)");
  if (!StrKey.isValidEd25519SecretSeed(secret)) {
    throw new ConfigError("KEEPER_SECRET is not a valid Stellar secret seed (S...)");
  }

  const contractId = nonEmpty(env.GUARD_CONTRACT_ID);
  if (!contractId) throw new ConfigError("GUARD_CONTRACT_ID is required (the deployed polaris_guard contract, C...)");
  if (!StrKey.isValidContract(contractId)) {
    throw new ConfigError(`GUARD_CONTRACT_ID is not a valid contract id: ${contractId}`);
  }

  return {
    keypair: Keypair.fromSecret(secret),
    guardContractId: contractId,
    // SOROBAN_RPC_URL / NETWORK_PASSPHRASE are canonical; the STELLAR_* names
    // from .env.example are accepted as fallbacks so one .env serves everyone.
    rpcUrl: nonEmpty(env.SOROBAN_RPC_URL) ?? nonEmpty(env.STELLAR_RPC_URL) ?? DEFAULT_RPC_URL,
    networkPassphrase:
      nonEmpty(env.NETWORK_PASSPHRASE) ?? nonEmpty(env.STELLAR_NETWORK_PASSPHRASE) ?? DEFAULT_NETWORK_PASSPHRASE,
    pollSeconds: parsePositiveInt("KEEPER_POLL_SECONDS", env.KEEPER_POLL_SECONDS, 15),
    maxPerTick: parsePositiveInt("KEEPER_MAX_PER_TICK", env.KEEPER_MAX_PER_TICK, 5),
    dryRun: overrides.dryRun ?? parseBool("KEEPER_DRY_RUN", env.KEEPER_DRY_RUN, false),
    txTimeoutSeconds: parsePositiveInt("KEEPER_TX_TIMEOUT_SECONDS", env.KEEPER_TX_TIMEOUT_SECONDS, 30),
    maxFeeStroops: parsePositiveInt("KEEPER_MAX_FEE_STROOPS", env.KEEPER_MAX_FEE_STROOPS, 5_000_000),
    pollIntervalMs: 1000,
  };
}

/** Safe-to-log view of the config: public key instead of the keypair. */
export function redactedConfig(cfg: KeeperConfig): Record<string, unknown> {
  const { keypair, ...rest } = cfg;
  return { ...rest, keeperPublicKey: keypair.publicKey() };
}
