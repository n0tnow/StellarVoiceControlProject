# Report: A11 — Anthropic provider, phase-level latency, language matching

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a11-anthropic-and-language` / `.worktrees/a11`
- **PR:** none (task: push only, no PR, no merge, no tag)

## Objective

Three things, in this order: (1) instrument every phase of one spoken turn so the
owner finally has a real latency breakdown, and verify whether playback really
starts at the first audio byte; (2) add Anthropic as a selectable provider behind
the existing `AgentLlm` port and benchmark it against `glm-5.3-flash`; (3) fix the
language bug (`"can you send 400 dollar to bilal"` was answered in Turkish by an
English voice) and investigate the STT locale.

---

## PART 1 — Where the time actually goes

### What is instrumented

A process-global turn trace in Rust (`app/src-tauri/src/timing.rs`). It is opened
at the **hotkey release** and closed when playback ends, and prints one block to
the Rust terminal. The webview contributes the phases that only exist in
TypeScript through a new `polaris_phase` command; everything else is marked where
it happens:

| Phase | Marked in |
|---|---|
| `hotkey release` | `hotkey.rs` (`Action::Stop`) and `commands::capture_stop` |
| `wav ready` | `capture.rs` (`finish_capture`, on the finalized WAV) |
| `transcript` | `stt.rs` (`handle`, just before the `transcript` event) |
| `agent request built` | webview `agent.ts` (before the Rust `agent_chat` invoke) |
| `provider request sent` / `provider first byte` / `provider full response` | `agent.rs` (before `send`, after headers, after the body read) |
| `intent parsed` | webview `agent.ts` (after `runTurn` resolves) |
| `sentence built` | webview `speech.ts` (before the `speak` invoke) |
| `tts request sent` | `commands::speak` |
| `tts first audio byte` | `tts/player.rs` (first chunk read / first byte buffered) |
| `playback start` | the backend's real playback-start callback (`commands::speak`) |
| `playback end` / close | `commands::speak` (or the next `begin_turn` flushes a turn that never spoke) |

It is behind `POLARIS_TIMING` and **on by default**; `0`/`false`/`off`/`no`
disables it. The block is printed in one `println!` so concurrent terminal lines
cannot interleave inside it.

### The breakdown (real runs)

The app path needs a microphone, so the timings below are a **composed real run**:
the agent half from `e2e:speak` (real `glm-5.3-flash`, phase-timed `fetch`) plus
the TTS half from the Rust live Fish path (its own `turn timing` block). No number
here is simulated; the full single-process app block starts one phase earlier
(`hotkey release`, `wav ready`, `transcript`) and is printed by the app on the
owner's next mic run (see "Still not measured").

**English — the owner's exact command `"can you send 400 dollar to bilal"`:**

| Phase | ms | Δ |
|---|---|---|
| agent request built | 2 | — |
| provider request sent | 2 | +0 |
| provider first byte | 1688 | +1686 |
| provider full response | 1691 | +3 |
| intent parsed | 1691 | +0 |
| sentence built | 1691 | +0 |
| tts request sent | 0 (TTS clock) | — |
| tts first audio byte | 2398 | +2398 |
| playback start | 2398 | +0 |
| playback end | 17631 | +15233 |

Sentence: `Sending 400 USDC to bilal. Do you confirm?` — language `en`.

**Turkish — `"Ahmete 5 USDC gönder"`:**

| Phase | ms | Δ |
|---|---|---|
| agent request built | 2 | — |
| provider request sent | 2 | +0 |
| provider first byte | 1436 | +1434 |
| provider full response | 1439 | +3 |
| intent parsed | 1440 | +1 |
| sentence built | 1440 | +0 |
| tts request sent | 0 (TTS clock) | — |
| tts first audio byte | 2666 | +2666 |
| playback start | 2667 | +1 |
| playback end | 7654 | +4987 |

Sentence: `Ahmet adresine 5 USDC gönderiyorum. Onaylıyor musun?` — language `tr`.

Provider benchmark (same day, this machine, 3 reps, `bench:providers`):

| provider | model | input | median ms | min | max | correct tool call | language |
|---|---|---|---|---|---|---|---|
| glm | glm-5.3-flash | tr payment | 2131 | 1103 | 2482 | 3/3 | tr |
| glm | glm-5.3-flash | en payment | 1235 | 1152 | 1292 | 3/3 | en |
| glm | glm-5.3-flash | chat | 1767 | 1230 | 2513 | 3/3 | en |

### What the numbers say

- **The provider's cost is time-to-first-byte, not body transfer.** `first byte →
  full response` is 3 ms in both runs; practically all of the model time is spent
  before the first byte (server queueing + generation of the first token). Caching
  or streaming the *body* would buy nothing.
- **Playback really does start at the first audio byte** — the prime suspect from
  the task. In every real Fish run measured here (`2398/2398`, `2666/2667`,
  `2551/2551`) `tts first audio byte` and `playback start` are the **same
  millisecond**, and both are well before `playback end`. The buffered
  `afplay`/temp-file path would put `first audio byte` at the end of the download.
  So A5's streaming claim is confirmed for the current path; the coordinator's
  6.0–6.3 s "buffered" figure is not what the app is doing now.
- **Honest caveat on "playback start":** the callback fires when the first chunk
  has been written to `ffplay`'s stdin, which is the earliest point ffplay *can*
  begin decoding — not a speaker-verified instant. A5 measured ffplay's own startup
  at ≈ 0.39 s, so audible start ≈ these numbers + ~0.4 s. The mark is a tight lower
  bound, not an ear-confirmed time.
- **The remaining dominant term is Fish Audio's free-tier tail**, not our code.
  Audio duration (playback end − playback start) was 4.4–5.0 s in the normal runs,
  and the English run that day hit a **17.6 s tail** — the free tier has no SLA and
  its variance is the largest single factor left. `glm` itself was 1.2–2.1 s.

### Still not measured (deliberate honesty)

- **One full in-app turn** (hotkey release → WAV → transcript → provider → TTS →
  playback end) needs the owner's microphone. The code now prints that entire
  block; the composed table above starts at `agent request built` because the
  headless driver has no capture/STT half.
- The app's provider phases come from the **Rust** transport; the headless driver
  measures them in Node. They are the same conceptual marks but not the same
  process.

---

## PART 2 — Anthropic as a selectable provider

### Implementation

- **`agent/src/llm/anthropic.ts`** — a second implementation of the existing
  `AgentLlm` port (the loop, tools and UI never change). Verified against the API
  reference and pinned by tests:
  - `POST {base}/v1/messages`, base `https://api.anthropic.com`.
  - Headers `x-api-key` (not a Bearer token), `anthropic-version: 2023-06-01`,
    `content-type: application/json`.
  - Top-level `system`, tools use `input_schema`, `max_tokens` is required.
  - Response `content` blocks: text joined; `type: "tool_use"` → `{name, input}`;
    any string `input` is parsed as JSON, never string-matched.
  - Thinking off: Sonnet 5 → `thinking: {type:"disabled"}` with **no**
    `budget_tokens` (400s on Sonnet 5); Haiku 4.5 → the field is **omitted** and
    `output_config.effort` is never sent.
  - Model ids are exactly `claude-sonnet-5` / `claude-haiku-4-5`, never dated.
