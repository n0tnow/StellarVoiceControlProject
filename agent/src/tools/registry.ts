import type { Intent } from "@polaris/interfaces";

/**
 * Everything a tool is allowed to touch. Kept deliberately small in the skeleton;
 * Owner B's chain tools receive an extended context (network config, signing
 * service handle) in step A5.
 */
export interface ToolContext {
  /** Voice transcript excerpt that triggered this turn. */
  transcript: string;
  /** Testnet-only in this project (see docs/architecture.md §1 "Non-goals"). */
  network: "testnet";
}

/**
 * A tool the LLM may call. `inputSchema` is the JSON Schema handed to the
 * tool-use API — the same value is used for the model request and for local
 * validation, so there is exactly one description of each tool.
 */
export interface AgentTool<Input = unknown, Output = unknown> {
  name: string;
  /** Shown to the model; keep it short and action-oriented. */
  description: string;
  /** JSON Schema (object) describing `Input`. */
  inputSchema: Record<string, unknown>;
  /**
   * `true` for anything that moves value: the shell must gate the *result* of
   * the call behind Touch ID approval before it reaches the chain.
   */
  requiresApproval?: boolean;
  run(input: Input, ctx: ToolContext): Promise<Output>;
}

/** Chain tools take an `Intent` (see docs/interfaces.md §2). */
export type IntentTool = AgentTool<Intent>;

export class ToolRegistry {
  readonly #tools = new Map<string, AgentTool<never, unknown>>();

  register<Input, Output>(tool: AgentTool<Input, Output>): this {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    // The registry is type-erased on purpose: the model supplies `unknown` JSON,
    // individual tools re-validate their own input.
    this.#tools.set(tool.name, tool as unknown as AgentTool<never, unknown>);
    return this;
  }

  get(name: string): AgentTool<never, unknown> | undefined {
    return this.#tools.get(name);
  }

  /** Tool definitions passed to the LLM. */
  definitions(): Array<Pick<AgentTool, "name" | "description" | "inputSchema">> {
    return [...this.#tools.values()].map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  get size(): number {
    return this.#tools.size;
  }
}

export function createToolRegistry(): ToolRegistry {
  return new ToolRegistry();
}