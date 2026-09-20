# sprints.md — Milestone & Sprint Tracking

> Milestones and checklists live here. The coordinator reads this file when prioritizing tasks.
> Under each milestone, completion criteria (Definition of Done) are kept as a checklist.
> High quality in a short time frame: few milestones, clear criteria, frequent reviews.
> All entries are written in **English**.

---

## Milestone 0 — Project Infrastructure ✅
- [x] CLAUDE.md / AGENTS.md constitution
- [x] notes.md (idea memory)
- [x] backlog.md + backlog/ report system
- [x] docs/reports/ research archive
- [x] docs/model-ladder.md worker ladder
- [x] sprints.md milestone tracking

## Milestone 1 — Topic & Architecture Decision ✅
> Owner: research team — results land in `docs/reports/`.
- [x] Project topic finalized (2026-09-19: Polaris — see docs/architecture.md §1)
- [x] Technical architecture decision made (2026-09-19: docs/architecture.md, registered in docs/reports/INDEX.md)
- [x] Technology stack selected (2026-09-19: Tauri v2 + Rust core + React/TS/Vite + Tailwind + shadcn/ui)
- [x] Repository skeleton created (2026-09-19: npm workspaces — `interfaces/`, `agent/`, `app/`, `stellar/`, `contracts/` + `Makefile`/`scripts/`; report: `backlog/2026-09-19-monorepo-skeleton.md`)
- [x] model-ladder.md model table filled in (2026-09-19: table + PONG log filled; file is local-only and never committed, see .gitignore)

## Milestone 2 — Vertical Slice 🔲
> Goal: voice → agent → one real testnet transaction. Deadline: today (hackathon crunch, ~6h blocks).
- [ ] docs/interfaces.md agreed by both owners (types: Intent, ChainTool, SigningService, PolarisEvent)
- [ ] Tauri spike: global hotkey + mic capture + Touch ID + Keychain read (Tauri vs Electron decision lands here)
- [x] Repository skeleton: app/, agent/, stellar/, contracts/ + CI-less build scripts (2026-09-19, `feat/monorepo-skeleton`)
- [ ] Voice pipeline: hotkey press/release → STT → agent loop → spoken/displayed answer
- [ ] Chain tool: "send 10 USDC to <alias>" returns unsigned XDR + decoded summary
- [ ] Touch ID approval card → signed XDR → testnet tx confirmed (SLICE COMPLETE)

### M2 — Owner A Track: Voice Pipeline, step-by-step 🔲
> **Superseded (2026-09-20, `integration/wallet-login`).** A2 (agent loop), A3 (TTS) and
> A5 (chain tool + approval/Touch ID) all shipped in integrated form; only **A4 (screen
> reading)** stays open. The step rows below are kept as history — see **Milestone 5** for
> the real order and the current open list.
> Rule: **one feature at a time, no skipping.** Do not start step N+1 until step N's
> acceptance test passes and is demoed. Each step is its own branch + PR + review.

### M2 — Progress log
> 2026-09-19 — **Skeleton landed** (`feat/monorepo-skeleton`): all four layers exist and
> build (`make check`), and the shell already carries the typed `polaris-event` stream
> from Rust to the log pane. Because of that, **A0 shrinks to audio capture + hotkey**:
> the window, the log pane, the event plumbing and `app_info` are already in place
> (`dev_self_test` is the temporary stand-in for the hotkey path and must be deleted
> when A0 lands).
>
> 2026-09-19 — **A0 landed** (`feat/a0-push-to-talk-notch`): the shell is now the notch
> overlay, `control+option+space` holds/releases a `cpal` capture, and `dev_self_test` is
> gone. Build/test/typecheck/clippy are green; end-to-end microphone capture still needs a
> human hold-and-speak check. See the A0 report.
>
> 2026-09-19 — **Modifier-only gesture + horizontal expand** (`feat/a0-push-to-talk-notch`): the
> default trigger is now holding **Control+Option** (native `flagsChanged`, 300 ms arming,
> Command/Shift excluded, 1 s watchdog), gated on Accessibility with `Control+Option+Space` kept
> as the permission-free fallback; the notch height no longer animates so the expansion reads as
> left/right only. Build/test/clippy/typecheck all green; the gesture, the Accessibility grant,
> and the animation still need a human on the real machine. See
> `backlog/2026-09-19-modifier-only-and-horizontal-expand.md`.
>
> 2026-09-19 — **A1 cloud-first STT** (`feat/a1-stt`): a finished capture is transcribed
> automatically by a `GroqTranscriber` behind a `Transcriber` trait; the overlay shows
> "Thinking" and never the transcript, which travels on `transcript { text, final }` and
> the Rust terminal. WAV retention (delete-on-success, cap 10, keep failures) lands here.
> Build/test/clippy/typecheck all green; real-provider latency and the 5-command
> acceptance run are **unverified** (no API key in this environment). See the A1 report.
>
> 2026-09-20 — **W1 network wiring** (`feat/w1-network-wiring`): the Rust `stellar_config`
> command (allow-listed, validated) now feeds the webview; `app/src/lib/chain.ts` lazily
> configures Owner B's `sendPayment` with the owner address + env aliases merged over
> `aliases.json`; and the A9 execution seam is reordered to **build the unsigned XDR first**,
> then ask the approver with the decoded `summary` + `payloadHash`. A live read-only script
> (`npm run e2e:build-xdr`) printed a real testnet unsigned XLM XDR for acc1→acc2. Signing and
> submission remain a later milestone. See `backlog/w1-network-wiring.md`.
>
> 2026-09-20 — **W1-fix review corrections**: the seam's `payloadHash` is now documented
> and named as the XDR digest (`xdrDigest`), distinct from the Stellar transaction hash
> (both pinned for one fixture, so a swap fails); a malformed tool result fails closed;
> `executeIntent` no longer throws on an undefined tool set or a non-object decision; the
> owner/alias `G...` addresses are CRC16-XModem checksum-validated in Rust; SHA-256
> multi-block/UTF-8 vectors added. All suites/clippy green. See the Review fixes section in
> `backlog/w1-network-wiring.md`.

> 2026-09-20 — **T1 settings / env / Makefile** (`feat/t1-settings-env`): read-only Settings panel (`voice_health` + `stellar_config` rows with status badges, redacted Copy diagnostics) + `settings` Debug check; `.env` falls back to `~/Library/Application Support/Polaris/.env`; `make build` uses the local Tauri CLI and `make run` launches the bundle from the repo root; all checks/tests/build/clippy green — `backlog/t1-settings-env.md`.

