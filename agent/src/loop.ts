import type { Intent } from "@polaris/interfaces";
import { AgentError, isAgentError } from "./errors.ts";
import type { PolarisEventBus } from "./events.ts";
import { POLARIS_SYSTEM_PROMPT } from "./prompt.ts";
import type { AgentTool, ToolContext, ToolRegistry } from "./tools/registry.ts";

/** A single tool invocation requested by the model. */
export interface LlmToolCall {
  name: string;
  input: unknown;
}

/** One model turn: either a final answer, tool calls, or both. */
export interface LlmTurn {
  text?: string;
  toolCalls: LlmToolCall[];
}

/**
 * The provider port (step A2). Anything that can turn a transcript plus a tool
 * list into tool calls satisfies it: the real OpenAI-compatible client, the
 * deterministic `MockLlm`, and the test `ScriptedLlm`.
 */
export interface AgentLlm {
  /** Model id, surfaced in the log pane so the demo shows what answered. */
  readonly model: string;
  turn(input: {
    transcript: string;
    /** System prompt, passed in so the prompt is provider-independent. */
    system: string;
    tools: Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
  }): Promise<LlmTurn>;
}

export interface AgentTurnOptions {
  transcript: string;
  registry: ToolRegistry;
  llm: AgentLlm;
  bus: PolarisEventBus;
  /** Defaults to testnet; see docs/architecture.md §1 "Non-goals". */
  network?: "testnet";
  /** Overrides the built-in Polaris prompt (used by tests). */
  system?: string;
  /** Overrides the transcript handed to tools (used by tests). */
  toolContext?: Partial<ToolContext>;
}

export interface AgentTurnResult {
  answer: string;
  executedTools: string[];
  /** The parsed value-moving intent, when the model produced a valid one. */
  intent?: Intent;
  /** Registry name of the tool that produced `intent`. */
  intentTool?: string;
}

/** Short human summary of an intent; the UI's single-line intent display. */
export function describeIntent(intent: Intent): string {
  const recipient = intent.recipient ?? intent.alias ?? "(unknown recipient)";
  return `Send ${intent.amount} ${intent.asset} to ${recipient}.`;
}

/**
 * One full agent turn: transcript in, `PolarisEvent`s out.
 *
 * Behaviour (step A2):
 *
 * * The model sees the tool registry and either asks for a tool or answers.
 * * A **non-approval** tool (`noop`) runs and its result is fed into the answer —
 *   this is the round-trip proof.
 * * An **approval-gated** tool (`send_payment`) is never executed: its arguments
 *   are validated into an `Intent` and returned. Nothing in A2 reaches the
 *   chain, and no value moves.
 * * Bad arguments become a clarification, not an intent. So does more than one
 *   action at once.
 * * Provider failures propagate as `AgentError` after an `error` event, so the
 *   UI can show the short label while the terminal keeps the full detail.
 */
export async function runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { transcript, registry, llm, bus } = options;
  const context: ToolContext = {
    network: options.network ?? "testnet",
    transcript,
    ...options.toolContext,
  };
  const system = options.system ?? POLARIS_SYSTEM_PROMPT;

  try {
    bus.emit({ type: "agent_status", stage: "thinking" });
    const first = await llm.turn({ transcript, system, tools: registry.definitions() });

    const executedTools: string[] = [];
    const toolResults: string[] = [];
    const intents: Array<{ tool: string; intent: Intent }> = [];
    let clarification: string | undefined;

    for (const call of first.toolCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        throw new AgentError("unknown_tool", `model requested unknown tool: ${call.name}`);
      }

      if (tool.requiresApproval) {
        if (!tool.toIntent) {
          throw new AgentError("config", `approval-gated tool ${tool.name} does not implement toIntent()`);
        }
        try {
          const intent = tool.toIntent(call.input as never, context);
          intents.push({ tool: tool.name, intent });
          bus.emit({ type: "agent_status", stage: "awaiting_approval" });
        } catch (error) {
          if (isAgentError(error) && error.kind === "input") {
            // The model's tool call could not be trusted. Ask instead of storing
            // a bogus intent (docs/architecture.md §6: the LLM proposes).
            clarification ??=
              `I couldn't turn that into a payment. Please repeat the amount, ` +
              `asset and recipient. (${error.detail})`;
          } else {
            throw error;
          }
        }
        continue;
      }

      bus.emit({ type: "agent_status", stage: "tool_call" });
      const output = await tool.run(call.input as never, context);
      executedTools.push(tool.name);
      toolResults.push(`${tool.name} -> ${JSON.stringify(output)}`);
    }

    let answer: string;
    let resolved: { tool: string; intent: Intent } | undefined;

    if (clarification !== undefined) {
      answer = clarification;
    } else if (intents.length > 1) {
      answer = "I can only prepare one action at a time. Which payment should I set up?";
    } else if (intents.length === 1 && intents[0]) {
      resolved = intents[0];
      answer = describeIntent(resolved.intent);
    } else if (toolResults.length > 0) {
      answer = [first.text, ...toolResults]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    } else {
      answer = first.text ?? "(no answer)";
    }

    if (toolResults.length > 0) {
      bus.emit({ type: "transcript", text: answer, final: true });
    }
    bus.emit({ type: "agent_status", stage: "done" });
    return {
      answer,
      executedTools,
      ...(resolved ? { intent: resolved.intent, intentTool: resolved.tool } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bus.emit({ type: "error", message });
    throw error;
  }
}

/**
 * Deterministic stand-in for the real model: answers plainly, and calls the
 * `noop` tool when the transcript mentions one. Keeps the loop testable and the
 * demo runnable without a key or a network call.
 */
export class MockLlm implements AgentLlm {
  readonly model = "mock";

  async turn(input: {
    transcript: string;
    system: string;
    tools: Array<Pick<AgentTool, "name" | "description" | "inputSchema">>;
  }): Promise<LlmTurn> {
    const wantsTool = /noop|tool/i.test(input.transcript);
    const hasNoop = input.tools.some((tool) => tool.name === "noop");
    if (wantsTool && hasNoop) {
      return {
        text: "(mock) calling the noop tool to prove the round trip.",
        toolCalls: [{ name: "noop", input: { echo: input.transcript } }],
      };
    }
    return {
      text: `(mock) transcript received: "${input.transcript}".`,
      toolCalls: [],
    };
  }
}
