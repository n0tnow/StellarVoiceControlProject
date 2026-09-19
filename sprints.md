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
> Rule: **one feature at a time, no skipping.** Do not start step N+1 until step N's
> acceptance test passes and is demoed. Each step is its own branch + PR + review.

### M2 — Progress log
> 2026-09-19 — **Skeleton landed** (`feat/monorepo-skeleton`): all four layers exist and
> build (`make check`), and the shell already carries the typed `polaris-event` stream
> from Rust to the log pane. Because of that, **A0 shrinks to audio capture + hotkey**:
> the window, the log pane, the event plumbing and `app_info` are already in place
> (`dev_self_test` is the temporary stand-in for the hotkey path and must be deleted
> when A0 lands).

#### A0 — Test harness 🔲
- [ ] Minimal Tauri window: a "record" button (or hotkey) + a text log pane.
- [ ] Purpose: every later step is tested by hand through this harness, no CLI hacks.
- **Accept:** app runs, audio captured to a file, log pane prints events.

#### A1 — STT (speech → text) 🔲
- [ ] Model choice (decide, record in notes.md): local `whisper.cpp` (Metal) first; cloud API fallback only if quality fails.
- [ ] Wire: captured audio → STT → transcript into the log pane.
- **Accept:** speak 5 different commands, all transcribe correctly, <2s latency on release.

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
- [ ] **C4.** Registration/adapter so a shell can turn an `Intent` into a `ChainToolResult`; expose `@polaris/stellar` to the webview (no voice dependency)
- [ ] **C5. (PROPOSED)** Signing option: Rust approval gate + TypeScript signing/submission (option 1) for the demo; full Rust-native signer post-hackathon
- [ ] **C6. (PROPOSED)** Standardise signing on XDR: `SigningService.sign(payloadHash)` → `signTransaction(xdr)` — needs Owner A agreement
- [x] (2026-09-20, chain-lane PR) **C7.** Guard client + keeper take the contract id as a parameter (e.g. `GUARD_CONTRACT_ID`), never hard-coded, so v0.1 and v0.2 (`polaris_guard_v2`) run side by side (D9)
- [x] (2026-09-20, chain-lane PR) **T1.** Approval policy + `enableAutoPay(draft)` builder (`always_ask` | `auto_under_limit`; safe order `approve` → `set_rule` → `set_executor`, executor last = arming), `buildBaselineSetup()` / `buildTightenRule()` / `disableAutoPay()`, profile→on-chain mapping — `stellar/src/guard/` (PLANNED) (D10/D10b/D10c/D13; see `docs/approval-and-scheduling.md` §3, §9, §11)
- [x] (2026-09-20, chain-lane PR) **T2.** Schedule tools: `schedulePayment`, `cancelSchedule`, `listSchedules` ChainTools + explicit-timezone local→UTC helper (see `docs/approval-and-scheduling.md` §5, §9)

### Voice lane (Owner A — not blocking)
- [ ] **V1. (PROPOSED)** Merge order of the `interfaces/src/index.ts` branches: `a0` → `a1-stt` → `a1-ondevice` → `a2` → `a3` → `docs/rule-types-and-decisions` (freeze the seam after `a0`)
- [ ] **V2.** Merge A0 (+ A1): `make dev` runs, hold hotkey → `transcript` event
- [ ] **V3.** Text-input dev path calling `runAgentTurn(text)` → `Intent` in `AgentTrace`
- [ ] **V4.** Approval card component renders the summary + Approve/Deny
- [ ] **V5.** Submit path: sign in TS, `submitSignedTx(signedXdr, unsignedXdr)`, emit `tx_submitted`
- [ ] **V6.** Replace text input with the merged voice path
- [ ] **V7. (stretch)** Touch ID (LocalAuthentication) behind the approval gate

## Milestone 3 — Chain & Guard 🔲
- [x] polaris_guard Soroban contract: per-tx/daily spending limit + alias book; deployed on testnet, contract ID documented (2026-09-19, PR #10 + keeper PR #9)
- [ ] Anchor flow: SEP-10/38/6 TRY mock deposit → USDC balance, driven by voice
  - SEP-6 client merged ([PR #11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11)); voice wiring pending (Owner A, not on the chain-lane critical path)
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
- [ ] **T6.** Demo runbook completed after T1/T2/T5 (`docs/demo-runbook.md`)

## Milestone 4 — Delivery / Presentation 🔲
> Deadline: 20 Sep 12:00. Bonuses (passkey wallet, P2P escrow, developer mode) ONLY after M4 items are done.
- [ ] README refreshed to reflect current codebase (constitution requirement)
- [ ] Demo video recorded + pitch deck
- [ ] Docs synced: notes.md, backlog reports, docs/reports/INDEX.md, sprints.md all up to date
- [ ] (bonus, if everything above is done) passkey wallet / P2P escrow / developer mode

---

### Notes
- Each completed checklist item is marked with date + PR link: `[x] (2026-09-19, PR #12)`
- Milestone completion criteria: all checklist items ✅ + all PRs reviewed + no open backlog entries.