#### A0 — Push-to-talk + notch overlay harness ✅
> Design pivot (2026-09-19): the dashboard/log-pane harness was replaced by the notch
> overlay from the design reference (`notch-design.md`: "Replace the A0 dashboard"). The
> overlay's state *is* the harness — the typed event stream drives it directly.
- [x] Notch overlay window (transparent, click-through, always-on-top, native AppKit geometry, all Spaces) driven purely by the `polaris-event` stream (2026-09-19, branch `feat/a0-push-to-talk-notch`).
- [x] Global push-to-talk: **hold Control+Option** (release either) is the default gesture, with `control+option+space` kept as the permission-free fallback (2026-09-19, branch `feat/a0-push-to-talk-notch`).
- [x] Notch expansion reads as horizontal only: the width keeps the spring curve, the height transition was removed (2026-09-19).
- [x] Microphone capture with `cpal` → 16-bit PCM WAV (`hound`); microphone/permission failures surface as the overlay `error` state.
- [x] Temporary `dev_self_test` deleted; `capture_start` / `capture_stop` / `capture_status` / `notch_geometry` commands added.
- **Accept:** app runs and the overlay is positioned from real AppKit geometry (verified: idle pill matches the measured cutout 179×32 pt, expanded 680×66 pt on the built-in display); holding the hotkey to produce a WAV is **not yet verified by a human** — see `backlog/2026-09-19-a0-push-to-talk-notch.md`.

#### A1 — STT (speech → text) 🔲
- [x] Model choice (decided, recorded in notes.md): **cloud-first** — Groq `whisper-large-v3-turbo` behind a one-method `Transcriber` trait, so a local `whisper.cpp` backend can be added without touching call sites (2026-09-19, branch `feat/a1-stt`).
- [x] Wire: captured audio → STT → `transcript { text, final }` on the event stream + Rust terminal; overlay shows "Thinking" only and never the transcript (2026-09-19).
- [x] Retention (A0 review MAJOR-3): delete a recording after a successful transcription, keep failed ones, cap the recordings dir at 10 (2026-09-19).
- [x] F3 reliability: bilingual Groq `prompt`, one-shot allowed-language retry, short-audio hallucination filter, `GroqTransport` seam + `npm run stt:probe` (2026-09-20, `fix/f3-stt-vocab`); real-mic run still needs a human (see `backlog/f3-stt-vocab.md`).
- [x] F3-fix: language-aware prompt (EN/TR only when forced), prompt-echo + forced-language-mismatch filters, 700 ms pre-API minimum, agent unintelligible rule; probe shows no echo (2026-09-20, `fix/f3-stt-vocab`); real-mic run still needs a human.
- [x] F3-agent: unintelligible/empty-input rule ported into the capabilities prompt (`capabilities.ts`) with a 120-char cap and few-shot, `prompt.test.ts` reconciled to the composed prompt, eval 33/33 = 100% (2026-09-20, `integration/wallet`).
- [ ] **Accept:** speak 5 different commands, all transcribe correctly, <2s latency on release — **blocked on a `GROQ_API_KEY` and a human run** (latency unmeasured so far; see `backlog/2026-09-19-a1-stt.md`).

#### A2 — LLM roundtrip (text → agent → response) 🔲
- [ ] Agent core (Claude tool-use) receives transcript, returns a structured answer to the log pane.
- [ ] First tool (mock, not chain): `noop` tool call proving tool-use works end to end.
- **Accept:** "what is Soroban?" gets a sensible answer; a tool-invoking request shows the tool call + result in the log.

#### A3 — TTS (response → speech) 🔲
- [ ] Model choice (decide, record in notes.md): macOS system voice (AVSpeechSynthesizer / `say`) first — free, instant; premium voice only if pitch demo needs it.
- [ ] Wire: agent answer → spoken output, with a mute toggle in the harness.
- **Accept:** full loop hands-free: hold hotkey → speak → hear answer. Latency budget noted.

#### A4 — Computer use (screen awareness) 🔲
- [ ] Rust side: screenshot capture command exposed to the agent.
- [ ] Agent tool: "describe screen / read this error" uses the screenshot.
- **Accept:** with a Stellar Lab page open, voice query "what does this error say" returns the on-screen error text.

#### A5 — Wire to real chain tool (merge point with Owner B) 🔲
- [ ] Replace A2's mock tool with Owner B's real `ChainTool` (Intent → unsigned XDR + summary).
- [ ] Approval card + Touch ID gate → signed → testnet tx (M2 slice complete).
- **Accept:** "send 10 USDC to <alias>" end-to-end, Touch ID approved, tx visible on explorer.