- **Selection by env.** `POLARIS_AGENT_PROVIDER` (`openai` default | `anthropic`)
  picks the implementation; `POLARIS_AGENT_MODEL` stays the model id, so the
  Sonnet/Haiku comparison is a `.env` change. Anthropic gets its **own** base URL
  variable `POLARIS_ANTHROPIC_BASE_URL` (default `https://api.anthropic.com`)
  because `POLARIS_AGENT_BASE_URL` points at OpenCode Zen Go and reusing it would
  send the Messages body to the wrong host. Credential is `ANTHROPIC_API_KEY`.
- **Provider-aware Rust transport (`agent.rs`).** `agent_chat` now takes the
  provider (the webview passes the same `POLARIS_AGENT_PROVIDER` it used to build
  the body) and builds the endpoint and headers accordingly: OpenAI-compatible
  `Authorization: Bearer` + `x-opencode-session` + `/chat/completions`, or
  Anthropic `x-api-key` + `anthropic-version` + `/v1/messages`. `ANTHROPIC_API_KEY`
  is read only in Rust/Node and never enters the webview bundle.
- **Node vs Rust, per the task.** The Rust transport hand-rolls the wire format
  (there is no Anthropic SDK for Rust) — expected and fine. The Node-side benchmark
  uses the **official `@anthropic-ai/sdk`** (added as a dev dependency of
  `@polaris/agent`). The shipped TypeScript client is unit-tested against a fake so
  the app path is covered without network.
- **Benchmark script.** `npm run bench:providers -w @polaris/agent` runs the
  Turkish payment command, the English payment command and a chat line, `--reps=N`
  times each, and reports median/min/max plus whether the correct tool call was
  produced.

### Comparison table — **Anthropic rows were NOT run**

`.env` has no `ANTHROPIC_API_KEY` on this machine, so the Anthropic rows are left
for the owner. **No Anthropic latency numbers are invented.** Set the key in `.env`
and run `npm run bench:providers -w @polaris/agent` to fill them in.

