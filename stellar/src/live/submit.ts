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
  const deadline = now() + (opts.waitMs ?? DEFAULT_WAIT_MS);

  let sent: StellarRpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(tx);
  } catch (e) {
    return { hash, ledger: 0, status: "FAILED", resultXdrSummary: "send failed", error: classifyThrown(e) };
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
    const res = await server.getTransaction(hash);
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
        if (now() >= deadline) {
          const error: ClassifiedError = {
            kind: "rpc",
            name: "WaitTimeout",
            message: `no final status for ${hash} within ${opts.waitMs ?? DEFAULT_WAIT_MS} ms`,
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
  try {
    const res = await horizon.submitTransaction(tx);
    return { hash: res.hash, ledger: res.ledger, status: "SUCCESS", resultXdrSummary: "SUCCESS" };
  } catch (e) {
    const codes = horizonResultCodes(e);
    const error = classifyThrown(codes ? new Error(codes) : e);
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
): Promise<string> {
  const tx = parseSigned(unsignedXdr, networkPassphrase);
  const account = await loadAccount(source);
  const next = BigInt(account.sequenceNumber()) + 1n;
  const envelope = tx.toEnvelope() as unknown as { value: { tx: { seqNum: bigint } } };
  envelope.value.tx.seqNum = next;
  return new Transaction(envelope as unknown as xdr.TransactionEnvelope, networkPassphrase).toXDR();
}

/** Read a transaction back from Soroban RPC (independent on-chain verification). */
export async function fetchSorobanTx(
  server: StellarRpc.Server,
  hash: string,
): Promise<StellarRpc.Api.GetTransactionResponse> {
  return server.getTransaction(hash);
}

// ── result decoding ─────────────────────────────────────────────────────────

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
