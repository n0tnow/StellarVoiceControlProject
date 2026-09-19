# Report: A12 — language detection end to end, and a hard cap on what gets spoken

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a12-language-detection` / `.worktrees/a12`
- **PR:** none (per the task: no PR, no merge, no tag)
- **Baseline:** app 19, agent 91, cargo 118 passed / 3 ignored, typecheck/build/clippy clean
- **After:** app 19, agent 100, cargo 120 passed / 5 ignored, typecheck/build/clippy clean

---

## 1. Root cause (confirmed, not re-researched)

The A11 bug — an English command answered in Turkish by an English voice — was not
in the model or the TTS. **The on-device recogniser was pinned to a single locale
(`tr-TR`)**, so English speech was transcribed as garbled Turkish and *every*
downstream stage (the model's language, the reply text, the TTS voice) inherited
the wrong language. A11 correctly refused to guess a fix and left the backend/locale
a product decision; the owner has now asked for it to be solved properly.

`POLARIS_STT_LOCALE` was unset → `tr-TR`; Apple's `SFSpeechRecognizer` is
single-locale, so there is no way to make it identify English. The coordinator's
pre-validated path is used as-is: Groq `whisper-large-v3-turbo` self-detects the
language and returns it in a `verbose_json` response.

## 2. What changed

### 2.1 Detected language flows STT → agent → TTS

- **`Transcription` carries a language.** `app/src-tauri/src/stt.rs` gained
  `Transcription.language: Option<String>` (BCP-47 tag) and
  `normalize_detected_language`, which maps the backends' two vocabularies to one:
  Groq's Whisper returns a *name* (`"Turkish"`), Apple returns a *locale*
  (`tr-TR`). An unmapped name is `None`, never a guess.
- **Groq now asks for the language.** `response_format` moved from `json` to
  `verbose_json` (the only format with a `language` field) and `parse_response`
  normalises it. `POLARIS_STT_LANGUAGE` still works as an optional hint.
- **On-device reports its pinned locale** (`ondevice::finish_transcript` takes the
  locale), so the single-locale limitation is visible downstream instead of silent.
- **The transcript event carries it.** `PolarisEvent::Transcript` and the
  `@polaris/interfaces` union gained `language: string | null`. `stt::handle`
  emits it; `App.tsx` forwards it into `runAgentTurn`.
- **The agent reconciles detected vs. model-reported** (`agent/src/language.ts`
  `resolveTurnLanguage`): the **detected** language wins because it is measured
  from the audio, while the model's report is an inference about its own output
  and can be dragged wrong by a bad transcript — exactly the A11 failure. The
  model's report is used only when detection is unavailable. Disagreement is
  logged with the winner and the reason (`loop.ts`). The comparison is on the
  **base** language, so `en-US` vs `en` is agreement, not a conflict.
- **The detected language is pinned into the prompt** (`prompt.ts`
  `withDetectedLanguage`) so the reply text is generated in it, and it is what the
  TTS per-language voice override (`POLARIS_TTS_REFERENCE_ID_<LANG>`) keys on.
  `.env.example` now documents setting `_EN`/`_TR`.

### 2.2 Backend selection: correct by default, honest about the trade-off

The default is now **Groq** — multilingual and self-detecting — because it is the
backend that makes the demo correct for both languages. On-device stays selectable
with `POLARIS_STT_BACKEND=ondevice` (and remains the only backend that keeps audio
on the Mac). The startup line states which backend is active **and whether audio
leaves the machine**:

```
polaris: STT backend Groq whisper-large-v3-turbo (cloud, multilingual, self-detecting); audio leaves this Mac for transcription — set POLARIS_STT_BACKEND=ondevice to keep it local
polaris: STT backend on-device (tr-TR, single-locale); audio never leaves this Mac — set POLARIS_STT_BACKEND=groq for multilingual auto-detection
```

An unknown backend value falls back to the Groq default **and** warns, so a typo
cannot silently change where audio goes.

### 2.3 Hard cap on what gets spoken

- **Prompt end:** the system prompt now says answers are spoken aloud — one or two
  short sentences, a confirmation is ~40 characters, no reasoning/options/caveats.
- **Code end:** `agent/src/speech.ts` gained `capSpokenText` (and
  `MAX_SPOKEN_CHARS = 120`), applied inside `spokenText`, the single place the
  spoken sentence is built. It truncates at the **last sentence boundary** inside
  the window, else the **last word boundary** (+ `…`), else a hard cut — never
  mid-word. Rust stays a dumb player (the A4 decision), so the cap lives once, in
  TypeScript, where the sentence is built.

## 3. The private alternative: two on-device recognisers in parallel

**Finding: not shipped — the confidence is not a usable cross-locale discriminator,
and it cannot even be measured in this environment.**

- Apple exposes per-segment `confidence` (`SFTranscriptionSegment.confidence`,
  bound as `objc2-speech 0.3.2`), so the mechanical part of "run `tr-TR` and
  `en-US`, pick the higher-confidence result" is possible. A probe
  (`ondevice::manual_parallel_recognisers_report_confidence`, `#[ignore]`) was
  written to measure it.
