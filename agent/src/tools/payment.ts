/**
 * `send_payment` — the first real Polaris tool (step A2).
 *
 * It is deliberately **not executable**: A2 stops at a parsed, validated
 * `Intent`. The tool validates whatever the model produced and returns the
 * `Intent` shape from `docs/interfaces.md` §1; the chain half (unsigned XDR +
 * summary, then the Touch ID gate) arrives in step A5. Nothing here touches the
 * network or the chain.
 *
 * Validation is local and strict because the model is the untrusted party: it
 * may return a number where a decimal string is required, omit the asset, or
 * hallucinate a negative amount. A rejected argument set is an `AgentError` of
 * kind `input`, which the loop reports as a clarification instead of storing a
 * bad intent.
 */
import type { Intent } from "@polaris/interfaces";
import { DEFAULT_ASSET, describeSupportedAssets, normalizeAsset } from "../assets.ts";
import { AgentError } from "../errors.ts";
import type { AgentTool, ToolContext } from "./registry.ts";

/** Raw model output for a payment. Amounts may arrive as a number or a string. */
export interface SendPaymentInput {
  amount?: unknown;
  asset?: unknown;
  recipient?: unknown;
  memo?: unknown;
}

/** The decimal-string money rule from `docs/interfaces.md` §1. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

function bad(message: string): never {
  throw new AgentError("input", `send_payment arguments rejected: ${message}`);
}

/** Normalises a decimal amount to a non-empty string, rejecting anything else. */
export function parseAmount(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) bad("amount is not a finite number");
    value = String(value);
  }
  if (typeof value !== "string") bad("amount must be a string or a number");
  const amount = value.trim();
  if (!DECIMAL.test(amount)) bad(`amount is not a positive decimal: "${amount}"`);
  if (!/[1-9]/.test(amount)) bad(`amount must be greater than zero: "${amount}"`);
  return amount;
}

/** Trims and requires a non-empty string field. */
function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    bad(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Validates a model-supplied payment and returns the shared `Intent`.
 *
 * `asset` is canonicalised against `assets.ts`: a blank value defaults to
 * `DEFAULT_ASSET` (the system prompt tells the model to omit it when the user
 * named no asset), a colloquial money word maps to the supported stablecoin,
 * and a genuinely unsupported code is rejected — a guess must become a
 * clarification, not an intent that reaches the approval seam. `recipient` is
 * kept verbatim (an address book alias like "Ahmet" is a valid recipient;
 * resolution is Owner B's job).
 */
export function parseSendPayment(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) {
    bad("arguments were not an object");
  }
  const raw = input as SendPaymentInput;
  const amount = parseAmount(raw.amount);
  const asset = normalizeAsset(raw.asset);
  if (asset === undefined) {
    bad(
      `asset "${String(raw.asset)}" is not supported; supported assets are: ` +
        `${describeSupportedAssets()}`,
    );
  }
  const recipient = requireText(raw.recipient, "recipient");
  const memo = raw.memo === undefined || raw.memo === null ? undefined : requireText(raw.memo, "memo");

  return {
    kind: "send",
    asset,
    amount,
    recipient,
    ...(memo ? { memo } : {}),
    source: ctx.transcript,
  };
}

export const sendPaymentTool: AgentTool<SendPaymentInput, Intent> = {
  name: "send_payment",
  description:
    "Send a Stellar payment. The recipient may be a name or alias from the user's address book.",
  inputSchema: {
    type: "object",
    properties: {
      amount: {
        type: "string",
        description: 'Positive decimal amount as a string, e.g. "5".',
      },
      asset: {
        type: "string",
        description: `Asset code; only ${describeSupportedAssets()} are supported. Defaults to ${DEFAULT_ASSET}.`,
      },
      recipient: {
        type: "string",
        description: 'Recipient name, alias or "G..." address, exactly as spoken.',
      },
      memo: { type: "string", description: "Optional memo." },
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). ' +
          "Used to pick the reply voice; never spoken.",
      },
    },
    required: ["amount", "asset", "recipient"],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseSendPayment,
  // Never called by the loop for an approval-gated tool; present because the
  // `AgentTool` contract requires it, and returning the parsed intent keeps the
  // tool honest if a caller ever invokes it directly.
  async run(input: SendPaymentInput, ctx: ToolContext): Promise<Intent> {
    return parseSendPayment(input, ctx);
  },
};
