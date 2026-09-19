/**
 * Shared "build + simulate" plumbing for the guard client and the SAC
 * allowance helper. Mirrors the keeper's `SorobanChain` invocation flow:
 * `getAccount -> build -> simulate -> assemble`, but stops before signing or
 * submitting (these are UNSIGNED calls for the approval card).
 */
import { BASE_FEE, Contract, TransactionBuilder, rpc as StellarRpc, scValToNative } from "@stellar/stellar-sdk";
import type { Transaction, xdr } from "@stellar/stellar-sdk";
import type { GuardRpcLike } from "./types.ts";
import { GuardClientError, classifyGuardText } from "./errors.ts";

const { Api, assembleTransaction } = StellarRpc;

/** Default transaction validity window (seconds). */
export const DEFAULT_TX_TIMEOUT_SECONDS = 300;

export interface InvokeOptions {
  contractId: string;
  method: string;
  args: xdr.ScVal[];
  /** Transaction source; for writes this is also the address that must sign. */
  source: string;
  networkPassphrase: string;
  txTimeoutSeconds?: number;
}

function buildTransaction(opts: InvokeOptions, account: Awaited<ReturnType<GuardRpcLike["getAccount"]>>): Transaction {
  const contract = new Contract(opts.contractId);
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: opts.networkPassphrase,
  })
    .addOperation(contract.call(opts.method, ...opts.args))
    .setTimeout(opts.txTimeoutSeconds ?? DEFAULT_TX_TIMEOUT_SECONDS)
    .build();
}

/** Build, simulate and assemble an unsigned write invocation. */
export async function buildUnsignedInvoke(
  rpc: GuardRpcLike,
  opts: InvokeOptions,
): Promise<{ tx: Transaction; unsignedXdr: string }> {
  const account = await rpc.getAccount(opts.source);
  const tx = buildTransaction(opts, account);
  const sim = await rpc.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) throw classifyGuardText(sim.error);
  const assembled = assembleTransaction(tx, sim).build();
  return { tx: assembled, unsignedXdr: assembled.toXDR() };
}

/** Simulate a read-only invocation and decode its return value. */
export async function simulateReadValue(rpc: GuardRpcLike, opts: InvokeOptions): Promise<unknown> {
  const account = await rpc.getAccount(opts.source);
  const tx = buildTransaction(opts, account);
  const sim = await rpc.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) throw classifyGuardText(sim.error);
  const retval = sim.result?.retval;
  if (!retval) {
    throw new GuardClientError({
      name: "NoReturnValue",
      kind: "unknown_contract",
      message: `${opts.method} simulation returned no value`,
    });
  }
  return scValToNative(retval);
}
