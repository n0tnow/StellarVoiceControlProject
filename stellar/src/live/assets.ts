/**
 * Throwaway asset provisioning for the live run: issuer + trustlines + mint and
 * the Stellar Asset Contract (SAC) deployment the guard actually spends through.
 *
 * Classic operations go to Horizon; the SAC deployment is a Soroban
 * `createStellarAssetContract` host call from the owner account (permissionless
 * for a classic asset, exactly as `contracts/scripts/demo.sh` does it).
 */
import {
  Asset,
  BASE_FEE,
  Contract,
  Horizon,
  Operation,
  TransactionBuilder,
  scValToNative,
  rpc as StellarRpc,
} from "@stellar/stellar-sdk";
import type { Keypair } from "@stellar/stellar-sdk";
import { submitClassic, submitSoroban } from "./submit.ts";

const { Api, assembleTransaction } = StellarRpc;

const CLASSIC_FEE = BASE_FEE;
const TIMEBOUND_SECONDS = 180;

/** Poll Horizon until a freshly funded account is visible (ingestion lag). */
export async function waitForHorizonAccount(
  horizon: Horizon.Server,
  address: string,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 15;
  const delayMs = opts.delayMs ?? 2_000;
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await horizon.loadAccount(address);
      return;
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error(`account ${address} never appeared on Horizon: ${(lastError as Error)?.message}`);
}

/** True when `address` already has `asset` in its trustline set. */
export async function accountHasTrustline(
  horizon: Horizon.Server,
  address: string,
  asset: Asset,
): Promise<boolean> {
  const account = await horizon.loadAccount(address);
  return account.balances.some(
    (b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}

/** Create the trustline if missing. Returns true when this call created it. */
export async function ensureTrustline(
  horizon: Horizon.Server,
  signer: Keypair,
  asset: Asset,
  networkPassphrase: string,
): Promise<{ created: boolean; hash?: string }> {
  if (await accountHasTrustline(horizon, signer.publicKey(), asset)) return { created: false };
  const account = await horizon.loadAccount(signer.publicKey());
  const tx = new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase })
    .addOperation(Operation.changeTrust({ asset }))
    .setTimeout(TIMEBOUND_SECONDS)
    .build();
  tx.sign(signer);
  const res = await submitClassic(horizon, tx.toXDR(), { networkPassphrase });
  if (res.status !== "SUCCESS") {
    throw new Error(`changeTrust failed for ${signer.publicKey()}: ${res.resultXdrSummary}`);
  }
  return { created: true, hash: res.hash };
}

/** Issue `amount` of `asset` from the issuer to `to`. */
export async function issueAsset(
  horizon: Horizon.Server,
  issuer: Keypair,
  to: string,
  asset: Asset,
  amount: string,
  networkPassphrase: string,
): Promise<{ hash: string; ledger: number }> {
  const account = await horizon.loadAccount(issuer.publicKey());
  const tx = new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase })
    .addOperation(Operation.payment({ destination: to, asset, amount }))
    .setTimeout(TIMEBOUND_SECONDS)
    .build();
  tx.sign(issuer);
  const res = await submitClassic(horizon, tx.toXDR(), { networkPassphrase });
  if (res.status !== "SUCCESS") {
    throw new Error(`asset payment failed: ${res.resultXdrSummary}`);
  }
  return { hash: res.hash, ledger: res.ledger };
}

/** The classic balance of `asset` held by `address` (decimal string; "0" when absent). */
export async function getAssetBalance(
  horizon: Horizon.Server,
  address: string,
  asset: Asset,
): Promise<string> {
  const account = await horizon.loadAccount(address);
  const line = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
  return line ? line.balance : "0";
}

/** The deterministic SAC contract id for a classic asset. */
export function sacContractId(asset: Asset, networkPassphrase: string): string {
  return asset.contractId(networkPassphrase);
}

export interface SacDeployResult {
  sac: string;
  deployed: boolean;
  hash?: string;
  ledger?: number;
}

/**
 * Deploy the asset's SAC if it does not exist yet (idempotent). Existence is
 * probed by simulating a read of the contract's `decimals` entry point.
 */
export async function ensureSac(
  server: StellarRpc.Server,
  deployer: Keypair,
  asset: Asset,
  networkPassphrase: string,
): Promise<SacDeployResult> {
  const sac = sacContractId(asset, networkPassphrase);
  if (await sacExists(server, sac, deployer.publicKey(), networkPassphrase)) {
    return { sac, deployed: false };
  }
  const account = await server.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase })
    .addOperation(Operation.createStellarAssetContract({ asset }))
    .setTimeout(TIMEBOUND_SECONDS)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) {
    throw new Error(`SAC deploy simulation failed: ${sim.error}`);
  }
  const assembled = assembleTransaction(tx, sim).build();
  assembled.sign(deployer);
  const res = await submitSoroban(server, assembled.toXDR(), { networkPassphrase });
  if (res.status !== "SUCCESS") {
    throw new Error(`SAC deploy failed: ${res.resultXdrSummary}`);
  }
  return { sac, deployed: true, hash: res.hash, ledger: res.ledger };
}

/** Simulate a read-only SAC call and decode its native value (S0 existence proof). */
export async function readSac(server: StellarRpc.Server, input: {
  sac: string;
  method: string;
  args: import("@stellar/stellar-sdk").xdr.ScVal[];
  source: string;
  networkPassphrase: string;
}): Promise<unknown> {
  const account = await server.getAccount(input.source);
  const tx = new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase: input.networkPassphrase })
    .addOperation(new Contract(input.sac).call(input.method, ...input.args))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (Api.isSimulationError(sim)) throw new Error(`SAC ${input.method} simulation failed: ${sim.error}`);
  const retval = sim.result?.retval;
  if (!retval) throw new Error(`SAC ${input.method} returned no value`);
  return scValToNative(retval);
}

async function sacExists(
  server: StellarRpc.Server,
  sac: string,
  source: string,
  networkPassphrase: string,
): Promise<boolean> {
  try {
    const account = await server.getAccount(source);
    const tx = new TransactionBuilder(account, { fee: CLASSIC_FEE, networkPassphrase })
      .addOperation(new Contract(sac).call("decimals"))
      .setTimeout(60)
      .build();
    const sim = await server.simulateTransaction(tx);
    return !Api.isSimulationError(sim);
  } catch {
    return false;
  }
}
