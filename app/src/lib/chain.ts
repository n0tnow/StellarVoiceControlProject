/**
 * The shell's composition root for the A9 intent execution seam (W1: real
 * network config).
 *
 * `@polaris/agent` owns the *shape* of the path (chain tool → approval gate →
 * outcome) and knows nothing about the chain package. This file is the one place
 * that binds that shape to the real tools, so Owner B can replace an
 * implementation inside `@polaris/stellar` without touching the seam, the agent
 * core or the shell.
 *
 * Ownership boundary: the tools below are Owner B's. Do not change their
 * behaviour here — this module only selects, configures and injects them. The
 * mapping is total over the current `IntentKind` union minus `raw_tx` (which has
 * no dedicated tool and therefore settles as `unsupported`).
 *
 * ## Where the owner address and aliases come from (W1)
 *
 * Neither the owner address nor the recipient aliases are secrets, but they are
 * environment-specific, so they are **not** bundled. The Rust `stellar_config`
 * command (`getStellarConfig`) returns them validated; the env aliases
 * (`POLARIS_ALIASES`) are merged over the committed `stellar/config/aliases.json`,
 * with the environment winning. Owner B's chain tool is configured lazily on the
 * first intent, so a voice turn that never reaches the chain pays for neither the
 * SDK nor the config read. Missing owner address is refused with a clear label
 * ("Set POLARIS_OWNER_ADDRESS") and never guessed.
 *
 * The approver is **fail-closed by default**. In a real Tauri runtime the Touch
 * ID gate (W3) is selected: it registers the exact blob and returns a decision
 * only when the gate reports `authorized`. Outside Tauri, the loud auto-approval
 * placeholder is reachable only with `POLARIS_ALLOW_AUTO_APPROVE=1` (the
 * CLI/demo path); everything else is the deny-all gate. In the app the biometric
 * gate always wins, so no value can move without a real gesture; see
 * `agent/src/execution.ts` for the seam contract.
 */
import { isTauri } from "@tauri-apps/api/core";
import {
  createDenyApprover,
  executeIntent,
  resolveApprover,
  type ExecutionOutcome,
  type IntentApprover,
} from "@polaris/agent";
import type { Intent } from "@polaris/interfaces";

import { getStellarConfig } from "@/lib/stellarConfig";
import {
  p2pAcceptTool,
  p2pCancelTool,
  p2pConfirmTool,
  p2pOfferTool,
  p2pReclaimTool,
} from "@/lib/p2p";
import { createTouchIdApprover, defaultApproverDeps, type ApproverDeps } from "@/lib/approver";
import {
  defaultSigningDeps,
  signAndSubmit,
  type SubmittedOutcome,
  type SigningDeps,
} from "@/lib/signing";
import type { PaymentStage } from "@/lib/turnSession";
import { webLog } from "@/lib/weblog";
import committedAliases from "../../../stellar/config/aliases.json";

/**
 * The approver selection (W4b). **Fail-closed by default.**
 *
 * * In a real Tauri runtime the Touch ID gate (W3) is the approver: it registers
 *   the exact blob, opens the approval card and returns a decision only when the
 *   gate reports `authorized`.
 * * `POLARIS_ALLOW_AUTO_APPROVE=1` still opts into the loud auto-approval
 *   placeholder — but **only outside** a Tauri runtime (the CLI/demo path). In
 *   the app the gate always wins, so the placeholder can never move real value.
 * * Everything else is the deny-all gate.
 *
 * The Touch ID approver is built lazily (its event subscription is async), so a
 * turn that never reaches the chain pays for nothing.
 */
let approverPromise: Promise<IntentApprover> | undefined;

async function resolveRuntimeApprover(
  onStage?: (stage: PaymentStage) => void,
): Promise<IntentApprover> {
  if (isTauri()) {
    const deps: ApproverDeps = await defaultApproverDeps(onStage);
    return createTouchIdApprover(deps);
  }
  if (import.meta.env.POLARIS_ALLOW_AUTO_APPROVE === "1") {
    return resolveApprover(true);
  }
  return createDenyApprover();
}

function approverFor(onStage?: (stage: PaymentStage) => void): Promise<IntentApprover> {
  // A stage-reporting approver is bound to the turn that supplied the callback,
  // so it is never memoized; the default approver still is.
  if (onStage !== undefined) {
    return resolveRuntimeApprover(onStage);
  }
  approverPromise ??= resolveRuntimeApprover();
  return approverPromise;
}

