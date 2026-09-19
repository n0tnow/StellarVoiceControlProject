/**
 * The real `sendPayment` ChainTool: a validated `Intent` (kind "send") becomes
 * an UNSIGNED Stellar payment transaction plus a summary decoded from that XDR.
 *
 * Boundaries (deliberate):
 *  - No signing, no submission, no Horizon calls. `loadAccount` is injected.
 *  - The recipient is resolved ONLY through the alias book; raw `G...` addresses
 *    are refused (docs/confidential-payments.md §12 C3; slice §H.6).
 *  - Privacy modes are fail-closed: any non-public mode is refused, never
 *    downgraded to a public payment.
 *
 * Browser-safe: no `Buffer`, no `node:` imports.
 */
import { BASE_FEE, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import type { ChainTool, ChainToolResult, Intent } from "@polaris/interfaces";
import { chooseGuardedRoute } from "../guard/route.ts";
import { toRawUnits } from "../guard/amount.ts";
import { buildGuardedPaymentSummary } from "../guard/describe.ts";
import { asGuardClientError } from "../guard/errors.ts";
import type { GuardClient } from "../guard/types.ts";
import { requiresApprovalCard, resolveApprovalRoute } from "../approval/routing.ts";
import { DEFAULT_APPROVAL_PROFILE, type ApprovalProfile } from "../approval/types.ts";
import { resolveAlias, type AliasBook } from "./aliases.ts";
import { toSdkAsset, type AssetRegistry, type AssetSpec } from "./assets.ts";
import { buildPaymentSummary } from "./summary.ts";

export type PaymentRefusalCode =
  | "not_configured"
  | "invalid_intent"
  | "invalid_amount"
  | "unsupported_asset"
  | "unknown_recipient"
  | "mode_not_supported"
  | "guarded_route_not_available"
  | "recipient_no_trustline"
  | "trustline_check_failed"
  | "account_not_found"
  // -- guarded route (see docs table in backlog/guard-client.md) -------------
  | "guard_rule_missing"
  | "guard_limit_exceeded"
  | "guard_asset_not_allowed"
  | "guard_client_error";

/**
 * Machine-readable refusal. The shared `ChainToolResult` has no refusal field,
 * so refusals are thrown; the shell turns them into events later. The shell
 * should match on `code`, never on the human `message`.
 *
 * `guardErrorName` carries the mapped `polaris_guard` error name when the
 * refusal came from the guard (e.g. `OverPerTxLimit`), so the app can explain
 * the exact on-chain reason.
 */
export class PaymentRefusal extends Error {
  readonly code: PaymentRefusalCode;
  readonly guardErrorName: string | undefined;
  constructor(code: PaymentRefusalCode, message: string, guardErrorName?: string) {
    super(message);
    this.name = "PaymentRefusal";
    this.code = code;
    this.guardErrorName = guardErrorName;
  }
}

/** RESERVED field (docs/confidential-payments.md §4.1); absent means "public". */
export type PaymentMode = "public" | "confidential" | "private";
/** `direct` = a plain payment op; `guarded` = through `polaris_guard` (needs a `guard` client). */
export type PaymentRoute = "direct" | "guarded";

/** `Intent` widened with the reserved `mode` field; `interfaces/` is not edited here. */
export interface PaymentIntent extends Intent {
  mode?: PaymentMode;
}

/** The structural shape `TransactionBuilder` needs (`Account` / `AccountResponse`). */
export interface AccountLike {
  accountId(): string;
  sequenceNumber(): string;
  incrementSequenceNumber(): void;
}

export interface PaymentDeps {
  ownerAddress: string;
  aliases: AliasBook;
  loadAccount(address: string): Promise<AccountLike>;
  networkPassphrase: string;
  horizonUrl?: string;
  explorerBase?: string;
  assets: AssetRegistry;
  /** Optional live precheck: false for a non-native asset -> `recipient_no_trustline`. */
  checkTrustline?(address: string, asset: AssetSpec): Promise<boolean>;
  /** Defaults to "direct". `"guarded"` requires `guard` + `guardAssetContracts`. */
  route?: PaymentRoute;
  /**
   * Owner/executor guard client, built with the deployed contract id from
   * `GUARD_CONTRACT_ID`. Required for `route: "guarded"`; never a constant here.
   */
  guard?: GuardClient;
  /** Asset code -> SAC contract id used by the guard (`{ USDC: "C..." }`). */
  guardAssetContracts?: Record<string, string>;
  /**
   * App-side approval preference (D10). Defaults to `always_ask`: the guarded
   * route then always takes the owner-signed `pay_owner` path, even when the
   * chain would allow the executor. `auto_under_limit` / `custom` defer to the
   * chain's `chooseGuardedRoute` decision. The app can only be stricter.
   */
  approvalProfile?: ApprovalProfile;
  /** Injected clock for deterministic time bounds in tests. */
  now?: () => Date;
  /** Transaction validity window in seconds (default 300). */
  timeboundSeconds?: number;
}

/** Same call shape as `ChainTool`, but accepting the reserved `mode` field. */
export type PaymentChainTool = (intent: PaymentIntent) => Promise<ChainToolResult>;

/** 1-7 fraction digits, at most 12 integer digits, no sign/exponent/whitespace. */
const AMOUNT = /^\d{1,12}(\.\d{1,7})?$/;
/** Stellar amounts are int64 stroops. */
const MAX_STROOPS = 9_223_372_036_854_775_807n;

function assertPositiveAmount(amount: unknown): string {
  if (typeof amount !== "string" || !AMOUNT.test(amount)) {
    throw new PaymentRefusal(
      "invalid_amount",
      `amount must be a positive decimal string with 1-7 fraction digits and at most 12 integer digits, got ${JSON.stringify(amount)}`,
    );
  }
  const [whole, frac = ""] = amount.split(".") as [string, string?];
  const stroops = BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0"));
  if (stroops <= 0n) {
    throw new PaymentRefusal("invalid_amount", `amount must be greater than zero, got ${JSON.stringify(amount)}`);
  }
  if (stroops > MAX_STROOPS) {
    throw new PaymentRefusal("invalid_amount", `amount ${JSON.stringify(amount)} exceeds the maximum Stellar amount`);
  }
  return amount;
}

export function createSendPayment(deps: PaymentDeps): ChainTool {
  return async (rawIntent: Intent): Promise<ChainToolResult> => {
    const intent = rawIntent as PaymentIntent | null | undefined;

    if (intent === null || intent === undefined || typeof intent !== "object") {
      throw new PaymentRefusal(
        "invalid_intent",
        `sendPayment expects a kind "send" intent object, got ${JSON.stringify(intent)}`,
      );
    }

    if (intent.kind !== "send") {
      throw new PaymentRefusal("invalid_intent", `sendPayment expects kind "send", got ${JSON.stringify(intent.kind)}`);
    }

    const mode = intent.mode ?? "public";
    if (mode !== "public") {
      throw new PaymentRefusal("mode_not_supported", "Privacy modes are not available yet; the payment was NOT sent");
    }
    const route = deps.route ?? "direct";
    if (route === "guarded") {
      return guardedPayment(deps, intent);
    }
    if (route !== "direct") {
      throw new PaymentRefusal(
        "guarded_route_not_available",
        "The guarded payment route is not available yet; use the direct route",
      );
    }

    if (typeof intent.asset !== "string") {
      throw new PaymentRefusal(
        "unsupported_asset",
        `asset must be a string code (allowed: USDC, XLM), got ${JSON.stringify(intent.asset)}`,
      );
    }
    const spec = deps.assets.get(intent.asset);
    if (!spec) {
      throw new PaymentRefusal(
        "unsupported_asset",
        `asset ${JSON.stringify(intent.asset)} is not supported (allowed: USDC, XLM)`,
      );
    }

    const amount = assertPositiveAmount(intent.amount);

    const rawRecipient = intent.recipient ?? intent.alias ?? "";
    if (typeof rawRecipient !== "string") {
      throw new PaymentRefusal(
        "unknown_recipient",
        `recipient must be an alias string, got ${JSON.stringify(rawRecipient)}`,
      );
    }
    const alias = rawRecipient.trim().toLowerCase();
    if (!alias) {
      throw new PaymentRefusal(
        "unknown_recipient",
        "a recipient alias is required; raw addresses are not accepted",
      );
    }
    const entry = resolveAlias(deps.aliases, alias);
    if (!entry) {
      throw new PaymentRefusal(
        "unknown_recipient",
        `recipient ${JSON.stringify(alias)} is not a known alias; add it to the alias book first (raw addresses are not accepted)`,
      );
    }

    if (!spec.native && deps.checkTrustline) {
      let ok: boolean;
      try {
        ok = await deps.checkTrustline(entry.address, spec);
      } catch (e) {
        throw new PaymentRefusal(
          "trustline_check_failed",
          `could not check the ${spec.code} trustline for ${alias}: ${(e as Error).message}`,
        );
      }
      if (!ok) {
        throw new PaymentRefusal(
          "recipient_no_trustline",
          `${alias} cannot hold ${spec.code} (no trustline); a payment would fail with op_no_trust`,
        );
      }
    }

    let source: AccountLike;
    try {
      source = await deps.loadAccount(deps.ownerAddress);
    } catch (e) {
      throw new PaymentRefusal(
        "account_not_found",
        `could not load the owner account ${deps.ownerAddress}: ${(e as Error).message}`,
      );
    }

    const now = deps.now ? deps.now() : new Date();
    const windowSeconds = deps.timeboundSeconds ?? 300;
    // No lower time bound (`minTime: 0`): setting it to the client's wall clock
    // made the payment fail with `tx_too_early` whenever the ledger close time
    // lagged the client clock (observed on testnet). The upper bound is enough.
    const unsignedXdr = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: deps.networkPassphrase,
      timebounds: { minTime: 0, maxTime: new Date(now.getTime() + windowSeconds * 1000) },
    })
      .addOperation(Operation.payment({ destination: entry.address, asset: toSdkAsset(spec), amount }))
      .build()
      .toXDR();

    const { summary } = buildPaymentSummary({
      unsignedXdr,
      networkPassphrase: deps.networkPassphrase,
      alias,
      ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
    });
    return { unsignedXdr, summary };
  };
}