| provider | model | tr payment | en payment | chat | correct |
|---|---|---|---|---|---|
| glm | glm-5.3-flash | median 2131 ms (1103–2482) | median 1235 ms (1152–1292) | median 1767 ms (1230–2513) | 9/9 |
| anthropic | claude-sonnet-5 | not run (no key) | not run | not run | not run |
| anthropic | claude-haiku-4-5 | not run (no key) | not run | not run | not run |

---

## PART 3 — Answering in the language the user spoke

### The model reports the language (no detection library)

The model already knows the language, so it reports it as part of its output:

- a tool call carries an optional **`language`** field (BCP-47 base, e.g. `tr`/`en`),
  read as structured JSON from the already-parsed input;
- a text answer begins with the same tag in brackets, e.g. `[en] Yes, I can hear
  you.` — the client strips it before the text is spoken.

`agent/src/language.ts` normalises both; the OpenAI-compatible and Anthropic
clients set `LlmTurn.language`, the loop forwards it as `AgentTurnResult.language`,
and the shell passes it to `speak`. When the model reports nothing, the field is
absent (never guessed) and the pinned voice is used.

### The reply is now localised

`confirmationSentence(intent, language)` has `en` and `tr` templates (English is
the fallback for an unknown language). Live proof, English vs Turkish:

```
intent in 1691 ms: {"kind":"send","asset":"USDC","amount":"400","recipient":"bilal",...}
spoken sentence: Sending 400 USDC to bilal. Do you confirm?
language: en

intent in 1440 ms: {"kind":"send","asset":"USDC","amount":"5","recipient":"Ahmet",...}
spoken sentence: Ahmet adresine 5 USDC gönderiyorum. Onaylıyor musun?
language: tr
```

Before this step the spoken confirmation was hard-coded English in both cases,
which is how an English voice ended up reading Turkish (or vice versa).

### TTS receives the language; voice choice stays the owner's

`Speaker::speak` now takes `Option<&str> language`. Both backends resolve a voice
the same way:

- Fish: `POLARIS_TTS_REFERENCE_ID_<LANG>` (e.g. `_TR`) overrides, else the pinned
  `POLARIS_TTS_REFERENCE_ID`.
- Local `say`: `POLARIS_TTS_LOCAL_VOICE_<LANG>` overrides, else
  `POLARIS_TTS_LOCAL_VOICE`.

The pinned voice is **required** and is the fallback, so a language with no
override — or no language at all — can never silently change it. Live proof that an
override is selected (a stand-in id, just to show the lookup):

```
polaris: live Fish voice for lang tr => 536d3a5e000945adb7038665781a4aca (overrides: tr=536d3a5e000945adb7038665781a4aca)
polaris: tts in 6998 ms via fish (52 chars, lang tr)
```

**Fish Audio finding:** the `/v1/tts` request body (re-read from the API reference)
has **no language field** — only `text`, `reference_id`, prosody/format knobs. Fish
follows the language of the text and the reference voice; the voice is therefore
the only language lever, which is exactly what the per-language override mechanism
controls. `.env.example` documents the two override variables for the owner.

### STT investigation — the likely real root cause, needs an owner decision

- `POLARIS_STT_LOCALE` is unset in this `.env`, so the on-device recognizer runs as
  the fixed default **`tr-TR`** (`app/src-tauri/src/stt/ondevice.rs:59`,
  `resolve_locale`).
- Apple's `SFSpeechRecognizer` is **single-locale**: a `tr-TR` recognizer listening
  to English "can you send 400 dollar to bilal" produces Turkish-orthography text.
  That garbled transcript is what the model then sees, which plausibly explains a
  Turkish reply to an English command. **This is a strong hypothesis, not a
  verified one** — I did not capture a microphone recording to confirm it.
- The Groq fallback cannot rescue this: it fires **only** on
  `SttError::Unavailable` (raised before any recognition), never on a poor
  transcript (`stt.rs`, `FallbackTranscriber`).
- **There is no bilingual `tr`+`en` locale to switch to**, and no on-device audio
  language detection. So this is a **design decision for the owner**, with three
  options:
  1. Keep `tr-TR` and accept that English utterances transcribe with Turkish
     phonetics (current behaviour).
  2. Set `POLARIS_STT_LOCALE=en-US` (fixes English, breaks Turkish).
  3. Use Groq with auto-detection (`POLARIS_STT_BACKEND=groq`, `GROQ_API_KEY` set,
     `POLARIS_STT_LANGUAGE` empty — Whisper auto-detects mixed tr/en, see
     `stt/groq.rs`). Trade-off: **the audio leaves the machine**, which reverses
     the on-device privacy decision.
  4. (Follow-up, larger) run two recognizers per utterance and pick the higher
     confidence — roughly doubles recognition latency and needs a threshold tuned
     on real recordings.
