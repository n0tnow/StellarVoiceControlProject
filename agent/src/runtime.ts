/**
 * Default agent wiring (step A2).
 *
 * One place assembles the registry and the provider so the CLI, the demo and the
 * desktop app all run the same objects. The desktop app keeps this same client
 * and injects a Rust-backed `fetchImpl` (its transport); everything else is
 * identical.
 */
import type { AgentLlm } from "./loop.ts";
import {
  anthropicOptionsFromEnv,
  openAiOptionsFromEnv,
  processEnv,
  resolveProvider,
  type AgentEnv,
} from "./llm/config.ts";
import { AnthropicLlm } from "./llm/anthropic.ts";
import { OpenAiCompatibleLlm } from "./llm/openai.ts";
import { depositTool, withdrawTool } from "./tools/anchor.ts";
import { getBalanceTool } from "./tools/balance.ts";
import { deleteContactTool, listContactsTool, saveContactTool } from "./tools/contact.ts";
import { navigateTool } from "./tools/navigate.ts";
import { sendPaymentTool } from "./tools/payment.ts";
import { setApprovalRuleTool } from "./tools/rule.ts";
import { buyAssetTool, sellAssetTool } from "./tools/sell.ts";
import { cancelScheduleTool, schedulePaymentTool } from "./tools/schedule.ts";
import { p2pAcceptTool, p2pConfirmTool, p2pOfferTool } from "./tools/p2p.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts";

/**
 * The production tool set: the value-moving intent tools and nothing else.
 *
 * Step A5 trimmed the `noop` round-trip probe out of the default registry. Every
 * registered tool is serialised into **every** model request, and `noop` was a
 * demo artifact — it only added tokens (and reasoning) to real turns. It is still
 * exported and used by `demo.ts` and the loop tests. W5b adds `deposit` and
 * `withdraw` for the anchor on/off-ramp, W6b the two schedule tools and W8b the
 * P2P escrow tools; they all validate into an `Intent` and never touch the chain.
 * `get_balance` (T1) is the one read-only tool: it returns balances, never an
 * `Intent`, and the loop speaks its `toSpeech` sentence. `navigate` (NAV) is the
 * other read-only tool: it returns a `NavigationRequest`, never an `Intent`.
 * W15f adds the contact tools (`save_contact`, `list_contacts`,
 * `delete_contact`): read-only, no approval, no intent.
 */
export function createDefaultRegistry(): ToolRegistry {
  return createToolRegistry()
    .register(sendPaymentTool)
    .register(getBalanceTool)
    .register(navigateTool)
    .register(depositTool)
    .register(withdrawTool)
    .register(schedulePaymentTool)
    .register(cancelScheduleTool)
    .register(p2pOfferTool)
    .register(p2pAcceptTool)
    .register(p2pConfirmTool)
    // voice-dialog: rules by voice and the sell/buy routing layer. `set_approval_rule`
    // only proposes a `guard_policy` rule; `sell_asset`/`buy_asset` map onto the
    // existing withdraw/p2p_offer/deposit/p2p_accept executors.
    .register(setApprovalRuleTool)
    .register(sellAssetTool)
    .register(buyAssetTool)
    // W15f: the address book by voice or typed prompt. All read-only (no
    // approval, no intent); the shell injects `ToolContext.contacts`.
    .register(saveContactTool)
    .register(listContactsTool)
    .register(deleteContactTool);
}

export interface AgentRuntime {
  registry: ToolRegistry;
  llm: AgentLlm;
}

/**
 * Builds the default runtime from the environment.
 *
 * `POLARIS_AGENT_PROVIDER` picks the implementation behind the `AgentLlm` port:
 * the OpenAI-compatible client (default) or the Anthropic Messages client. An
 * unknown value falls back to OpenAI-compatible and warns, so a typo cannot
 * silently change where the request goes.
 */
export function createAgentRuntime(env: AgentEnv = processEnv()): AgentRuntime {
  const { provider, recognized } = resolveProvider(env);
  if (!recognized) {
    console.warn(
      `polaris: unknown POLARIS_AGENT_PROVIDER — using the OpenAI-compatible default ` +
        `(accepted values are \`openai\` and \`anthropic\`)`,
    );
  }
  return {
    registry: createDefaultRegistry(),
    llm:
      provider === "anthropic"
        ? new AnthropicLlm(anthropicOptionsFromEnv(env))
        : new OpenAiCompatibleLlm(openAiOptionsFromEnv(env)),
  };
}
