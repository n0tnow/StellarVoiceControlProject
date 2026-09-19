/**
 * Submit-and-wait helpers for the live run.
 *
 * Two paths:
 *  - `submitSoroban`: sign already happened elsewhere; send the signed envelope
 *    through Soroban RPC and poll `getTransaction` to a final status.
 *  - `submitClassic`: post a signed classic payment to Horizon.
 *
 * Failures are classified with the **existing** keeper/errors tables (guard
 * codes >= 100, token/host codes < 100), so a live rejection reads the same as
 * an offline one. A submitted transaction is never lost: the hash is derived
 * from the signed envelope and returned in every result.
 *
 * Every network call is hard-bounded (`NETWORK_CALL_TIMEOUT_MS`, review item
 * #1) and the whole submission honours an operation deadline
 * (`DEFAULT_OPERATION_TIMEOUT_MS`); both surface as typed timeout errors and,
 * for callers that only read `SubmitResult.error`, as `rpc`-kind
 * classifications named `NetworkTimeout` / `OperationTimeout`.
 */
import { Horizon, Transaction, TransactionBuilder, rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { xdr } from "@stellar/stellar-sdk";
import {
  classifyContractText,
  classifyThrown,
  classifyTxResultCode,
  type ClassifiedError,
} from "../keeper/errors.ts";
import { asArray, field, variant } from "../keeper/xdr-compat.ts";
import {
  DEFAULT_OPERATION_TIMEOUT_MS,
  NETWORK_CALL_TIMEOUT_MS,
  withNetworkTimeout,
} from "./timeout.ts";

export interface SubmitResult {
  hash: string;
  ledger: number;
  status: "SUCCESS" | "FAILED";
  /** Short human summary of the result (contract error name / tx result code). */
  resultXdrSummary: string;
  /** Set when the transaction failed or was refused before inclusion. */
  error?: ClassifiedError;
}

export interface SubmitOptions {
  networkPassphrase: string;
  /** Hard cap on how long to wait for a final status. */
  waitMs?: number;
  pollMs?: number;
  /** Hard cap on any single network call (default 30 s). */
  callTimeoutMs?: number;
  /** Hard cap on the whole submit+wait operation (default 120 s). */
  operationTimeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 1_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function hashOf(tx: Transaction): string {
  return Buffer.from(tx.hash()).toString("hex");
}

function parseSigned(signedXdr: string, networkPassphrase: string): Transaction {
  const parsed = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  if (!(parsed instanceof Transaction)) throw new Error("fee-bump envelopes are not supported in the live e2e");
  return parsed;
}

/** A typed timeout as a `ClassifiedError` (`kind: "rpc"`). */
function timeoutClassified(err: unknown): ClassifiedError {
  const name = err instanceof Error ? err.name : "Timeout";
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "rpc", name, message };
}

/** Send a signed Soroban envelope and poll until SUCCESS/FAILED or the deadline. */
export async function submitSoroban(
  server: StellarRpc.Server,
  signedXdr: string,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const tx = parseSigned(signedXdr, opts.networkPassphrase);
  const hash = hashOf(tx);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const callTimeoutMs = opts.callTimeoutMs ?? NETWORK_CALL_TIMEOUT_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  const opMs = opts.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  const startedAt = now();
  const waitDeadline = startedAt + waitMs;
  const opDeadline = startedAt + opMs;

  let sent: StellarRpc.Api.SendTransactionResponse;
  try {
    sent = await withNetworkTimeout(server.sendTransaction(tx), "sendTransaction", callTimeoutMs);
  } catch (e) {
    const error = isClassifiedTimeout(e) ? timeoutClassified(e) : classifyThrown(e);
    return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
  }

  switch (sent.status) {
    case "ERROR": {
      const error = describeSendError(sent);
      return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
    }
    case "TRY_AGAIN_LATER": {
      const error: ClassifiedError = {
        kind: "rpc",
        name: "TRY_AGAIN_LATER",
        message: "the RPC node shed load and asked to retry later",
      };
      return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
    }
    case "PENDING":
    case "DUPLICATE":
      break;
  }

  for (;;) {
    let res: StellarRpc.Api.GetTransactionResponse;
    try {
      res = await withNetworkTimeout(server.getTransaction(hash), "getTransaction", callTimeoutMs);
    } catch (e) {
      const error = isClassifiedTimeout(e) ? timeoutClassified(e) : classifyThrown(e);
      return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
    }
    switch (String(res.status)) {
      case "SUCCESS": {
        const ok = res as StellarRpc.Api.GetSuccessfulTransactionResponse;
        return { hash, ledger: ok.ledger, status: "SUCCESS", resultXdrSummary: "SUCCESS" };
      }
      case "FAILED": {
        const failed = res as StellarRpc.Api.GetFailedTransactionResponse;
        const error = describeFailure(failed);
        return { hash, ledger: failed.ledger, status: "FAILED", resultXdrSummary: error.name, error };
      }
      default: {
        if (now() >= waitDeadline) {
          const error: ClassifiedError = {
            kind: "rpc",
            name: "WaitTimeout",
            message: `no final status for ${hash} within ${waitMs} ms`,
          };
          return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
        }
        if (now() >= opDeadline) {
          const error: ClassifiedError = {
            kind: "rpc",
            name: "OperationTimeout",
            message: `submitting ${hash} exceeded the operation deadline of ${opMs} ms`,
          };
          return { hash, ledger: 0, status: "FAILED", resultXdrSummary: error.name, error };
        }
        await sleep(opts.pollMs ?? DEFAULT_POLL_MS);
      }
    }
  }
}

/** Post a signed classic transaction to Horizon. */
export async function submitClassic(
  horizon: Horizon.Server,
  signedXdr: string,
  opts: SubmitOptions,
): Promise<SubmitResult> {
  const tx = parseSigned(signedXdr, opts.networkPassphrase);
  const hash = hashOf(tx);
  const callTimeoutMs = opts.callTimeoutMs ?? NETWORK_CALL_TIMEOUT_MS;
  try {
    const res = await withNetworkTimeout(horizon.submitTransaction(tx), "submitTransaction", callTimeoutMs);
    return { hash: res.hash, ledger: res.ledger, status: "SUCCESS", resultXdrSummary: "SUCCESS" };
  } catch (e) {
    const codes = horizonResultCodes(e);
    const error = isClassifiedTimeout(e)
      ? timeoutClassified(e)
      : classifyThrown(codes ? new Error(codes) : e);
    return { hash, ledger: 0, status: "FAILED", resultXdrSummary: codes ?? error.name, error };
  }
}

/**
 * Rewrite an unsigned envelope's sequence number to the account's next one.
 *
 * Approval flows build several steps up front, so every step embeds the same
 * sequence number; submitting them in order would fail `txBadSeq` after the
 * first. Resequencing right before signing (footprint/resource fee do not
 * depend on the sequence number) makes sequential submission safe.
 */
export async function resequenceEnvelope(
  unsignedXdr: string,
  networkPassphrase: string,
  source: string,
  loadAccount: (address: string) => Promise<{ sequenceNumber(): string }>,
  callTimeoutMs: number = NETWORK_CALL_TIMEOUT_MS,
): Promise<string> {
  const account = await withNetworkTimeout(loadAccount(source), "loadAccount", callTimeoutMs);
  const next = BigInt(account.sequenceNumber()) + 1n;
  return setSequence(unsignedXdr, networkPassphrase, next);
}

/**
 * Set an explicit sequence number on an unsigned envelope (used by the manual
 * tool to give each step of a multi-step flow its own sequence *before* the
 * approval card renders it, so the card shows the exact XDR that gets signed).
 */
export function setSequence(unsignedXdr: string, networkPassphrase: string, sequence: bigint): string {
  const tx = parseSigned(unsignedXdr, networkPassphrase);
  const envelope = tx.toEnvelope() as unknown as { value: { tx: { seqNum: bigint } } };
  envelope.value.tx.seqNum = sequence;
  return new Transaction(envelope as unknown as xdr.TransactionEnvelope, networkPassphrase).toXDR();
}

/** Read a transaction back from Soroban RPC (independent on-chain verification). */
export async function fetchSorobanTx(
  server: StellarRpc.Server,
  hash: string,
  callTimeoutMs: number = NETWORK_CALL_TIMEOUT_MS,
): Promise<StellarRpc.Api.GetTransactionResponse> {
  return withNetworkTimeout(server.getTransaction(hash), "getTransaction", callTimeoutMs);
}

// ── result decoding ─────────────────────────────────────────────────────────

function isClassifiedTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "NetworkTimeout" || err.name === "OperationTimeout");
}