/** Thrown (and caught below) only when the owner wallet is not configured. */
const OWNER_MISSING = "POLARIS_OWNER_ADDRESS is not set";

let configured = false;
let configuring: Promise<void> | undefined;

/**
 * The live alias book the payment tool resolves recipients against (shared by
 * reference with the configured deps), so a typed address can be added to it.
 */
let paymentBook: Record<string, { address: string; network: "testnet" }> | undefined;

// A contact saved (or removed) after start must be payable without a restart:
// forget the memoized config so the next turn rebuilds the alias book from the
// current contacts.
if (typeof window !== "undefined") {
  window.addEventListener("polaris:contacts-changed", () => {
    configured = false;
    configuring = undefined;
  });
}

/**
 * Lets a person pay an address they typed themselves: registers it in the alias
 * book under a short deterministic name and returns that name for the intent.
 * The voice agent never uses this — its recipients must still be saved aliases,
 * so a hallucinated address cannot be paid. The approval card always shows the
 * full address, and the owner path still needs Touch ID.
 */
export async function recipientForTypedAddress(address: string): Promise<string> {
  await ensurePaymentsConfigured();
  const { parseAliasBook } = await import("@polaris/stellar");
  const trimmed = address.trim();
  const name = `to-${trimmed.slice(-24).toLowerCase()}`;
  const { book } = parseAliasBook({ [name]: { address: trimmed, network: "testnet" } });
  const entry = book[name];
  if (!entry || !paymentBook) throw new Error("could not use that address");
  paymentBook[name] = entry;
  return name;
}

/** The env `alias -> address` map as alias-book entries (testnet only). */
function envAliasEntries(
  aliases: Record<string, string>,
): Record<string, { address: string; network: "testnet" }> {
  return Object.fromEntries(
    Object.entries(aliases).map(([alias, address]) => [
      alias,
      { address, network: "testnet" as const },
    ]),
  );
}

/**
 * Reads the validated config once and installs Owner B's payment tool. Memoized
 * on success; a failure (no owner, a failed config read) is retried on the next
 * turn rather than cached.
 */
async function ensurePaymentsConfigured(): Promise<void> {
  if (configured) return;
  configuring ??= (async () => {
    const config = await getStellarConfig();
    if (!config.ownerAddress) {
      throw new Error(OWNER_MISSING);
    }
    const { configurePayments, defaultPaymentDeps, parseAliasBook } = await import(
      "@polaris/stellar"
    );
    // Env aliases win over the committed book, and `parseAliasBook` re-validates
    // every address, so a malformed entry is refused rather than paid.
    const { book } = parseAliasBook({
      ...committedAliases,
      ...envAliasEntries(config.aliases),
    });
    paymentBook = book;
    configurePayments(
      defaultPaymentDeps({
        ownerAddress: config.ownerAddress,
        aliases: book,
        horizonUrl: config.horizonUrl,
        networkPassphrase: config.networkPassphrase,
      }),
    );
    // The anchor tools (`depositTry` / `withdrawTry`) need a session with the
    // shell signer. `createAnchorSigner` routes sequence-0 challenges to the
    // wallet-only Rust command and everything else to the Touch ID pipeline.
    const { anchor } = await import("@polaris/stellar");
    const { createAnchorSigner } = await import("@/lib/anchor");
    // BANK-SIM: the anchor scenario is selectable via POLARIS_ANCHOR_HOME_DOMAIN
    // (read in Rust; default the SDF test anchor). Keeps the voice and panel
    // flows on the same home domain.
    const { getBankAnchorConfig } = await import("@/lib/bank");
    const anchorConfig = await getBankAnchorConfig();
    anchor.configureAnchor({ signer: createAnchorSigner(), homeDomain: anchorConfig.homeDomain });
    configured = true;
  })();
  try {
    await configuring;
  } finally {
    if (!configured) configuring = undefined;
  }
}

/**
 * Logs one non-executed outcome to the Rust terminal with enough context to
 * debug it (label, detail, intent kind/asset/amount/recipient). It deliberately
 * never logs the unsigned or signed XDR — only the redacted detail.
 */
function logFailure(outcome: SubmittedOutcome): void {
  if (outcome.status === "executed") return;
  const { kind, asset, amount, recipient, alias } = outcome.intent;
  webLog(
    "error",
    `chain ${outcome.status}: ${outcome.label ?? "Chain error"} — ${outcome.detail ?? ""} ` +
      `(kind=${kind} asset=${asset} amount=${amount} recipient=${recipient ?? alias ?? "unknown"})`,
    true,
  );
}

