/**
 * Sign + submit after an approved intent (milestone W4b).
 *
 * The chain tool has already built the unsigned XDR and the Rust Touch ID gate
 * has released it; this module is the last leg of the value-moving path:
 *
 *   `wallet_sign(id)` (the embedded wallet)
 *                      →  the wallet returns a signed envelope
 *                      →  the signed envelope comes back to Rust, which verifies
 *                         it independently
 *                      →  this module submits it via `submitSignedTx`
 *                      →  `tx_submitted { hash, explorerUrl }` is emitted.
 *
 * The embedded wallet signs inside the app; no browser is involved.
 *
 * ## Fail-closed and never throws
 *
 * Every failure is mapped to a short, human label on the shared `ExecutionOutcome`
 * so the notch can settle instead of hanging: a wallet rejection, a timeout, an
 * integrity failure and a submission error are all labelled outcomes, never an
 * exception. The submission hash is compared against the `txHash` Rust computed
 * and any disagreement is a labelled integrity error (a mismatch means the
 * network saw a different transaction than the one that was approved).
 *
 * ## No secrets, no value without approval
 *
 * The XDR only exists in Rust while signing; this module sees the returned
 * signed envelope and the tx hash. `wallet_sign` accepts only an approval id
 * whose gate state is `Authorized`, so nothing here can sign without the gate.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ExecutionOutcome } from "@polaris/agent";
import type { SubmitResult } from "@polaris/stellar";

import type { InvokeFn } from "./approval.ts";
import type { PaymentStage } from "./turnSession.ts";
import { webLog } from "./weblog.ts";

/** The Rust `wallet_sign` success shape (`BridgeOutcome` camelCase). */
export interface BridgeSigned {
  ok: true;
  signedXdr: string;
  signerAddress: string;
  txHash: string;
}

/** The Rust `wallet_sign` failure shape. */
export interface BridgeFailure {
  ok: false;
  code: BridgeFailureCode;
  message: string;
}

export type BridgeFailureCode =
  | "rejected"
  | "address_mismatch"
  | "network_mismatch"
  | "wallet_unavailable"
  | "not_authorized"
  | "integrity"
  | "timeout"
  | "error";

export type BridgeOutcome = BridgeSigned | BridgeFailure;

/**
 * True for the success arm — and only when the payload is actually usable. A
 * malformed success (`ok: true` without a string `signedXdr`/`txHash`) is not
 * treated as signed, so the caller labels it instead of throwing on
 * `txHash.toLowerCase()` (W4b-2 MINOR-1).
 */
export function isBridgeSigned(value: BridgeOutcome): value is BridgeSigned {
  return (
    value.ok === true &&
    typeof value.signedXdr === "string" &&
    typeof value.txHash === "string"
  );
}

/**
 * A submitted transaction: the enriched outcome the shell speaks and links.
 * `status` is `"executed"` on success and the matching failure status otherwise,
 * so it is a drop-in `ExecutionOutcome` with the extra chain facts attached.
 */
export interface SubmittedOutcome extends ExecutionOutcome {
  /** Stellar transaction hash (lowercase hex); present iff submitted. */
  txHash?: string;
  /** stellar.expert testnet link; present iff submitted. */
  explorerUrl?: string;
  /** The signer's public address; present iff submitted. */
  signerAddress?: string;
}

/** Short, overlay-safe labels for the wallet's failure codes. */
const BRIDGE_LABELS: Record<BridgeFailureCode, string> = {
  rejected: "Wallet didn't sign",
  address_mismatch: "Wrong wallet account",
  network_mismatch: "Wrong network",
  wallet_unavailable: "Wallet unavailable",
  not_authorized: "Not approved",
  integrity: "Signature check failed",
  timeout: "Wallet timed out",
  error: "Signing error",
};

/** The handful of submission failures a user can act on get a friendlier label. */
function submissionLabel(message: string): string {
  if (/tx_bad_seq/i.test(message)) return "Transaction expired";
  if (/op_underfunded|insufficient|underfunded/i.test(message)) return "Not enough balance";
  if (/tx_too_late/i.test(message)) return "Transaction expired";
  if (/network|fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|timed? ?out|offline/i.test(message)) {
    return "Network unreachable";
  }
  return "Submit failed";
}

