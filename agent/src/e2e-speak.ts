/**
 * Opt-in end-to-end check (steps A4/A5/A12) — a real turn spoken through the real TTS.
 *
 *   npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"   # intent
 *   npm run e2e:speak -w @polaris/agent -- "hello can you hear me"  # answer
 *   POLARIS_E2E_WAV=/path/clip.wav npm run e2e:speak -w @polaris/agent
 *
 * Step A14 adds an optional `POLARIS_E2E_STT_LANG` override so the owner's
 * real failing case — correct English text that Whisper still labelled `tr` —
 * can be reproduced without a microphone:
 *
 *   POLARIS_E2E_STT_LANG=tr npm run e2e:speak -w @polaris/agent -- "Can you send 400$ to Bilal?"
 *
 * It chains the actual halves the app runs, with no stubs:
 *
 *   0. (A12, optional) when `POLARIS_E2E_WAV` is set, the real Groq STT backend
 *      transcribes the audio and reports the detected language, so the whole
 *      audio → transcript → language path is exercised without a microphone;
 *   1. the real agent runtime turns the transcript into an `Intent`, or into a
 *      plain conversational answer, with the detected language pinned into the
 *      prompt and reconciled against the model's own report;
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
import { createDefaultRegistry } from "./runtime.ts";
import { isSpeakable, spokenText } from "./speech.ts";
import { AnthropicLlm } from "./llm/anthropic.ts";
import { anthropicOptionsFromEnv, openAiOptionsFromEnv, resolveProvider } from "./llm/config.ts";
import { OpenAiCompatibleLlm } from "./llm/openai.ts";

const tauriDir = path.resolve(fileURLToPath(new URL("../../app/src-tauri", import.meta.url)));

/** The Rust tests this driver runs (kept in one place). */
const STT_TEST = "manual_live_groq_transcribes_a_wav";
const TTS_TEST = "manual_live_fish_synthesises_mpeg_and_speaks";

/**
 * Runs the real Groq STT backend over an audio file by spawning the Rust test,
 * and parses its single machine-readable `polaris: e2e-stt {…}` JSON line.
 */
async function transcribeAudio(wav: string): Promise<{ text: string; language?: string; ms: number }> {
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      "caffeinate",
      ["-i", "cargo", "test", STT_TEST, "--", "--ignored", "--nocapture"],
      {
        cwd: tauriDir,
        env: { ...process.env, POLARIS_E2E_WAV: wav },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => (buffer += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(buffer) : reject(new Error(`the Rust STT run exited ${String(code)}\n${buffer}`)),
    );
  });
  process.stderr.write(output);
  const marker = "polaris: e2e-stt ";
  const line = output
    .split("\n")
    .reverse()
    .find((candidate) => candidate.includes(marker));
  if (!line) {
    throw new Error("the Rust STT run printed no e2e-stt result");
  }
  const parsed = JSON.parse(line.slice(line.indexOf(marker) + marker.length)) as {
    text: string;
    language: string | null;
    ms: number;
  };
  return {
    text: parsed.text,
    ...(parsed.language ? { language: parsed.language } : {}),
    ms: parsed.ms,
  };
}

const wavPath = process.env.POLARIS_E2E_WAV?.trim();
const argumentTranscript = process.argv.slice(2).join(" ").trim();
if (!wavPath && !argumentTranscript) {
  console.error(
    'usage: npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"\n' +
      "   or: POLARIS_E2E_WAV=/path/clip.wav npm run e2e:speak -w @polaris/agent",
  );
  process.exit(2);
}

