/**
 * Intent execution seam (step A9; reordered in W1) — infrastructure, never chain
 * logic.
 *
 * Steps A2–A8 stop at a validated `Intent`: `send_payment` is approval-gated, so
 * the loop produces an `Intent` and deliberately never calls `run()`. Nothing in
 * the product could act on that intent. This module is the single, documented
 * path from "a validated `Intent`" to "the matching `ChainTool` from
 * `@polaris/stellar` was called and returned its `ChainToolResult`".
 *
 * ## What belongs here, and what does not
 *
 * Owner B owns `stellar/` (the chain tools, the anchor, the Soroban contracts) and
 * is implementing those behind the frozen `ChainTool`/`ChainToolResult` contract
 * in `@polaris/interfaces`. This module imports **none** of that package: the tool
 * set is injected as `ChainToolSet`, so the seam is testable with fakes and the
 * actual wiring lives in a composition root (the shell, `app/src/lib/chain.ts`).
 *
 * ## Build first, then ask (W1)
 *
 * The order is: validate the intent → resolve the tool → **run the chain tool**
 * (side-effect-free: it only builds an unsigned XDR + decoded summary) → build
 * the approval request `{ intent, summary, payloadHash }` → ask the approver →
 * return the `executed` outcome. The approval card therefore renders the exact
 * transaction that will be signed, instead of gating on the bare intent.
 *
 * Running the tool before the gate is safe by contract: a `ChainTool` never
 * signs and never submits, it only builds the XDR. It also makes the failure
 * picture honest — a tool that is not wired yet (`NotImplementedError`) or not
 * configured (`not_configured`) settles with a labelled outcome *before* a
 * useless approval prompt.
 *
 * ## The approval gate
 *
 * An explicit seam sits between "unsigned XDR built" and "value can move"
 * ([`IntentApprover`]). When an approver denies, the result is discarded and the
 * outcome is `rejected` — the XDR is never handed to a signer. That ordering is
 * pinned by a test.
 *
 * **Fail-closed by default.** The composition root must choose the approver
 * explicitly; [`resolveApprover`] returns a deny-all gate unless auto-approval
 * was opted into, so a real value-moving step can never execute by accident.
 * [`createAutoApprovalPlaceholder`] is a loud stand-in for the stubbed demo only
 * and is never the default.
 *
 * ## The ``payloadHash`` is the XDR digest, not the Stellar transaction hash (W1)
 *
 * Two different values are both called a "hash" in this system. They are **not**
 * interchangeable, and one must never be passed where the other is expected.
 *
 * - **XDR digest — `payloadHash`.** Lowercase-hex SHA-256 of the UTF-8 bytes of
 *   the base64 unsigned-XDR string ([`xdrDigest`]). This is the value carried at
 *   the seam: `ApprovalRequest.payloadHash`, `ExecutionOutcome.payloadHash`, and
 *   the `approval_request` / `approval_result` events. It binds the exact blob a
 *   signer will be handed, and it is computable in Rust without XDR parsing.
 *   At the gate/event boundary the field is named `payloadHash` and *always*
 *   means this digest.
 * - **Stellar transaction hash.** `Transaction.hash()` over the same envelope,
 *   i.e. `payloadHashOf` in `@polaris/stellar`
 *   (`stellar/src/payments/summary.ts`). It identifies the transaction on-chain;
 *   the chain summary puts it in the explorer URL. It is derived from the network
 *   passphrase and the envelope, not from the base64 string, so it differs from
 *   the digest.
 *
 * The regression test pins both values for one fixed XDR fixture: the transaction
 * hash must never be used at the approval gate, and the digest must never be used
 * as an on-chain identifier.
 *
 * Signing and submission are **not** part of this seam. An `executed` outcome
 * carries the `ChainToolResult` and the `payloadHash` so a later milestone (the
 * Touch ID gate) can sign and submit; nothing here does either.
 *
 * ## Unimplemented chain tools are an expected state, not a crash
 *
 * Owner B's `swap` and `guardPolicy` currently throw `NotImplementedError`. That
 * is the normal state, so it is modelled explicitly as [`ExecutionOutcome.status`]
 * `"unavailable"` with a short, user-safe label — the notch says plainly that the
 * chain step is not wired yet and settles, rather than showing an error or
 * hanging. The detection is structural (`name === "NotImplementedError"`) on
 * purpose: it keeps this module independent of the chain package.
 *
 * `depositTry` is **not** a stub (M8): with no anchor configured it throws a
 * plain error (reported as `"failed"` / `Chain error`), and with one configured
 * it builds the unsigned trustline or SEP-10 login XDR (reported as `"executed"`).
 * It never submits, so nothing reaches the network from here. W5b adds the
 * `withdraw` kind, dispatched to `withdrawTry` the same way.
 */
