/**
 * The shared "approve → Touch ID → sign → submit" pipeline for the notch pages (W0d).
 *
 * The voice payment path (`@/lib/chain.ts`) drives one intent through the seam
 * and then `signAndSubmit`. The notch pages (Rules, Tasks, Trade) already
 * build unsigned transactions with the `@polaris/stellar` builders and must push
 * them through the *same* approval pipeline — the Touch ID gate, then the
 * wallet signing, then Horizon. This module factors that path out once so a
 * page never re-implements it (and never gets it subtly wrong).
 *
 * It composes, and never re-implements, the real seams:
 * - `xdrDigest` (`@polaris/agent`) computes the digest exactly as `executeIntent`
 *   does, so the card and the gate bind the same blob.
 * - the Touch ID approver (`createTouchIdApprover`) registers the request and is
 *   fail-closed — a deny, expiry, timeout or throw is never an approval.
 * - `signAndSubmit` releases the approved XDR to the wallet and
 *   submits it, returning a labelled outcome instead of throwing.
 *
 * `runTx` never throws: every path resolves to a discriminated `TxRunOutcome`,
 * so a panel button can render a short label and settle. `runTxSequence` runs a
 * list of steps strictly in order and stops at the first non-submitted outcome.
 *
 * No secret ever reaches this module: it handles only the digest, the unsigned
 * XDR (already public to the approval card) and the gate-assigned approval id.
 */
import { xdrDigest, type ApprovalDecision, type ExecutionOutcome, type IntentApprover } from "@polaris/agent";
import type { ChainToolResult, Intent } from "@polaris/interfaces";

import type { SubmittedOutcome } from "@/lib/signing";

/** What one `runTx` call is about: the intent and a short UI label. */
export interface TxRunMeta {
  intent: Intent;
  /** Short label for the UI and progress; defaults to the summary title. */
  label?: string;
}

/**
 * The terminal result of the pipeline. It is always returned, never thrown.
 * `label` identifies the transaction (`meta.label`, or the summary title); the
 * `detail` on a non-submitted outcome is the human-readable failure reason. `atMs`
 * is the injected clock's value when the outcome settled, so a panel can order
 * results deterministically.
 */
export type TxRunOutcome =
  | { status: "submitted"; txHash: string; explorerUrl: string; atMs: number }
  | { status: "denied"; label: string; detail: string; atMs: number }
  | { status: "failed"; label: string; detail: string; atMs: number };

/**
 * The injected seams. Tests pass fakes; `runTx` fills any missing piece from the
 * real shell lazily (same pattern as `@/lib/chain.ts`), so a panel that never
 * runs a transaction pays for neither the approver nor the wallet.
 */
export interface TxPipelineDeps {
  approver: IntentApprover;
  /** Signs and submits an approved outcome; production default is `signAndSubmit`. */
  sign: (outcome: ExecutionOutcome) => Promise<SubmittedOutcome>;
  /** Injectable clock; outcome timestamps come from here so tests are deterministic. */
  now: () => number;
  /**
   * Gives a step's transaction its source account's **current** next sequence
   * number before it is approved, returning a result whose summary reflects the
   * resequenced XDR (the tx hash, and therefore the explorer link, changes).
   * Production default parses the source, loads it over Soroban RPC and reuses
   * `resequenceEnvelope` from `@polaris/stellar`; tests inject a fake.
   */
  resequence: (result: ChainToolResult) => Promise<ChainToolResult>;
}

/**
 * Builds the production seams. The imports are dynamic for the same reason as
 * `chain.ts`: the approval card and the chain SDK are not loaded until a panel
 * actually runs a transaction.
 */
let defaultsPromise: Promise<TxPipelineDeps> | undefined;