#### W0 — Interactive panel windows (UI infrastructure) ✅
> Gives the click-through notch a real interaction surface and the frontend owner a
> pattern to add panels without touching Rust. Report: `backlog/w0-panel-windows.md`.
- [x] Rust panel registry (`app/src-tauri/src/panels.rs`): allow-list (`wallet`/`approval`/`settings`), `open_panel` command + `open` helper, typed `unknownPanel` rejection, one instance per label, close hides (not quits) (2026-09-20, branch `feat/w0-panel-windows`).
- [x] Menu-bar tray (Wallet… / Settings… / Quit Polaris) using the bundled app icon; accessory activation policy unchanged (2026-09-20).
- [x] `panel-*` capability (`capabilities/panels.json`); hash routing (`panelRoutes.ts`) + `PanelShell` + Wallet/Approval/Settings skeletons + `lib/panels.ts` wired to the existing event stream (2026-09-20).
- [x] Tests: `parsePanelRoute` (app) + panel registry (Rust, no window); docs `docs/ui-panels.md` (2026-09-20).
- [x] Independent-review corrections applied: UI promise rejections caught, single `PanelName` source, failed-`hide()` fallback, create-race collision focuses the existing window (+1 Rust test) (2026-09-20, report §8).
- [x] W0c: five more panel skeletons registered (`security`/`schedules`/`suggestions`/`anchor`/`p2p`) + tray reworked to one item per panel (2026-09-20, branch `feat/w0c-more-panels`, `backlog/w0c-more-panels.md`).
- [x] RMTRAY: menu-bar tray removed (setup/menu/handlers + `tray-icon` feature); notch "⋯" menu (`MoreMenu.tsx`) opens the panels and Quit (new `quit_app` command) (2026-09-20, branch `chore/remove-tray-icon`, `backlog/rm-tray.md`).
- **Accept:** `npm run check` / `npm test -w @polaris/app` / `npm run build -w @polaris/app` / `cargo test` / `cargo clippy -D warnings` green. Tray icon, focusable windows and close-keeps-app-alive are **unverified** — need a human on a real Mac (`backlog/w0-panel-windows.md`).
#### W0d — Shared panel transaction pipeline 🔲
- [x] `app/src/lib/txPipeline.ts` (`runTx`/`runTxSequence`, injectable approver/signer/clock, never throws) + `useTxRun.ts` hook + `docs/ui-panels.md` §10 (2026-09-20, `feat/w0d-tx-pipeline`).
- [ ] **Accept:** `npm run check` / `npm test -w @polaris/app` (173 pass) / `npm run build -w @polaris/app` green; real Touch ID + Freighter round trip from a panel is **unverified** (needs a human). Trace: `backlog/w0d-tx-pipeline.md`
#### F1 — Notch lifetime 🔲
- [x] (2026-09-20, branch `fix/f1-notch-lifetime`, pending PR) **F1.** The notch stays expanded through the whole turn: payment stages (`awaiting_approval`/`signing`/`submitting`) reached via additive `onStage`, collapse only from `done`/`error`, pending payment owns the notch (a hotkey press is refused with a soft en/tr label), per-stage + 6 min total watchdogs; `npm run check` / `npm test -w @polaris/app` (185 pass) / `npm run build -w @polaris/app` green — see `backlog/f1-notch-lifetime.md`
- [ ] **Accept:** the live Touch ID card + Freighter round trip visibly holds the stage labels and a second hotkey press during the wait is ignored — **unverified** (needs a human on a real Mac). Trace: `backlog/f1-notch-lifetime.md`
- [x] (2026-09-20, branch `fix/notch-hover`) **HOVER.** Fixed hover dying after a panel: panels' `set_focus` activated the accessory app and macOS pauses the global `mouseMoved` monitor while active — `lib.rs` now resigns active once the last panel closes; added `notch_hover_health`/`notch_simulate_hover` + hover/state logs and a `notchHover` Debug check, `shellVoiceInputs` + fail→settle→hover tests; check/app (356 pass)/build/cargo (319)/clippy green — `backlog/fix-notch-hover.md` (real-notch hover still needs a human).
- [x] (2026-09-20, branch `feat/w6c-wallet-suggestions`) **W6c.** Wallet panel (owner/network/balances/alias book/last-10 payments + clear states + Refresh) and Suggestions panel (offline `suggest()` over owner Horizon history; Accept→opens panel + copies draft, Dismiss→`localStorage`); `wallet`/`suggestions` Debug checks; app check/tests (202 pass)/build green — `backlog/w6c-wallet-suggestions.md`
#### NW — Notch pages → real data 🔲
- [x] (2026-09-20, branch `feat/nw4-history-page`) **NW4.** History page reads `useHistoryData`: local 50-turn log + owner Horizon payments merged via pure mappers, demo-only fallback, error/Retry, Refresh + Clear local history, `history` Debug check; app check/tests (308 pass)/build green — `backlog/nw-history.md` (real-notch render still needs a human)
- [x] (2026-09-20, branch `feat/history-ui-pro`) **HISTORY-UI.** Pro History timeline: kind icons + status chips + signed 7-decimal bigint amounts, filter chips/search/CSV, sticky day groups, in-place detail drawer, Horizon cursor paging + offline notice, P2P/anchor best-effort rows; app check/tests (399 pass)/build green — `backlog/history-ui-pro.md` (real-notch render needs a human)
#### W8 — P2P escrow ramp (client + voice + panel) 🔲
- [x] `@polaris/stellar` `p2p` client (unsigned create/accept/confirm/cancel/reclaim + simulated reads, contract id a parameter), `p2p_offer`/`p2p_accept`/`p2p_confirm` voice intents + agent tools, P2P panel through `txPipeline`, Debug `p2p` check + `POLARIS_P2P_CONTRACT_ID` in `stellar_config` (2026-09-20, `feat/w8b-p2p-client`, `backlog/w8b-p2p-client.md`).
- [x] (2026-09-20, branch `feat/w17b-p2p`) **W17b.** "Create offer" `HostError #13` fixed: fail-closed seller balance/trustline preflight (Horizon) before the approval card, plain SAC/escrow error sentences, held-asset picker; live testnet simulation confirmed #13 = missing USDC trustline; stellar/app `check` clean, stellar p2p **25/0**, app **415/0** — `backlog/w17b-p2p.md`
- [x] (2026-09-20, branch `feat/w18-trustline`) **W18.** "Add asset" (trustline): unsigned `changeTrust` builder (pinned USDC/SRT issuers) through the existing `runTx` Touch-ID pipeline, Wallet list with `Added` state + USDC faucet hint (allow-listed `faucet.circle.com`), P2P "Add USDC" action; check clean, app **416/0**, stellar payments **135/0** (9 new), cargo 3/3 + clippy — `backlog/w18-trustline.md`
- [ ] **Accept:** `npm run check` / all workspace tests / `npm run build` green; live testnet read (`npm run p2p:live`) decodes offer `1` (`Settled`); the real Mac panel/approval flow is **unverified**. Review fixes applied (union `OfferState` decode, confirm+reclaim after deadline, paging, accept-card terms).
#### W3 — Touch ID approval gate (Rust) 🔲
- [x] `biometric.rs` (`LAContext` device-owner auth, reason sanitising), `approval.rs` (one-request state machine, hash binding, webview commands, in-process `take_authorized`), `health.rs` (Debug health + self-test) — 2026-09-20, `feat/w3-touchid-gate`
- [x] Independent-review fixes: `WalletOnly` unreachable from the webview (in-process `begin_wallet_only` only), `{kind,message}` error contract + snapshot returns (W2), panic-safe `in_flight` guard — 2026-09-20
- [ ] **Accept:** the real Touch ID prompt, the device-password fallback and cancel verified by a human on a real Mac (**not verified** — needs a human). Trace: `backlog/w3-touch-id-gate.md`

## Milestone 2b — Minimal Integration Slice (chain lane first) 🔲
> Source: `backlog/2026-09-19-slice-gap-analysis.md` §G.3 (S1–S10), adapted to decisions D1/D2.
> Integration between the UI lane and the chain lane is **paused until both sides are done**.
> The chain lane stays **headless** (Node scripts, typed input) and touches only `stellar/` and
> `contracts/`. Voice is **not** on the critical path.
> Items marked **PROPOSED** await Owner A agreement.
>
> **Live testnet status (2026-09-20, chain-lane PR):** 12/12 scenarios S0–S11 pass on
> Stellar TESTNET, independently verified on-chain (`backlog/e2e-testnet-review.md`); the
> manual tool `e2e:tool` exercises the same chain-lane code the app will use
> (`backlog/e2e-polish.md`). Offline: 922 tests green across 8 suites.

