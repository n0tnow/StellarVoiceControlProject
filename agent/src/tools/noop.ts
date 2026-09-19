import type { AgentTool } from "./registry.ts";

export interface NoopInput {
  /** Anything the model wants echoed back; proves tool-use plumbing works. */
  echo: string;
}

export interface NoopOutput {
  echoed: string;
  at: string;
}

/**
 * The mock tool required by step A2: it moves no value and talks to no chain, it
 * only proves that a transcript -> tool call -> tool result round trip works end
 * to end. Step A5 replaces it with Owner B's real `ChainTool`.
 */
export const noopTool: AgentTool<NoopInput, NoopOutput> = {
  name: "noop",
  description:
    "Echo the given text back. Use this to verify the tool-use round trip; it never touches the chain.",
  inputSchema: {
    type: "object",
    properties: {
      echo: { type: "string", description: "Text to echo back." },
    },
    required: ["echo"],
    additionalProperties: false,
  },
  requiresApproval: false,
  async run(input: NoopInput): Promise<NoopOutput> {
    return { echoed: input.echo, at: new Date().toISOString() };
  },
};