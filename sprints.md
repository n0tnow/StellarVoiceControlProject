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


## Milestone 3 — Chain & Guard 🔲
- [ ] polaris_guard Soroban contract: per-tx/daily spending limit + alias book; deployed on testnet, contract ID documented
- [ ] Anchor flow: SEP-10/38/6 TRY mock deposit → USDC balance, driven by voice
- [ ] Protocol integration: Soroswap swap OR DeFindex vault (pick ONE via testnet spike, do not attempt both)
- [ ] Approval card UI polished (Stellar Design System / shadcn), explorer links on card
- [ ] (optional if time) MPP pay-per-command session

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