### Chain lane (Owner B — critical path)
- [x] (2026-09-20, chain-lane PR) **C1.** Real `sendPayment` ChainTool: `Intent` → unsigned XDR + decoded summary; alias resolution via committed `aliases.json` first (D1 step 1)
- [x] (2026-09-20, chain-lane PR) **C2.** `polaris_guard` owner-side TypeScript client: `set_rule`, `set_alias`, SAC `approve`, `pay_executor`, plus `direct` / `guarded` modes of `sendPayment` (D1 step 2)
- [x] (2026-09-20, chain-lane PR) **C3.** Headless end-to-end script: `Intent` → XDR → dev-key sign → `submitSignedTx` → testnet tx; over-limit rejected with guard error **#105** (`NeedsOwnerApproval`) (D1 step 3)
- [x] **C4.** Registration/adapter so a shell can turn an `Intent` into a `ChainToolResult`; expose `@polaris/stellar` to the webview (no voice dependency) — (2026-09-20, `feat/w1-network-wiring`: `stellar_config` Rust command → `app/src/lib/chain.ts` lazily configures `sendPayment`; the A9 seam now builds the XDR before the approval gate and hands the card `summary` + `payloadHash`; live `e2e:build-xdr`) — see `backlog/w1-network-wiring.md`
- [x] **C5. (PROPOSED)** Rust approval gate + TypeScript signing/submission → **superseded 2026-09-20** by the embedded **Rust-native signer** behind the Touch ID gate (`feat/w10-embedded-wallet`, `feat/w11a-executor-rust`; Milestone 5).
- [x] **C6. (PROPOSED)** Standardise on `SigningService.sign(payloadHash)` → **superseded**: XDR is built in TS and signed in Rust, bound by the approval `xdrDigest`; no separate signing service remains.
- [x] (2026-09-20, chain-lane PR) **C7.** Guard client + keeper take the contract id as a parameter (e.g. `GUARD_CONTRACT_ID`), never hard-coded, so v0.1 and v0.2 (`polaris_guard_v2`) run side by side (D9)
- [x] (2026-09-20, chain-lane PR) **T1.** Approval policy + `enableAutoPay(draft)` builder (`always_ask` | `auto_under_limit`; safe order `approve` → `set_rule` → `set_executor`, executor last = arming), `buildBaselineSetup()` / `buildTightenRule()` / `disableAutoPay()`, profile→on-chain mapping — `stellar/src/guard/` (PLANNED) (D10/D10b/D10c/D13; see `docs/approval-and-scheduling.md` §3, §9, §11)
- [x] (2026-09-20, chain-lane PR) **T2.** Schedule tools: `schedulePayment`, `cancelSchedule`, `listSchedules` ChainTools + explicit-timezone local→UTC helper (see `docs/approval-and-scheduling.md` §5, §9)

### Voice lane (Owner A — not blocking)
> **Collapsed (2026-09-20):** V1–V7 were planning rows for a merge order that the
> `integration/wallet-login` build absorbed; V2–V7 shipped as the notch voice pipeline,
> approval card, Touch ID gate and submit path. Kept as history — see **Milestone 5**.
- [x] **V1. (PROPOSED)** `interfaces/src/index.ts` merge order — **superseded** by the single integration branch.
- [x] **V2.** `make dev` runs; hold hotkey → `transcript` event — **done**.
- [x] **V3.** Text/voice path calling `runAgentTurn` → `Intent` in `AgentTrace` — **done** (`agent/src/loop.ts`).
- [x] **V4.** Approval card renders the summary + Approve/Deny — **done** (`panels/ApprovalPanel.tsx`).
- [x] **V5.** Submit path + `tx_submitted` — **done**, now signed by the embedded wallet in Rust.
- [x] **V6.** Replace text input with the merged voice path — **done**.
- [x] **V7. (stretch)** Touch ID behind the approval gate — **done** (`wallet/biometric.rs`, W3).
- [x] **F2.** Real assistant system prompt: `capabilities.ts` (role/behaviour + tool-registry capability list + config account table + few-shot examples), pure `accountRefs.ts` normalisation before the model and at validation, `app/src/lib/agent.ts` config wiring, live `npm run e2e:prompt` eval (31/31 = 100%) — `backlog/f2-assistant-prompt.md`
- [x] (2026-09-20, branch `feat/t1-asset-defaults`) **T1-defaults.** `send_payment` asks instead of defaulting a missing asset, read-only `get_balance` with a deterministic spoken sentence (`toSpeech` in the loop, Horizon reader injected from `stellar_config`), PGUSD added to the chain asset registry — `backlog/t1-asset-defaults.md`
- [x] (2026-09-20, branch `feat/nw1-wallet-page`) **NW1.** Notch Wallet page on real data: `notch/data/useWalletData.ts` (stellar_config + Horizon balances/payments + alias book + session `tx_submitted` latest tx), mock import removed from `WalletPage.tsx`; check/tests (301 pass)/build green — `backlog/nw-wallet.md`
- [x] (2026-09-20, branch `feat/w10b-wallet-notch-ui`) **W10b.** Notch Wallet login + recipients: engine-detected create (phrase shown once) / import (preview→confirm), account list + balances + Friendbot, recipient "rumuz" book (Rust `contacts.rs` + `stellar_config` alias merge + per-turn refresh), no-wallet gate; app 374, agent 182, cargo 324/5-ignored, clippy clean — `backlog/w10b-wallet-ui.md`
- [x] (2026-09-20, branch `feat/nav-voice-navigation`) **NAV.** Voice navigation: read-only `navigate` tool + additive `NavigationRequest` seam, notch page / panel-window mapping, spoken confirmation; agent 190, app 357, live `e2e:prompt` 54/54 = 100% — `backlog/nav-voice-navigation.md`
- [x] (2026-09-20, branch `integration/wallet-login`) **MERGE-WALLET.** Reconciled W10 (wallet engine TS lib) with W10b (notch UI): one `wallet.ts` (free wrappers + `walletEngine`, wire types single-sourced in `@polaris/interfaces`) and `stellar_config` keeping both the active-wallet owner override and the contacts alias merge; app 385/0, agent 190/0, stellar 112/0, cargo 349/0/5-ignored, clippy clean — `backlog/w10b-wallet-ui.md`
- [x] (2026-09-20, branch `feat/w13b-wallet-experience`) **W13b.** Professional wallet experience: session-driven Wallet page (Connect/Unlock/Dashboard), startup auto-open + pin, UI gate on History/Tasks/Rules + "⋯", dashboard (network/Funded, full key + QR Receive, trustlines + reserve, 10-op activity, account switcher, Send via `executeApprovedIntent`, Log out + auto-lock); app 404/0, agent 190/0, check/build green; W13a Rust session commands not yet in branch (feature-detected) — `backlog/w13b-wallet-experience.md`
- [x] (2026-09-20, branch `integration/wallet-login`) **MERGE-WALLET2.** Merged W13a + W13b onto the security-fixed engine; one `WalletSession` contract in `@polaris/interfaces`, fixed the `walletSessionLive` event channel, single Rust+TS suite; check/app 404/agent 190/stellar 112/build/cargo 375/clippy green — `backlog/w13a-wallet-session.md`
- [x] (2026-09-20, branch `feat/voice-dialog`) **VOICE-DIALOG.** Conversational voice layer: in-memory dialogue + pending clarification, `set_approval_rule` proposal (`Intent.rule`), `sell_asset`/`buy_asset` mapping to existing executors, prompt taxonomy; agent 213, app 385, app build green, live `e2e:prompt` 90/90 = 100% — `backlog/voice-dialog.md`
- [x] (2026-09-20, branch `integration/wallet-login`) **MERGE-HIST.** Merged the pro History timeline; new body kept as `HistoryBody` behind the same `LoginGate`/`useWalletLocked` gate as Tasks/Rules (no chain read while locked); check/app 418/agent 213/stellar 112/build/cargo 375/clippy green — `backlog/history-ui-pro.md`
- [x] (2026-09-20, branch `fix/notch-panel-clipped`, pending PR) **NOTCH-CLIP.** Wallet gate panel was clipped to the collapsed strip: the native hover watchdog force-collapsed the pinned interactive panel ~1.5 s after launch; added a `pin` shell source (attention voice still outranks), `shell_set_pinned` + runtime `pinned` watchdog exemption, Debug state readout and `.panel-body` scroll; app 407/0, cargo 377/0/5-ignored, check/build/clippy green — `backlog/fix-notch-clip.md`