import type { ChainTool, ChainToolResult, Intent, IntentKind } from "@polaris/interfaces";

import { refusalLabel } from "./errors.ts";

/* ------------------------------------------------------------------ *
 * Approval gate
 * ------------------------------------------------------------------ */

/** What an approver answers for one intent. */
export interface ApprovalDecision {
  approved: boolean;
  /** Short, terminal-safe reason; shown when `approved` is false. */
  reason?: string;
  /**
   * The gate-assigned id of the approved request (W4b), when the approver has
   * one. A real approver (the Touch ID gate) registers the request and hands
   * this back so the signing step can release exactly that blob. It is absent
   * for a gate that does not store requests (the deny/auto placeholders) and is
   * never required for `approved: true`.
   */
  approvalId?: string;
}

/**
 * Post-tool material handed to the approval gate: the intent, the summary
 * decoded from the unsigned XDR, and `payloadHash` — the **XDR digest** (SHA-256
 * of the base64 unsigned-XDR string, [`xdrDigest`]). This is exactly what the
 * approval card renders (mirrors `PolarisEvent::approval_request`).
 *
 * `payloadHash` here is never the Stellar transaction hash; see the module
 * header. The signing milestone must bind the signer to this digest.
 *
 * `unsignedXdr` was added in W4b so the gate can store the exact blob a signer
 * will be handed: the Rust approval gate validates that the blob's digest equals
 * `payloadHash` before it accepts the request, and releases the XDR only after a
 * real gesture. It is the same value the chain tool returned, never a second
 * source of truth.
 */
export interface ApprovalRequest {
  intent: Intent;
  summary: ChainToolResult["summary"];
  payloadHash: string;
  /** base64 unsigned transaction envelope; the gate binds it to `payloadHash`. */
  unsignedXdr: string;
}

/**
 * The approval gate. Owner A's Touch ID flow implements this.
 *
 * It is a **card-level** gate: it sees the unsigned transaction's summary and
 * payload hash, so it can show the user what they are about to authorise and
 * approve or deny it. The chain tool has already run here (side-effect-free); a
 * deny decision discards the result before any signer sees it.
 *
 * Implementations must not perform chain work — they only decide. Implementations
 * **may throw** (for example a biometric error); `executeIntent` maps that to a
 * labelled failure instead of letting it escape.
 */
export interface IntentApprover {
  approve(request: ApprovalRequest): Promise<ApprovalDecision>;
}

/**
 * Development placeholder — **not** Touch ID. It approves unconditionally.
 *
 * This exists so the execution path is real end to end for the stubbed demo, and
 * it is **never** the default: a composition root installs it only through
 * [`resolveApprover`] with an explicit opt-in. It was harmless while every tool
 * threw `NotImplementedError`, but `depositTry` is already real and any of
 * `sendPayment`, `swap` or `guardPolicy` may stop throwing at any time — at
 * which point an auto-approver would move value without a user gesture. Keeping
 * it opt-in is what makes that unreachable by accident.
 */
export function createAutoApprovalPlaceholder(): IntentApprover {
  return {
    async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
      console.warn(
        `[polaris] approval gate is the A9 placeholder (Touch ID is a later milestone); ` +
          `auto-approving a "${request.intent.kind}" intent`,
      );
      return { approved: true };
    },
  };
}

/**
 * The safe default: deny everything until a real gate is installed.
 *
 * Used whenever auto-approval was not explicitly opted into, so a value-moving
 * step cannot run without a deliberate decision (M5).
 */
export function createDenyApprover(
  reason = "the approval gate is not configured",
): IntentApprover {
  return {
    async approve(request: ApprovalRequest): Promise<ApprovalDecision> {
      console.warn(
        `[polaris] refusing to approve a "${request.intent.kind}" intent: ${reason} ` +
          `(the Touch ID approver is a later milestone)`,
      );
      return { approved: false, reason };
    },
  };
}

