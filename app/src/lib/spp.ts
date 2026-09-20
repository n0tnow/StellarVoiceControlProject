/**
 * Stellar Private Payments (SPP) — read-only facts for the Privacy panel (W9).
 *
 * The full SPP loop is proven on testnet (spike `spike/spp`) with Nethermind's
 * deployed contracts, but the client is the **Rust SDK** and every `transact`
 * needs a Soroban auth-entry signature in addition to the envelope signature.
 * Polaris' wallet only signs an envelope (`wallet_sign`), so nothing
 * in this module moves value or signs anything: it renders the deployed contract
 * addresses, the privacy explainer and the spike's verifiable transactions, and
 * checks that the testnet RPC is reachable.
 *
 * Everything here is pure except [`loadSppStatus`], whose transport is injected
 * so the panel (and its tests) never touch the network unless asked.
 */
import { TESTNET } from "@polaris/stellar";

/** The pinned upstream commit the spike proved against; never imported as code. */
export const SPP_PINNED_COMMIT = "10ffa0ecd268582f6ef80e53ac5129a33ecf5846";

/** The public testnet contracts (from the spike's decoded deployment). */
export const SPP_CONTRACTS = {
  pool: "CCM5G4FCOV7PLKFMEJBCYM5R7JOTZVUXKWBDR3SWCW2IM2LKNNBO4TH5",
  publicKeyRegistry: "CCQ24X7RNSMWXLLVAVZ6LOI4EGXKPWXP5QWIM4NEZYYAYHWPZSUNTR2A",
  aspMembership: "CALQNKQ4ZW2O7L2LLJKLVKMXRFWLT5U77LKOI2CKLKZT7KX2YRQ5UMB3",
  aspNonMembership: "CAADTTZWMNAABQOOTGRYLPEKWGMQT746A4EF7JWMBY5TJTMUNQYB4UZ3",
  verifier: "CCHMOZQRSTWQY7I3A5J3HIASYJO7K2IU5KK2GYVGQJQ7VNQZD2PHGVI3",
  tokenXlmSac: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
} as const;

/** The ledger the pool was deployed at; used for the RPC retention estimate. */
export const SPP_DEPLOYMENT_LEDGER = 4_710_199;

/**
 * Stellar RPC prunes history after roughly this many ledgers (~7 days at 5 s);
 * older notes can only be reconstructed through a bootnode.
 */
export const SPP_RETENTION_LEDGERS = 120_960;

/** One decoded transaction from the spike, kept as verifiable evidence. */
export interface SppSpikeTx {
  step: string;
  hash: string;
  ledger: number;
  fn: string;
  /** What an observer can learn from it (never an overclaim). */
  visible: string;
}

/** The five testnet transactions the spike produced, all `SUCCESS`. */
export const SPP_SPIKE_TXS: readonly SppSpikeTx[] = [
  {
    step: "Register A",
    hash: "f79ff5576ce2e7379ab2d5a18639fc5a51bf20924d49c3e58ee5852ec511c570",
    ledger: 4_766_195,
    fn: "register",
    visible: "A's public note/encryption keys enter the registry",
  },
  {
    step: "Register B",
    hash: "67ca009286005b7e63c6c147bca95ed9b8eab275f60591251b23fcb37bac7096",
    ledger: 4_766_200,
    fn: "register",
    visible: "B's public keys enter the registry",
  },
  {
    step: "Deposit 3 XLM (A)",
    hash: "786a24d64f69776ce3f06674f4ffbd981b3be45f4eec70bc07d7fe1ebad37cb0",
    ledger: 4_766_218,
    fn: "transact",
    visible: "A and the plaintext amount are public",
  },
  {
    step: "Private transfer 1 XLM (A→B)",
    hash: "c3516008d85d1766a0430c57b3c8075f8a269031e1b9ddcc6747315d2a6eca44",
    ledger: 4_766_222,
    fn: "transact",
    visible: "only the pool, nullifiers, commitments and ciphertexts — no recipient, no amount",
  },
  {
    step: "Withdraw 1 XLM (pool→C)",
    hash: "1cf2e7aad0b368c66b62c4047f8360a5908ad6957fe8236dcd578f0d574befc2",
    ledger: 4_766_228,
    fn: "transact",
    visible: "the destination address C and the plaintext amount are public",
  },
];

