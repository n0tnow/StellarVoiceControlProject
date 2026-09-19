/**
 * Spoken output on the shell side (step A4).
 *
 * The agent core owns the sentence (see `@polaris/agent`'s `speech.ts`); this
 * module only plays it through the Rust `speak` command and enforces the overlap
 * policy. Keeping the queue here means playback is fire-and-forget from React's
 * point of view: a turn's visible result is set first, and speech arrives when it
 * is ready. A speech failure is logged and otherwise ignored — it must never
 * swallow or delay the intent.
 */
import { invoke } from "@tauri-apps/api/core";
import { SpeechQueue, spokenText, type SpokenResult } from "@polaris/agent";
import { markTurnPhase } from "@/lib/polaris";

/** Success shape of the Rust `speak` command (`SpeechOutcome`). */
export interface SpeechOutcome {
  backend: string;
  latencyMs: number;
  characters: number;
}

/** Failure shape of the Rust `speak` command (`SpeechFailure`). */
export interface SpeechFailure {
  label: string;
  detail: string;
}

const queue = new SpeechQueue(
  async (text, language) => {
    // A11: the sentence the app will say is already built at this point.
    markTurnPhase("sentence built");
    // The model-reported language travels with the sentence so Rust can pick a
    // per-language voice; `undefined` keeps the pinned voice.
    const outcome = await invoke<SpeechOutcome>("speak", { text, language: language ?? null });
    console.info(`speech in ${outcome.latencyMs} ms via ${outcome.backend}`);
  },
  (error) => {
    console.warn("speech failed; the on-screen result is unaffected", error);
  },
);

/**
 * Speaks a successful agent turn. Non-blocking: the call returns immediately and
 * the utterance is serialized behind any audio still playing.
 *
 * `onFailure` fires only if this utterance never produces audio (e.g. both TTS
 * backends failed). Step A9 made "Speaking" real-playback-driven, so there is no
 * `speech_status` event to settle a turn that failed during synthesis; the
 * caller uses this to settle it instead of waiting for the watchdog.
 */
export function speakTurnResult(
  result: SpokenResult,
  onFailure?: (error: unknown) => void,
): void {
  queue.enqueue(spokenText(result), onFailure, result.language);
}

/** True while an utterance is playing; exposed for tests and future mute UI. */
export function isSpeaking(): boolean {
  return queue.speaking;
}
