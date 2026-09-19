/**
 * Default agent wiring (step A2).
 *
 * One place assembles the registry and the provider so the CLI, the demo and the
 * desktop app all run the same objects. The app swaps in a same-origin base URL
 * (its dev proxy) instead of the provider root; everything else is identical.
 */
import type { AgentLlm } from "./loop.ts";
import { openAiOptionsFromEnv, processEnv, type AgentEnv } from "./llm/config.ts";
import { OpenAiCompatibleLlm } from "./llm/openai.ts";
import { noopTool } from "./tools/noop.ts";
import { sendPaymentTool } from "./tools/payment.ts";
import { createToolRegistry, type ToolRegistry } from "./tools/registry.ts";

/** Every tool the demo agent exposes: the real intent tool plus the round-trip probe. */
export function createDefaultRegistry(): ToolRegistry {
  return createToolRegistry().register(sendPaymentTool).register(noopTool);
}

export interface AgentRuntime {
  registry: ToolRegistry;
  llm: AgentLlm;
}

/** Builds the default runtime from the environment (real provider, no network yet). */
export function createAgentRuntime(env: AgentEnv = processEnv()): AgentRuntime {
  return {
    registry: createDefaultRegistry(),
    llm: new OpenAiCompatibleLlm(openAiOptionsFromEnv(env)),
  };
}