// ---------------------------------------------------------------------------
// Guarded route
// ---------------------------------------------------------------------------

/** Asset code -> SAC contract id, tolerating either case in the deps table. */
function guardAssetContract(deps: PaymentDeps, code: string): string | undefined {
  const table = deps.guardAssetContracts;
  if (!table) return undefined;
  return table[code] ?? table[code.toUpperCase()] ?? table[code.toLowerCase()];
}

/** Guard error name -> the app-facing refusal code. */
const GUARD_REFUSAL_BY_NAME: Readonly<Record<string, PaymentRefusalCode>> = {
  NotConfigured: "guard_rule_missing",
  OverPerTxLimit: "guard_limit_exceeded",
  OverDailyLimit: "guard_limit_exceeded",
  AssetNotAllowed: "guard_asset_not_allowed",
  InvalidAmount: "invalid_amount",
};

/** Wrap a guard failure as a typed `PaymentRefusal`, preserving the mapped name. */
function guardRefusal(error: unknown): PaymentRefusal {
  const mapped = asGuardClientError(error);
  const code = GUARD_REFUSAL_BY_NAME[mapped.name] ?? "guard_client_error";
  return new PaymentRefusal(code, `polaris_guard ${mapped.name}: ${mapped.message}`, mapped.name);
}

