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
| 2026-09-20 | **A14 — invert language precedence + notch over fullscreen** on `feat/a12-language-detection`: the owner's log showed Whisper tagging correct English text `tr`, so A12's "detected wins" rule was backwards. `resolveTurnLanguage` now lets the **model's judgement of the transcript text win**; the STT label is a prompt hint and the fallback only when the model reports nothing (kept — fallback + diagnostic). Prompt reframed as a hint the model may override; worker log tag `[stt-lang hint …]`; new tests built from the real failing transcript. Overlay: window level `NSStatusWindowLevel` (25) → `NSPopUpMenuWindowLevel` (101) plus the named `CanJoinAllSpaces \| FullScreenAuxiliary \| Stationary \| IgnoresCycle` behaviour, so the notch floats over fullscreen apps on every Space without taking focus. Live flags read off the running `NSWindow` (`level: 101`, `full_screen_auxiliary: true`, `can_join_all_spaces: true`, `focusable: false`) + `notch_window_flags` command. App 19, agent 108→109, cargo 120/5→121/5 | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; **owner visual check over a real fullscreen app outstanding** | [`backlog/2026-09-20-a14-language-precedence-and-fullscreen.md`](backlog/2026-09-20-a14-language-precedence-and-fullscreen.md) | P0 |
| 2026-09-20 | **A15 — the notch overlay floats over fullscreen (activation policy)** on `fix/a15-fullscreen-overlay`: A14's flags were correct and the overlay still vanished, so the missing gate was one layer down — Polaris was a **regular** app. `lsappinfo` reported a running Polaris as `type="Foreground"` and tao hardcodes `ActivationPolicy::Regular`; macOS does not layer a regular app's windows into *another* app's fullscreen Space whatever the window level or collection behaviour. Fix: `tauri::ActivationPolicy::Accessory` applied on the `App` **before `run()`** (the config window is built before `setup`, so doing it in `setup` is too late; the `App` path applies at `applicationDidFinishLaunching`, i.e. before any window exists). Level/collection behaviour unchanged; overlay still click-through and non-focusable; hotkey untouched. **Cost (product change): no Dock icon, no app menu bar; no menu-bar status item yet.** Diagnostics: `notch_window_flags` + the startup line now log `activation_policy: Accessory` (read off `NSRunningApplication`), with a loud warning if it is not. Verified from the process: `type="Foreground"` → `type="UIElement"` per the WindowServer. Cargo 121/5→123/5 (two new tests). | opencode worker (deepseek-v4.1-flash) | pushed, no PR — all suites green; **owner visual check over a real fullscreen app outstanding** | [`backlog/2026-09-20-a15-fullscreen-overlay.md`](backlog/2026-09-20-a15-fullscreen-overlay.md) | P0 |
| 2026-09-19 | **A0 — harness**: global hotkey (press/release) + microphone capture to WAV + wire both into the existing log pane; delete the temporary `dev_self_test` command | Owner A | open — live work: [PR #14](https://github.com/n0tnow/StellarVoiceControlProject/pull/14) on `feat/a0-push-to-talk-notch` (superseded the closed PR #6; rescue copy preserved on `rescue/a0-harness` (`7a024a6`)) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |

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
| 2026-09-19 | Rule/schedule types, guard ABI and 2026-09-19 decisions | Owner B / W5 | open (draft) — [PR #8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8) (awaits Owner A review) | [`backlog/rule-types-docs.md`](backlog/rule-types-docs.md) (file lands with PR #8) | P1 |
| 2026-09-19 | A0 — push-to-talk harness (report rescued) | Owner A | closed unmerged — [PR #6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6); preserved on `rescue/a0-harness` (`7a024a6`) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |
| 2026-09-19 | Model ladder restore (local-only; report rescued) | coordinating agent | closed unmerged — [PR #5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5); preserved on `rescue/model-ladder-restore` (`4ac06b0`) | [`backlog/2026-09-19-model-ladder-restore.md`](backlog/2026-09-19-model-ladder-restore.md) | P2 |

## Round-3 Reports (2026-09-19)

> Reports produced for the round-3 plan below. All three are **local until this docs PR merges**.
> Decisions they feed (D1–D8) are recorded in `docs/confidential-payments.md` and `notes.md`.

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Contracts audit (DeepSeek L2) — `polaris_guard` v0.1 findings F-01…F-12, N-01…N-03 | opencode-go/deepseek-v4.1-flash (L2) | done — local until this PR merges | [`backlog/contracts-audit.md`](backlog/contracts-audit.md) | P1 |
| 2026-09-19 | Independent review of the contracts audit (DeepSeek L4) — accepted with corrections | opencode-go/deepseek-v4.1-flash (L4) | done — local until this PR merges | [`backlog/contracts-audit-review.md`](backlog/contracts-audit-review.md) | P1 |
| 2026-09-19 | Slice gap analysis — interfaces drift, chain/voice gaps, minimal slice S1–S10 | opencode-go/deepseek-v4.1-flash (L2) | done — local until this PR merges | [`backlog/2026-09-19-slice-gap-analysis.md`](backlog/2026-09-19-slice-gap-analysis.md) | P1 |

## Chain-Lane Reports (2026-09-19 / 2026-09-20)

> Worker reports and independent reviews for the chain-lane modules. All are
> **merged via the chain-lane PR** (`integration/chain-lane`); the pre-PR gate is
> [`backlog/final-gate-chain-lane.md`](backlog/final-gate-chain-lane.md). Each report carries
> its own review trail.

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | C1 — real `sendPayment` ChainTool: `Intent` → unsigned XDR + decoded summary, alias book (D1 step 1) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/send-payment.md`](backlog/send-payment.md) | P0 |
| 2026-09-19 | C2 — owner/executor-side `polaris_guard` TS client + SAC allowance + `guarded` route (D1 step 2) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/guard-client.md`](backlog/guard-client.md) | P0 |
| 2026-09-19 | T1 — approval profiles + `enableAutoPay` / baseline / tighten / disable builders (D10/D10b/D10c/D13) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/approval-policy.md`](backlog/approval-policy.md) | P0 |
| 2026-09-19 | T2 — schedule tools: `schedulePayment`, `cancelSchedule`, `listUpcoming` + local→UTC helper | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/schedule-tools.md`](backlog/schedule-tools.md) | P0 |
| 2026-09-19 | T3 — deterministic, offline suggestions engine (D11) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/suggest-engine.md`](backlog/suggest-engine.md) | P2 |
| 2026-09-19 | C3 — live TESTNET end-to-end run, S0–S11 (D1 step 3); found and fixed `tx_too_early` | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/e2e-testnet.md`](backlog/e2e-testnet.md) | P0 |
| 2026-09-20 | Manual tooling `e2e:tool` / `e2e:status`, uniform timeouts, strict `y`/`yes` gate, manual-testing README | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/e2e-polish.md`](backlog/e2e-polish.md) | P0 |
| 2026-09-19 | Integration verification of the merged chain-lane branch (offline cross-module flow, hygiene) | DeepSeek v4.1 Flash (L4 independent) | done — merged via the chain-lane PR | [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) | P1 |
| 2026-09-20 | Final pre-PR gate: scope vs `main`, offline gates, hygiene, PR-ready summary | DeepSeek v4.1 Flash (L4 independent) | done — merged via the chain-lane PR | [`backlog/final-gate-chain-lane.md`](backlog/final-gate-chain-lane.md) | P0 |
| 2026-09-19 | Review — send-payment (found the `resolveAlias` prototype defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/send-payment-review.md`](backlog/send-payment-review.md) | P0 |
| 2026-09-19 | Review 2 (delta) — send-payment fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/send-payment-review-2.md`](backlog/send-payment-review-2.md) | P0 |
| 2026-09-19 | Review — guard-client; reject (blocking `setRule` ABI encoding defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/guard-client-review.md`](backlog/guard-client-review.md) | P0 |
| 2026-09-19 | Review 2 (delta) — guard-client ABI fix; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/guard-client-review-2.md`](backlog/guard-client-review-2.md) | P0 |
| 2026-09-19 | Review — approval-policy; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review.md`](backlog/approval-policy-review.md) | P0 |
| 2026-09-19 | Review 2 — approval-policy T1-fix delta; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review-2.md`](backlog/approval-policy-review-2.md) | P0 |
| 2026-09-19 | Review 3 — approval-policy T1 correction (fix2); approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review-3.md`](backlog/approval-policy-review-3.md) | P0 |
| 2026-09-19 | Review — schedule-tools; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/schedule-tools-review.md`](backlog/schedule-tools-review.md) | P0 |
| 2026-09-19 | Delta re-review — schedule-tools fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/schedule-tools-review-2.md`](backlog/schedule-tools-review-2.md) | P0 |
| 2026-09-19 | Review — suggest-engine; approve with corrections (outlier threshold defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review.md`](backlog/suggest-engine-review.md) | P2 |
| 2026-09-19 | Review 2 (delta) — suggest-engine fixes; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review-2.md`](backlog/suggest-engine-review-2.md) | P2 |
| 2026-09-19 | Review 3 (final delta) — suggest-engine residual fix; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review-3.md`](backlog/suggest-engine-review-3.md) | P2 |
| 2026-09-20 | Review — live TESTNET run + live-adapter security; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-testnet-review.md`](backlog/e2e-testnet-review.md) | P0 |
| 2026-09-20 | Review — e2e-polish; approve with corrections (B1/B2/B3) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-polish-review.md`](backlog/e2e-polish-review.md) | P0 |
| 2026-09-20 | Review 2 (delta) — e2e-polish fixes; approve with corrections (4/4 mutations caught) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-polish-review-2.md`](backlog/e2e-polish-review-2.md) | P0 |