function defaultTxDeps(): Promise<TxPipelineDeps> {
  defaultsPromise ??= (async () => {
    const [{ createTouchIdApprover, defaultApproverDeps }, { defaultSigningDeps, signAndSubmit }] =
      await Promise.all([import("@/lib/approver"), import("@/lib/signing")]);
    const approver = createTouchIdApprover(await defaultApproverDeps());
    return {
      approver,
      sign: (outcome) => signAndSubmit(outcome, defaultSigningDeps),
      now: () => Date.now(),
      resequence: defaultResequence,
    };
  })();
  return defaultsPromise;
}

/** Point an explorer link at a new tx hash (resequencing changes the hash). */
function rewriteExplorerUrl(url: string | undefined, hash: string): string | undefined {
  if (!url) return undefined;
  const marker = "/tx/";
  const at = url.lastIndexOf(marker);
  return at >= 0 ? `${url.slice(0, at + marker.length)}${hash}` : url;
}

/**
 * The production resequencer: load each step's source over Soroban RPC and reuse
 * `resequenceEnvelope` so a multi-step plan submits as `base+n`. The summary's
 * explorer link is recomputed from the resequenced XDR's real tx hash; every
 * other summary field is sequence-independent and kept verbatim.
 */
async function defaultResequence(result: ChainToolResult): Promise<ChainToolResult> {
  const [{ getStellarConfig }, sdk, stellar] = await Promise.all([
    import("@/lib/stellarConfig"),
    import("@stellar/stellar-sdk"),
    import("@polaris/stellar"),
  ]);
  const config = await getStellarConfig();
  const tx = sdk.TransactionBuilder.fromXDR(result.unsignedXdr, config.networkPassphrase);
  if (!(tx instanceof sdk.Transaction)) throw new Error("fee-bump envelopes are not supported");
  const server = new sdk.rpc.Server(config.rpcUrl);
  const unsignedXdr = await stellar.resequenceEnvelope(
    result.unsignedXdr,
    config.networkPassphrase,
    tx.source,
    (address) => server.getAccount(address),
  );
  const fresh = sdk.TransactionBuilder.fromXDR(unsignedXdr, config.networkPassphrase);
  const explorerUrl = rewriteExplorerUrl(result.summary.explorerUrl, stellar.guard.toHex(fresh.hash()));
  return { unsignedXdr, summary: { ...result.summary, ...(explorerUrl ? { explorerUrl } : {}) } };
}