function describeSendError(sent: StellarRpc.Api.SendTransactionResponse): ClassifiedError {
  const code = variant(field(sent.errorResult, "result"));
  if (code) return classifyTxResultCode(code);
  return { kind: "unknown", name: "SendError", message: "sendTransaction returned ERROR" };
}

/** Best-effort decode of a FAILED Soroban transaction: contract code first. */
function describeFailure(res: StellarRpc.Api.GetFailedTransactionResponse): ClassifiedError {
  const fromEvents = contractErrorFromEvents(res.diagnosticEventsXdr);
  if (fromEvents) return fromEvents;
  let name = variant(field(res.resultXdr, "result"));
  if (name === "txFailed") {
    const first = asArray(field(field(res.resultXdr, "result"), "results"))[0];
    const inner = variant(field(field(first, "tr"), "invokeHostFunctionResult"));
    if (inner) name = inner;
  }
  name ??= "TxFailed";
  return { kind: "unknown", name, message: `transaction failed: ${name}` };
}

/** Scan diagnostic events for `Error(Contract, #N)` and classify it. */
function contractErrorFromEvents(events: unknown[] | undefined): ClassifiedError | undefined {
  for (const de of events ?? []) {
    const v0 = field(field(field(de, "event"), "body"), "v0");
    const vals = [...asArray(field(v0, "topics")), field(v0, "data")];
    for (const v of vals) {
      if (variant(v) !== "scvError") continue;
      const err = field(v, "error");
      if (variant(err) === "sceContract") {
        return classifyContractText(`Error(Contract, #${String(field(err, "contractCode"))})`);
      }
    }
  }
  return undefined;
}

function horizonResultCodes(err: unknown): string | undefined {
  if (err === null || typeof err !== "object") return undefined;
  const response = field(err, "response");
  const data = field(response, "data");
  const extras = field(data, "extras");
  const codes = field(extras, "result_codes");
  if (codes === null || codes === undefined) return undefined;
  return JSON.stringify(codes);
}
