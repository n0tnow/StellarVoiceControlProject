/**
 * Opt-in end-to-end check (step A4) — a real intent spoken through the real TTS.
 *
 *   npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"
 *
 * It chains the actual halves the app runs, with no stubs:
 *
 *   1. the real agent runtime (OpenCode Zen Go) turns the transcript into an
 *      `Intent`;
 *   2. `spokenText` turns that intent into the confirmation sentence the app
 *      would say (`@polaris/agent` `speech.ts`);
 *   3. the Rust live test `manual_live_fish_synthesises_mpeg_and_speaks` speaks
 *      that exact sentence through the real Fish Audio backend and the pinned
 *      `reference_id`, via the production `speak_and_log` path (temp file ->
 *      `afplay`), asserting the payload is non-empty MPEG.
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
import { spokenText } from "./speech.ts";

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

if (!result.intent) {
  console.error(
    `no intent in ${intentMs} ms — nothing to speak; the model answered ` +
      `${JSON.stringify(result.answer)}`,
  );
  process.exit(1);
}

const sentence = spokenText(result);
console.log(`intent in ${intentMs} ms: ${JSON.stringify(result.intent)}`);
console.log(`spoken sentence: ${sentence}`);

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
      env: { ...process.env, POLARIS_E2E_TEXT: sentence },
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
