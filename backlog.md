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
| 2026-09-19 | **A6 — text-prompt popup (double-Control tap)** on `feat/a6-text-prompt`: pure tested `ctrl_tap.rs` (400 ms gap, 350 ms max hold, Option/Command/Shift contamination), a separate focusable notch-anchored `prompt` window whose height is content-driven, its own `polaris-prompt` event channel, `prompt.html` + React panel reusing the A2/A4 agent+TTS libs, persisted speaker switch; in-app double-tap/type/speak run pending a human keyboard | opencode worker (deepseek-v4.1-flash) | pushed, no PR — typecheck/build/103 Rust tests/clippy green, `tauri dev` start clean; human keyboard check pending | [`backlog/2026-09-19-a6-text-prompt.md`](backlog/2026-09-19-a6-text-prompt.md) | P0 |
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
