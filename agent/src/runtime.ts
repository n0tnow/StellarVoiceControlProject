/**
 * Default agent wiring (step A2).
 *
 * One place assembles the registry and the provider so the CLI, the demo and the
 * desktop app all run the same objects. The desktop app keeps this same client
 * and injects a Rust-backed `fetchImpl` (its transport); everything else is
 * identical.
 */
import type { AgentLlm } from "./loop.ts";
import { openAiOptionsFromEnv, processEnv, type AgentEnv } from "./llm/config.ts";
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

/** Builds the default runtime from the environment (real provider, no network yet). */
export function createAgentRuntime(env: AgentEnv = processEnv()): AgentRuntime {
  return {
    registry: createDefaultRegistry(),
    llm: new OpenAiCompatibleLlm(openAiOptionsFromEnv(env)),
  };
}