/**
 * `route: "guarded"`: resolve the recipient and the owner's on-chain rule,
 * apply the pure routing policy, then build the `pay_executor` / `pay_owner`
 * unsigned invocation through the injected guard client. The summary is decoded
 * from the produced XDR.
 */
async function guardedPayment(deps: PaymentDeps, intent: PaymentIntent): Promise<ChainToolResult> {
  if (typeof intent.asset !== "string") {
    throw new PaymentRefusal(
      "unsupported_asset",
      `asset must be a string code (allowed: USDC, XLM), got ${JSON.stringify(intent.asset)}`,
    );
  }
  const spec = deps.assets.get(intent.asset);
  if (!spec) {
    throw new PaymentRefusal(
      "unsupported_asset",
      `asset ${JSON.stringify(intent.asset)} is not supported (allowed: USDC, XLM)`,
    );
  }

  const amount = assertPositiveAmount(intent.amount);

  const rawRecipient = intent.recipient ?? intent.alias ?? "";
  if (typeof rawRecipient !== "string") {
    throw new PaymentRefusal(
      "unknown_recipient",
      `recipient must be an alias string, got ${JSON.stringify(rawRecipient)}`,
    );
  }
  const alias = rawRecipient.trim().toLowerCase();
  if (!alias) {
    throw new PaymentRefusal("unknown_recipient", "a recipient alias is required; raw addresses are not accepted");
  }
  const entry = resolveAlias(deps.aliases, alias);
  if (!entry) {
    throw new PaymentRefusal(
      "unknown_recipient",
      `recipient ${JSON.stringify(alias)} is not a known alias; add it to the alias book first (raw addresses are not accepted)`,
    );
  }

  if (!spec.native && deps.checkTrustline) {
    let ok: boolean;
    try {
      ok = await deps.checkTrustline(entry.address, spec);
    } catch (e) {
      throw new PaymentRefusal(
        "trustline_check_failed",
        `could not check the ${spec.code} trustline for ${alias}: ${(e as Error).message}`,
      );
    }
    if (!ok) {
      throw new PaymentRefusal(
        "recipient_no_trustline",
        `${alias} cannot hold ${spec.code} (no trustline); a payment would fail with op_no_trust`,
      );
    }
  }

  const guard = deps.guard;
  if (!guard) {
    throw new PaymentRefusal(
      "guarded_route_not_available",
      "The guarded payment route is not available: no guard client is configured",
    );
  }
  // The asset is resolved from the owner's own allowlist, never from agent
  // input (contracts/DEPLOYED.md, F-06). A guarded XLM payment is refused
  // unless its SAC id is supplied.
  const assetContractId = guardAssetContract(deps, spec.code);
  if (!assetContractId) {
    throw new PaymentRefusal(
      "unsupported_asset",
      `no SAC contract id is configured for guarded ${spec.code} payments`,
    );
  }

  let rule: Awaited<ReturnType<GuardClient["getRule"]>>;
  try {
    rule = await guard.getRule(deps.ownerAddress);
  } catch (e) {
    throw guardRefusal(e);
  }
  if (!rule) {
    throw new PaymentRefusal(
      "guard_rule_missing",
      `no polaris_guard rule is published for ${deps.ownerAddress}`,
    );
  }

  let executor: string | null;
  let recipientKnown: boolean;
  try {
    executor = await guard.getExecutor(deps.ownerAddress);
    recipientKnown = await guard.isKnownRecipient(deps.ownerAddress, entry.address);
  } catch (e) {
    throw guardRefusal(e);
  }

  const amountRaw = toRawUnits(amount);
  let chainRoute: "pay_executor" | "pay_owner";
  try {
    chainRoute = chooseGuardedRoute({ rule, executor, amountRaw, assetContractId, recipientKnown }).route;
  } catch (e) {
    throw guardRefusal(e);
  }

  // D10: the app-side profile can only narrow the chain decision. The default
  // is `always_ask`, so `pay_executor` is never chosen unless the owner has
  // explicitly enabled auto-pay.
  const profile = deps.approvalProfile ?? DEFAULT_APPROVAL_PROFILE;
  const route = resolveApprovalRoute(profile, chainRoute);

  let call: Awaited<ReturnType<GuardClient["payOwner"]>>;
  try {
    call =
      route === "pay_executor"
        ? await guard.payExecutor(executor as string, deps.ownerAddress, entry.address, assetContractId, amountRaw)
        : await guard.payOwner(deps.ownerAddress, entry.address, assetContractId, amountRaw);
  } catch (e) {
    throw guardRefusal(e);
  }

  const { summary } = buildGuardedPaymentSummary({
    unsignedXdr: call.unsignedXdr,
    networkPassphrase: deps.networkPassphrase,
    contractId: guard.contractId,
    route,
    alias,
    assetCode: spec.code,
    ...(deps.explorerBase ? { explorerBase: deps.explorerBase } : {}),
  });
  // State the path and whether a card is required; `pay_executor` is only ever
  // reachable after the owner enabled auto-pay (see profile above).
  summary.lines.push(
    `Approval profile: ${profile.mode}`,
    `Approval card required: ${requiresApprovalCard(route) ? "yes" : "no"}`,
  );
  return { unsignedXdr: call.unsignedXdr, summary };
}
