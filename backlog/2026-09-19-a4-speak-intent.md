# Report: A4 — speak the agent's answer (LLM output → TTS)

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a4-speak-intent` / `.worktrees/a4` (A2 merged with A3)
- **PR:** none (task: push only, no PR, no merge, no tag)

## Objective

Close the loop between A2 and A3: whatever the agent says back to the user must be
spoken aloud. The sentence is built on the **TypeScript** side (the agent owns what
it means to answer) and the finished string is handed to the existing Rust `speak`
command. Rust never formats an intent. Playback must be non-blocking and a TTS
failure must never affect the visible result.

## What was wired

1. **Spoken sentence built in the agent core — `agent/src/speech.ts` (new).**
   - `confirmationSentence(intent)` turns a parsed `Intent` into one short
     confirmation prompt.
   - `spokenText(result)` returns the confirmation when an intent is present, and
     otherwise the turn's `answer` text (the clarification the model asked for).
   - `SpeechQueue` owns the overlap policy (below). It takes an injected
     `SpeakFn`, so it is unit-testable with no Tauri, network or audio.
2. **Exported from `@polaris/agent`** (`agent/src/index.ts`): `confirmationSentence`,
   `spokenText`, `SpeechQueue`, `SpeakFn`, `SpokenResult`.
3. **Shell wiring — `app/src/lib/speech.ts` (new).** Wraps the queue around the real
   `invoke("speak", { text })`, logs `speech in <ms> ms via <backend>`, and swallows
   a failure into a `console.warn`. `speakTurnResult(result)` is the only entry point.
4. **Call site — `app/src/App.tsx`.** After `runAgentTurn` resolves, the result is
   shown first (`setAgentRun(run)`) and only then `speakTurnResult(run.outcome)` is
   called. `speakTurnResult` returns immediately, so a ~3–9 s Fish synthesis never
   delays the transcript or the intent. `run.ok === false` (internal error) is never
   spoken.
5. **Live Fish test parameterised for the E2E — `app/src-tauri/src/tts.rs`.** The
   existing `#[ignore]`d `manual_live_fish_synthesises_mpeg_and_speaks` now prefers a
   sentence from `POLARIS_E2E_TEXT` (falling back to its fixed sentence) and prints
   the voice id it used.
6. **Opt-in end-to-end driver — `agent/src/e2e-speak.ts` (new)** +
   `npm run e2e:speak -w @polaris/agent -- "<transcript>"`. It runs the real LLM
   (real `Intent`), formats the real spoken sentence, then runs the Rust live test
   with `POLARIS_E2E_TEXT` set to that sentence, and **fails unless the Rust output
   contains `via fish`** (so a silently-filtered test cannot pass as proof).

## Spoken-sentence rules

| Turn outcome | Spoken? | Text |
|---|---|---|
| Valid intent produced | yes | `confirmationSentence(intent)` — e.g. `Sending 5 USDC to Ahmet. Do you confirm?` |
| No intent (clarification / off-topic answer) | yes | the turn's `answer`, trimmed |
| Internal error (`AgentFailure`) | **no** | already a short UI label; never read aloud |
| Empty answer / blank text | no | ignored before it reaches the backend |

The recipient falls back `recipient → alias → "the recipient"`; every `IntentKind`
has a template. Confirmation text is one or two short sentences, never JSON (a unit
test asserts the spoken sentence contains no `{`).

## Overlap policy (rapid successive commands)

**Never overlap; one in flight + one pending; the newest pending wins (latest-wins).**
- While an utterance is playing, a new request becomes the single pending utterance.
- If more arrive before the current one ends, each replaces the pending one, so only
  the most recent survives — a stale utterance that never started is dropped rather
  than queued behind, because the newest command is the one the user still cares
  about.
- Audio already playing is **not** interrupted: the Rust player (`afplay`) has no
  cancellation seam, and cutting a confirmation sentence off mid-word is worse than
  letting it finish. This is a deliberate choice, not an omission.
- A backend failure is caught per utterance; the queue continues with the next one.

## Files changed

- **New:** `agent/src/speech.ts`, `agent/src/speech.test.ts`, `agent/src/e2e-speak.ts`,
  `app/src/lib/speech.ts`, `backlog/2026-09-19-a4-speak-intent.md`
- **Modified:** `agent/src/index.ts` (exports), `agent/package.json` (`e2e:speak`),
  `app/src/App.tsx` (speak on a successful turn), `app/src-tauri/src/tts.rs` (live
  test accepts `POLARIS_E2E_TEXT`), `.env.example` (TTS vars documented),
  `docs/architecture.md` (§4.1, §4.2, §4.5, §7), `backlog.md`, `notes.md`
- **Not touched:** `stellar/**`, `contracts/**` (Owner B), `TASK-A4.md` (not committed).

## Acceptance commands and REAL output

Environment: Node v22.23.1, rustc 1.97.1 (this worktree). All long commands wrapped
in `caffeinate -i`.

```
$ caffeinate -i npm run typecheck
> @polaris/interfaces ... tsc   (clean)
> @polaris/agent ... tsc        (clean)
> @polaris/stellar ... tsc      (clean)
> @polaris/app ... tsc          (clean)

$ caffeinate -i npm run build
vite v8.3.0 building client environment for production...
✓ 46 modules transformed.
dist/index.html                   0.43 kB │ gzip:  0.27 kB
dist/assets/index-CcaBguYa.css   19.40 kB │ gzip:  4.80 kB
dist/assets/index-2e5aiNdD.js   237.53 kB │ gzip: 75.44 kB
✓ built in 160ms

$ caffeinate -i npm test -w @polaris/agent
# tests 38
# pass 38
# fail 0

$ grep -rqs "sk-fish\|FISH_AUDIO_API_KEY\|OPENCODE_API_KEY\|opencode.ai" app/dist \
    && echo "FOUND (bad)" || echo "no secret/provider string in bundle"
no secret/provider string in bundle

$ caffeinate -i cargo build            # app/src-tauri
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.44s

$ caffeinate -i cargo test             # app/src-tauri
test result: ok. 96 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ caffeinate -i cargo clippy --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.16s
```

