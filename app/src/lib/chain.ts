/**
 * The shell's composition root for the A9 intent execution seam.
 *
 * `@polaris/agent` owns the *shape* of the path (approval gate → chain tool →
 * outcome) and knows nothing about the chain package. This file is the one place
 * that binds that shape to the real tools, so Owner B can replace an
 * implementation inside `@polaris/stellar` without touching the seam, the agent
 * core or the shell.
 *
 * Ownership boundary: the tools below are Owner B's. Do not change their
 * behaviour here — this module only selects and injects them. The mapping is
 * total over the current `IntentKind` union minus `raw_tx` (which has no
 * dedicated tool and therefore settles as `unsupported`).
 *
 * The approver is **fail-closed by default**: a deny-all gate, not Touch ID.
 * Auto-approval is reachable only by explicitly setting
 * `POLARIS_ALLOW_AUTO_APPROVE=1` (for the stubbed demo); otherwise no chain tool
 * can run without a real gesture. Replacing the selection below with the
 * biometric gate is the only change needed to activate the real approval flow;
 * see `agent/src/execution.ts` for the seam contract and its M6 scope note
 * (intent-level gating only, not the post-tool approval card).
 */
import { executeIntent, resolveApprover, type ExecutionOutcome } from "@polaris/agent";
import type { Intent } from "@polaris/interfaces";

/**
 * The single selection to replace when Touch ID lands (separate milestone).
 *
 * Defaults to fail closed. `POLARIS_ALLOW_AUTO_APPROVE=1` opts into the loud
 * auto-approval placeholder, which is safe only while the chain tools are
 * stubs; it exists so the stubbed demo can reach the execution seam. This is a
 * non-secret flag, exposed to the webview by the Vite `envPrefix`.
 */
const approver = resolveApprover(import.meta.env.POLARIS_ALLOW_AUTO_APPROVE === "1");

/**
 * Executes one approved intent down the single seam.
 *
 * The chain package is imported lazily, only when an intent actually exists: its
 * SDK is large, and a voice turn that never reaches the chain must not pay for
 * it at shell startup. Never throws — every failure (including Owner B's
 * `NotImplementedError` stubs) comes back as a labelled `ExecutionOutcome`, so
 * the notch can show a short message and settle instead of crashing or hanging.
 */
export async function executeApprovedIntent(intent: Intent): Promise<ExecutionOutcome> {
  const { depositTry, guardPolicy, sendPayment, swap } = await import("@polaris/stellar");
  const chainTools = {
    send: sendPayment,
    swap,
    guard_policy: guardPolicy,
    deposit: depositTry,
  } as const;
  return executeIntent(intent, { approver, chainTools });
}