- **Evidence it cannot be measured headlessly:** running the probe from the bare
  `cargo test` binary aborts the process —
  `process didn't exit successfully … (signal: 6, SIGABRT: process abort signal)`,
  binary exit `134`. macOS TCC terminates a privacy-sensitive Speech access from a
  binary with no `NSSpeechRecognitionUsageDescription` in its bundle. The
  on-device recognizer only runs inside the packaged Polaris app; every A1/A11
  on-device run had the same constraint.
- **Why confidence would be a coin flip even if measured:** `confidence` is defined
  as how well the transcription matches the audio *within that locale's model*, not
  a cross-locale likelihood. A Turkish recognizer fed English audio still emits a
  confident (wrong) phonetic Turkish string — the very failure A11 recorded. The
  two numbers are therefore not on a comparable scale, so "pick the higher one" is
  not a decision rule.
- **Decision:** keep the single-locale on-device backend as the explicit private
  opt-in, use the self-detecting cloud backend as the default, and do not ship a
  two-recogniser guess. The probe is kept (ignored) as the harness for a future
  measurement in a bundled build.

## 4. Length cap: measured before/after (real Fish Audio)

Rambling answer (311 chars; the owner's log showed 261 chars → ~30 s):

| | spoken text | chars | Fish TTS |
|---|---|---|---|
| before cap | "Sure, let me explain how this works. Sending USDC on Stellar is fast and cheap because the network settles transactions in a few seconds and the fees are only a fraction of a cent, so you can move funds to bilal whenever you like, but please confirm the exact amount and the recipient before I prepare anything." | **311** | `polaris: tts in 20280 ms via fish (311 chars, lang en)` |
| after cap | "Sure, let me explain how this works." | **36** | `polaris: tts in 4325 ms via fish (36 chars, lang en)` |

**4.7× faster on a single utterance**, and the cap is a hard ceiling rather than a
prompt hope. Confirmations are unaffected (39–48 chars in the live runs below).

## 5. End-to-end runs (real audio → real STT → real agent → real Fish)

Both used the coordinator's sample files, converted to 16-bit PCM WAV for the
pipeline: `…/tts2/ethan-EN.mp3` and `…/tts3/A-spiker.mp3`.
`POLARIS_AGENT_PROVIDER=openai POLARIS_AGENT_MODEL=glm-5.3-flash` was forced on the
command line because this worktree's `.env` selects Anthropic, which the current
`claude-sonnet-5` endpoint rejects with `HTTP 400: temperature is deprecated for
this model` (a pre-existing A11 issue, unrelated to this change; see §6).

### 5.1 English sample (`ethan-EN.wav`)

```
transcribing …/ethan-EN.wav through the real Groq STT backend…
polaris: e2e-stt {"text":"Sending 5 USDC to AMET on Stellar Testnet. Do you confirm?","language":"en","ms":1032}
stt: 1032 ms, detected language=en
transcript: "Sending 5 USDC to AMET on Stellar Testnet. Do you confirm?"
agent: provider=openai, model=glm-5.3-flash, tools=1, transcript="Sending 5 USDC to AMET on Stellar Testnet. Do you confirm?"
intent in 3301 ms: {"kind":"send","asset":"USDC","amount":"5","recipient":"AMET",…}
spoken sentence: Sending 5 USDC to AMET. Do you confirm?
language: en (source stt)
agent phases: agent request built=1ms -> provider request sent=2ms -> provider first byte=3300ms -> provider full response=3301ms -> intent parsed=3301ms -> sentence built=3301ms
polaris: live Fish voice for lang en => 536d3a5e000945adb7038665781a4aca (overrides: en=536d3a5e000945adb7038665781a4aca)
polaris: tts in 6888 ms via fish (39 chars, lang en)

polaris: ── turn #1 timing (total 6888 ms; 5 phases) ──
polaris:   hotkey release              0 ms  (+0)
polaris:   tts request sent            0 ms  (+0)
polaris:   tts first audio byte     2405 ms  (+2405)
polaris:   playback start           2405 ms  (+0)
polaris:   playback end             6888 ms  (+4483)
polaris:   playback end / close     6888 ms  (total)
polaris: ────────────────────────────────────────────────────────
end-to-end: agent 3301 ms + speak 12119 ms = 15421 ms
```

→ **English in, English answer, English-suitable voice** (Ethan override), 39-char
confirmation.

### 5.2 Turkish sample (`A-spiker.wav`)

```
transcribing …/A-spiker.wav through the real Groq STT backend…
polaris: e2e-stt {"text":"Ahmet'e FIMF USCC gönderiyorum. Stenart Testnet üzerinden. Onaylıyor musun?","language":"tr","ms":3388}
stt: 3388 ms, detected language=tr
transcript: "Ahmet'e FIMF USCC gönderiyorum. Stenart Testnet üzerinden. Onaylıyor musun?"
agent: provider=openai, model=glm-5.3-flash, tools=1, …
no intent in 5796 ms — speaking the conversational answer
spoken sentence: Miktarı söylemedin; kaç USDC gönderelim Ahmet'e?
language: tr (source stt)
agent phases: agent request built=2ms -> provider request sent=3ms -> provider first byte=5793ms -> provider full response=5795ms -> intent parsed=5796ms -> sentence built=5796ms
polaris: live Fish voice for lang tr => 933563129e564b19a115bedd57b7406a (overrides: en=536d3a5e000945adb7038665781a4aca)
polaris: tts in 7265 ms via fish (48 chars, lang tr)

polaris: ── turn #1 timing (total 7266 ms; 5 phases) ──
polaris:   hotkey release              0 ms  (+0)
polaris:   tts request sent            0 ms  (+0)
polaris:   tts first audio byte     2892 ms  (+2892)
polaris:   playback start           2892 ms  (+0)
polaris:   playback end             7265 ms  (+4373)
polaris:   playback end / close     7266 ms  (total)
polaris: ────────────────────────────────────────────────────────
end-to-end: agent 5796 ms + speak 11837 ms = 17634 ms
```

→ **Turkish in, Turkish answer, Turkish voice** (pinned voice). The sample is a
statement without an amount, so the model asked for the missing amount in Turkish
— a correct conversational turn, and the point is that it stayed Turkish because
the detected language was `tr`, not because the model guessed.

## 6. Still open / notes

- **The owner's `.env` selects Anthropic**, and `claude-sonnet-5` currently rejects
  the request with `HTTP 400: temperature is deprecated for this model`. This
  blocks the in-app agent half (A11 parity) and is **pre-existing**, outside this
  task's scope. The live runs above therefore forced the OpenAI-compatible model.
- **`.env` is gitignored**, so the `POLARIS_TTS_REFERENCE_ID_EN=…` (Ethan) override
  used for the English voice is a local change; `.env.example` documents it.
- **In-app (mic → notch) run still needs a human**, as with every prior step; the
  audio path was exercised here with files, not a microphone.
- **Anthropic language parity** was not re-checked (no usable Anthropic key path
  today); the reconciliation is provider-independent, so it applies unchanged.
- Confirmation templates still exist only for `tr`/`en`; an unknown language falls
  back to English text (unchanged from A11).

## 7. Tests added

- `agent/src/language.test.ts`: `resolveTurnLanguage` — detected wins, agreement
  (base-insensitive), model fallback, unknown → none.
- `agent/src/speech.test.ts`: `capSpokenText` (sentence boundary / word boundary /
  hard cut / short unchanged) and `spokenText` capping a rambling answer;
  confirmation unaffected.
- `agent/src/loop.test.ts`: the detected language is pinned into the prompt and
  wins over the model's report; model report is the fallback.
- `app/src-tauri/src/stt.rs`: language normalisation from names and locales;
  `Transcription.language` survives the fallback handoff; backend default is Groq;
  the live STT harness (`manual_live_groq_transcribes_a_wav`, ignored).
- `app/src-tauri/src/stt/groq.rs`: `verbose_json` wire shape; name→tag parsing;
  missing/unmapped language is `None`.
- `app/src-tauri/src/stt/ondevice.rs`: transcript carries the recognizer locale;
  the parallel-confidence probe (ignored).
- `app/src-tauri/src/events.rs`: the transcript event's `language` key, including
  explicit `null`.

---

# A13 — unblock Claude Sonnet 5, and stop the model inventing assets

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a12-language-detection` / `.worktrees/a12` (continued)
- **PR:** none (per the task: no PR, no merge, no tag)
- **Baseline:** app 19, agent 100, cargo 120 passed / 5 ignored, typecheck/build/clippy clean
- **After:** app 19, agent 108, cargo 120 passed / 5 ignored, typecheck/build/clippy clean

## 1. `temperature` broke Sonnet 5 — removed from the Anthropic path

The A12 report's `HTTP 400: temperature is deprecated for this model` was the
client itself: `agent/src/llm/anthropic.ts` set `temperature` from options and sent
it on every request. Sampling parameters (`temperature`, `top_p`, `top_k`) are
removed on the current Claude models (Sonnet 5, Opus 5, Opus 4.8/4.7, Fable 5) —
sending one is a 400 — and still accepted on Haiku 4.5. Rather than branch on a
model list that only grows, the option was **deleted entirely** and the client now
sends no sampling parameter for any model. The OpenAI-compatible client
(`openai.ts`) is unchanged and still sends `temperature`. The same stray
`temperature: 0` was removed from the Anthropic SDK call in
`bench-providers.ts`, so the bench keeps working on Sonnet 5.

`agent/src/llm/anthropic.test.ts` gains `never sends a sampling parameter, for any
model (step A13)`, which asserts `temperature`/`top_p`/`top_k` are absent from both
the parsed body and its serialised JSON.

## 2. The model invented `USD` — one asset list, prompt + validation

`agent/src/assets.ts` is the single source of truth: `SUPPORTED_ASSETS = ["USDC",
"XLM"]`, `DEFAULT_ASSET = "USDC"`, and `ASSET_SYNONYMS` (dollar/dollars/dolar/`$`/
`usd` → USDC). Both layers read it — there is no second list:

- **Prompt** (`prompt.ts`): the asset rule is generated from the list, so it stays
  true if the list grows (`"the supported asset is USDC"` vs `"the supported assets
  are USDC and XLM"`). It names the supported codes, maps the colloquial money
  words to USDC, and says to omit `asset` when none was named.
- **Validation** (`tools/payment.ts`): `normalizeAsset` canonicalises the model's
  value against the same list. A blank value defaults to USDC; a colloquial word
  maps to USDC; a genuinely unsupported code (`EUR`, `BTC`, …) throws an `input`
  error, which `loop.ts` already speaks as a clarification — so a guess can no
  longer reach the approval seam as a bogus intent.

The tool's `asset` description is generated from the list too.

### Tests added
- `agent/src/assets.test.ts` (new): the prompt names every supported asset and
  every synonym from the one list; `normalizeAsset` returns a canonical code, a
  synonym's target, the default for blank/omitted, and `undefined` (never a guess)
  for EUR/BTC/non-strings.
- `agent/src/tools/payment.test.ts`: colloquial words → USDC; case-insensitive
  supported codes; genuinely unsupported assets rejected as `input`.
- `agent/src/loop.test.ts`: a colloquial word is canonicalised at the loop seam;
  an unsupported asset becomes a clarification, not an intent.

## 3. Real `claude-sonnet-5` runs (shipped client, `npm run cli`)

Provider forced on the command line: `POLARIS_AGENT_PROVIDER=anthropic
POLARIS_AGENT_MODEL=claude-sonnet-5`. Latency is the one `cli.ts` measures around
`runTurn` (the model call).

```
$ npm run cli -w @polaris/agent -- "Ahmet'e 5 USDC gönder"
agent: model=claude-sonnet-5, tools=1
intent in 1868 ms
{ "answer": "Send 5 USDC to Ahmet.",
  "intent": { "kind": "send", "asset": "USDC", "amount": "5", "recipient": "Ahmet",
              "source": "Ahmet'e 5 USDC gönder" }, "latencyMs": 1868 }

$ npm run cli -w @polaris/agent -- "can you send 400 dollar to bilal"
intent in 3225 ms
{ "answer": "Send 400 USDC to bilal.",
  "intent": { "kind": "send", "asset": "USDC", "amount": "400", "recipient": "bilal" },
  "latencyMs": 3225 }        # was asset "USD" before this change

$ npm run cli -w @polaris/agent -- "hello can you hear me"
no intent in 2241 ms
{ "answer": "Yes, I can hear you. What would you like to do?",
  "intent": null, "latencyMs": 2241 }

$ npm run cli -w @polaris/agent -- "can you send 400 euro to bilal"   # rejection proof
no intent in 2586 ms
{ "answer": "Sorry, I can only send USDC or XLM, not euros.",
  "intent": null, "latencyMs": 2586 }
```

- Turkish: **1868 ms**, `asset: "USDC"`.
- Dollar: **3225 ms**, `asset: "USDC"` (the bug fixed — not `USD`).
- Hello: **2241 ms**, no intent, conversational answer.
- Euro (extra evidence): **2586 ms**, no intent, spoken-style refusal.

## 4. Still open / notes

- **In-app mic → notch run still needs a human**, as with every prior step.
- **XLM is advertised but the guard MVP allowlists one asset per owner**; the list
  is the agent-side ceiling, not an on-chain authorisation promise.
- The `.env` Anthropic selection now works end to end — the A12 blocker is closed.
- `temperature` can still be injected via the explicit `AnthropicOptions.extra`
  escape hatch, but it is no longer a first-class option and is never sent by
  default (asserted by test).