### Signing bridge
- [x] (2026-09-20, branch `feat/w4a-freighter-bridge-page`, pending PR) **W4a.** Freighter signing bridge page (Stellar Wallets Kit): second Vite `/sign` entry, pure state machine, fail-closed address/network checks, signed-vs-unsigned hash binding, local fixture + tests, protocol docs (review fixes 2 applied; live Freighter still needs a human)
- [ ] (2026-09-20, branch `feat/w4b-wiring`, pending PR + W4b-1) **W4b-2.** TS wiring: Touch ID approver (`approval_begin`→open card→authorized/denied/expired/timeout, fail-closed), `bridge_sign`→`submitSignedTx`→`tx_submitted` with hash-equality check, enriched outcome + tr/en spoken result, Rust `tx_submitted_emit` command + validation, W4 Debug checks (`network`/`approval`/`bridge`/`submit`) — see `backlog/w4b-wiring.md`
- [x] (2026-09-20, branch `fix/w4b2-review`) **W4b-2 fix.** Applied the W4b-2 review: never-drop-submitted outcome (`shouldSurfaceOutcome`) + 90 s-approval tests, lazy `@polaris/stellar` imports (`signing`/`submit`/`network`), `isBridgeSigned` payload validation, `tx_submitted_emit` doc + Wallet label, approver deadline arming; MAJOR-2 eager-bundle goal blocked by out-of-scope W5/W6 modules — see `backlog/w4b2-fix.md`
- [x] (2026-09-20, branch `feat/w4b-bridge-server`) **W4b-1 (Rust).** Localhost signing-session server (`tiny_http`, one-time token, TTL, constant-time compare), `bridge_sign`/`bridge_selftest`/`bridge_health` commands, parse-free XDR verification + StrKey decode, browser launch, debug contract FeatureCheck; 44 bridge unit tests. Real browser + Freighter round trip still needs a human
- [x] (2026-09-20, branch `fix/f4-visible-errors`, pending PR) **F4.** Webview failures reach the Rust terminal via the new `polaris_log` command (redacted/truncated, optional `error` event for the Debug tail), `onerror`/`unhandledrejection` hooks, specific refusal labels, and chain/approver/signing failure logging; redactor + label-mapping tests. See `backlog/f4-visible-errors.md`
- [x] (2026-09-20, branch `feat/w10-embedded-wallet`) **W10.** Embedded wallet (Rust core + TS lib): BIP-39 create / SEP-5 import, macOS Keychain + 0600 fallback, zeroized seeds, local `ed25519-dalek` signing reusing the bridge verify, fixed command contract + `wallet_changed`, `POLARIS_SIGNER` default `embedded`, TS `lib/wallet.ts` + signer routing; Touch ID/Keychain/Friendbot still need a human — `backlog/w10-embedded-wallet.md`
- [x] (2026-09-20, branch `fix/w10-review`) **W10-fix.** Applied the wallet security review: Keychain-only default (file store requires `POLARIS_WALLET_ALLOW_FILE_STORE=1`), per-account `store` metadata, `SignerChanged` refusal, owner override only with `embedded`, one signer resolver, Debug/zeroize/0600/label/redaction fixes; cargo 362/0/5-ignored + clippy, app 385, agent 190, check/build green — `backlog/w10-review-fixes.md`
- [x] (2026-09-20, branch `feat/w13a-wallet-session`) **W13a.** Wallet session (`none`/`locked`/`unlocked`) enforced in Rust: `wallet/session.rs` + `wallet_session`/`wallet_unlock`/`wallet_lock`/`wallet_set_auto_lock`, idempotent idle auto-lock on an injected clock, `wallet_sign`/`remove`/`select`/`rename` + approval path + `ownerAddress` gated by `Locked`, `wallet_session_changed` event, `walletSession.ts` check; W13b UI separate — `backlog/w13a-wallet-session.md`
- [x] (2026-09-20, branch `feat/w11a-executor-rust`) **W11a (Rust).** Autopay executor key + strict `executor_sign_pay` (decodes with `stellar-xdr`; signs only a guard `pay_executor` call for this wallet/executor, hard cap, unlocked session) and one-Touch-ID `approval_begin_batch`/`approval_authorize_batch`; 393 cargo tests + clippy, check/app 421/stellar 112 green; live Touch ID/Keychain/on-chain `pay_executor` need a human — `backlog/w11a-executor-rust.md`
- [x] (2026-09-20, branch `fix/w11a-review`) **W11a-fix.** Applied the executor security review: fee/resource-fee caps + 5-min time bounds + no memo, 16 KiB input cap and bounded decode, auth-tree equality, atomic `executor_create`, per-asset decimals allow-list, executor cleanup on remove, all batch deny/lock hashes; cargo 372/0/5-ignored + clippy, check/app 416/stellar 112/agent 213, `e2e:autopay OK` — `backlog/w11a-executor-rust-review-fixes.md`

