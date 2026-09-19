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
  | "account_not_found";

/**
 * Machine-readable refusal. The shared `ChainToolResult` has no refusal field,
 * so refusals are thrown; the shell turns them into events later. The shell
 * should match on `code`, never on the human `message`.
 */
export class PaymentRefusal extends Error {
  readonly code: PaymentRefusalCode;
  constructor(code: PaymentRefusalCode, message: string) {
    super(message);
    this.name = "PaymentRefusal";
    this.code = code;
  }
}

/** RESERVED field (docs/confidential-payments.md §4.1); absent means "public". */
export type PaymentMode = "public" | "confidential" | "private";
/** Only `direct` is implemented; `guarded` is a later task. */
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
  /** Defaults to "direct". `"guarded"` is refused until the guard client lands. */
  route?: PaymentRoute;
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
    if (deps.route && deps.route !== "direct") {
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
    const unsignedXdr = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: deps.networkPassphrase,
      timebounds: { minTime: now, maxTime: new Date(now.getTime() + windowSeconds * 1000) },
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
