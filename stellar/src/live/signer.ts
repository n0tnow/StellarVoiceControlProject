/**
 * Signing helper for the live run (TESTNET ONLY).
 *
 * All owner/executor guard calls built by `guard/client.ts` set the actor as
 * the **transaction source** (`pay_owner` source = owner, `pay_executor` source
 * = executor, `set_rule`/`set_executor`/`create_schedule`/… source = owner). In
 * Soroban, `require_auth(source)` is satisfied by the source-account
 * credentials, i.e. by signing the transaction envelope — no separate
 * authorization entry is needed. `signEnvelope` therefore:
 *
 *   1. refuses any passphrase that is not the testnet one;
 *   2. refuses an envelope whose source account is not the signer (a foreign
 *      auth entry would be what needs signing, and this client never builds
 *      one — failing loudly beats signing the wrong transaction);
 *   3. signs the envelope with the actor keypair.
 */
import { Keypair, Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { TESTNET_PASSPHRASE } from "../anchor/config.ts";

export type SignRefusalCode = "not_testnet" | "source_mismatch" | "not_soroban" | "invalid_secret";

export class SignRefusal extends Error {
  readonly code: SignRefusalCode;
  constructor(code: SignRefusalCode, message: string) {
    super(message);
    this.name = "SignRefusal";
    this.code = code;
  }
}

/** Refuse to sign for anything but the testnet network. */
export function assertTestnetPassphrase(passphrase: string): void {
  if (passphrase !== TESTNET_PASSPHRASE) {
    throw new SignRefusal(
      "not_testnet",
      `refusing to sign: network passphrase is not the testnet one (got ${JSON.stringify(passphrase)})`,
    );
  }
}

/** Sign an unsigned base64 XDR with the actor's secret seed. Returns signed XDR. */
export function signEnvelope(unsignedXdr: string, secret: string, networkPassphrase: string): string {
  return signEnvelopeWithKeypair(unsignedXdr, keypairFromSecret(secret), networkPassphrase);
}

/** Same as `signEnvelope`, for callers that already hold a `Keypair`. */
export function signEnvelopeWithKeypair(
  unsignedXdr: string,
  keypair: Keypair,
  networkPassphrase: string,
): string {
  assertTestnetPassphrase(networkPassphrase);

  let parsed: unknown;
  try {
    parsed = TransactionBuilder.fromXDR(unsignedXdr, networkPassphrase);
  } catch (e) {
    throw new SignRefusal("not_soroban", `could not parse the unsigned XDR: ${(e as Error).message}`);
  }
  if (!(parsed instanceof Transaction)) {
    throw new SignRefusal("not_soroban", "fee-bump envelopes are not supported by the live e2e signer");
  }
  if (parsed.source !== keypair.publicKey()) {
    throw new SignRefusal(
      "source_mismatch",
      `refusing to sign: transaction source ${parsed.source} is not the signer ${keypair.publicKey()}; ` +
        "a foreign auth entry would need signing and this client does not build those",
    );
  }
  parsed.sign(keypair);
  return parsed.toXDR();
}

function keypairFromSecret(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch (e) {
    throw new SignRefusal("invalid_secret", `not a valid Stellar secret seed: ${(e as Error).message}`);
  }
}
