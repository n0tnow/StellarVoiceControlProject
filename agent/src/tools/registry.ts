import type { Intent, NavigationRequest } from "@polaris/interfaces";
import type { BalanceReader } from "./balance.ts";
import type { ContactStore } from "./contact.ts";

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
  /**
   * Known recipient aliases (canonical name -> `G...` address), supplied by the
   * shell (step F2). Validation uses them to accept a recipient the model
   * returned as "wallet 2" or "hesap 2" by resolving it to `acc2`.
   */
  aliases?: Record<string, string>;
  /**
   * The device's IANA zone, used to interpret schedule wall-clock times when the
   * user named no zone (W6b). Optional so workers that do not need it can omit
   * it; schedule tools fall back to `Intl`'s resolved zone.
   */
  timeZone?: string;
  /** The turn's clock, for "tomorrow"/"next Friday" resolution and tests. */
  now?: Date;
  /**
   * Reads the connected wallet's balances from Horizon (T1). Injected because
   * the agent core never talks to the chain itself: the app builds it from
   * `stellar_config`, tests supply a fake. Absent means `get_balance` cannot
   * read anything and says so instead of guessing.
   */
  readBalances?: BalanceReader;
  /**
   * The saved recipients, for `save_contact`/`list_contacts`/`delete_contact`
   * (W15f). Injected because the agent core never touches the Rust store; the
   * app binds it to the `contacts_*` commands. Absent means the tools say they
   * cannot read or write the book instead of guessing.
   */
  contacts?: ContactStore;
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
  /**
   * Approval-gated tools **must not run** during the agent turn. Instead the
   * loop validates the model's arguments and turns them into a structured
   * `Intent` — this is the whole output of step A2. Implementations throw an
   * `AgentError` of kind `input` when the arguments cannot be trusted, which the
   * loop converts into a clarification rather than a bogus intent.
   */
  toIntent?(input: Input, ctx: ToolContext): Intent;
  run(input: Input, ctx: ToolContext): Promise<Output>;
  /**
   * Optional deterministic spoken form of `run`'s output (T1). When present the
   * loop speaks this sentence instead of the raw tool JSON, so a read-only tool
   * can answer aloud without a second model turn. It must be a short sentence
   * and must never contain a secret.
   */
  toSpeech?(output: Output): string;
  /**
   * Optional structured navigation request produced by a read-only tool
   * (`navigate`). Like `toSpeech`, the loop extracts it from the tool's output
   * during the turn; unlike `toIntent` it never reaches the approval gate or the
   * chain.
   */
  toNavigation?(output: Output): NavigationRequest | undefined;
  /**
   * Optional read-only branch of an **approval-gated** tool (voice-dialog): for
   * an input that should open a screen instead of building an intent (e.g. buying
   * peer-to-peer before an offer id is known). Checked before `toIntent`; the
   * intent is not built when a navigation is returned.
   */
  toNavigationFor?(input: Input, ctx: ToolContext): NavigationRequest | undefined;
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