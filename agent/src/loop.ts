import type { Intent, NavigationRequest } from "@polaris/interfaces";
import { clarificationSentence, DialogMemory, isCancelUtterance } from "./dialog.ts";
import { AgentError, isAgentError } from "./errors.ts";
import type { PolarisEventBus } from "./events.ts";
import { resolveTurnLanguage } from "./language.ts";
import { POLARIS_SYSTEM_PROMPT, withClock, withDetectedLanguage } from "./prompt.ts";
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
  /**
   * The BCP-47 language the model answered in, when it reported one (step A11).
   * A tool call carries it as an `input.language` field, a text answer as a
   * leading `[xx]` tag that the provider client strips from `text`. The TTS layer
   * uses it to pick a per-language voice; the reply text itself is already in the
   * user's language because the system prompt requires it.
   */
  language?: string;
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
  /**
   * The STT-detected language of the audio (step A12), as a BCP-47 tag. It is
   * passed to the model as a **hint** in the prompt, and it is only the
   * fallback for the reply/TTS language: the model's own assessment of the
   * transcript text wins (`resolveTurnLanguage`, inverted in A14).
   */
  transcriptLanguage?: string;
  /**
   * Conversation memory (voice-dialog). When present, the last exchanges and any
   * pending clarification are added to the prompt and the turn updates the memory;
   * absent keeps the old one-shot behaviour (the CLI/demo path).
   */
  dialog?: DialogMemory;
}

export interface AgentTurnResult {
  answer: string;
  executedTools: string[];
  /** The parsed value-moving intent, when the model produced a valid one. */
  intent?: Intent;
  /** Registry name of the tool that produced `intent`. */
  intentTool?: string;
  /**
   * A read-only navigation request (`navigate`), when the model opened a screen
   * by voice. Never set together with `intent`: a value-moving command wins.
   */
  navigation?: NavigationRequest;
  /** The reconciled turn language, forwarded to speech (steps A11/A12). */
  language?: string;
  /** Which side decided `language`: the model or the audio detector. */
  languageSource?: "stt" | "model";
}

/** Short human summary of an intent; the UI's single-line intent display. */
export function describeIntent(intent: Intent): string {
  const recipient = intent.recipient ?? intent.alias ?? "(unknown recipient)";
  if (intent.kind === "cancel_schedule") {
    return intent.scheduleId !== undefined
      ? `Cancel scheduled payment #${intent.scheduleId}.`
      : `Cancel the scheduled payment to ${recipient}.`;
  }
  if (intent.kind === "schedule_payment") {
    const when = intent.firstRun
      ? ` starting ${intent.firstRun.localDate} ${intent.firstRun.localTime}`
      : "";
    return `Schedule ${intent.amount} ${intent.asset} to ${recipient}${when}.`;
  }
  return `Send ${intent.amount} ${intent.asset} to ${recipient}.`;
}

/**
 * One full agent turn: transcript in, `PolarisEvent`s out.
 *
 * Behaviour (step A2):
 *
 * * The model sees the tool registry and either asks for a tool or answers.
 * * A **non-approval** tool (`noop`, `get_balance`) runs and its result is fed
 *   into the answer — the round-trip proof. A tool with a `toSpeech` form
 *   (`get_balance`) supplies the spoken sentence directly, so no JSON is read
 *   aloud and no second model turn is made.
 * * An **approval-gated** tool (`send_payment`) is never executed: its arguments
 *   are validated into an `Intent` and returned. Nothing in A2 reaches the
 *   chain, and no value moves.
 * * Bad arguments become a clarification, not an intent. So does more than one
 *   action at once.
 * * Provider failures propagate as `AgentError` after an `error` event, so the
 *   UI can show the short label while the terminal keeps the full detail.
 */