## Docs-Plan Reviews (2026-09-19)

> Independent reviews of the design/docs plan; already on `main` via
> [PR #17](https://github.com/n0tnow/StellarVoiceControlProject/pull/17).

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Review — docs plan; approve with corrections (personal name + N-03 flag) | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review.md`](backlog/docs-plan-review.md) | P1 |
| 2026-09-19 | Review 2 (delta) — docs-plan fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review-2.md`](backlog/docs-plan-review-2.md) | P1 |
| 2026-09-19 | Review 3 — approval/scheduling docs + D9; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review-3.md`](backlog/docs-plan-review-3.md) | P1 |

## Round-3 Plan (2026-09-19)

> Order and decisions: `docs/confidential-payments.md` §9 (D1), `sprints.md` (M2b / M3b).

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Confidential-payments **CT integration** — spike done on local branch `spike/ct` (GO/NO-GO report local-only); integration pending | worker TBD | open (spike done — see `notes.md` 2026-09-20) | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P1 |
| 2026-09-19 | Confidential-payments **SPP integration** — spike done on local branch `spike/spp` (GO/NO-GO report local-only); integration pending | worker TBD | open (spike done — see `notes.md` 2026-09-20) | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P2 |
| 2026-09-19 | `polaris_guard` **v0.2 hardening** as a **new crate `polaris_guard_v2`** (single new deployment) | worker TBD | parked | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | Read-only verify of the deployed wasm hash on-chain (`stellar contract fetch` + sha256 vs `DEPLOYED.md`) | worker TBD | planned | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | **Interface drift fixes**: wrong Rust mirror path in `interfaces/src/index.ts`; `SigningService.sign(payloadHash)` vs `Signer.signTransaction(xdr)` (**PROPOSED: standardise on XDR**); missing `withdraw` kind | Owner A (agreement) | planned | [`docs/interfaces.md`](docs/interfaces.md) §7 | P1 (needs Owner A) |
| 2026-09-19 | README refresh: A2 still called "mock/Anthropic"; reflect the current codebase (constitution requirement) | docs worker | planned | [`README.md`](README.md) | P2 |
| 2026-09-19 | Doc-only fixes: `contracts/scripts/demo.sh:81` comment (F-09) + `stellar/src/keeper/README.md:146` error example (F-10) | docs worker (W-docs) | done in this PR | [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md) §Known limitations | — |
| 2026-09-19 | Cleanup of merged worktrees/branches | coordinating agent | planned | — | P3 |
| 2026-09-19 | `.gitignore` `node_modules/` (trailing slash) does not match a `node_modules` **symlink** | coordinating agent | planned | [`backlog/contracts-audit-review.md`](backlog/contracts-audit-review.md) §4 | P3 |
| 2026-09-19 | **T4 — history readers**: local encrypted history store + Horizon/`Paid` events reader | Owner B | open | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6, §9 | P2 |
| 2026-09-19 | **T5 — UI**: Settings "Security" profiles, "Upcoming payments" list with Cancel, suggestions panel with Accept/Dismiss, auto-pay enable card | Owner A | open | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3–§5, §9 | P1 |
| 2026-09-19 | **T6 — demo runbook execution**: keeper start/rehearse/verify, scheduled-payment demo, approval-profile demo (skeleton written) | Owner B | open — complete after T1/T2/T5 | [`docs/demo-runbook.md`](docs/demo-runbook.md) | P1 |
| 2026-09-19 | **Passkey wallet integration** (bonus, after M4 items) | worker TBD | open | [`docs/architecture.md`](docs/architecture.md) | P3 |
| 2026-09-19 | **Keeper hosting decision (D12)** — same-Mac demo vs always-on server | coordinating agent | open (PROPOSED — needs user confirmation) | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7 | P2 |
| 2026-09-20 | `e2e:tool` non-blocking notes: prototype-named flags accepted; `RpcTimeoutError` alias mislabel; symlinked-dir `chmod` case | worker TBD | open | [`backlog/e2e-polish-review-2.md`](backlog/e2e-polish-review-2.md) | P3 |
| 2026-09-20 | `describeValue` duplicate cleanup: export the guard helper, delete the approval copy (`TODO(T1-fix)`) | worker TBD | open | [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) §4 (D1) | P3 |
| 2026-09-20 | **Version tag `v0.2.0` candidate** — cut after the chain-lane PR merges (coordinator) | coordinating agent | open | [`CHANGELOG.md`](CHANGELOG.md) | P2 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
| 2026-09-19 | Owner B: fill in `stellar/` (anchor SEP-10/38/6 client, `sendPayment` tool) — stubs threw `NotImplementedError` | Owner B | [#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`), [#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`), [#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`) merged 2026-09-19 | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md), [`backlog/keeper.md`](backlog/keeper.md), [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) |
| 2026-09-19 | Monorepo skeleton: `interfaces/`, `agent/`, `app/` (Tauri v2 + React), `stellar/`, `contracts/` (Soroban), tooling (`Makefile`, `scripts/`, `VERSION`, `CHANGELOG.md`) | coordinating agent (no workers, per user instruction) | [PR #4](https://github.com/n0tnow/StellarVoiceControlProject/pull/4) (merged 2026-09-19T12:01:56Z, commit `a559403`) | `backlog/2026-09-19-monorepo-skeleton.md` |
| 2026-09-19 | **A0 — push-to-talk + notch overlay**: global `control+option+space` hotkey, `cpal`→WAV capture, AppKit notch overlay driven by the event stream; `dev_self_test` deleted | opencode worker (deepseek-v4.1-flash) | pending PR review (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-a0-push-to-talk-notch.md` |
| 2026-09-19 | **Notch shape fix**: idle pill matches the measured cutout (179x32, was 199x36), four derived corner radii flow through the `NotchGeometry` seam, geometry-driven silhouette | opencode worker (deepseek-v4.1-flash) | pending user visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-notch-shape-fix.md` |
| 2026-09-19 | **Modifier-only Control+Option hold (default gesture) + horizontal-only expansion**: native `flagsChanged` latch with 300 ms arming, Command/Shift exclusion, Accessibility gate + preserved `Control+Option+Space` fallback, 1 s watchdog; notch height no longer transitions | opencode worker (deepseek-v4.1-flash) | pending user runtime/visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-modifier-only-and-horizontal-expand.md` |
| 2026-09-19 | **Capture `Xrun` fix + fixed error-state height**: realtime callback no longer does disk I/O under a mutex (dedicated WAV writer thread + bounded channel; stream torn down on failure), pure tested `wav_spec`; error message moved into the fixed 66 pt shell so no state changes height | opencode worker (deepseek-v4.1-flash) | pending user device/visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-capture-device-and-error-height-fix.md` |
| 2026-09-20 | Chain-lane slice C1/C2/C3: real `sendPayment`, owner-side guard client, headless live TESTNET e2e (S0–S11) | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/send-payment.md`](backlog/send-payment.md), [`backlog/guard-client.md`](backlog/guard-client.md), [`backlog/e2e-testnet.md`](backlog/e2e-testnet.md), [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) |
| 2026-09-20 | T1 — approval policy + `enableAutoPay` / baseline / tighten / disable builders | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/approval-policy.md`](backlog/approval-policy.md), [`backlog/approval-policy-review-3.md`](backlog/approval-policy-review-3.md) |
| 2026-09-20 | T2 — schedule tools + local→UTC helper | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/schedule-tools.md`](backlog/schedule-tools.md), [`backlog/schedule-tools-review-2.md`](backlog/schedule-tools-review-2.md) |
| 2026-09-20 | T3 — deterministic, offline suggestions engine | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/suggest-engine.md`](backlog/suggest-engine.md), [`backlog/suggest-engine-review-3.md`](backlog/suggest-engine-review-3.md) |

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