/**
 * Selects the approver for a composition root. **Fail-closed by default**: only
 * an explicit `autoApprove === true` installs the auto-approving placeholder;
 * everything else gets the deny-all gate, so the dangerous wiring cannot be
 * reached by forgetting a flag (M5). The caller reads the flag from an explicit
 * opt-in (see `app/src/lib/chain.ts`), never from an implicit default.
 */
export function resolveApprover(autoApprove: boolean): IntentApprover {
  return autoApprove ? createAutoApprovalPlaceholder() : createDenyApprover();
}

/* ------------------------------------------------------------------ *
 * Payload hash
 * ------------------------------------------------------------------ */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value: number, bits: number): number {
  return ((value >>> bits) | (value << (32 - bits))) >>> 0;
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string. Pure and environment-independent
 * (no `node:crypto`, no `crypto.subtle`), so the seam works unchanged in the
 * webview and under `node --test`.
 */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = (bytes.length + 9 + 63) & ~63;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(bytes);
  buffer[bytes.length] = 0x80;
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15] ?? 0;
      const y = w[i - 2] ?? 0;
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * The seam's `payloadHash`: lowercase-hex SHA-256 of the UTF-8 bytes of the
 * base64 unsigned-XDR string (the **XDR digest**). This is what binds the exact
 * blob a signer is handed, and it is computable in Rust without XDR parsing.
 *
 * Do not confuse it with the Stellar transaction hash (`Transaction.hash()`,
 * `payloadHashOf` in `@polaris/stellar`), which is a different value and must
 * never be passed where the digest is expected. See the module header.
 */
