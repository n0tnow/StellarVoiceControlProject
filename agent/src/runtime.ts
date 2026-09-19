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
import { sendPaymentTool } from "./tools/payment.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts";

/**
 * The production tool set: the real intent tool and nothing else.
 *
 * Step A5 trimmed the `noop` round-trip probe out of the default registry. Every
 * registered tool is serialised into **every** model request, and `noop` was a
 * demo artifact — it only added tokens (and reasoning) to real turns. It is still
 * exported and used by `demo.ts` and the loop tests.
 */
export function createDefaultRegistry(): ToolRegistry {
  return createToolRegistry().register(sendPaymentTool);
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