/** Injected seams so the whole path is unit-testable without Tauri or a network. */
export interface SigningDeps {
  invoke: InvokeFn;
  submit: (signedXdr: string, expectedXdr?: string) => Promise<SubmitResult>;
  /** Builds the canonical testnet link for a hash; injectable for tests. */
  explorerTxUrl?: (hash: string) => string;
  /** Emits `tx_submitted` to the webview. Routed to the Rust command by default. */
  emitSubmitted: (hash: string, explorerUrl: string) => Promise<void> | void;
  /**
   * Additive (F1): reports the signing wait and the submit boundary so the
   * notch keeps the matching stage up. Optional, so existing callers and tests
   * that do not care about UI stages are unaffected.
   */
  onStage?: (stage: PaymentStage) => void;
}

/**
 * Default seams: the real Tauri invoke, the real submitter and emitter. The
 * chain SDK is imported **lazily** inside `submit`, so `@polaris/stellar` stays
 * out of the shell's eager bundle (W4b-2 MAJOR-2): a turn that never signs pays
 * for neither the SDK nor the bundle weight.
 */
export const defaultSigningDeps: SigningDeps = {
  invoke,
  submit: async (signedXdr, expectedXdr) => {
    const { submitSignedTx } = await import("@polaris/stellar");
    return submitSignedTx(signedXdr, expectedXdr);
  },
  explorerTxUrl,
  emitSubmitted: async (hash, explorerUrl) => {
    await invoke("tx_submitted_emit", { hash, explorerUrl });
  },
};

/** Builds the canonical testnet explorer link for a hash. */
export function explorerTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/**
 * Signs the approved transaction with the embedded wallet, submits it, and
 * emits `tx_submitted`. Never throws; every failure is a labelled outcome with
 * the original `intent` intact so the shell can settle the turn.
 *
 * `outcome` must be an `executed` outcome carrying an `approvalId` and the
 * unsigned XDR; anything else is returned unchanged (it is already a labelled
 * failure, and there is nothing to sign).
 */
export async function signAndSubmit(
  outcome: ExecutionOutcome,
  deps: SigningDeps = defaultSigningDeps,
): Promise<SubmittedOutcome> {
  const unsignedXdr = outcome.result?.unsignedXdr;
  const approvalId = outcome.approvalId;
  if (outcome.status !== "executed" || !unsignedXdr || !approvalId) {
    return outcome;
  }

  // F1: the approved blob is handed to the wallet; the shell shows the signing
  // wait from here until the signed envelope comes back.
  deps.onStage?.("signing");
  let bridge: BridgeOutcome;
  try {
    bridge = await deps.invoke<BridgeOutcome>("wallet_sign", { id: approvalId });
  } catch (error) {
    // A rejected command (transport, a typed gate error) is a labelled failure;
    // no signed envelope was produced, so nothing can be submitted.
    const detail = error instanceof Error ? error.message : String(error);
    return fail(outcome, "Signing error", detail);
  }

  if (!isBridgeSigned(bridge)) {
    // A malformed success (`ok: true` missing a string field) is not signed:
    // label it instead of letting `txHash.toLowerCase()` throw (MINOR-1).
    const failure = bridge as Partial<BridgeFailure>;
    const code = failure.code ?? "error";
    return fail(outcome, BRIDGE_LABELS[code], failure.message ?? "malformed bridge response");
  }

  // F1: the signed envelope is on its way to Horizon.
  deps.onStage?.("submitting");
  let submitted: SubmitResult;
  try {
    submitted = await deps.submit(bridge.signedXdr, unsignedXdr);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail(outcome, submissionLabel(detail), detail);
  }

  // The hash Rust computed must be the hash the network accepted. A mismatch
  // means two different transactions are in play, which is never benign.
  if (submitted.hash.toLowerCase() !== bridge.txHash.toLowerCase()) {
    return fail(
      outcome,
      "Transaction mismatch",
      `the network accepted ${submitted.hash} but the signed envelope hashed to ${bridge.txHash}`,
    );
  }

  const buildExplorerUrl = deps.explorerTxUrl ?? explorerTxUrl;
  const explorerUrl = submitted.explorerUrl || buildExplorerUrl(submitted.hash.toLowerCase());
  try {
    await deps.emitSubmitted(submitted.hash.toLowerCase(), explorerUrl);
  } catch (error) {
    // The transaction is already final; a failed UI emit must not turn a
    // successful submission into a failure. The hash is still returned.
    console.warn("could not emit tx_submitted", error);
  }

  return {
    ...outcome,
    txHash: submitted.hash.toLowerCase(),
    explorerUrl,
    signerAddress: bridge.signerAddress,
  };
}

/** Builds a labelled failure that keeps the executed result for diagnostics. */
function fail(outcome: ExecutionOutcome, label: string, detail: string): SubmittedOutcome {
  webLog("error", `signing ${label}: ${detail}`, true);
  return { status: "failed", intent: outcome.intent, label, detail, result: outcome.result };
}
