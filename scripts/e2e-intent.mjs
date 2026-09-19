// A9 acceptance driver — the real turn and the real execution seam, headless.
//
//   npm run e2e:intent -- "Ahmete 5 USDC gönder"
//
// It is deliberately opt-in (real LLM call, needs the gitignored root `.env`)
// and never part of `npm test`. It runs the exact halves the shell runs:
//
//   1. the real agent runtime (OpenCode Zen Go) turns the transcript into an
//      `Intent`;
//   2. the A9 execution seam (`@polaris/agent`) dispatches it through the
//      approval placeholder to Owner B's real `@polaris/stellar` tool;
//   3. the shell's exact turn reducer (`app/src/lib/turnSession.ts`) is fed the
//      real event stream, so the printed stage order is the on-screen order.
//
// Today every chain tool throws `NotImplementedError`, so the expected result is
// `status: unavailable`, label `Chain not wired`, and a notch that settles.
import { createEventBus } from "../agent/src/events.ts";
import { createAutoApprovalPlaceholder, executeIntent } from "../agent/src/execution.ts";
import { runTurn } from "../agent/src/loop.ts";
import { createAgentRuntime } from "../agent/src/runtime.ts";
import { depositTry, guardPolicy, sendPayment, swap } from "../stellar/src/index.ts";
import { reduceTurnSession } from "../app/src/lib/turnSession.ts";

const transcript = process.argv.slice(2).join(" ").trim();
if (!transcript) {
  console.error('usage: npm run e2e:intent -- "Ahmete 5 USDC gönder"');
  process.exit(2);
}

const { registry, llm } = createAgentRuntime();
const bus = createEventBus();

// The shell's turn machine, fed exactly as `App.tsx` feeds it.
let session = null;
const stages = [];
const apply = (signal) => {
  session = reduceTurnSession(session, signal);
  stages.push(session ? session.stage : "idle(collapsed)");
};

bus.subscribe((event) => {
  if (event.type === "agent_status") {
    console.error(`event: agent_status ${event.stage}`);
    if (event.stage === "thinking") apply({ type: "transcribed" });
  }
});

console.error(`agent: model=${llm.model} tools=${registry.size} transcript=${JSON.stringify(transcript)}`);
apply({ type: "capture", state: "recording", label: null });
apply({ type: "capture", state: "ready", label: null });
apply({ type: "capture", state: "transcribing", label: null });
apply({ type: "capture", state: "idle", label: null });

const started = Date.now();
const result = await runTurn({ transcript, registry, llm, bus });
console.log(`intent in ${Date.now() - started} ms: ${JSON.stringify(result.intent)}`);

const outcome = await executeIntent(result.intent, {
  approver: createAutoApprovalPlaceholder(),
  chainTools: { send: sendPayment, swap, guard_policy: guardPolicy, deposit: depositTry },
});

if (outcome.status === "executed") {
  console.log(`execution executed: ${JSON.stringify(outcome.result.summary)}`);
} else {
  apply({ type: "failed", label: outcome.label });
  console.log(`execution ${outcome.status}: label=${JSON.stringify(outcome.label)}`);
  console.log(`  detail: ${outcome.detail}`);
}

console.log(`stage order: ${stages.join(" -> ")}`);
console.log(
  `notch label after turn: ${
    outcome.status === "executed" ? "Speaking" : JSON.stringify(session?.failureLabel)
  }`,
);