export function xdrDigest(unsignedXdr: string): string {
  return sha256Hex(unsignedXdr);
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

/** The chain tools available to the agent, keyed by the intent kind they serve. */
export type ChainToolSet = Partial<Record<IntentKind, ChainTool>>;

/** Why an intent did not produce a usable `ChainToolResult`. */
export type ExecutionStatus = "executed" | "rejected" | "unsupported" | "unavailable" | "failed";

/** One intent's execution result. `label`/`detail` are set for every non-success. */
export interface ExecutionOutcome {
  status: ExecutionStatus;
  intent: Intent;
  /** Short, overlay-safe label (e.g. "Chain not wired"). Absent when executed. */
  label?: string;
  /** Full terminal detail. Absent when executed. */
  detail?: string;
  /** The unsigned XDR + decoded summary. Present iff `status === "executed"`. */
  result?: ChainToolResult;
  /**
   * The **XDR digest** — hex SHA-256 of the base64 unsigned-XDR string. Present
   * iff `status === "executed"`; it is what a later signing step must be bound
   * to. It is never the Stellar transaction hash.
   */
  payloadHash?: string;
  /**
   * The gate-assigned approval id (W4b). Present iff `status === "executed"` and
   * the approver supplied one; the signing step passes it to `wallet_sign` to
   * release the approved blob. Absent for the deny/auto placeholders.
   */
  approvalId?: string;
}

export interface ExecuteIntentOptions {
  /** The approval gate; the unsigned result is only kept if this approves. */
  approver: IntentApprover;
  /** Owner B's tools, injected by the composition root. */
  chainTools: ChainToolSet;
  /**
   * Overrides the XDR digest function (used by tests to pin the request).
   * Defaults to [`xdrDigest`].
   */
  xdrDigest?: (unsignedXdr: string) => string;
}

/** True for Owner B's `NotImplementedError` stubs, matched structurally. */
export function isNotImplementedError(error: unknown): boolean {
  return error instanceof Error && error.name === "NotImplementedError";
}

/** The structural `code` of a chain refusal (e.g. `not_configured`), if any. */
function refusalCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/**
 * Runtime guard for a chain tool's result. `ChainTool` promises a non-empty
 * `unsignedXdr` plus a well-formed `summary`, but the tools are injected and
 * this seam is the safety boundary, so a malformed result must fail closed
 * rather than produce an `executed` outcome with a bogus hash (M-2).
 */
function isUsableToolResult(value: unknown): value is ChainToolResult {
  if (typeof value !== "object" || value === null) return false;
  const { unsignedXdr, summary } = value as { unsignedXdr?: unknown; summary?: unknown };
  if (typeof unsignedXdr !== "string" || unsignedXdr.length === 0) return false;
  if (typeof summary !== "object" || summary === null) return false;
  const { title, lines, estimatedFee } = summary as {
    title?: unknown;
    lines?: unknown;
    estimatedFee?: unknown;
  };
  return (
    typeof title === "string" &&
    Array.isArray(lines) &&
    lines.every((line) => typeof line === "string") &&
    typeof estimatedFee === "string"
  );
}

/**
 * The single path from a validated `Intent` to its chain tool and its approval.
 *
 * Order is part of the contract (pinned by a test): resolve the tool, build the
 * unsigned XDR, hash it, then ask the approver. Outcomes:
 *
 * - `unsupported` — no chain tool is registered for this intent kind.
 * - `unavailable` — the tool exists but is not wired yet (`NotImplementedError`).
 * - `failed` — the tool threw (including a `not_configured` refusal), returned a
 *   result without a usable unsigned XDR + summary, or the approver threw / gave
 *   no decision.
 * - `rejected` — the approver denied; the built result is discarded.
 * - `executed` — the tool returned an unsigned XDR + summary and the approver
 *   approved; `result` + `payloadHash` (the XDR digest) are returned for the
 *   signing step.
 *
 * Never throws: a throwing approver (the realistic Touch ID error/cancel shape)
 * is caught and returned as a labelled `failed` outcome, exactly like a tool
 * failure, so callers always get something they can render or settle.
 */
export async function executeIntent(
  intent: Intent,
  options: ExecuteIntentOptions,
): Promise<ExecutionOutcome> {
  const tool = options.chainTools?.[intent.kind];
  if (!tool) {
    return {
      status: "unsupported",
      intent,
      label: "Not supported",
      detail: `no chain tool is registered for intent kind "${intent.kind}"`,
    };
  }

  // Build first: a `ChainTool` only produces the unsigned XDR + summary, so this
  // moves no value and lets the approval card show what would really be signed.
  let rawResult: unknown;
  try {
    rawResult = await tool(intent);
  } catch (error) {
    if (isNotImplementedError(error)) {
      return {
        status: "unavailable",
        intent,
        label: "Chain not wired",
        detail: detailOf(error),
      };
    }
    if (refusalCode(error) === "not_configured") {
      return {
        status: "failed",
        intent,
        label: "Chain not configured",
        detail: detailOf(error),
      };
    }
    // F4: a typed refusal (unknown recipient, bad amount, unsupported asset, …)
    // gets a specific label instead of the generic "Chain error".
    return {
      status: "failed",
      intent,
      label: refusalLabel(refusalCode(error)),
      detail: detailOf(error),
    };
  }

  // Fail closed on a malformed result (M-2): no `unsignedXdr`, no `executed`.
  if (!isUsableToolResult(rawResult)) {
    return {
      status: "failed",
      intent,
      label: "Chain error",
      detail: "the chain tool returned no usable unsigned XDR + summary",
    };
  }
  const result = rawResult;

  const payloadHash = (options.xdrDigest ?? xdrDigest)(result.unsignedXdr);
  const request: ApprovalRequest = {
    intent,
    summary: result.summary,
    payloadHash,
    unsignedXdr: result.unsignedXdr,
  };

  let rawDecision: unknown;
  try {
    rawDecision = await options.approver.approve(request);
  } catch (error) {
    // A biometric gate may reject or error by throwing (cancel, hardware
    // failure). That must not escape the seam: map it to a labelled outcome so
    // the shell can settle the turn instead of hitting its generic catch.
    return {
      status: "failed",
      intent,
      label: "Approval error",
      detail: detailOf(error),
    };
  }
  // A non-object decision (an approver that resolved to `undefined`/`null`) is a
  // broken gate, not an approval (m-4): settle it as a failure.
  if (typeof rawDecision !== "object" || rawDecision === null) {
    return {
      status: "failed",
      intent,
      label: "Approval error",
      detail: "the approver returned no decision",
    };
  }
  const decision = rawDecision as ApprovalDecision;
  if (decision.approved !== true) {
    // The XDR was built but is discarded: nothing reaches a signer.
    return {
      status: "rejected",
      intent,
      label: "Not approved",
      detail:
        typeof decision.reason === "string"
          ? decision.reason
          : "the approval gate rejected the intent",
    };
  }

  return {
    status: "executed",
    intent,
    result,
    payloadHash,
    ...(typeof decision.approvalId === "string" ? { approvalId: decision.approvalId } : {}),
  };
}
