/**
 * Manual entry point for the A2 round trip — the "enter" half of "speak/enter".
 *
 *   npm run cli -w @polaris/agent -- "Ahmete 5 USDC gönder"
 *   npm run cli -w @polaris/agent -- "bugün hava nasıl"
 *
 * Provider config is read from the environment (the npm script loads the
 * gitignored root `.env`). The result is JSON on stdout; events and the latency
 * line go to stderr so piping stdout stays clean. The API key is never printed.
 */
import { toAgentError } from "./errors.ts";
import { createEventBus } from "./events.ts";
import { runTurn } from "./loop.ts";
import { createAgentRuntime } from "./runtime.ts";

const transcript = process.argv.slice(2).join(" ").trim();
if (!transcript) {
  console.error('usage: npm run cli -w @polaris/agent -- "Ahmete 5 USDC gönder"');
  process.exit(2);
}

const bus = createEventBus();
bus.subscribe((event) => console.error(`  event: ${JSON.stringify(event)}`));

const { registry, llm } = createAgentRuntime();
console.error(`agent: model=${llm.model}, tools=${registry.size}`);

const started = Date.now();
try {
  const result = await runTurn({ transcript, registry, llm, bus });
  const latencyMs = Date.now() - started;
  console.error(
    result.intent ? `intent in ${latencyMs} ms` : `no intent in ${latencyMs} ms`,
  );
  console.log(
    JSON.stringify(
      {
        transcript,
        answer: result.answer,
        intent: result.intent ?? null,
        executedTools: result.executedTools,
        latencyMs,
      },
      null,
      2,
    ),
  );
} catch (error) {
  const agentError = toAgentError(error);
  console.error(
    `agent failed [${agentError.label}] after ${Date.now() - started} ms: ${agentError.detail}`,
  );
  process.exitCode = 1;
}
