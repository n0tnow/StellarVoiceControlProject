/**
 * TEST-ONLY signer fed from an environment variable. The real product signs in
 * the Rust core behind Touch ID; this exists so tests and the e2e script can run
 * headless. Never commit a secret; never log one.
 */
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET_PASSPHRASE } from "./config.ts";
import type { Signer } from "./types.ts";

export class EnvSigner implements Signer {
  private readonly keypair: Keypair;

  constructor(secret: string) {
    this.keypair = Keypair.fromSecret(secret);
  }

  /** Reads `POLARIS_TEST_SECRET` (or the variable named by `envVar`). */
  static fromEnv(envVar = "POLARIS_TEST_SECRET"): EnvSigner {
    const secret = process.env[envVar];
    if (!secret) throw new Error(`${envVar} is not set (test-only signer; use a throwaway testnet key)`);
    return new EnvSigner(secret);
  }

  publicKey(): Promise<string> {
    return Promise.resolve(this.keypair.publicKey());
  }

  signTransaction(xdr: string, opts?: { networkPassphrase?: string }): Promise<string> {
    const tx = TransactionBuilder.fromXDR(xdr, opts?.networkPassphrase ?? TESTNET_PASSPHRASE);
    tx.sign(this.keypair);
    return Promise.resolve(tx.toXDR());
  }
}