/**
 * Executes one validated intent down the single seam: build → approve → sign →
 * submit.
 *
 * The chain package is imported lazily, only when an intent actually exists: its
 * SDK is large, and a voice turn that never reaches the chain must not pay for
 * it at shell startup. Never throws — a missing owner, a failed config read and
 * every execution failure (including Owner B's `NotImplementedError` stubs) come
 * back as a labelled `SubmittedOutcome`, so the notch can show a short message
 * and settle instead of crashing or hanging.
 *
 * On success the returned outcome carries `txHash`/`explorerUrl` (and the raw
 * `ExecutionOutcome` fields), which the shell's speak path announces. A failure
 * anywhere in the values above — including the wallet declining, an integrity
 * failure or a rejected submission — is a labelled failure with no `txHash`.
 */
export async function executeApprovedIntent(
  intent: Intent,
  signingDeps?: Partial<SigningDeps>,
): Promise<SubmittedOutcome> {
  // W11b: a spoken spending rule now opens the batch approval card and, on ONE
  // Touch ID, applies the ordered owner transactions (`approve` → `set_rule` →
  // `set_executor`, executor last). The Security panel's own `guard_policy`
  // intents carry no `rule`, so they keep their existing path.
  if (intent.kind === "guard_policy" && intent.rule) {
    const { runGuardPolicySetup } = await import("@/lib/autopayWiring");
    const outcome = await runGuardPolicySetup(intent);
    logFailure(outcome);
    return outcome;
  }
  // W11b: when auto-pay is armed, a small payment to a saved contact is settled
  // by the executor key with no card (fail closed: any doubt returns `null` and
  // the owner path below runs, so we never silently pay outside the mandate).
  if (intent.kind === "send") {
    const { tryAutoPaySend } = await import("@/lib/autopayWiring");
    const auto = await tryAutoPaySend(intent);
    if (auto) {
      logFailure(auto);
      return auto;
    }
  }
  const deps: SigningDeps = {
    ...defaultSigningDeps,
    ...signingDeps,
  };
  try {
    await ensurePaymentsConfigured();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const failure: SubmittedOutcome = {
      status: "failed",
      intent,
      label: detail.includes("POLARIS_OWNER_ADDRESS") ? "Set POLARIS_OWNER_ADDRESS" : "Chain not configured",
      detail,
    };
    logFailure(failure);
    return failure;
  }
  const { depositTry, guardPolicy, sendPayment, swap, withdrawTry } = await import(
    "@polaris/stellar"
  );
  // W6b: the schedule tools live in their own module (RPC + guard client wiring);
  // both adapt a validated `Intent` to the chain tool's unsigned XDR + summary.
  const { cancelChainTool, scheduleChainTool } = await import("@/lib/schedulesLive");
  // W5b/M1: deposit/withdraw are multi-step anchor flows, not one tool XDR.
  // Drive the same `AnchorSession` the panel uses, so the SEP-10 challenge is
  // signed wallet-only and every value-moving step goes through the Touch ID
  // pipeline. This also keeps a sequence-0 challenge out of `wallet_sign`.
  if (intent.kind === "deposit" || intent.kind === "withdraw") {
    // BANK-SIM: deposit/withdraw now drive the demo bank ↔ anchor automation,
    // which includes the on-chain steps (through the same Touch ID pipeline).
    const { runBankIntent } = await import("@/lib/bankAnchor");
    return runBankIntent(intent);
  }
  const chainTools = {
    send: sendPayment,
    swap,
    guard_policy: guardPolicy,
    deposit: depositTry,
    withdraw: withdrawTry,
    schedule_payment: scheduleChainTool,
    cancel_schedule: cancelChainTool,
    // P2P escrow (W8). The TRY leg stays off-chain; these only build the escrow
    // calls and still go through the same approve → sign → submit pipeline.
    p2p_offer: p2pOfferTool,
    p2p_accept: p2pAcceptTool,
    p2p_confirm: p2pConfirmTool,
    p2p_cancel: p2pCancelTool,
    p2p_reclaim: p2pReclaimTool,
  } as const;
  // F1: `deps.onStage` (when supplied) threads the turn's stage reports through
  // both the approval gate and the sign/submit path.
  const approver = await approverFor(deps.onStage);
  const outcome: ExecutionOutcome = await executeIntent(intent, { approver, chainTools });
  const submitted = await signAndSubmit(outcome, deps);
  logFailure(submitted);
  return submitted;
}
