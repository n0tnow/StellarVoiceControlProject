/**
 * Chain access for the keeper: a small port (`KeeperChain`) plus the real
 * Soroban implementation (`SorobanChain`).
 *
 * The keeper loop only talks to `KeeperChain`, which keeps it trivially
 * testable. `SorobanChain` is itself tested against a fake of the four RPC
 * methods it uses (`RpcLike`).
 *
 * Invocation flow per `execute_schedule(id)` (docs: simulateTransaction guide,
 * "Handling archived ledger entries", SDK `assembleTransaction`):
 *   getAccount -> build -> simulate -> (restore archived entries if asked)
 *   -> refuse non-source auth -> assemble (footprint/auth/fee) -> fee cap
 *   -> sign -> sendTransaction -> poll getTransaction to a final status.
 */
import {
  BASE_FEE,
  Contract,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc as StellarRpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { Keypair, Transaction } from "@stellar/stellar-sdk";
import {
  classifyContractText,
  classifyThrown,
  classifyTxResultCode,
  type ClassifiedError,
} from "./errors.ts";
import { asArray, field, variant } from "./xdr-compat.ts";

const { Api, assembleTransaction } = StellarRpc;

/** The subset of `rpc.Server` the keeper uses; lets tests inject a fake. */
export type RpcLike = Pick<
  StellarRpc.Server,
  "getAccount" | "simulateTransaction" | "sendTransaction" | "getTransaction"
>;

/** `Schedule` as returned by `guard.get_schedule(id)`. */
export interface Schedule {
  id: number;
  owner: string;
  to: string;
  asset: string;
  amount: bigint;
  next_run_at: bigint;
  interval_secs: bigint;
  runs_left: number;
  active: boolean;
}

export type ExecResult =
  /** Included in a ledger and succeeded. */
  | { kind: "success"; hash: string; ledger: number }
  /** Included in a ledger but failed (fee was charged). */
  | { kind: "failed"; hash: string; error: ClassifiedError }
  /** Refused before inclusion (simulation error, network reject, local guard). */
  | { kind: "rejected"; error: ClassifiedError; hash?: string }
  /** Submitted, final status still unknown; check again with `checkPending`. */
  | { kind: "pending"; hash: string; expiresAt: number }
  /**
   * A `RestoreFootprint` was submitted but has no final status yet. Distinct
   * from `pending` on purpose: the schedule has NOT run, so a later SUCCESS
   * resolves to "entries restored", never to a false `executed` (the keeper
   * re-executes the schedule instead).
   */
  | { kind: "restore_pending"; hash: string; expiresAt: number }
  /** Dry run: the simulation succeeded, nothing was signed or sent. */
  | { kind: "dry_run"; note?: string };

/** One page of due schedule ids. `nextCursor === null` means "no more pages". */
export interface DuePage {
  ids: number[];
  nextCursor: number | null;
}

export interface KeeperChain {
  /**
   * One page of ids of schedules due at the current ledger time (at most
   * `limit`), starting at `cursor` (0 for the first page). The keeper loops
   * over pages, bounded; the contract-specific paging ABI is decoded here and
   * nowhere else (see `SorobanChain.listDue`).
   */
  listDue(cursor: number, limit: number): Promise<DuePage>;
  /** Full schedule record for logs and dry runs; `null` when the id does not exist. */
  getSchedule(id: number): Promise<Schedule | null>;
  /** Run one occurrence of the schedule. Throws only on transport errors. */
  execute(id: number, opts: { dryRun: boolean }): Promise<ExecResult>;
  /** Re-check a previously submitted, unresolved transaction. */
  checkPending(hash: string, expiresAt: number): Promise<ExecResult>;
}

export interface SorobanChainOptions {
  contractId: string;
  keypair: Keypair;
  networkPassphrase: string;
  /** Transaction validity window in seconds. */
  txTimeoutSeconds: number;
  /** Refuse to sign above this fee (stroops). */
  maxFeeStroops: number;
  /** getTransaction poll interval. */
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Grace after a transaction's max time before NOT_FOUND is treated as dead. */
const EXPIRY_SLACK_MS = 15_000;

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class SorobanChain implements KeeperChain {
  private readonly contract: Contract;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly rpc: RpcLike;
  private readonly opts: SorobanChainOptions;

  constructor(rpc: RpcLike, opts: SorobanChainOptions) {
    this.rpc = rpc;
    this.opts = opts;
    this.contract = new Contract(opts.contractId);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? realSleep;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /**
   * THE ONLY place that knows the `list_due` ABI.
   *
   * Current guard: `list_due(cursor: u32, limit: u32) -> (Vec<u32>, u32)`.
   * The scan examines at most `limit` ids starting at `cursor` (the contract
   * clamps to its own MAX_DUE_SCAN) and returns `(due_ids, next_cursor)`.
   * `next_cursor` is the id to pass next, or `0` once the scan reached the end
   * of the id space — mapped here to `nextCursor: null`, the port's only
   * end-of-pages signal (a cursor never equals a schedule id, so `0` is
   * unambiguous on the contract side; the keeper loop just follows it).
   */
  async listDue(cursor: number, limit: number): Promise<DuePage> {
    const value = await this.readCall(
      "list_due",
      nativeToScVal(cursor, { type: "u32" }),
      nativeToScVal(limit, { type: "u32" }),
    );
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error("list_due returned a malformed page (expected (Vec<u32>, u32))");
    }
    const [ids, next] = value as [unknown, unknown];
    if (!Array.isArray(ids)) throw new Error("list_due returned a non-array id vector");
    const nextCursor = Number(next);
    if (!Number.isInteger(nextCursor) || nextCursor < 0) {
      throw new Error(`list_due returned a malformed next cursor: ${String(next)}`);
    }
    return { ids: ids.map((v) => Number(v)), nextCursor: nextCursor === 0 ? null : nextCursor };
  }

  /** `get_schedule` returns `Option<Schedule>`: void (None) decodes to null. */
  async getSchedule(id: number): Promise<Schedule | null> {
    const value = await this.readCall("get_schedule", nativeToScVal(id, { type: "u32" }));
    return value === null || value === undefined ? null : (value as Schedule);
  }

  /** Simulate a read-only call from the keeper account and decode the return value. */
  private async readCall(method: string, ...args: xdr.ScVal[]): Promise<unknown> {
    const account = await this.rpc.getAccount(this.opts.keypair.publicKey());
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(this.opts.txTimeoutSeconds)
      .build();
    const sim = await this.rpc.simulateTransaction(tx);
    if (Api.isSimulationError(sim)) {
      // A failed read is not a "keeper" problem we can classify per id; surface as thrown text.
      throw new Error(`${method} simulation failed: ${sim.error}`);
    }
    const retval = sim.result?.retval;
    if (!retval) throw new Error(`${method} simulation returned no value`);
    return scValToNative(retval);
  }

  // ── write ────────────────────────────────────────────────────────────────

  async execute(id: number, opts: { dryRun: boolean }): Promise<ExecResult> {
    let tx = await this.buildExecuteTx(id);
    let sim = await this.rpc.simulateTransaction(tx);

    // Archived ledger entries: restore first (RestoreFootprint), then re-simulate.
    if (Api.isSimulationRestore(sim)) {
      if (opts.dryRun) return { kind: "dry_run", note: "would restore archived entries first" };
      const restored = await this.restore(sim.restorePreamble);
      // A pending restore is not a pending execution: report it separately so a
      // later SUCCESS is never logged as `executed` (the schedule still has to run).
      if (restored.kind === "pending") {
        return { kind: "restore_pending", hash: restored.hash, expiresAt: restored.expiresAt };
      }
      if (restored.kind !== "success") return restored;
      tx = await this.buildExecuteTx(id);
      sim = await this.rpc.simulateTransaction(tx);
    }

    if (Api.isSimulationError(sim)) {
      return { kind: "rejected", error: classifyContractText(sim.error) };
    }

    // The keeper only ever signs as the transaction source. If the contract
    // wants a signature from any other address, this call cannot succeed here
    // (and must not be papered over): refuse instead of burning fees.
    const foreign = (sim.result?.auth ?? []).some(
      (a) => variant(field(a, "credentials")) !== "sorobanCredentialsSourceAccount",
    );
    if (foreign) {
      return {
        kind: "rejected",
        error: {
          kind: "auth_required",
          name: "AuthRequired",
          message: "simulation requires authorization from an address other than the keeper",
        },
      };
    }

    const assembled = assembleTransaction(tx, sim).build();
    if (this.feeAboveCap(assembled)) {
      return { kind: "rejected", error: feeAboveCapError(assembled.fee, this.opts.maxFeeStroops) };
    }

    if (opts.dryRun) return { kind: "dry_run" };

    assembled.sign(this.opts.keypair);
    return this.submitAndWait(assembled);
  }

  private async buildExecuteTx(id: number): Promise<Transaction> {
    // Fresh account every time: the sequence number always comes from the
    // network, never from local state, so restarts and retries are safe.
    const account = await this.rpc.getAccount(this.opts.keypair.publicKey());
    return new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.opts.networkPassphrase,
    })
      .addOperation(this.contract.call("execute_schedule", nativeToScVal(id, { type: "u32" })))
      .setTimeout(this.opts.txTimeoutSeconds)
      .build();
  }

  private async restore(preamble: StellarRpc.Api.SimulateTransactionRestoreResponse["restorePreamble"]): Promise<ExecResult> {
    const account = await this.rpc.getAccount(this.opts.keypair.publicKey());
    // build() adds the resource fee carried by `transactionData` on top of this
    // inclusion fee, so the fee here is just the base fee (no double counting).
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: this.opts.networkPassphrase })
      .setSorobanData(preamble.transactionData.build())
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(this.opts.txTimeoutSeconds)
      .build();
    // `preamble.transactionData` (and thus its resourceFee) is RPC-supplied and
    // attacker-controllable. Enforce the same total-fee cap as the execute path
    // BEFORE signing, or the keeper could be tricked into paying an unbounded fee.
    if (this.feeAboveCap(tx)) {
      return { kind: "rejected", error: feeAboveCapError(tx.fee, this.opts.maxFeeStroops) };
    }
    tx.sign(this.opts.keypair);
    return this.submitAndWait(tx);
  }

  /** The total fee a signed envelope will pay, including any resource fee (exact integer compare). */
  private feeAboveCap(tx: Transaction): boolean {
    return BigInt(tx.fee) > BigInt(this.opts.maxFeeStroops);
  }

  /** sendTransaction, then poll getTransaction until a final status or the deadline. */
  private async submitAndWait(tx: Transaction): Promise<ExecResult> {
    // The hash is a pure function of the signed envelope, so we know it before
    // sending and can never lose track of a transaction, even if the send call
    // itself fails ambiguously (network drop after the node accepted it).
    const hash = Buffer.from(tx.hash()).toString("hex");
    const maxTimeSec = Number(tx.timeBounds?.maxTime ?? 0);
    const expiresAt = maxTimeSec > 0 ? maxTimeSec * 1000 : this.now() + this.opts.txTimeoutSeconds * 1000;

    let sent: StellarRpc.Api.SendTransactionResponse;
    try {
      sent = await this.rpc.sendTransaction(tx);
    } catch {
      return { kind: "pending", hash, expiresAt };
    }
    switch (sent.status) {
      case "ERROR":
        return { kind: "rejected", hash, error: describeSendError(sent) };
      case "TRY_AGAIN_LATER":
        // Node is shedding load: nothing was accepted, retry later.
        return { kind: "rejected", hash, error: { kind: "rpc", name: "TRY_AGAIN_LATER", message: "node asked to try again later" } };
      case "PENDING":
      case "DUPLICATE":
        break;
    }

    // Wait until a final status. `checkPending` turns NOT_FOUND into a definitive
    // "expired" once the validity window (+ slack) is over, so this terminates.
    for (;;) {
      let res: ExecResult;
      try {
        res = await this.checkPending(hash, expiresAt);
      } catch {
        // The tx is already submitted: never lose its hash to a polling error.
        // Hand it back as pending so the keeper resolves it on a later tick.
        return { kind: "pending", hash, expiresAt };
      }
      if (res.kind !== "pending") return res;
      await this.sleep(this.opts.pollIntervalMs);
    }
  }

  async checkPending(hash: string, expiresAt: number): Promise<ExecResult> {
    const res = await this.rpc.getTransaction(hash);
    switch (String(res.status)) {
      case "SUCCESS":
        return { kind: "success", hash, ledger: "ledger" in res ? res.ledger : 0 };
      case "FAILED":
        return { kind: "failed", hash, error: describeFailure(res as StellarRpc.Api.GetFailedTransactionResponse) };
      default:
        // NOT_FOUND: still in the mempool, or dead if its validity window is long gone.
        if (this.now() >= expiresAt + EXPIRY_SLACK_MS) {
          return {
            kind: "rejected",
            hash,
            error: { kind: "tx_expired", name: "txTooLate", message: "transaction never landed before its max time" },
          };
        }
        return { kind: "pending", hash, expiresAt };
    }
  }
}

// ── result decoding helpers ─────────────────────────────────────────────────

function feeAboveCapError(fee: string, cap: number): ClassifiedError {
  return {
    kind: "keeper_funds",
    name: "FeeAboveCap",
    message: `fee ${fee} stroops exceeds KEEPER_MAX_FEE_STROOPS=${cap}`,
  };
}

function describeSendError(sent: StellarRpc.Api.SendTransactionResponse): ClassifiedError {
  const code = variant(field(sent.errorResult, "result"));
  if (code) return classifyTxResultCode(code);
  return { kind: "unknown", name: "SendError", message: "sendTransaction returned ERROR" };
}

/** Best-effort decode of a FAILED transaction: contract error code first, then result codes. */
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

/** Scan diagnostic events for a `Error(Contract, #N)` value and classify it. */
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

/** Re-exported so callers can classify raw thrown errors without importing errors.ts. */
export { classifyThrown };
