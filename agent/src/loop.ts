import type { PolarisEvent } from "@polaris/interfaces";
import type { PolarisEventBus } from "./events.ts";
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

export interface AgentLlm {
  /** Model id, surfaced in the log pane so the demo shows what answered. */
  readonly model: string;
  /**
   * TODO(A2): implement with the Anthropic tool-use API (`@anthropic-ai/sdk`),
   * passing `tools` as the tool definitions. Kept behind this interface so the
   * loop is testable without a network call or an API key.
   */
  turn(input: {
    transcript: string;
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
  /** Overrides the transcript handed to tools (used by tests). */
  toolContext?: Partial<ToolContext>;
}

export interface AgentTurnResult {
  answer: string;
  executedTools: string[];
}

/**
 * One full agent turn: transcript in, `PolarisEvent`s out.
 *
 * Skeleton behaviour (step A2): emit `agent_status` for each stage, run every
 * requested tool, feed the results back to the model once, and return the final
 * answer. Approval-gated tools are *reported* here but executed only after the
 * shell's Touch ID gate (step A5).
 */
export async function runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { transcript, registry, llm, bus } = options;
  const context: ToolContext = {
    network: options.network ?? "testnet",
    transcript,
    ...options.toolContext,
  };

  try {
    bus.emit({ type: "agent_status", stage: "thinking" });
    const first = await llm.turn({ transcript, tools: registry.definitions() });

    const executedTools: string[] = [];
    const toolResults: string[] = [];
    for (const call of first.toolCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        throw new Error(`model requested unknown tool: ${call.name}`);
      }
      bus.emit({ type: "agent_status", stage: "tool_call" });
      const output = await tool.run(call.input as never, context);
      executedTools.push(tool.name);
      toolResults.push(`${tool.name} -> ${JSON.stringify(output)}`);
    }

    const answer = toolResults.length
      ? `${first.text ?? ""}${first.text ? "\n" : ""}${toolResults.join("\n")}`
      : (first.text ?? "(no answer)");

    if (toolResults.length) {
      bus.emit({ type: "transcript", text: answer, final: true });
    }
    bus.emit({ type: "agent_status", stage: "done" });
    return { answer, executedTools };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const event: PolarisEvent = { type: "error", message };
    bus.emit(event);
    throw error;
  }
}

/**
 * Deterministic stand-in for the real model: answers plainly, and calls the
 * `noop` tool when the transcript mentions one. Lets A2 be demoed before the
 * Anthropic key is wired up.
 */
export class MockLlm implements AgentLlm {
  readonly model = "mock";

  async turn(input: {
    transcript: string;
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
      text: `(mock) transcript received: "${input.transcript}" — real model wiring lands in step A2.`,
      toolCalls: [],
    };
  }
}