38 agent tests = A2's 28 + 10 new (formatting + queue). The Rust count is unchanged
at 96 passing / 2 ignored — no regression.

### Opt-in live end-to-end — actually run (real LLM + real Fish + real playback)

Command and **real** output (audio genuinely played through `afplay`; the test
errors otherwise). The pinned voice id was logged and matches `.env`:

```
$ caffeinate -i npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"

agent: model=deepseek-v4.1-flash, tools=2, transcript="Ahmete 5 USDC gönder"
  event: agent_status thinking
  event: agent_status awaiting_approval
  event: agent_status done
intent in 5717 ms: {"kind":"send","asset":"USDC","amount":"5","recipient":"Ahmet","source":"Ahmete 5 USDC gönder"}
spoken sentence: Sending 5 USDC to Ahmet. Do you confirm?
speaking through the real Rust path (cwd .../app/src-tauri)…
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.51s
     Running unittests src/lib.rs (target/debug/deps/polaris_app_lib-4c84e768663fafd1)

running 1 test
polaris: loaded environment from /Users/fatih/StellarVoiceControlProject/.worktrees/a4/.env
polaris: live Fish voice reference_id=933563129e564b19a115bedd57b7406a sentence="Sending 5 USDC to Ahmet. Do you confirm?"
polaris: tts in 8743 ms via fish (40 chars)
test tts::tests::manual_live_fish_synthesises_mpeg_and_speaks ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 13.72s
...
end-to-end: intent 5717 ms + speak 14336 ms = 20054 ms
```

Measured chain: **real intent 5717 ms → real Fish synthesis + playback 8743 ms →
20.1 s wall** (the 14.3 s "speak" figure includes cargo's test-binary startup; the
provider line is the 8743 ms). This is slower than A3b's 6.7 s for the same style of
sentence — `s2.1-pro-free` has no SLA, which is exactly why the local fallback and
the non-blocking design exist.

Honesty note: the **first** E2E attempt passed with `speak 224 ms` because the Rust
filter used `--exact` with an unqualified name and matched nothing ("98 filtered
out"). That was a false pass; the driver was changed to (a) drop `--exact`, and
(b) exit non-zero unless the captured output contains `via fish`. The run above is
the corrected one — 1 test actually ran and `tts in 8743 ms via fish` is real.

## Unverified (stated plainly)

- **The in-app path was not run end to end.** Hotkey → mic → STT → agent → `speak`
  inside the running Tauri webview needs a human with a microphone and the Speech
  permission. The two halves were verified independently and composed by the E2E
  driver above: the webview calls the exact same `speak` command with the exact same
  sentence the formatter produces, but the joined UI path is not observed.
- **Audible quality is subjective.** Whether the pinned `Sarah` voice reads Turkish
  well is the owner's call; the test proves the payload is MPEG and that `afplay`
  exited 0, not that it sounds good.
- **Free-tier endurance.** One live call was made this round (plus A3b's); no
  sustained-load or quota-exhaustion run. The local fallback is the mitigation.
- **The `answer` spoken for a `noop` round-trip turn** is the tool result text; only
  intent and answer paths were exercised live. Unit tests cover `spokenText`
  directly.

## Left over / handed off

- A `speech_status` event (or mute toggle) was not added — A3 left that to the UI,
  and this task did not need it to close the loop. `isSpeaking()` in
  `app/src/lib/speech.ts` is the hook if a mute indicator is wanted.
- `npm test -w @polaris/agent` still is not in `scripts/check.sh` (same A2 handoff;
  `scripts/` is outside this task's scope).
- The `/agent-api` dev proxy is still dev-only (A2 handoff): a packaged Polaris
  reaches neither the LLM nor, consequently, speech.
- `sprints.md` A4 checkboxes were left for the coordinator.

## Blockers

- None. The provider answered correctly on the first real call.

## Review Notes

- **No seam change.** `interfaces/` and the Rust event mirror are untouched; speech
  reuses the existing `speak` command and its `SpeechOutcome`/`SpeechFailure` types.
  The intent still travels back in `AgentTurnResult`; nothing new crosses the wire.
- **One formatting site.** `confirmationSentence` exists only in `agent/src/speech.ts`;
  Rust receives a finished string, so an `Intent` is never formatted twice.
- **Failure isolation.** `SpeechQueue.#drain` catches per utterance and reports
  through the injected `onError`; the React `.then` sets the visible result before
  queueing, so a TTS failure cannot swallow or delay it.
- **No voice id in code.** The E2E prints the `reference_id` from `.env` for the
  report but nothing in `agent/**` or `app/**` hardcodes it.

## Suggested Next Step

Run the app on the real machine (`make dev`), hold Control+Option, say "Ahmete 5
USDC gönder", confirm the trace shows the intent **and** the pinned voice speaks
"Sending 5 USDC to Ahmet. Do you confirm?"; then repeat with "bugün hava nasıl" to
hear the clarification. Then add a mute/speech indicator if the demo wants one.
