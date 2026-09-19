/**
 * Bridges the anchor client to the fixed `ChainTool` / `submitSignedTx` contract
 * from docs/interfaces.md. The anchor flow is multi-step, so the tool returns
 * the FIRST value-relevant thing the user must approve, and the agent then drives
 * the rest through `AnchorSession` step methods:
 *
 *   depositTry(intent)  ->  unsigned XDR + summary of either
 *        (a) the USDC trustline (changeTrust) if the account still needs it, or
 *        (b) the SEP-10 login challenge (proves key ownership; moves no funds),
 *      with the SEP-38 quote and the plan in `summary.lines`.
 *   -> after signing: (a) submitSignedTx(xdr), then call depositTry again;
 *                     (b) session.finishLogin(signedXdr), then session.startDeposit(...).
 *
 * See the report / README for the recommended `@polaris/interfaces` extension.
 */
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ChainTool, ChainToolResult } from "@polaris/interfaces";
import { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "./config.ts";
import { ExplainLog } from "./explain.ts";
import { explorerTxUrl, submitEnvelope } from "./horizon.ts";
import { displayAsset } from "./sep38.ts";
import { AnchorSession, assertAmount, type AnchorSessionConfig } from "./session.ts";
import type { AnchorContext } from "./types.ts";

let active: AnchorSession | undefined;

/** Installs the session the chain tools use (call once at app start with the real Signer). */
export function configureAnchor(sessionOrConfig: AnchorSession | AnchorSessionConfig): AnchorSession {
  active = sessionOrConfig instanceof AnchorSession ? sessionOrConfig : new AnchorSession(sessionOrConfig);
  return active;
}

export function getAnchorSession(): AnchorSession {
  if (!active) throw new Error("anchor is not configured: call configureAnchor({ signer }) first");
  return active;
}

/** Human-readable lines decoded FROM the XDR (never from LLM text). */
export function describeXdr(xdr: string, networkPassphrase: string): { lines: string[]; feeXlm: string } {
  const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  if (!(tx instanceof Transaction)) throw new Error("fee-bump envelopes are not supported here");
  const lines = tx.operations.map((op) => describeOperation(op));
  if (tx.memo.type !== "none") lines.push(`Memo (${tx.memo.type}): ${String(tx.memo.value)}`);
  return { lines, feeXlm: (Number(tx.fee) / 1e7).toFixed(7) };
}

type Op = Transaction["operations"][number];

function describeOperation(op: Op): string {
  switch (op.type) {
    case "changeTrust":
      return `Trust asset ${op.line && "code" in op.line ? op.line.code : "?"} (opt in to hold it)`;
    case "payment":
      return `Pay ${op.amount} ${op.asset.code} to ${op.destination}`;
    case "manageData":
      return `Login proof entry "${op.name}" (authentication only; this transaction is never submitted to the network)`;
    default:
      return `Operation: ${op.type}`;
  }
}

/**
 * `ChainTool` for "deposit lira": amount is the LOCAL-currency amount (TRY).
 * `intent.asset` may be the fiat code ("TRY") or the target token ("USDC").
 */
export const depositTry: ChainTool = async (intent): Promise<ChainToolResult> => {
  if (intent.kind !== "deposit") throw new Error(`depositTry expects a "deposit" intent, got "${intent.kind}"`);
  assertAmount(intent.amount, "deposit amount");
  const session = getAnchorSession();
  const passphrase = session.ctx.networkPassphrase;

  const quote = (await session.quoteDeposit(intent.amount)).data;
  const state = (await session.inspect()).data;
  const target = displayAsset(quote.buyAsset);
  const plan = [
    `Deposit ${quote.sellAmount} ${displayAsset(quote.sellAsset)} by bank transfer to the anchor (${session.homeDomain}).`,
    `Estimated result: about ${quote.buyAmount} ${target}${quote.feeTotal ? ` (anchor fee ${quote.feeTotal} ${displayAsset(quote.feeAsset ?? quote.sellAsset)})` : ""}.`,
  ];

  const trust = state.exists && !state.hasTrustline ? (await session.buildTrustline()).data : undefined;
  if (trust) {
    const d = describeXdr(trust.xdr, passphrase);
    return {
      unsignedXdr: trust.xdr,
      summary: {
        title: `Allow ${target} on your account (needed before the deposit)`,
        lines: [...plan, ...d.lines, "Without this the anchor would hold the deposit in pending_trust."],
        estimatedFee: `${d.feeXlm} XLM`,
      },
    };
  }
  const { challengeXdr } = (await session.beginLogin()).data;
  const d = describeXdr(challengeXdr, passphrase);
  return {
    unsignedXdr: challengeXdr,
    summary: {
      title: `Sign in to ${session.homeDomain} to start the deposit`,
      lines: [
        ...plan,
        ...d.lines,
        ...(state.exists ? [] : ["Your account does not exist on the network yet; it must be funded first (testnet: Friendbot)."]),
      ],
      estimatedFee: "0 XLM (authentication only, never submitted)",
    },
  };
};

export interface SubmitResult {
  hash: string;
  explorerUrl: string;
}

/**
 * Submits a signed envelope to Stellar. NOT for SEP-10 challenges: those go to
 * the anchor through `AnchorSession.finishLogin`.
 */
export async function submitSignedTx(signedXdr: string): Promise<SubmitResult> {
  const ctx: AnchorContext = active?.ctx ?? {
    fetch: (input, init) => fetch(input, init),
    explain: new ExplainLog(),
    horizonUrl: TESTNET_HORIZON_URL,
    friendbotUrl: TESTNET_FRIENDBOT_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => new Date(),
    requestTimeoutMs: 20_000,
  };
  const tx = TransactionBuilder.fromXDR(signedXdr, ctx.networkPassphrase);
  if (tx.signatures.length === 0) throw new Error("refusing to submit an unsigned transaction");
  const out = await submitEnvelope(ctx, signedXdr);
  ctx.explain.record(
    "submit",
    `Submitted the signed transaction to the Stellar network; it is final in ledger ${out.ledger ?? "?"} (hash ${out.hash.slice(0, 8)}...).`,
    "Only after your approval and signature does anything reach the blockchain.",
  );
  return { hash: out.hash, explorerUrl: explorerTxUrl(out.hash, ctx.networkPassphrase) };
}