/** The plain-language explainer the panel and the Debug check share. */
export const SPP_PRIVACY = {
  publicOnChain: [
    "That the shared pool was used, and which transaction paid the fee.",
    "Deposit and withdrawal amounts and their edge addresses (depositor in, destination out).",
  ],
  hiddenInPool: [
    "A private transfer hides the recipient's address and the amount.",
    "Deposits cannot be linked to withdrawals except by weak amount/timing heuristics.",
  ],
  caveats: [
    "Testnet-only, unaudited upstream developer preview — never use it with real funds.",
    "Privacy grows with the pool's anonymity set; a small pool is correlatable.",
    "Notes must be re-synced within the RPC retention window (~7 days) or via a bootnode.",
  ],
} as const;

/** Builds a stellar.expert testnet explorer link for a transaction hash. */
export function sppTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/** Builds a stellar.expert testnet explorer link for a contract id. */
export function sppContractUrl(contractId: string): string {
  return `https://stellar.expert/explorer/testnet/contract/${contractId}`;
}

/** True for a 56-char `C...` contract StrKey shape (the checksum is not checked). */
export function isContractId(value: string): boolean {
  return /^C[A-Z2-7]{55}$/.test(value);
}

/** The live facts the panel shows; injected so the summary stays pure. */
export interface SppStatusFacts {
  /** `null` when the RPC could not be reached at all. */
  latestLedger: number | null;
  /** The RPC endpoint the read was attempted against. */
  rpcUrl: string;
  deploymentLedger: number;
}

/** The panel-ready status, with a severity the panel colours by. */
export interface SppStatusSummary {
  status: "ok" | "warn" | "fail";
  detail: string;
}

/**
 * Maps the gathered RPC facts to a short status. Reachability is an `ok`; an
 * unreachable RPC is a `fail`; a deployment already pruned out of the retention
 * window is still `ok` (the panel only reads current state) but says so.
 */
export function summarizeSppStatus(facts: SppStatusFacts): SppStatusSummary {
  if (facts.latestLedger === null) {
    return {
      status: "fail",
      detail: `The testnet RPC is unreachable at ${facts.rpcUrl}; pool state cannot be read.`,
    };
  }
  const behind = facts.latestLedger - facts.deploymentLedger;
  if (behind > SPP_RETENTION_LEDGERS) {
    return {
      status: "ok",
      detail: `RPC reachable at ledger ${facts.latestLedger}; the SPP deployment is beyond the ~7-day retention window, so notes need a bootnode.`,
    };
  }
  return {
    status: "ok",
    detail: `RPC reachable at ledger ${facts.latestLedger}; the SPP deployment is inside the ~7-day retention window.`,
  };
}

/** The injected transport for the live read. */
export interface SppStatusDeps {
  fetchJson?: (url: string, body: unknown) => Promise<unknown>;
}

/** Default transport: a JSON-RPC POST with the shared testnet RPC. */
async function postJson(url: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`RPC returned HTTP ${response.status}`);
  return response.json();
}

/**
 * Reads the latest testnet ledger from the RPC's `getLatestLedger`. Returns
 * `null` for the ledger when the call fails, so the panel degrades to a `fail`
 * status instead of throwing.
 */
export async function loadSppStatus(
  deps: SppStatusDeps = {},
): Promise<SppStatusFacts> {
  const fetchJson = deps.fetchJson ?? postJson;
  const rpcUrl = TESTNET.rpcUrl;
  try {
    const body = await fetchJson(rpcUrl, {
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
    });
    const sequence = (body as { result?: { sequence?: unknown } } | null)?.result?.sequence;
    const latestLedger = typeof sequence === "number" ? sequence : null;
    return { latestLedger, rpcUrl, deploymentLedger: SPP_DEPLOYMENT_LEDGER };
  } catch {
    return { latestLedger: null, rpcUrl, deploymentLedger: SPP_DEPLOYMENT_LEDGER };
  }
}