/** Merges the injected fakes over the lazily built real seams. */
async function resolveDeps(deps?: Partial<TxPipelineDeps>): Promise<TxPipelineDeps> {
  if (deps?.approver && deps.sign && deps.now && deps.resequence) {
    return { approver: deps.approver, sign: deps.sign, now: deps.now, resequence: deps.resequence };
  }
  return { ...(await defaultTxDeps()), ...deps };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The body of one run once the seams are resolved. */
async function runWith(
  result: ChainToolResult,
  meta: TxRunMeta,
  deps: TxPipelineDeps,
): Promise<TxRunOutcome> {
  const label = meta.label ?? result.summary.title;

  // Hash exactly as the seam does, so the gate stores the same digest the card
  // showed and signs only this blob.
  const payloadHash = xdrDigest(result.unsignedXdr);
  const request = {
    intent: meta.intent,
    summary: result.summary,
    payloadHash,
    unsignedXdr: result.unsignedXdr,
  };

  let decision: ApprovalDecision;
  try {
    decision = await deps.approver.approve(request);
  } catch (error) {
    // A biometric error/cancel must not escape as a rejection.
    return {
      status: "failed",
      label,
      detail: `Approval error: ${detailOf(error)}`,
      atMs: deps.now(),
    };
  }

  if (decision.approved !== true) {
    return {
      status: "denied",
      label,
      detail: decision.reason ?? "the approval gate denied the request",
      atMs: deps.now(),
    };
  }

  const outcome: ExecutionOutcome = {
    status: "executed",
    intent: meta.intent,
    result,
    payloadHash,
    ...(typeof decision.approvalId === "string" ? { approvalId: decision.approvalId } : {}),
  };

  let signed: SubmittedOutcome;
  try {
    signed = await deps.sign(outcome);
  } catch (error) {
    return {
      status: "failed",
      label,
      detail: `Signing error: ${detailOf(error)}`,
      atMs: deps.now(),
    };
  }

  if (signed.status === "executed" && signed.txHash && signed.explorerUrl) {
    return {
      status: "submitted",
      txHash: signed.txHash,
      explorerUrl: signed.explorerUrl,
      atMs: deps.now(),
    };
  }
  // An approved-but-unsigned outcome (no txHash) is a failure, never a success.
  return {
    status: "failed",
    label,
    detail: signed.detail ?? signed.label ?? "the transaction was not submitted",
    atMs: deps.now(),
  };
}

/**
 * Runs one already-built transaction through approval, signing and submission.
 * Never throws: a missing/unbuildable approver, a denial, a throwing approver, a
 * signer failure and a submission failure all resolve to a `TxRunOutcome`.
 */
export async function runTx(
  result: ChainToolResult,
  meta: TxRunMeta,
  deps?: Partial<TxPipelineDeps>,
): Promise<TxRunOutcome> {
  let resolved: TxPipelineDeps;
  try {
    resolved = await resolveDeps(deps);
  } catch (error) {
    return {
      status: "failed",
      label: "Approval unavailable",
      detail: detailOf(error),
      atMs: Date.now(),
    };
  }
  return runWith(result, meta, resolved);
}

/** One step of a sequence: an unsigned result plus the intent that produced it. */
export interface TxRunStep {
  result: ChainToolResult;
  intent: Intent;
  label: string;
  /**
   * Optional lazy builder, preferred when present: it is called right before the
   * step is approved so a fresh `ChainToolResult` (current state, current
   * sequence) can replace the plan-time one. The pipeline resequences either way.
   */
  build?: () => Promise<ChainToolResult>;
}

/** The phase a progress callback reports for a step. */
export type TxPhase = "approving" | "submitted" | "denied" | "failed";

/** Reports a step's phase: `index` is zero-based, `total` is the step count. */
export type TxProgress = (index: number, total: number, label: string, phase: TxPhase) => void;

/**
 * Runs steps strictly in order and stops at the first non-submitted outcome, so
 * a multi-transaction panel flow cannot race or continue past a denial.
 *
 * Every step is resequenced against its source account's **current** on-chain
 * sequence immediately before it is approved (not when the plan was built), so a
 * plan whose steps all embed the same base sequence submits as `base+1`,
 * `base+2`, … instead of failing `txBadSeq` after the first. The approval digest
 * and the displayed summary are computed from the resequenced XDR. A resequencing
 * failure is a labelled failure and the stale XDR is never approved or signed.
 * Returns the outcomes produced (at most one per step, from the start to the stop).
 */
export async function runTxSequence(
  steps: readonly TxRunStep[],
  deps?: Partial<TxPipelineDeps>,
  onProgress?: TxProgress,
): Promise<TxRunOutcome[]> {
  let resolved: TxPipelineDeps;
  try {
    resolved = await resolveDeps(deps);
  } catch (error) {
    return [{ status: "failed", label: "Approval unavailable", detail: detailOf(error), atMs: Date.now() }];
  }

  const outcomes: TxRunOutcome[] = [];
  const total = steps.length;
  for (let index = 0; index < total; index++) {
    const step = steps[index]!;
    let result: ChainToolResult;
    try {
      const built = step.build ? await step.build() : step.result;
      result = await resolved.resequence(built);
    } catch (error) {
      onProgress?.(index, total, step.label, "failed");
      outcomes.push({
        status: "failed",
        label: step.label,
        detail: `Resequencing error: ${detailOf(error)}`,
        atMs: resolved.now(),
      });
      break;
    }
    onProgress?.(index, total, step.label, "approving");
    const outcome = await runWith(result, { intent: step.intent, label: step.label }, resolved);
    outcomes.push(outcome);
    onProgress?.(index, total, step.label, outcome.status);
    if (outcome.status !== "submitted") break;
  }
  return outcomes;
}
