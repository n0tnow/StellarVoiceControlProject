/**
 * Opt-in end-to-end check (steps A4/A5) — a real turn spoken through the real TTS.
 *
 *   npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"   # intent
 *   npm run e2e:speak -w @polaris/agent -- "hello can you hear me"  # answer
 *
 * It chains the actual halves the app runs, with no stubs:
 *
 *   1. the real agent runtime (OpenCode Zen Go) turns the transcript into an
 *      `Intent`, or into a plain conversational answer;
 *   2. `spokenText` turns that result into the sentence the app would say — the
 *      confirmation sentence for an intent, the trimmed answer otherwise
 *      (`@polaris/agent` `speech.ts`);
 *   3. the Rust live test `manual_live_fish_synthesises_mpeg_and_speaks` speaks
 *      that exact sentence through the real Fish Audio backend and the pinned
 *      `reference_id`, via the production streaming path (bytes piped into the
 *      player), asserting the payload is non-empty MPEG.
 *
 * A turn **without an intent is still a spoken turn** — that is the A5 bug this
 * driver once reintroduced by treating "no intent" as "nothing to say". Only a
 * genuinely empty sentence (a blank answer) stops the driver.
 *
 * It is deliberately **not** part of `npm test`: it makes a real LLM call and a
 * real Fish Audio call, and audio plays aloud. It needs the gitignored root
 * `.env` (the `npm script` loads it) and a human-visible machine.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createEventBus } from "./events.ts";
import { runTurn } from "./loop.ts";
import { createAgentRuntime } from "./runtime.ts";
import { isSpeakable, spokenText } from "./speech.ts";

const transcript = process.argv.slice(2).join(" ").trim();
if (!transcript) {
  console.error('usage: npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"');
  process.exit(2);
}

const bus = createEventBus();
bus.subscribe((event) => {
  if (event.type === "agent_status") {
    console.error(`  event: agent_status ${event.stage}`);
  }
});

const { registry, llm } = createAgentRuntime();
console.error(`agent: model=${llm.model}, tools=${registry.size}, transcript=${JSON.stringify(transcript)}`);

const started = Date.now();
const result = await runTurn({ transcript, registry, llm, bus });
const intentMs = Date.now() - started;

// A turn without an intent is NOT a failed turn: the model answered
// conversationally and that answer is what gets spoken (A5 bug fix). Only a
// blank answer leaves nothing to say — an internal error never reaches here.
if (!isSpeakable(result)) {
  console.error(
    `nothing to speak in ${intentMs} ms — the model produced a blank answer ` +
      `(${JSON.stringify(result.answer)})`,
  );
  process.exit(1);
}

const sentence = spokenText(result);
if (result.intent) {
  console.log(`intent in ${intentMs} ms: ${JSON.stringify(result.intent)}`);
} else {
  console.log(`no intent in ${intentMs} ms — speaking the conversational answer`);
}
console.log(`spoken sentence: ${sentence}`);
// Step A11: the model reports the language of the turn; the shell hands it to
// TTS so the voice matches the words. The driver forwards it to the Rust test.
console.log(`language: ${result.language ?? "(not reported)"}`);

// The Rust side owns Fish Audio; the driver only feeds it the finished sentence.
// Spawning the ignored test keeps the provider client in one place.
const tauriDir = path.resolve(fileURLToPath(new URL("../../app/src-tauri", import.meta.url)));
console.error(`speaking through the real Rust path (cwd ${tauriDir})…`);

const speakStarted = Date.now();
let rustOutput = "";
const exitCode = await new Promise<number | null>((resolve) => {
  const child = spawn(
    "caffeinate",
    [
      "-i",
      "cargo",
      "test",
      "manual_live_fish_synthesises_mpeg_and_speaks",
      "--",
      "--ignored",
      "--nocapture",
    ],
    {
      cwd: tauriDir,
      env: {
        ...process.env,
        POLARIS_E2E_TEXT: sentence,
        ...(result.language ? { POLARIS_E2E_LANG: result.language } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk: Buffer) => {
    rustOutput += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    rustOutput += chunk.toString();
  });
  child.on("error", (error) => {
    console.error(`could not start the Rust e2e: ${error.message}`);
    resolve(null);
  });
  child.on("close", (code) => resolve(code));
});
const speakMs = Date.now() - speakStarted;
process.stdout.write(rustOutput);

console.log(
  `end-to-end: intent ${intentMs} ms + speak ${speakMs} ms = ${Date.now() - started} ms`,
);

if (exitCode !== 0) {
  console.error(`Rust speak path exited with ${String(exitCode)} — no proof of audio`);
  process.exit(1);
}
// Guard against a silently-filtered test run: the production latency line is the
// only evidence that the real Fish backend actually synthesized and played.
if (!rustOutput.includes("via fish")) {
  console.error("the Rust run never printed `via fish` — the live Fish path did not speak");
  process.exit(1);
}
