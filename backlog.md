# backlog.md — Master Index of Unfinished Work

> This file is the **master index of all unfinished / handed-off work.**
> Every worker and sub-agent writes unfinished work as a detailed report in `backlog/<task-name>.md`
> and adds a single-line entry here. **Goal: never lose track of any task.**
> All entries and reports are written in **English**.
>
> Index row format:
> `| Date | Task | Worker/Agent | Status | Report | Priority |`

## Open Tasks

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | **A2 — LLM roundtrip (transcript → intent)** on `feat/a2-llm`: real OpenAI-compatible client (OpenCode Zen Go `deepseek-v4.1-flash`) behind the `AgentLlm` port + `send_payment` intent validation, webview wiring with a key-hiding Vite `/agent-api` proxy, 28 network-free tests; in-app end-to-end run pending a human + mic, production proxy handed off | opencode worker (deepseek-v4.1-flash) | pushed, no PR — real-provider CLI verified, in-app run pending | [`backlog/2026-09-19-a2-llm.md`](backlog/2026-09-19-a2-llm.md) | P0 |
| 2026-09-19 | **A1 — On-device STT backend (new default)** on `feat/a1-ondevice-stt`: Apple `SFSpeechRecognizer` behind the existing `Transcriber` seam with `requiresOnDeviceRecognition`, Groq kept as opt-in + configured fallback, `POLARIS_STT_BACKEND`/`POLARIS_STT_LOCALE`, Speech permission; awaiting a real permissioned recognition run (permission prompt + one-time locale asset check) | opencode worker (deepseek-v4.1-flash) | pushed, no PR — human run pending | [`backlog/2026-09-19-a1-ondevice-stt.md`](backlog/2026-09-19-a1-ondevice-stt.md) | P0 |
| 2026-09-19 | **A1 — STT (cloud-first)** implementation on `feat/a1-stt`, awaiting a `GROQ_API_KEY` + human 5-command / <2 s acceptance run; local whisper.cpp backend and a failed-recording retry path are handed off | opencode worker (deepseek-v4.1-flash) | pushed, no PR — acceptance pending key + human | [`backlog/2026-09-19-a1-stt.md`](backlog/2026-09-19-a1-stt.md) | P0 |
| 2026-09-19 | Modifier-gesture hardening: VoiceOver on/off toggle (needs a settings surface) + `NSWorkspace` sleep/lock force-stop | opencode worker | open | `backlog/2026-09-19-modifier-only-and-horizontal-expand.md` | P2 |
| 2026-09-19 | **A3 — TTS (Fish Audio + local fallback)** on `feat/a3-tts`: `Speaker` seam with a Fish Audio backend (`s2.1-pro-free`, fixed voice via `POLARIS_TTS_REFERENCE_ID`) and a mandatory local macOS `say` fallback; `speak` command on the blocking pool, `tts in <ms> ms` log | opencode worker (deepseek-v4.1-flash) | pushed, no PR — live Fish verified in A3b | [`backlog/2026-09-19-a3-tts.md`](backlog/2026-09-19-a3-tts.md) | P0 |
| 2026-09-19 | **A4 — speak the agent's answer (LLM output → TTS)** on `feat/a4-speak-intent`: `spokenText`/`confirmationSentence` + `SpeechQueue` in `agent/src/speech.ts` (10 unit tests), webview `speak` wiring (`app/src/lib/speech.ts`, `App.tsx`) that is non-blocking and never overlaps, and an opt-in live E2E (`npm run e2e:speak`) proving a **real intent** speaks through the real Fish backend with the pinned voice; in-app run still needs a human + mic | opencode worker (deepseek-v4.1-flash) | pushed, no PR — live intent→sentence→Fish audio verified; in-app path pending human | [`backlog/2026-09-19-a4-speak-intent.md`](backlog/2026-09-19-a4-speak-intent.md) | P0 |
| 2026-09-19 | **A5 — conversational reply fix, Speaking state, time-to-audio** on `feat/a4-speak-intent`: the no-intent E2E dead end is gone (`isSpeakable`, regression test, live conversational E2E passes), a `speech_status` event drives a real "Speaking" notch state (same animation as Thinking, cleared on failure), Fish audio is now **streamed** into `ffplay` stdin (afplay/temp-file kept as fallback) and the agent model moved to `glm-5.3-flash`; prompt + tool payload trimmed (~466→366 est. tokens). In-app run still needs a human + mic | opencode worker (deepseek-v4.1-flash) | pushed, no PR — both live E2E paths pass; in-app path pending human | [`backlog/2026-09-19-a5-latency-and-speaking.md`](backlog/2026-09-19-a5-latency-and-speaking.md) | P0 |
| 2026-09-19 | **A6 — webview→provider transport fix** on `feat/a4-speak-intent`: the real cause was WebKit's WebIDL receiver check — `this.#fetch(...)` in `agent/src/llm/openai.ts` threw `TypeError: Can only call Window.fetch on instances of Window` before any request (quoted from the live app). Fixed the receiver *and* moved the provider call into the Rust `agent_chat` command, deleting the dev-only Vite `/agent-api` proxy (works packaged, key stays in Rust). Also settled the agent stage on failure (`loop.ts` `finally`) and made the notch show the short label then collapse. Live in-app turn: `HTTP 200 in 2029 ms`, intent in 2039 ms. Packaged launch + human mic run still pending | opencode worker (deepseek-v4.1-flash) | pushed, no PR — live dev-mode turn verified | [`backlog/2026-09-19-a6-webview-agent-transport.md`](backlog/2026-09-19-a6-webview-agent-transport.md) | P0 |
| 2026-09-19 | **A8 — continuous notch session (shell UX only)** on `feat/a4-speak-intent`: removed the `<AgentTrace>`/`<EventLog>` debug surfaces and their dead log helpers; replaced the independent `collapsed`/`dismissible`/`speakingVisual`/`agentFailureVisual` visuals with one pure turn session (`app/src/lib/turnSession.ts`, 9 `node:test` cases) that stays expanded from hotkey-down to turn end and moves `listening → thinking → checking → speaking`, with a label cross-fade (`StageLabel`) and one shared indicator treatment. A failure settles exactly once; a watchdog prevents a stuck-expanded shell. **Visual check of the animation is outstanding** — proof is the state-machine tests, not the screen | opencode worker (deepseek-v4.1-flash) | pushed, no PR — unit-tested, visible animation pending human eye | [`backlog/2026-09-19-a8-notch-session.md`](backlog/2026-09-19-a8-notch-session.md) | P0 |
| 2026-09-19 | **A9 — honest stages + intent execution seam + MCP scaffolding** on `feat/a4-speak-intent`: Rust `speak` now emits `speech_status: speaking` from a real playback-start callback (Fish/ffplay, afplay, `say`; latched across the fallback) instead of at dispatch, so the synthesis wait never reads as "Speaking"; the shell's stage machine is event-driven (`listening → thinking → speaking`) and `checking` was removed (validation measured at ~0.00008 ms/call). Added `agent/src/execution.ts` — a single `executeIntent(intent, { approver, chainTools })` path with an explicit `IntentApprover` gate (placeholder, not Touch ID), structural `NotImplementedError` → `"Chain not wired"`, and never-throw labelled outcomes; `app/src/lib/chain.ts` binds it to `@polaris/stellar` (lazy import). Added read-only MCP scaffolding (`agent/src/mcp/`: config, Streamable-HTTP JSON-RPC/SSE client, ToolRegistry bridge with a write-verb + `readOnlyHint` policy, fake-server tests; app-side webview attachment deliberately left out). App 9→12, agent 40→58, cargo 104→107 | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; live LLM→seam and live Fish runs pasted in the report | [`backlog/2026-09-19-a9-execution-seam.md`](backlog/2026-09-19-a9-execution-seam.md) | P0 |
| 2026-09-20 | **A10 — close the demo-critical review findings** on `fix/a10-review-majors`: M2 second-utterance **supersede** policy (`app/src/lib/turnFlow.ts`, replaces the silent `agentBusyRef` drop), M4 speaking watchdog (`turnSession.stageWatchdog`), M1 execution-path turn-id guard (`isCurrentTurn`), M3 superseded-capture transcript guard (`Capture::is_current` + `stt::handle`), M10 real-`afplay` test ignored, M5 **fail-closed** approver default + `POLARIS_ALLOW_AUTO_APPROVE` opt-in, M7 throwing approver → labelled outcome, M6/M8 handoff-doc corrections. M9/M11 deferred. App 12→19, agent 58→61, cargo 107/2→107/3 | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; M9/M11 deferred | [`backlog/2026-09-20-a10-review-fixes.md`](backlog/2026-09-20-a10-review-fixes.md) | P0 |
| 2026-09-20 | **A11 — Anthropic provider + phase timing + language matching** on `feat/a11-anthropic-and-language`: a Rust process-global per-turn timing trace (hotkey release → WAV → transcript → provider request/first byte/full response → intent parsed → sentence built → TTS request → first audio byte → playback start → playback end, `POLARIS_TIMING`, on by default) with the webview feeding the TS-only phases through `polaris_phase`; playback confirmed to start at the first audio byte (streaming works). Anthropic Messages client behind the same `AgentLlm` port (`POLARIS_AGENT_PROVIDER`, `ANTHROPIC_API_KEY`, thinking off per model) + provider-aware Rust transport + `bench:providers`; **Anthropic rows not run (no key)**. Language bug fixed: the model reports the language (`language` tool field / `[xx]` text tag), confirmations are localised tr/en, and `Speaker` selects an optional per-language voice override, falling back to the pinned voice. STT `tr-TR` default identified as the likely root cause and left as an owner decision. App 19, agent 61→91, cargo 107/3→118/3 | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; Anthropic rows + in-app mic run + STT decision outstanding | [`backlog/2026-09-20-a11-anthropic-and-language.md`](backlog/2026-09-20-a11-anthropic-and-language.md) | P0 |
| 2026-09-20 | **A12 — language detection end to end + spoken-length cap** on `feat/a12-language-detection`: root cause was the single-locale on-device recogniser (`tr-TR`) poisoning the transcript. Groq `verbose_json` now detects the language; `Transcription.language` → `transcript` event → agent reconciliation (`resolveTurnLanguage`; detected wins over the model's guess, logged) → per-language TTS voice, with the detected language pinned into the prompt. Default backend flipped to **Groq** (self-detecting, audio leaves the Mac; startup line says so), on-device kept as the private opt-in. Parallel on-device recognisers **not shipped** (confidence is not a cross-locale discriminator; probe aborts with SIGABRT under TCC from a bare test binary). Hard `MAX_SPOKEN_CHARS=120` cap in `spokenText` (sentence/word boundary, never mid-word) + a brevity prompt rule — a 311-char answer went from `tts in 20280 ms` to 36 chars / `4325 ms`. Real audio→STT→agent→Fish runs pasted for EN (39 chars, Ethan voice) and TR (48 chars, pinned voice). App 19, agent 91→100, cargo 118/3→120/5 | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; in-app mic run + owner `.env` Anthropic `temperature` issue outstanding | [`backlog/2026-09-20-a12-language-detection.md`](backlog/2026-09-20-a12-language-detection.md) | P0 |

## Round-2 Reports (2026-09-19)
> Index of the round-2 worker reports. PRs #10 (`a8c4416`), #9 (`259dbe9`) and #11 (`a01d6a1`)
> merged 2026-09-19, so `backlog/guard-rules-schedule.md`, `backlog/keeper.md` and
> `backlog/anchor-sep6.md` are already on `main`; `backlog/rule-types-docs.md` lands with PR #8
> (independent, awaiting Owner A review). The rescued #5/#6 reports land with this docs PR.
> See `backlog/2026-09-19-closed-prs-and-round2-plan.md`.
| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Anchor SEP-6 client (deposit + withdraw) with explain-log — round-2 hardening complete | Owner B / W4, W4b | merged 2026-09-19 — [PR #11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`; resolved the shared files and completed the unified test wiring) | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md) | P0 |
| 2026-09-19 | Off-chain keeper triggering due `polaris_guard` schedules | Owner B / W3 | merged 2026-09-19 — [PR #9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`) | [`backlog/keeper.md`](backlog/keeper.md) | P1 |
| 2026-09-19 | On-chain rule engine + scheduler for `polaris_guard` (testnet deployment) | Owner B / W1 | merged 2026-09-19 — [PR #10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`) | [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) | P1 |
| 2026-09-19 | Rule/schedule types, guard ABI and 2026-09-19 decisions | Owner B / W5 | open (draft) — [PR #8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8) (awaits Owner A review) | [`backlog/rule-types-docs.md`](backlog/rule-types-docs.md) | P1 |
| 2026-09-19 | A0 — push-to-talk harness (report rescued) | Owner A | closed unmerged — [PR #6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6); preserved on `rescue/a0-harness` (`7a024a6`) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |
| 2026-09-19 | Model ladder restore (local-only; report rescued) | coordinating agent | closed unmerged — [PR #5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5); preserved on `rescue/model-ladder-restore` (`4ac06b0`) | [`backlog/2026-09-19-model-ladder-restore.md`](backlog/2026-09-19-model-ladder-restore.md) | P2 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
| 2026-09-19 | Monorepo skeleton: `interfaces/`, `agent/`, `app/` (Tauri v2 + React), `stellar/`, `contracts/` (Soroban), tooling (`Makefile`, `scripts/`, `VERSION`, `CHANGELOG.md`) | coordinating agent (no workers, per user instruction) | [PR #4](https://github.com/n0tnow/StellarVoiceControlProject/pull/4) (merged 2026-09-19T12:01:56Z, commit `a559403`) | `backlog/2026-09-19-monorepo-skeleton.md` |
| 2026-09-19 | **A0 — push-to-talk + notch overlay**: global `control+option+space` hotkey, `cpal`→WAV capture, AppKit notch overlay driven by the event stream; `dev_self_test` deleted | opencode worker (deepseek-v4.1-flash) | pending PR review (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-a0-push-to-talk-notch.md` |
| 2026-09-19 | **Notch shape fix**: idle pill matches the measured cutout (179x32, was 199x36), four derived corner radii flow through the `NotchGeometry` seam, geometry-driven silhouette | opencode worker (deepseek-v4.1-flash) | pending user visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-notch-shape-fix.md` |
| 2026-09-19 | **Modifier-only Control+Option hold (default gesture) + horizontal-only expansion**: native `flagsChanged` latch with 300 ms arming, Command/Shift exclusion, Accessibility gate + preserved `Control+Option+Space` fallback, 1 s watchdog; notch height no longer transitions | opencode worker (deepseek-v4.1-flash) | pending user runtime/visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-modifier-only-and-horizontal-expand.md` |
| 2026-09-19 | **Capture `Xrun` fix + fixed error-state height**: realtime callback no longer does disk I/O under a mutex (dedicated WAV writer thread + bounded channel; stream torn down on failure), pure tested `wav_spec`; error message moved into the fixed 66 pt shell so no state changes height | opencode worker (deepseek-v4.1-flash) | pending user device/visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-capture-device-and-error-height-fix.md` |

---

## Sub-Report Template — `backlog/<task-name>.md`

```markdown
# Report: <task-name>
- **Date:** YYYY-MM-DD
- **Worker/Agent:** <name/model>
- **Branch/Worktree:** <branch>
- **PR:** <link or "none">

## Completed
- ...

## Unfinished (handed off)
- ...

## Blockers
- ...

## Review Notes
- ...

## Suggested Next Step
- ...
```
