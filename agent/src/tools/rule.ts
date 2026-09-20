/**
 * `set_approval_rule` — set a spending rule by voice (voice-dialog).
 *
 * Like the other value-moving tools it is **not executable** here: it validates
 * the model's arguments into a `guard_policy` intent carrying an
 * `ApprovalRulePayload` proposal. The shell shows the proposal and the executor
 * answers that autonomous rules are not enabled in this build yet; a weakening
 * change (raising a limit) is never applied silently by voice.
 *
 * "dollar"/"dolar" is ambiguous for a limit — the user may mean USDC or XLM — so
 * an unnamed asset is a clarification (`AgentError.pending`), not a guess. The
 * same `pending` mechanism lets the next utterance ("USDC") complete the rule.
 */
import type { ApprovalRulePayload, Intent } from "@polaris/interfaces";

import { describeSupportedAssets, normalizeAsset } from "../assets.ts";
import type { PendingClarificationDraft } from "../dialog.ts";
import { AgentError } from "../errors.ts";
import type { AgentTool, ToolContext } from "./registry.ts";

const DECIMAL = /^\d+(?:\.\d+)?$/;

function bad(message: string, pending?: PendingClarificationDraft): never {
  throw new AgentError("input", `set_approval_rule arguments rejected: ${message}`, pending);
}

/** Raw model output for a rule change. Amounts may arrive as strings or numbers. */
export interface SetApprovalRuleInput {
  mode?: unknown;
  autoApproveLimit?: unknown;
  asset?: unknown;
  perTxLimit?: unknown;
  dailyLimit?: unknown;
  knownRecipientsOnly?: unknown;
  language?: unknown;
}

/** Canonicalises the profile mode, accepting a couple of spoken synonyms. */
export function normalizeRuleMode(value: unknown): ApprovalRulePayload["mode"] | undefined {
  if (typeof value !== "string") return undefined;
  const folded = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["always_ask", "always", "ask", "manual", "off"].includes(folded)) return "always_ask";
  if (["auto_under_limit", "auto", "auto_approve", "automatic"].includes(folded)) {
    return "auto_under_limit";
  }
  return undefined;
}

/** A required/optional positive decimal as a string, or `undefined`. */
function optionalDecimal(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const asString = typeof value === "number" ? String(value) : value;
  if (typeof asString !== "string") bad(`${field} must be a decimal string`);
  const trimmed = asString.trim();
  if (trimmed.length === 0) return undefined;
  if (!DECIMAL.test(trimmed) || !/[1-9]/.test(trimmed)) {
    bad(`${field} is not a positive decimal: "${trimmed}"`);
  }
  return trimmed;
}

/** A boolean from a boolean or a spoken word ("yes", "only", "true"). */
function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const folded = value.trim().toLowerCase();
    if (["true", "yes", "only", "evet", "sadece"].includes(folded)) return true;
    if (["false", "no", "any", "anyone", "hayir", "herkes"].includes(folded)) return false;
  }
  bad(`${field} must be a boolean`);
}

/** Validates a model-supplied rule change into a `guard_policy` proposal. */
export function parseSetApprovalRule(input: unknown, ctx: ToolContext): Intent {
  if (typeof input !== "object" || input === null) {
    bad("arguments were not an object");
  }
  const raw = input as SetApprovalRuleInput;
  const autoApproveLimit = optionalDecimal(raw.autoApproveLimit, "autoApproveLimit");
  const perTxLimit = optionalDecimal(raw.perTxLimit, "perTxLimit");
  const dailyLimit = optionalDecimal(raw.dailyLimit, "dailyLimit");
  const knownRecipientsOnly = optionalBoolean(raw.knownRecipientsOnly, "knownRecipientsOnly");

  const contactsOnly = knownRecipientsOnly === true && !autoApproveLimit && !perTxLimit && !dailyLimit;
  // "sadece kayıtlı kişilere" names no limit, so it carries no mode; treat it as a
  // contacts-only change on top of the auto profile rather than rejecting it.
  const mode = normalizeRuleMode(raw.mode) ?? (contactsOnly ? "auto_under_limit" : undefined);
  if (!mode) bad(`mode must be "always_ask" or "auto_under_limit"`);

  let asset: string | undefined;
  if (raw.asset !== undefined && raw.asset !== null && String(raw.asset).trim().length > 0) {
    asset = normalizeAsset(raw.asset);
    if (asset === undefined) {
      bad(`asset "${String(raw.asset)}" is not supported; supported assets are: ${describeSupportedAssets()}`);
    }
  }

  if (mode === "auto_under_limit") {
    if (!autoApproveLimit && !contactsOnly) {
      bad("autoApproveLimit is required for auto_under_limit");
    }
    if (autoApproveLimit && !asset) {
      // "under 10 dollars" names no asset: dollar/dolar could be USDC or XLM.
      bad("asset is ambiguous", {
        kind: "guard_policy",
        filledSlots: { mode, autoApproveLimit },
        missing: ["asset"],
        question: "rule_asset",
      });
    }
  }

  const rule: ApprovalRulePayload = {
    mode,
    ...(asset ? { asset } : {}),
    ...(autoApproveLimit ? { autoApproveLimit } : {}),
    ...(perTxLimit ? { perTxLimit } : {}),
    ...(dailyLimit ? { dailyLimit } : {}),
    ...(knownRecipientsOnly !== undefined ? { knownRecipientsOnly } : {}),
  };

  return {
    kind: "guard_policy",
    asset: asset ?? "",
    amount: autoApproveLimit ?? "0",
    rule,
    source: ctx.transcript,
  };
}

export const setApprovalRuleTool: AgentTool<SetApprovalRuleInput, Intent> = {
  name: "set_approval_rule",
  description:
    "Change the spending rule by voice: ask for approval always, or auto-approve payments up to a limit (optionally per day, or only for saved contacts). Produces a proposal the user must still approve.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["always_ask", "auto_under_limit"],
        description:
          '"always_ask" = every payment needs approval; "auto_under_limit" = payments up to the limit need no approval. Omit only when knownRecipientsOnly is used alone.',
      },
      autoApproveLimit: {
        type: "string",
        description:
          'Biggest single auto-approved payment, as a decimal string ("5"). Required for auto_under_limit. Omit when the user said "dollar/dolar" — the asset is ambiguous and must be asked.',
      },
      asset: {
        type: "string",
        description:
          `Asset the limits apply to; only ${describeSupportedAssets()} are supported. Omit it for "dollar/dolar" and ask which one.`,
      },
      perTxLimit: { type: "string", description: 'Hard per-payment ceiling as a decimal string, e.g. "5".' },
      dailyLimit: { type: "string", description: 'Daily ceiling as a decimal string, e.g. "50".' },
      knownRecipientsOnly: {
        type: "boolean",
        description: "When true, the agent may only pay saved contacts. May be used alone.",
      },
      language: {
        type: "string",
        description:
          'The language the user spoke, as a BCP-47 base code ("tr" or "en"). Used to pick the reply voice; never spoken.',
      },
    },
    required: [],
    additionalProperties: false,
  },
  requiresApproval: true,
  toIntent: parseSetApprovalRule,
  async run(input: SetApprovalRuleInput, ctx: ToolContext): Promise<Intent> {
    return parseSetApprovalRule(input, ctx);
  },
};
