/**
 * Provider benchmark (step A11).
 *
 *   caffeinate -i npm run bench:providers -w @polaris/agent
 *   caffeinate -i npm run bench:providers -w @polaris/agent -- --reps=5
 *
 * Compares `glm-5.3-flash` (OpenCode Zen Go), `claude-sonnet-5` and
 * `claude-haiku-4-5` on the same three inputs — a Turkish payment command, an
 * English payment command and a chat line — and reports median/min/max latency
 * plus whether each run produced the expected tool call.
 *
 * The Anthropic half uses the **official `@anthropic-ai/sdk`**, per the task's
 * rule for Node code. The Rust transport has no Anthropic SDK, so it implements
 * the wire format directly (`app/src-tauri/src/agent.rs`) — that split is
 * deliberate. The OpenAI-compatible half reuses the shipped client.
 *
 * It is opt-in (real, metered calls) and never part of `npm test`. If
 * `ANTHROPIC_API_KEY` is absent, the Anthropic rows are reported as not run
 * rather than invented; the GLM rows still run.
 */
import Anthropic from "@anthropic-ai/sdk";

import { POLARIS_SYSTEM_PROMPT } from "./prompt.ts";
import { createDefaultRegistry } from "./runtime.ts";
import { openAiOptionsFromEnv } from "./llm/config.ts";
import { OpenAiCompatibleLlm } from "./llm/openai.ts";
import { languageFromToolCalls } from "./language.ts";

interface BenchInput {
  name: string;
  transcript: string;
  /** The tool the correct answer must call, or `null` for a conversational turn. */
  expectTool: "send_payment" | null;
}

const INPUTS: BenchInput[] = [
  { name: "tr payment", transcript: "Ahmete 5 USDC gönder", expectTool: "send_payment" },
  { name: "en payment", transcript: "can you send 400 dollar to bilal", expectTool: "send_payment" },
  { name: "chat", transcript: "hello can you hear me", expectTool: null },
];

const registry = createDefaultRegistry();
/** The port's tool shape (OpenAI-compatible `parameters` come from `inputSchema`). */
const definitions = registry.definitions();
/** The same tools in Anthropic's `input_schema` shape, for the SDK path. */
const anthropicTools = definitions.map((tool) => ({
  name: tool.name,
  description: tool.description,
  input_schema: tool.inputSchema,
})) as unknown as Anthropic.Tool[];

const repsArg = process.argv.find((argument) => argument.startsWith("--reps="));
const REPS = Math.max(1, Number(repsArg?.split("=")[1] ?? "3") || 3);

interface Sample {
  provider: string;
  model: string;
  input: string;
  latencyMs: number;
  toolCalled: string | null;
  correct: boolean;
  language?: string;
  error?: string;
}

function anthropicToolNames(content: Anthropic.ContentBlock[]): {
  names: string[];
  language: string | undefined;
} {
  const names: string[] = [];
  const calls: Array<{ input: unknown }> = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      names.push(block.name);
      calls.push({ input: block.input });
    }
  }
  return { names, language: languageFromToolCalls(calls) };
}

async function runOpenAiCompatible(
  provider: string,
  model: string,
  input: BenchInput,
): Promise<Sample> {
  const llm = new OpenAiCompatibleLlm({ ...openAiOptionsFromEnv(process.env), model });
  const started = performance.now();
  try {
    const turn = await llm.turn({
      transcript: input.transcript,
      system: POLARIS_SYSTEM_PROMPT,
      tools: definitions,
    });
    const toolCalled = turn.toolCalls[0]?.name ?? null;
    return {
      provider,
      model,
      input: input.name,
      latencyMs: Math.round(performance.now() - started),
      toolCalled,
      correct: toolCalled === input.expectTool,
      ...(turn.language ? { language: turn.language } : {}),
    };
  } catch (error) {
    return {
      provider,
      model,
      input: input.name,
      latencyMs: Math.round(performance.now() - started),
      toolCalled: null,
      correct: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runAnthropic(
  provider: string,
  model: string,
  input: BenchInput,
  apiKey: string,
): Promise<Sample> {
  const client = new Anthropic({ apiKey });
  const started = performance.now();
  try {
    const message = await client.messages.create({
      model,
      max_tokens: 1024,
      system: POLARIS_SYSTEM_PROMPT,
      messages: [{ role: "user", content: input.transcript }],
      tools: anthropicTools,
      tool_choice: { type: "auto" },
      // No sampling parameters: the current Claude models (Sonnet 5, Opus 5,
      // …) reject `temperature` with HTTP 400. Same rule as the shipped client.
      // Sonnet 5 disables thinking explicitly; Haiku 4.5 must not receive the
      // field at all (and never `output_config.effort`, which it rejects).
      ...(/haiku/i.test(model) ? {} : { thinking: { type: "disabled" as const } }),
    });
    const { names, language } = anthropicToolNames(message.content);
    const toolCalled = names[0] ?? null;
    return {
      provider,
      model,
      input: input.name,
      latencyMs: Math.round(performance.now() - started),
      toolCalled,
      correct: toolCalled === input.expectTool,
      ...(language ? { language } : {}),
    };
  } catch (error) {
    return {
      provider,
      model,
      input: input.name,
      latencyMs: Math.round(performance.now() - started),
      toolCalled: null,
      correct: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
const samples: Sample[] = [];

for (const input of INPUTS) {
  for (let rep = 0; rep < REPS; rep += 1) {
    process.stderr.write(`running glm-5.3-flash / ${input.name} (${rep + 1}/${REPS})…\n`);
    samples.push(await runOpenAiCompatible("glm", "glm-5.3-flash", input));
  }
}

if (anthropicKey.length === 0) {
  process.stderr.write(
    "\npolaris: ANTHROPIC_API_KEY is not set — the Anthropic rows are NOT RUN. " +
      "Set it in the root .env and re-run to fill them in.\n",
  );
} else {
  for (const model of ["claude-sonnet-5", "claude-haiku-4-5"]) {
    for (const input of INPUTS) {
      for (let rep = 0; rep < REPS; rep += 1) {
        process.stderr.write(`running ${model} / ${input.name} (${rep + 1}/${REPS})…\n`);
        samples.push(await runAnthropic("anthropic", model, input, anthropicKey));
      }
    }
  }
}

console.log(`\n# Provider benchmark — ${REPS} rep(s) per input\n`);
console.log("| provider | model | input | median ms | min | max | correct | language |");
console.log("|---|---|---|---|---|---|---|---|");

const groups = new Map<string, Sample[]>();
for (const sample of samples) {
  const key = `${sample.provider}\u0000${sample.model}\u0000${sample.input}`;
  const bucket = groups.get(key) ?? [];
  bucket.push(sample);
  groups.set(key, bucket);
}

for (const [key, bucket] of groups) {
  const [provider, model, input] = key.split("\u0000");
  const latencies = bucket.map((sample) => sample.latencyMs);
  const correct = bucket.filter((sample) => sample.correct).length;
  const languages = [...new Set(bucket.map((sample) => sample.language ?? "-"))].join(",");
  const errors = bucket.find((sample) => sample.error)?.error;
  console.log(
    `| ${provider} | ${model} | ${input} | ${median(latencies)} | ${Math.min(...latencies)} | ` +
      `${Math.max(...latencies)} | ${correct}/${bucket.length}${errors ? " (error)" : ""} | ${languages} |`,
  );
}

if (!anthropicKey) {
  console.log(
    "\n> Anthropic rows were not run: `ANTHROPIC_API_KEY` is not set. No numbers are invented.",
  );
}