- **I did not change the STT default or guess.** The recommendation is option 3 for
  mixed-language commands *if* the owner accepts the privacy trade-off, otherwise
  keep `tr-TR` and treat English as best-effort.

---

## Verification

Environment: Node v22.23.1, rustc 1.97.1, this worktree. Long commands wrapped in
`caffeinate -i`. All required commands green, no regressions:

```
$ caffeinate -i npm run typecheck        # interfaces, agent, stellar, app — clean
$ caffeinate -i npm run build            # vite build ok (index-*.js 247.96 kB)
$ caffeinate -i npm test -w @polaris/app # tests 19, pass 19, fail 0
$ caffeinate -i npm test -w @polaris/agent
# tests 91, pass 91, fail 0   (baseline 61; +30: anthropic 13, language 4, config 4,
#                              bench-free; openai/loop/speech additions)
$ caffeinate -i cargo test               # 118 passed; 0 failed; 3 ignored (baseline 107/3)
$ caffeinate -i cargo clippy --all-targets   # clean
```

New tests specifically required by the acceptance criteria:

- Anthropic request/response mapping against a fake, no network —
  `agent/src/llm/anthropic.test.ts` (13 cases: headers, endpoint, thinking off per
  model, block mapping, JSON-string tool input, error taxonomy, receiver guard).
- Language field flowing end to end —
  `agent/src/language.test.ts`, `agent/src/llm/openai.test.ts` (tool input + text
  tag), `agent/src/loop.test.ts` (result.language), `agent/src/speech.test.ts`
  (localised confirmation + queue passes the language to the backend).
- Per-language voice fallback — `tts/fish.rs` and `tts/local.rs` unit tests
  (override wins, unknown language falls back to the pinned voice, blank override
  never shadows it, precedence is case/region-insensitive).

Real runs pasted above: the provider benchmark, the English and Turkish
`e2e:speak` turns (agent phases + Rust TTS block), and the per-language override
run. All audio played through the production `... via fish` streaming path.

---

## Files changed

- **New:** `app/src-tauri/src/timing.rs`, `agent/src/language.ts` (+ test),
  `agent/src/llm/anthropic.ts` (+ test), `agent/src/bench-providers.ts`,
  `backlog/2026-09-20-a11-anthropic-and-language.md`.
- **Modified (Rust):** `lib.rs` (timing module + command), `hotkey.rs`,
  `commands.rs` (timing marks, `speak` language arg), `capture.rs`, `stt.rs`,
  `agent.rs` (timing marks + provider-aware endpoint/headers/command),
  `tts.rs` (language on the `Speaker` port + voice-override logging),
  `tts/fish.rs` (per-language voices), `tts/local.rs`, `tts/player.rs`
  (first-audio-byte mark).
- **Modified (TS):** `agent/src/llm/{config,openai}.ts` (+ tests),
  `agent/src/runtime.ts`, `agent/src/index.ts`, `agent/src/loop.ts` (+ test),
  `agent/src/speech.ts` (+ test), `agent/src/prompt.ts`,
  `agent/src/tools/payment.ts` (optional `language` in the schema),
  `agent/src/e2e-speak.ts` (agent phase timing + language forwarding),
  `app/src/lib/{agent,speech,polaris}.ts`, `app/vite.config.ts`
  (`POLARIS_AGENT_PROVIDER` in the env prefix), `agent/package.json` +
  `package-lock.json` (`@anthropic-ai/sdk` dev dep, `bench:providers` script),
  `.env.example`, `docs/architecture.md`.
- **Not touched:** `stellar/**`, `contracts/**` (Owner B), `TASK-A11.md`
  (not committed).

## Still unresolved / honest gaps

1. **The Anthropic comparison table has not been run** — no `ANTHROPIC_API_KEY` on
   this machine. Leave the rows for the owner.
2. **A full single-process app turn trace is not measured** — needs the owner's
   microphone; the app will print the complete block on the next in-app turn
   (`POLARIS_TIMING` on by default).
3. **The STT locale is a design decision** (see PART 3); the default was left as
   `tr-TR`.
4. **The `[xx]` text-tag protocol is a prompt convention.** If the model omits it
   (and provides no tool-call language), the turn has no language and uses the
   pinned voice — graceful, but it means the tag is only as reliable as the model.
5. **Confirmations exist only in `tr`/`en`.** A third language falls back to
   English until a template is added.
6. **The English `e2e:speak` run hit a 17.6 s Fish playback tail** — free-tier
   variance, reported rather than filtered out.

## Suggested next step

Run the app once with a microphone in each language (`make dev`), paste the
`turn #N timing` block for both, set `ANTHROPIC_API_KEY` and run
`npm run bench:providers` to fill the Anthropic rows, then decide the STT locale
question.
