/**
 * Runnable smoke test for the agent skeleton.
 *
 *   npm run start -w @polaris/agent        # from the repo root
 *   node src/demo.ts                       # from agent/
 *
 * It runs two turns through the event bus and prints every `PolarisEvent` as it
 * is emitted — the same stream the Tauri log pane renders.
 */
import { createEventBus } from "./events.ts";
import { MockLlm, runTurn } from "./loop.ts";
import { createToolRegistry } from "./tools/registry.ts";
import { noopTool } from "./tools/noop.ts";

const bus = createEventBus();
bus.subscribe((event) => {
  console.log(`  event: ${JSON.stringify(event)}`);
});

const registry = createToolRegistry().register(noopTool);
const llm = new MockLlm();

const transcripts = [
  "what is Soroban?",
  "please run the noop tool with hello",
];

console.log(`agent skeleton — model=${llm.model}, tools=${registry.size}`);

for (const transcript of transcripts) {
  console.log(`\nturn: "${transcript}"`);
  const result = await runTurn({ transcript, registry, llm, bus });
  console.log(`  answer: ${result.answer.replace(/\n/g, " | ")}`);
  console.log(`  tools executed: ${result.executedTools.join(", ") || "(none)"}`);
}

console.log("\nagent skeleton OK");