// Step A12: when an audio file is given, the real STT half runs first, so the
// transcript AND its detected language come from the audio rather than argv.
// Step A14: `POLARIS_E2E_STT_LANG` injects the STT label directly (no mic), so
// the mislabel case can be reproduced: English text tagged `tr`.
let transcript = argumentTranscript;
let detectedLanguage = process.env.POLARIS_E2E_STT_LANG?.trim() || undefined;
if (wavPath) {
  console.error(`transcribing ${wavPath} through the real Groq STT backend…`);
  const stt = await transcribeAudio(wavPath);
  transcript = stt.text;
  detectedLanguage = stt.language;
  console.log(`stt: ${stt.ms} ms, detected language=${stt.language ?? "(unknown)"}`);
  console.log(`transcript: ${JSON.stringify(stt.text)}`);
}
if (detectedLanguage) {
  console.error(`STT language hint handed to the agent: ${detectedLanguage}`);
}


const bus = createEventBus();
bus.subscribe((event) => {
  if (event.type === "agent_status") {
    console.error(`  event: agent_status ${event.stage}`);
  }
});

// Step A11: this driver also measures the agent half of the turn, phase by
// phase, so a real per-language breakdown exists without the microphone. The
// provider phases are captured by wrapping `fetch`: the client calls it once,
// and the body read (`.text()`) is wrapped to time the full response. The Rust
// subprocess below prints the TTS half of the same turn.
const timeline: Array<{ phase: string; at: number }> = [];
const began = performance.now();
const mark = (phase: string): void => {
  timeline.push({ phase, at: Math.round(performance.now() - began) });
};
const realFetch = globalThis.fetch;
const timingFetch: typeof fetch = async (input, init) => {
  mark("provider request sent");
  const response = await realFetch(input, init);
  mark("provider first byte");
  return new Proxy(response, {
    get(target, property, receiver) {
      if (property === "text") {
        return async () => {
          const body = await target.text();
          mark("provider full response");
          return body;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

const registry = createDefaultRegistry();
const { provider } = resolveProvider(process.env);
const options =
  provider === "anthropic" ? anthropicOptionsFromEnv(process.env) : openAiOptionsFromEnv(process.env);
const llm =
  provider === "anthropic"
    ? new AnthropicLlm({ ...options, fetchImpl: timingFetch })
    : new OpenAiCompatibleLlm({ ...options, fetchImpl: timingFetch });
console.error(
  `agent: provider=${provider}, model=${llm.model}, tools=${registry.size}, transcript=${JSON.stringify(transcript)}`,
);

mark("agent request built");
const result = await runTurn({
  transcript,
  registry,
  llm,
  bus,
  ...(detectedLanguage ? { transcriptLanguage: detectedLanguage } : {}),
});
mark("intent parsed");
const intentMs = Math.round(performance.now() - began);

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
mark("sentence built");
if (result.intent) {
  console.log(`intent in ${intentMs} ms: ${JSON.stringify(result.intent)}`);
} else {
  console.log(`no intent in ${intentMs} ms — speaking the conversational answer`);
}
console.log(`spoken sentence: ${sentence}`);
// Step A11/A12: the reconciled language of the turn; the shell hands it to TTS
// so the voice matches the words. `source` says whether the audio detector or
// the model decided it.
console.log(
  `language: ${result.language ?? "(not reported)"} (source ${result.languageSource ?? "none"})`,
);

// The agent-half phase table. The TTS half is printed by the Rust subprocess
// below as its own `turn timing` block.
console.log("agent phases: " + timeline.map(({ phase, at }) => `${phase}=${at}ms`).join(" -> "));

// The Rust side owns Fish Audio; the driver only feeds it the finished sentence.
// Spawning the ignored test keeps the provider client in one place.
console.error(`speaking through the real Rust path (cwd ${tauriDir})…`);

const speakStarted = Date.now();
let rustOutput = "";
const exitCode = await new Promise<number | null>((resolve) => {
  const child = spawn(
    "caffeinate",
    ["-i", "cargo", "test", TTS_TEST, "--", "--ignored", "--nocapture"],
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
  `end-to-end: agent ${intentMs} ms + speak ${speakMs} ms = ${Math.round(performance.now() - began)} ms`,
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
