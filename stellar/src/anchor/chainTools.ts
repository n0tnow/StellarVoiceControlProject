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
import type { ChainTool, ChainToolResult, Intent } from "@polaris/interfaces";
import { assertAmount } from "./amount.ts";
import { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "./config.ts";
import { assertSameTransaction, describeXdr } from "./describe.ts";
import { ExplainLog } from "./explain.ts";
import { explorerTxUrl, submitEnvelope } from "./horizon.ts";
import { displayAsset } from "./sep38.ts";
import { AnchorSession, type AnchorSessionConfig } from "./session.ts";
import type { AnchorContext } from "./types.ts";

// The narration event the anchor emits for the UI/TTS stream is a structural copy
// of the `anchor_step` member PR #8 adds to `PolarisEvent`; see `explain.ts`.

/**
 * Structural copy of the intent kinds this package handles. PR #8 adds
 * `"withdraw"` (and more) to `IntentKind` in @polaris/interfaces.
 * TODO: replace with `Intent` from @polaris/interfaces once #8 has merged.
 */
export type AnchorIntentKind = Intent["kind"] | "withdraw";
export type AnchorIntent = Omit<Intent, "kind"> & { kind: AnchorIntentKind };

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

/** Human-readable lines decoded FROM the XDR (never from LLM text). Re-exported from `describe.ts`. */
export { describeXdr };

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

/**
 * `ChainTool` for "cash out": amount is the ON-CHAIN asset amount (USDC) to
 * withdraw to the user's bank. Creates the anchor order, then returns the
 * unsigned on-chain payment the user must approve (decoded summary includes the
 * destination, memo, amount and the asset CODE + ISSUER). After the shell signs
 * it, submit with `submitSignedTx(signedXdr, unsignedXdr)` — passing the expected
 * XDR back enables the hash check (N9) — then poll with the session.
 */
export const withdrawTry = async (intent: AnchorIntent): Promise<ChainToolResult> => {
  if (intent.kind !== "withdraw") throw new Error(`withdrawTry expects a "withdraw" intent, got "${intent.kind}"`);
  assertAmount(intent.amount, "withdraw amount");
  const session = getAnchorSession();
  const quote = (await session.quoteWithdraw(intent.amount)).data;
  await session.startWithdraw(intent.amount); // binds destination + memo to this session
  const prep = (await session.prepareWithdrawal(intent.amount)).data;
  const sold = displayAsset(quote.sellAsset);
  const bought = displayAsset(quote.buyAsset);
  return {
    unsignedXdr: prep.xdr,
    summary: {
      ...prep.summary,
      lines: [
        `Cash out ${quote.sellAmount} ${sold} at ${session.homeDomain}; the anchor pays about ${quote.buyAmount} ${bought} to your bank.`,
        ...prep.summary.lines,
      ],
    },
  };
};

export interface SubmitResult {
  hash: string;
  explorerUrl: string;
}

/**
 * Submits a signed envelope to Stellar. NOT for SEP-10 challenges: those go to
 * the anchor through `AnchorSession.finishLogin` (a sequence-0 envelope is
 * refused here with that message). Pass the unsigned XDR the shell signed as
 * `expectedXdr` to have the returned hash compared before anything is submitted.
 */
export async function submitSignedTx(signedXdr: string, expectedXdr?: string): Promise<SubmitResult> {
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
  if (tx instanceof Transaction && tx.sequence === "0") {
    throw new Error("this is a SEP-10 login challenge (sequence 0); send it to AnchorSession.finishLogin(), not to the network");
  }
  if (expectedXdr) assertSameTransaction(expectedXdr, signedXdr, ctx.networkPassphrase);
  const out = await submitEnvelope(ctx, signedXdr);
  ctx.explain.record(
    "submit",
    `Submitted the signed transaction to the Stellar network; it is final in ledger ${out.ledger ?? "?"} (hash ${out.hash.slice(0, 8)}...).`,
    "Only after your approval and signature does anything reach the blockchain.",
  );
  return { hash: out.hash, explorerUrl: explorerTxUrl(out.hash, ctx.networkPassphrase) };
}