## Milestone 3 — Chain & Guard 🔲
- [x] polaris_guard Soroban contract: per-tx/daily spending limit + alias book; deployed on testnet, contract ID documented (2026-09-19, PR #10 + keeper PR #9)
- [x] Anchor flow, driven by voice — **primary is the SDF test anchor `testanchor.stellar.org`** (SRT/USD), verified live both directions; the TR mock anchor is secondary (deposit payouts stalled 2026-09-20). See `docs/anchor-sdf-flow.md`, `backlog/anchor-sep10-validity.md`.
  - [x] SEP-6 client merged ([PR #11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11)); voice wiring landed in W5b.
  - [x] (2026-09-20, branch `feat/w5b-anchor-flows`) **W5b.** App-side anchor `Signer` (seq-0 wallet-only challenge signing, else Touch ID pipeline) + `createAnchorSession`, voice `deposit`/`withdraw` intents, Anchor panel + Debug check; live Touch ID needs a human — `backlog/w5b-anchor-flows.md`
  - [x] (2026-09-20, branch `feat/w5a-anchor-signing`) **W5a (Rust).** Wallet-only SEP-10 challenge signing (now `wallet_sign_challenge` after W12 removed the bridge) + `anchor_signing_health`, seq-0/owner-source integrity checks (op types not parsed), parser hardened against crafted XDR (no panic), generalised signature-list parsing; live anchor challenge still needs a human — see `backlog/w5a-anchor-signing.md`
  - [x] (2026-09-20, branch `feat/w5b-anchor-flows`) **W5b-fix.** Review corrections: the real pipeline captures the signed XDR (fake-bridge tests), voice `deposit`/`withdraw` drive `runAnchorIntent` on the panel `AnchorSession`, stricter missing-command check, directional step mapping, configured passphrase — `backlog/w5b-anchor-flows.md`
  - [x] (2026-09-20, branch `fix/anchor-sdf-primary`) **ANCHOR-SDF.** Stellar SDF test anchor as a first-class scenario: fixed the SEP-10 window check (`maxTime-minTime`, not `maxTime-now`) that failed live login for both anchors, auto-filled SDF SEP-12 with clearly-fake demo data (unknown fields → `KycRequiredError`), live check + manual deposit verified; e2e blocked by SDF's USD-only SEP-38 and per-transaction identity KYC — `backlog/anchor-sep10-validity.md`
  - [x] (2026-09-20, branch `feat/bank-sim-automation`) **BANK-SIM.** Rust simulated bank ledger (`bank.rs`) + pure bank↔anchor automation (`bankFlow.ts`/`bankAnchor.ts`): deposit reserve→refund on stall, withdraw credit-once, restart reconciliation; Anchor-panel bank card/forms/history; voice routed via `runBankIntent`; `POLARIS_ANCHOR_HOME_DOMAIN` (default SDF); `bank` Debug check; cargo 328/0 + clippy clean, app 372/372 — `backlog/bank-sim.md`
  - [x] (2026-09-20, branch `integration/wallet-login`) **MERGE-BANK.** Merged BANK-SIM onto the wallet branch: `lib.rs` union (wallet + bank commands/setup once), deposit/withdraw → `runBankIntent` behind the session gate + `txPipeline`; challenge via `wallet_sign_challenge`; check clean, app 431, agent 213, stellar 970, cargo 386 + clippy clean — `backlog/bank-sim.md`
  - [x] (2026-09-20, branch `fix/anchor-sdf-primary`) **ANCHOR-SDF2.** Full SDF bank↔anchor loop LIVE both directions: scenario fiat/asset/delivery options, clearly-fake per-transaction test KYC with `transaction_id`, poll hook + `incomplete` polling, deferred withdraw account resolved before paying; deposit 10 USD→10 SRT and withdraw 10 SRT→USD both `completed`; check + 1044 stellar tests green — `backlog/anchor-sep10-validity.md`
- [ ] Protocol integration: Soroswap swap OR DeFindex vault (pick ONE via testnet spike, do not attempt both)
- [ ] Approval card UI polished (Stellar Design System / shadcn), explorer links on card
- [ ] (optional if time) MPP pay-per-command session

## Milestone 3b — Privacy modes (spike-gated) 🔲
> Design and decisions: [`docs/confidential-payments.md`](docs/confidential-payments.md).
> Testnet only; CT first, SPP second. Each system is gated by a time-boxed (2h) spike before
> integration. Scheduled confidential payments are out of scope (D6).
- [x] Design doc written (2026-09-19, this docs PR — `docs/confidential-payments.md`)
- [ ] CT spike (2h cap) → GO / NO-GO (`backlog/confidential-spike-ct.md`)
- [ ] CT integration (`stellar/src/confidential/`, PLANNED) — conditional on GO
- [ ] SPP spike (2h cap) → GO / NO-GO (`backlog/confidential-spike-spp.md`)
- [ ] SPP integration (`stellar/src/spp/`, PLANNED) — conditional on GO
- [x] (2026-09-20, branch `feat/w9-spp`) **W9.** In-app SPP read-only: `privacy` panel + `lib/spp.ts` (status/contracts/verified evidence) + Debug check; value-moving forms blocked on a bridge `signAuthEntry` extension — `backlog/w9-spp.md`
- [ ] `polaris_guard_v2` crate (new contract, own deployment; NOT an edit of `polaris_guard`) — D9
- [ ] `polaris_privacy_gate` crate (conditional on the spike showing on-chain deposit/withdraw gating is possible) — D9
- [ ] Approval-card privacy variant + batch payroll card
- [ ] Local encrypted transaction history (key custody open question)
- [ ] Demo talking points (privacy limits, public deposit/withdraw leg)

## Milestone 3c — Approval, scheduling & suggestions 🔲
> Design and decisions: [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md).
> Work items T3–T6 (T1/T2 live in Milestone 2b). D10 is the always-ask default; D11 suggestions are
> never auto-applied; D12 (keeper hosting) is PROPOSED; D13 fixes the enable order
> (`approve` → `set_rule` → `set_executor`); D14: the keeper cannot be in-contract (app =
> opportunistic keeper, tip-paying v2 parked).
- [x] (2026-09-20, chain-lane PR) **T3.** Suggestions engine: pure `suggest()` + fixtures + tests — `stellar/src/suggest/` (PLANNED), offline
- [ ] **T4.** History readers: local encrypted history store + Horizon/`Paid` events reader
- [ ] **T5.** UI (Owner A): Settings "Security" profiles, "Upcoming payments" list with Cancel, suggestions panel with Accept/Dismiss, auto-pay enable card
- [x] (2026-09-20, branch `feat/w11b-autopay-ui`) **W11b.** Autonomous payments on (TS/UI): voice/Rules-page setup → ONE batch card + Touch ID (`autopay.ts`/`autopayLive.ts`/`autopayWiring.ts`), fail-closed `send` routing via `executor_sign_pay`, batch approval card, functional Rules page, `autopay` Debug check, live `e2e:autopay` (unattended 1 XLM SUCCESS, 15 XLM #105); check/app 441/agent 213/stellar/build green — `backlog/w11b-autopay-ui.md`
- [x] (2026-09-20, W6a panel) Security panel: on-chain state + profiles + enable/tighten/disable in D13 order + alias editor + W6 Debug check — `backlog/w6a-security-panel.md` (upcoming-payments/suggestions remain)
- [x] (2026-09-20, branch `feat/w6b-schedules`) **W6b.** Scheduled payments: voice intents `schedule_payment`/`cancel_schedule` (tr/en, explicit device zone) + "Upcoming payments" panel (Cancel / New schedule / keeper strip) + `schedules` Debug check — see `backlog/w6b-schedules.md`
- [x] (2026-09-20, branch `feat/nw3-tasks-page`) **NW3.** Notch Tasks page → real schedules: `notch/data/useTasksData.ts` (view-model mappers + thin hook; mock only outside Tauri/no owner) + `TasksPage.tsx` (local+UTC next run, amount/alias, recurrence, runs left, keeper hint, Cancel via `txPipeline`, Retry/empty states); 6 mapper tests, app 299/build green — `backlog/nw3-tasks-page.md`

- [ ] **T6.** Demo runbook completed after T1/T2/T5 (`docs/demo-runbook.md`)
- [x] (2026-09-20, `integration/wallet`) **Merge-fix.** Repaired the naive five-branch merge (interfaces/agent/app/Rust); all checks, tests, build and clippy green — `backlog/merge-fix-integration.md`
- [x] (2026-09-20, `integration/wallet`) **MERGE-FIX2.** Fixed the W5a-broken Rust test build (`challenge` field in two test initializers) and re-scanned the last three merges for keep-both damage (none found); cargo test/clippy, `npm run check`, app/agent tests green — `backlog/merge-fix-integration.md`
- [x] (2026-09-20, `integration/wallet`) **MERGE-FIX3.** Merged the reviewed `feat/w5a-anchor-signing` and `feat/w5b-anchor-flows` fix branches into integration, resolving the `verify.rs` (panic-free parser + `SourceMismatch`) and `chain.ts` (W6b schedules + W5b `runAnchorIntent`) conflicts; all checks/tests/build/cargo test/clippy green — `backlog/merge-fix-integration.md`
- [x] (2026-09-20, `integration/wallet`) **MERGE-MAIN.** Merged Fatih's notch shell (origin/main #23/#24) into the pipeline branch: one App bridge over our turn session + his shell machine, typed prompt through `executeApprovedIntent`, debug check ported to `getShellGeometry`, `window_size` BUG-1 fix; all checks/tests/build/clippy green — `backlog/merge-main-notch-shell.md`
- [x] (2026-09-20, W6a-fix) Review fixes: per-step resequencing in `runTxSequence` (B1), mode-driven plan (M2), alias union + read-failed (M3), honest wording + double-click guard (N4–N8) — `backlog/w6a-security-panel.md`
- [x] (2026-09-20, branch `feat/nw2-rules-page`) **NW2.** Notch Rules page reads the real guard rules (read-only summary via `useRulesData` + pure `mapRulesView`), "Edit rules" opens the Security panel; app check/tests (299/0)/build green — `backlog/nw-rules.md`
- [ ] **T6.** Demo runbook completed after T1/T2/T5 (`docs/demo-runbook.md`)

## Milestone 4 — Delivery / Presentation 🔲
> Deadline: 20 Sep 12:00. Bonuses (passkey wallet, P2P escrow, developer mode) ONLY after M4 items are done.
- [x] (2026-09-20, `integration/wallet-login`) **MERGE-FINAL.** Merged `feat/w11a-executor-rust` + `feat/w11b-autopay-ui` + `chore/remove-freighter-bridge` (3 commits): `lib.rs` command/module union exactly once with no `bridge_*`, approval batch + autopay routing + Freighter removal reconciled; check/app 416/agent 213/stellar 1044/build/cargo 364/clippy green, `e2e:autopay OK` — `backlog/w12-remove-freighter.md`
- [x] (2026-09-20, branch `chore/remove-freighter-bridge`) **W12.** Removed the Freighter bridge entirely (Rust server/launcher/commands + `tiny_http`, bridge page/`app/src/bridge`/Wallets Kit dep/fixture/docs, `POLARIS_SIGNER`/`bridge_sign` branches); kept `verify.rs`/`strkey.rs` + `bridge/outcome.rs`; embedded wallet is the only signer — all checks/tests/build/cargo/clippy green, no wallets-kit   chunk in `dist`
- [x] (2026-09-20, branch `feat/w14-connect-wallet`) **W14.** Connect-existing-wallet as the primary first-run path: ConnectScreen leads with "Connect existing wallet" (secret mode default) over "Create new wallet" + Freighter/Lobstr/xBull copy, ImportWallet relabelled to Connect, shared `CONNECT_COPY`; import leaves the session unlocked → dashboard, no dead end; check clean, app 434/0 — `backlog/w14-connect-wallet.md`
- [x] README refreshed to reflect current codebase (constitution requirement)
- [ ] Demo video recorded + pitch deck; demo script + pitch text **rewritten for the current flow** (`docs/demo-script.md`, `docs/pitch.md`, branch `docs/final-sync`); the video itself is still to record.
- [ ] Docs synced: README/sprints/backlog/demo/pitch/wallet-track refreshed by `docs/final-sync` and the independent reviews archived in `docs/reviews/`; `notes.md` + `docs/reports/INDEX.md` unchanged by it.
- [ ] (bonus, if everything above is done) passkey wallet / P2P escrow / developer mode
- [x] (2026-09-20, W8a/W8b) P2P escrow contract `polaris_p2p_escrow`: built, 20 tests, testnet-deployed `CBMXLTXS76…`; TS client + voice intents + P2P panel via `txPipeline` (live panel/approval need a human) — `backlog/w8a-p2p-escrow.md`, `backlog/w8b-p2p-client.md`.

## Milestone 5 — Wallet & UI track ✅
> The wallet/UI track that landed on `integration/wallet-login` (branches merged in this
> order; details in `docs/wallet-track.md`). Docs for it: `docs/demo-script.md`,
> `docs/pitch.md`, `docs/reviews/`.
- [x] **W10** embedded wallet (Rust core + TS lib): BIP-39/SEP-5, Keychain seed, local Ed25519 signing → [x] **W10b** wallet login + recipients in the notch UI → **MERGE-WALLET** (`feat/w10-embedded-wallet`, `feat/w10b-wallet-notch-ui`, `fix/w10-review`).
- [x] **W13a** Rust-enforced session (`none`/`locked`/`unlocked`, auto-lock) → [x] **W13b** professional Wallet page (Connect/Unlock/Dashboard, QR, Send, Log out) → **MERGE-WALLET2** (`feat/w13a-wallet-session`, `feat/w13b-wallet-experience`).
- [x] **HISTORY-UI** pro History timeline (filters/search/drawer/paging) + **MERGE-HIST** behind the same lock gate (`feat/history-ui-pro`).
- [x] **VOICE-DIALOG** (dialogue memory, `set_approval_rule`, sell/buy routing) + **NAV** voice navigation (`feat/voice-dialog`, `feat/nav-voice-navigation`).
- [x] **W6c** Wallet/Suggestions panels; **NOTCH-CLIP** pinning fix (`feat/w6c-wallet-suggestions`, `fix/notch-panel-clipped`).
- [x] Chain track: **ANCHOR-SDF/BANK-SIM** (SDF anchor + demo bank, both directions live), **W8a/W8b** P2P escrow contract + client/panel, **W9** SPP read-only.
- [x] **W11a** executor key + `executor_sign_pay` → [x] **W11b** autonomous payments UI (`e2e:autopay` live) → [x] **W12** remove the Freighter bridge → **MERGE-FINAL**.
- [x] (2026-09-20, branch `feat/w15c-trade`) **W15c.** Trade page (Deposit·Withdraw·P2P) in the notch: anchor deposit/withdraw via BANK-SIM with a 3-row step list + bank/wallet balance line, P2P offers list + Accept and a Sell form; locked → LoginGate; check clean, app 444/0 (10 new), build green — `backlog/w15c-trade.md`
- [ ] **Open / honest:** SPP **value-moving** integration (needs wallet `signAuthEntry`); CT (confidential tokens) spike/integration; protocol integration (Soroswap swap **or** DeFindex, not both); **A4 screen reading**; developer mode; MPP; passkey wallet.
- [x] **W15d** Settings page — session/status/privacy/diagnostics/quit in the notch (`feat/w15d-settings`, `backlog/w15d-settings.md`).
- [x] **W15a** shell cleanup: panel always closable (Wallet auto-opens once at launch, logout/auto-lock collapses it), "⋯" `MoreMenu` deleted, every voice `NavigationTarget` folded into a notch page, compacted nav (`feat/w15a-shell`).
- [x] (2026-09-20, branch `feat/w15e-rules`) **W15e.** Notch Rules/Tasks redesign: one-control Rules page with live summary + Advanced (auto-pay batch save) and a compact New-schedule reveal on Tasks; check clean, app 442/0 — `backlog/w15e-rules.md`
- [x] **W15b** Wallet page radically simpler (in-app Fund account, balance hero, two-input Send, compact Contacts + cross-view `polaris:contacts-changed`, Accounts switcher/Manage) — `feat/w15b-wallet`.
- [x] **W15f** "Ask Polaris" saves/lists/deletes a contact by text/voice (read-only `save_contact`/`list_contacts`/`delete_contact`, secret-key refusal) (`feat/w15f-contact`).
- [x] **W15g** approval card moved inside the notch (no separate approval window): `notch/approval/**` overlay pins the `panel` and renders over the page body, result dwell then collapse, Touch ID/deny/batch unchanged — `backlog/w15g-approval.md`.
- [x] **W15h** panel-window layer removed: `app/src/panels/**` + `lib/panels.ts` + Rust `panels.rs`/`open_panel`/`panel-*` capability + hash routing gone; `shortAddress`→`lib/address.ts`, suggestions model→`lib/suggestionsModel.ts`, `quitPolaris`→`lib/app.ts`; docs `docs/notch-ui.md`; check/app 412/cargo 364/clippy green — `backlog/w15h-cleanup.md`.
- [x] (2026-09-20, branch `feat/w16-links`) **W16.** Every explorer link opens in the default browser: `ExplorerLink` `iconOnly` variant + links at Wallet address/accounts, History drawer, Trade/Rules/Tasks results and the approval overlay "Sent ✓" through `open_external`; check clean, app 412/0 — `backlog/w16-links.md`.
- [x] (2026-09-20, branch `feat/w17a-anchor`) **W17a.** Trade deposit/withdraw on the SDF test anchor + safe fallback: scenario-derived session (no TRY/SDF mixing), pure `selection.ts` preflights approved anchors (SDF then TR mock) and picks the first healthy one before any money moves (no fallback after value moved), "via …" caption + Details toggle; check clean, stellar anchor 219/0 (8 new), app 412/0, live SDF preflight smoke ok — `backlog/w17a-anchor.md`
- [ ] **Open / honest:** SPP **value-moving** integration (needs wallet `signAuthEntry`); **Trade page**; CT (confidential tokens) spike/integration; protocol integration (Soroswap swap **or** DeFindex, not both); **A4 screen reading**; developer mode; MPP; passkey wallet.
- **Human-verification list (unverified by automation):** real mic + STT, real Touch ID (create/sign/unlock/batch), real Keychain first-access, live anchor payout leg, live `pay_executor`, real notch windows/hover/pin, Friendbot.

---

### Notes
- Each completed checklist item is marked with date + PR link: `[x] (2026-09-19, PR #12)`
- Milestone completion criteria: all checklist items ✅ + all PRs reviewed + no open backlog entries.