export async function runTurn(options: AgentTurnOptions): Promise<AgentTurnResult> {
  const { transcript, registry, llm, bus, dialog } = options;
  const now = options.toolContext?.now ?? new Date();
  const context: ToolContext = {
    network: options.network ?? "testnet",
    transcript,
    ...options.toolContext,
  };
  const system = withClock(
    withDetectedLanguage(options.system ?? POLARIS_SYSTEM_PROMPT, options.transcriptLanguage),
    now,
    options.toolContext?.timeZone,
  );
  // voice-dialog: the model sees what it just asked and what it already knows,
  // built from the pre-turn state (never the current utterance).
  const dialogBlock = dialog?.contextBlock(now.getTime()) ?? "";
  const prompt = dialogBlock.length > 0 ? `${system}\n\n${dialogBlock}` : system;
  dialog?.recordUser(transcript);

  try {
    bus.emit({ type: "agent_status", stage: "thinking" });
    const first = await llm.turn({ transcript, system: prompt, tools: registry.definitions() });

    // A14: the model's assessment of the transcript text is authoritative; the
    // STT label is a hint kept as the fallback. Say which won when the two
    // disagree, so the owner can see the detector's error rate.
    const language = resolveTurnLanguage(options.transcriptLanguage, first.language);
    if (language.disagreed) {
      console.warn(
        `language disagreement: STT detected "${language.detected}" but the model reported ` +
          `"${language.reported}" — using the model's report (judged from the transcript text)`,
      );
    }

    const executedTools: string[] = [];
    const toolResults: string[] = [];
    // Deterministic spoken forms of executed tool outputs (T1). A read-only tool
    // supplies one so the turn can answer aloud without a second model call.
    const spokenResults: string[] = [];
    const intents: Array<{ tool: string; intent: Intent }> = [];
    // Read-only navigation requests (NAV). Like spoken results they are produced
    // during the turn; unlike intents they never reach the approval gate.
    const navigations: NavigationRequest[] = [];
    let clarification: string | undefined;

    for (const call of first.toolCalls) {
      const tool = registry.get(call.name);
      if (!tool) {
        throw new AgentError("unknown_tool", `model requested unknown tool: ${call.name}`);
      }

      if (tool.requiresApproval) {
        // voice-dialog: an approval-gated tool may have a read-only branch for
        // this input (buying peer-to-peer opens the offers before anything signs).
        const readOnly = tool.toNavigationFor?.(call.input as never, context);
        if (readOnly) {
          navigations.push(readOnly);
          continue;
        }
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
            if (error.pending) {
              // voice-dialog: remember exactly which slot is missing so the next
              // utterance completes this request instead of starting over.
              dialog?.setPending(error.pending, now.getTime());
              clarification ??= clarificationSentence(error.pending.question, language.language);
            } else {
              clarification ??=
                `I couldn't turn that into a payment. Please repeat the amount, ` +
                `asset and recipient. (${error.detail})`;
            }
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
      const spoken = tool.toSpeech?.(output);
      if (spoken) spokenResults.push(spoken);
      const navigation = tool.toNavigation?.(output);
      if (navigation) navigations.push(navigation);
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
    } else if (spokenResults.length > 0) {
      // A tool that can answer in words owns the answer; the model's text and
      // the raw JSON never reach TTS (T1: deterministic, no second model turn).
      answer = spokenResults.join(" ");
    } else if (toolResults.length > 0) {
      answer = [first.text, ...toolResults]
        .filter((line): line is string => Boolean(line))
        .join("\n");
    } else {
      answer = first.text ?? "(no answer)";
    }

    // A value-moving intent outranks navigation: if the model produced both, the
    // payment is what matters and the screen request is dropped.
    const navigation = intents.length === 0 ? navigations[0] : undefined;

    // voice-dialog: settle the dialogue for the next utterance. An explicit
    // cancel or a completed/refused action clears it; a clarification keeps the
    // pending slot (already armed above) and the answer is remembered.
    if (dialog) {
      if (isCancelUtterance(transcript)) {
        dialog.reset();
      } else if (resolved || navigation || intents.length > 1) {
        dialog.reset();
      } else {
        dialog.recordAssistant(answer);
      }
    }

    if (toolResults.length > 0) {
      bus.emit({
        type: "transcript",
        text: answer,
        final: true,
        language: language.language ?? null,
      });
    }
    return {
      answer,
      executedTools,
      ...(resolved ? { intent: resolved.intent, intentTool: resolved.tool } : {}),
      ...(navigation ? { navigation } : {}),
      // The reconciled language is handed to the shell so the voice matches the
      // words (steps A11/A12). Absent means "unknown" — never guessed here.
      ...(language.language && language.source !== "none"
        ? { language: language.language, languageSource: language.source }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    bus.emit({ type: "error", message });
    throw error;
  } finally {
    // A turn always settles its stage — success *or* failure. Without this the
    // notch/trace stayed on the last stage ("thinking") after a provider error,
    // which is exactly the stuck state step A6 fixes.
    bus.emit({ type: "agent_status", stage: "done" });
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
