# notes.md — Idea & Discussion Notes

> This file is the project's memory. **Every idea** that comes up and **every discussion** held is recorded here as a dated note.
> **No note, idea, or decision is ever forgotten or deleted.** If a decision changes, an update is appended below the old note without striking it through.
> All notes are written in **English**, regardless of the conversation language.
>
> Format:
> ```
> ## YYYY-MM-DD — <Topic Title>
> - **Idea:** ...
> - **Discussion:** ...
> - **Decision:** (if any) ...
> - **Status:** [open | decided | shelved]
> ```

---

## 2026-09-19 — Project Bootstrap
- **Idea:** Project infrastructure set up: CLAUDE.md/AGENTS.md constitution, backlog system, report archive, model ladder, sprint tracking.
- **Decision:** Primary model acts as coordinator; all execution happens in parallel workers. Worktree + PR + mandatory review. Caffeinate for all long-running operations.
- **Decision:** Single-repo model — origin = `n0tnow/StellarVoiceControlProject` (shared repo), fork = personal backup only.
- **Decision:** All documentation is written in English, even when prompts/conversations are in Turkish.
- **Note:** Project topic, architecture, and technical research are being handled by another team member; results will land in `docs/reports/`.
- **Status:** decided

## 2026-09-19 — Architecture Decision (Polaris)
- **Idea:** Desktop app architecture for the Stellar Pro Hackathon (Genesis track, deadline 20 Sep 12:00).
- **Decision:** Full decision recorded in `docs/architecture.md` (registered in `docs/reports/INDEX.md`). Tauri v2 shell with thin Rust core (hotkey, audio/screen capture, Keychain + Touch ID custody) + TypeScript/React (Vite, Tailwind, shadcn/ui) webview; decision is spike-gated with Electron fallback. Soroban contract `polaris_guard` enforces spending policy on testnet.
- **Status:** decided

## 2026-09-19 — Owner A UX Vision: Notch Companion UI
- **Idea:** Polaris lives in the MacBook notch as an always-present companion. Six core UX features (Owner A's part; reference screenshots provided, visually similar to "HeyClickey"-style notch assistants):
  1. **Idle notch pill:** A black, rounded, pixel-perfect area flush with the notch, always visible even in idle state. (Ref: plain black bar hugging the notch.)
  2. **Hold-to-talk hotkey (Ctrl+Option):** While held, the assistant listens; the notch area expands horizontally (left + right) with an animated state. A short status label is shown — e.g. `Listening`, `Thinking`, `Sending`, `Speaking` — with a small animated indicator (Ref: "Thinking" state with purple gradient + pulsing dots; "Speaking" state with orange waveform bars).
  3. **Mouse-following caption pill:** When an operation runs, a button/pill appears next to the user's mouse cursor and smoothly follows it, showing the transcript of the spoken conversation. (Ref: green "YouTube Premium" pill.)
  4. **Companion cursor:** The AI has its OWN cursor, used to point at / highlight relevant spots on the screen. (Ties into M2 A4 — computer use / screen awareness.)
  5. **Expandable notch workspaces:** For required operations the notch can expand into larger in-notch interfaces (cards, controls). The concrete list of these interfaces is TBD — **to be discussed in a follow-up session.** (Ref: "Your Mac is muted — answer on clipboard, ⌘V to paste" card with an Unmute action button and close button.)
  6. **Text input mode (double-tap Ctrl):** Double-pressing Ctrl expands the notch into a text input field so the user can type to the AI instead of speaking. Includes mute toggle, attach (📎) and send buttons, close button. (Ref: "Ask HeyClickey…" input bar.)
- **Discussion:** These define the visual/interaction layer of the voice pipeline track (M2 A0–A5 harness UI evolves into this notch companion). Research tasks will be requested in a new session (native macOS notch window approach vs Tauri overlay, expansion animation, cursor-following window, companion cursor rendering).
- **Status:** open (concept recorded; research pending)


## 2026-09-19 — Two-Person Review & Merge Workflow (Main Branch Strategy)
- **Idea:** With only two collaborators and no capacity for continuous, synchronous code review, define a lightweight but mandatory PR review workflow for merging into `main`.
- **Discussion:** The constitution's mandatory-review rule (author never reviews own code) is satisfiable in a 2-person team: each person reviews the other's PRs. Review must be asynchronous and timeboxed rather than blocking, especially under the hackathon deadline (20 Sep 12:00). A fast-track path is needed for urgent fixes so review never becomes the bottleneck.
- **Decision:**
  1. **Async review with SLA:** Open a PR for every change; the other person reviews at fixed checkpoints (morning / evening) or within ~12 hours, whichever comes first. No real-time availability required.
  2. **Small PRs:** One logical change per PR (code + its doc updates together), so a review takes minutes, not hours. Draft PRs are opened early so the reviewer can follow along while work is in progress.
  3. **Merge style:** Squash-merge into `main` (one clean commit per PR), delete the feature branch after merge. `main` must always be green/deployable: CI passing + at least 1 approval (the other person) before merge.
  4. **Fast-track (deadline exception):** For urgent bug fixes or time-critical changes, the author may self-merge with the `review-after-merge` label + a short written risk note in the PR description; the other person reviews it post-merge within the next checkpoint. Not allowed for new features or anything touching secrets/key handling.
  5. **Trivial changes (docs, typos, comments):** May be merged without approval, but still via PR so history stays traceable.
  6. **Conflict avoidance:** As per constitution, parallel work stays in separate worktrees/branches with non-overlapping file scopes; rebase onto `main` before requesting review if the branch has drifted.
- **Status:** decided

## 2026-09-19 — Research: Genesis prior-art + Raven/Stellar feasibility (two reports archived)
- **Idea:** Two research reports completed and archived in `docs/reports/` (registered in `docs/reports/INDEX.md`): `2026-09-19-raven-stellar-feasibility.md` and `2026-09-19-hackathon-prior-art.md`.
- **Findings (Raven / Stellar feasibility):**
  - Raven is SDF-operated; canonical endpoint is now `raven.stellar.org` (both hosts work). OAuth PKCE + dynamic client registration accepts a loopback redirect → ~2–4h Tauri integration, or the `npx mcp-remote` sidecar.
  - LumenLoop MCP is no longer auth-free (WorkOS OAuth), so it is not a simpler fallback; Scout MCP (stdio) has no auth.
  - Mock anchor is live and the treasury is funded (~26.6k USDC). SEP-6 `/sep6/info` shows 0.5–300 vs the guide's 50–3000 units — discrepancy must be reconciled. SEP-38 uses `sell_asset`/`buy_asset`.
  - Both Soroswap and DeFindex SDKs require API keys → protocol integration is cuttable.
- **Findings (prior art / hackathon reality check):**
  - Prior art is crowded except voice-first: no voice-first build found in 1,348 indexed Stellar hackathon builds (search-based evidence). SpendGuard ≈ `polaris_guard` concept; Verbex ≈ conversation-to-DeFi; MPP was the previous hackathon's theme.
  - Recommended MVP: voice → anchor TRY→USDC → guard-routed payment → Touch ID → explorer link + one deliberate on-chain over-limit rejection. Ordered cut list: P2P, dev mode, screen control, notch polish, MPP, premium TTS, passkeys.
  - Reconcile/verify the 20 Sep 12:00 deadline and shortlist criteria with organizers.
- **Follow-ups (docs):** `docs/architecture.md` facts to correct: Raven ownership/canonical host, `skills.*` family missing from the MCP catalog list, LumenLoop auth, Scout tool count, SEP-38 field names, SEP-6 amount units.
- **Status:** open (follow-ups: deadline/criteria verification, architecture.md corrections)

## 2026-09-19 — Monorepo Skeleton Landed (first code)
- **Idea:** Land the first code in the repository: the monorepo skeleton for all layers, so both owners can start their step-by-step tracks (M2 A0–A5 for Owner A, chain work for Owner B) without waiting on each other.
- **Discussion:** Done directly by the coordinating agent in one worktree (`feat/monorepo-skeleton`) instead of parallel workers — the two-person async review workflow (§notes 2026-09-19) still applies: one branch, one PR, one review. The skeleton had to be *verifiable*, not empty folders: every layer typechecks/builds, and the shell already carries the typed event stream end to end.
- **Decision:**
  1. **Workspaces:** root npm workspaces (`interfaces`, `agent`, `stellar`, `app`); npm (not pnpm/bun) so one toolchain covers the repo; Node 22 pinned via `.nvmrc`.
  2. **Pinned versions:** TypeScript 7.0.2, React 19.3.0, Vite 8.3.0, Tailwind 4.3.3 (`@tailwindcss/vite`), Tauri crates 2.11.5 / `tauri-build` 2.6.3, `@tauri-apps/api` 2.11.1, `@tauri-apps/cli` 2.11.4, Soroban SDK 28.0.0.
  3. **`@polaris/interfaces` is source-only** (`exports` → `src/index.ts`, no build step); Vite + tsconfig alias it. It carries the seam types plus exactly two runtime values: `POLARIS_EVENT_NAME` and `isPolarisEvent`.
  4. **Rust mirror of the seam:** `app/src-tauri/src/types.rs` (`Intent`, `TxSummary`) and `events.rs` (`PolarisEvent`). Wire shape is pinned by unit tests — snake_case type tags, camelCase fields (`rename_all_fields = "camelCase"`), e.g. `{"type":"hotkey","state":"down"}`.
  5. **Event channel name is `polaris-event`** (alphanumerics + dash only) to stay clear of Tauri's event-name validation rules.
  6. **`contracts/` is a separate Cargo workspace** from `app/src-tauri`, so a Soroban wasm build never pulls the desktop dependency tree (and vice versa).
  7. **Step A0 harness is partly pre-wired:** the shell window, log pane and `dev_self_test` command exist so the stream can be exercised by hand; the command is explicitly temporary and is deleted when the real hotkey + microphone land.
  8. **No CI yet** (hackathon): `make check` / `scripts/check.sh` is the gate (typecheck all workspaces → vite build → agent smoke test → `cargo check`), with `caffeinate -i` for the long parts per AGENTS.md §4.
  9. **Icons are generator-produced** (`scripts/generate-icons.py`, stdlib only): the PNG set + `.icns` are committed because Tauri needs them at compile time, but the script is the source of truth — never hand-edit the binaries (`--check` verifies presence).
- **Gotcha found (worth remembering):** Vite 8 is rolldown/Oxc-based and **no longer bundles esbuild** — an explicit `build.minify: "esbuild"` fails with `Cannot find package 'esbuild'`. Leave the minifier at its default (Oxc) or install esbuild deliberately.
- **Gotcha found (worth remembering):** as of soroban-sdk v28 a plain `cargo build --target wasm32v1-none` is **refused on purpose** ("soroban-sdk requires stellar-cli v25.2.0+ to build a contract"). Contract builds must go through `stellar contract build` (stellar-cli v28.0.0 is installed on the dev machine; it sets `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1`). Two follow-on requirements: `[profile.release]` must set **`overflow-checks = true`** (stellar-cli rejects the profile otherwise) and host-side `cargo test` is unaffected.
- **Status:** decided
- **Idea:** Make the version-control usage explicit for agents: commit/push intervals, when to update `main`, and when real-time coordination between the two collaborators is needed.
- **Decision:** Documented as §9 in AGENTS.md/CLAUDE.md:
  1. **Commit** after every completed logical step (atomic, single-topic) — no timer-based commits.
  2. **Push** the working branch at the end of every task/session; work never stays local-only.
  3. **`main` is PR-only** (squash-merge per the async review decision); every agent pulls/rebases `main` at task start.
  4. **SemVer starts when code lands:** root `VERSION` + `CHANGELOG.md`, `v0.x.y` tags per milestone (MINOR = feature, PATCH = fix); coordinator cuts tags, agents never tag.
  5. **No real-time coordination for routine commits/pushes** — face-to-face/DM only for scope changes, merge conflicts, milestone completion, or touching files someone else is actively editing.
  6. `.gitignore`-d files stay clone-local; `.gitignore` itself must be identical across all clones.
- **Status:** decided

## 2026-09-19 — Round-3 Decisions: Contracts Frozen, Privacy Modes, Work Order
- **Decision (D8):** `polaris_guard` is **frozen for the slice**. The v0.1 audit findings go into
  `contracts/DEPLOYED.md` ("Known limitations (v0.1)") + demo talking points, and the fixes are batched
  into a single `polaris_guard` v0.2 redeploy **only after the slice works** — any change = new contract
  ID = every owner re-publishes rule + allowance + keeper env update. Spec:
  [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

## 2026-09-19 — Integration Paused; Chain Lane Headless First
- **Decision:** Integration between the UI/voice lane (Owner A) and the chain lane (Owner B) is
  deliberately **paused until both sides are done**. The chain lane stays **headless** (Node scripts,
  typed input) and touches only `stellar/` and `contracts/`. Voice is not on the critical path.
- **Pointer:** `backlog/2026-09-19-slice-gap-analysis.md` §G.3; `sprints.md` "Milestone 2b".
- **Status:** decided

## 2026-09-19 — Privacy Modes: CT then SPP (Testnet Only)
- **Decision (D2–D6):** Confidential/private payments are **in scope** as "privacy modes" because the
  project is **testnet only**, so the unaudited developer-preview status of Confidential Tokens (CT) and
  Stellar Private Payments (SPP) is not a blocker (still labelled testnet-only/unaudited). Order: **CT
  first, SPP second**, each gated by a 2h spike.
- **Decision:** voice expresses the mode as intent ("secretly"/"privately"); registration, contacts,
  address entry, default-mode changes are **manual-tab only**; addresses are never dictated by voice;
  **fail-closed** (never downgrade a private request to public). **Instant payroll is in**, **scheduled
  confidential payments are out** (keeper has no sender secret material).
- **Pointer:** [`docs/confidential-payments.md`](docs/confidential-payments.md).
- **Status:** decided

## 2026-09-19 — D1: Chain-Lane Work Order
- **Decision (D1):** chain lane order — (1) real `sendPayment` ChainTool (`Intent` → unsigned XDR +
  decoded summary; alias via committed `aliases.json`), (2) `polaris_guard` owner-side TS client
  (`set_rule`, `set_alias`, SAC `approve`, `pay_executor`, `direct`/`guarded` modes), (3) headless
  end-to-end script (over-limit rejected with guard error **#105**), and **only then** (4) the privacy
  spikes. Workers run sequentially.
- **Pointer:** `docs/confidential-payments.md` §9; `sprints.md` "Milestone 2b".
- **Status:** decided

## 2026-09-19 — Worker Ladder: DeepSeek v4.1 Flash via opencode
- **Decision:** round-3 workers run as **DeepSeek v4.1 Flash** via opencode under the Claude-based
  coordinator. The worker ladder table is **local-only** and never committed, so the ladder was simply
  updated locally for this round (no repo change).
- **Pointer:** `AGENTS.md` §2 (worker architecture); `docs/model-ladder.md` (local-only).
- **Status:** decided

## 2026-09-19 — Idea: Guard Limits at the Public Boundary for Privacy Modes
- **Idea:** because a confidential transfer hides its amount, `polaris_guard` cannot enforce per-tx/daily
  limits on the confidential leg. Move the enforceable guarantee to the **public boundary**: cap the
  amount moved *into* the CT wrapper / SPP pool (deposit amounts are public), enforce a per-transfer
  limit client-side (the app knows the amount before encrypting), and use the approval card as the gate.
  Keeper is excluded from confidential schedules.
- **Open question:** whether `polaris_guard` can gate `deposit`/`withdraw` **on-chain** (executor calls
  the wrapper) — for the spike.
- **Pointer:** `docs/confidential-payments.md` §7; `contracts/DEPLOYED.md` "Privacy modes note".
- **Status:** open (resolved by the CT/SPP spikes)

## 2026-09-19 — PROPOSED: Mixed-Mode Payroll Batch Policy
- **Idea:** A single payroll batch may mix public and private (CT/SPP) recipients, which can leak intent
  or confuse the single approval card.
- **Proposed policy (needs owner confirmation):** refuse mixed-mode batches unless every line resolves
  cleanly to one mode; otherwise split the batch into two cards (one public, one private).
- **Pointer:** `docs/confidential-payments.md` §11 risk R7.
- **Status:** open (PROPOSED — needs owner confirmation)

## 2026-09-19 — Decision: Contract Evolution = New Crates, v0.1 Frozen
- **Decision (D9):** `polaris_guard` v0.1 (deployed, id in `contracts/DEPLOYED.md`) is **frozen** and
  stays the reference deployment; its source under `contracts/polaris_guard/` is never edited again
  except for a critical owner-decided fix.
- **Decision:** every future contract change/addition is a **new crate** under `contracts/` (own Cargo
  package, own tests, own testnet deployment, own `DEPLOYED.md` section, registered as a workspace
  member), so old and new contracts are tested and run side by side. This supersedes the D8 wording of a
  single in-place v0.2 redeploy: v0.2 = new crate `polaris_guard_v2`; any on-chain privacy gate = new
  crate `polaris_privacy_gate`; client/keeper take the contract id as a parameter.
- **Pointer:** [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

<!-- New notes are appended chronologically at the bottom. -->

## 2026-09-19 — D10/D10b/D10c: Approval Profiles & Auto-Pay
- **Decision (D10):** default approval profile = **"Always ask"** — every money-out shows an approval
  card (+ Touch ID); nothing is auto-approved at first start.
- **Decision (D10b):** the user can later enable **auto-pay under a threshold** by settings OR voice
  ("don't ask me for payments under 25 USDC"); payments ≤ threshold run via `pay_executor`
  (agent-signed) without a card, above the threshold still ask.
- **Decision (D10c):** enabling/loosening is never silent — a voice request creates a **draft** that is
  read back and applied only after **ONE card + Touch ID**; tightening/disabling may be done by voice
  with read-back and the lighter confirmation; the **app preference can only be STRICTER than the
  chain, never looser**.
- **Execution order:** fixed later by **D13** — `approve` → `set_rule` → `set_executor` (executor last
  = arming); any earlier "allowance last" ordering is **SUPERSEDED by D13**.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §2–§4.
- **Status:** decided

## 2026-09-19 — D11: Local Deterministic Smart Suggestions
- **Decision (D11):** the app analyses the user's payment history and proposes changes (auto-pay
  threshold, daily limit, recurring → schedule); suggestions are computed **locally and
  deterministically** (statistics) and an LLM may only phrase them.
- **Decision:** raw history never leaves the device — only aggregates, and only if the owner allows. A
  suggestion is **never applied automatically**; it becomes a draft through the same read-back + card +
  Touch ID flow.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6.
- **Status:** decided

## 2026-09-19 — D12 (PROPOSED): Keeper Hosting for the Demo
- **Proposed decision (D12, awaiting user confirmation):** keeper hosting for the demo = the **same
  Mac** as the app (`npm run keeper -w @polaris/stellar`, wrapped in `caffeinate -i`); production path
  = an always-on small server with multiple independent keepers.
- **Note:** the user asked what "keeper hosting" means, so the docs must explain the keeper in plain
  words.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7.
- **Status:** open (PROPOSED — needs user confirmation)

## 2026-09-19 — D13: Safe Execution Order of the Enable-Auto-Pay Flow
- **Decision (D13):** the SAC allowance is mandatory for every guard payment, so a baseline allowance
  already exists in the "Always ask" profile; what **arms** unattended payments is registering the
  executor together with a positive `auto_approve_limit`. The enable flow therefore executes as
  **1) `approve` (allowance), 2) `set_rule`, 3) `set_executor`** — registering the executor is the
  **last, arming** step.
- **Card:** the approval card lists the same three actions in the same order and calls out the arming
  step; it is still **ONE card and ONE Touch ID**.
- **State after a failure:** after step 1 only the allowance changed; after step 2 the new rule is
  stored but no executor exists so nobody can auto-pay; after step 3 auto-pay is armed.
- **Disable order:** `revoke_executor` first (**disarm**), then the optional `approve(0)`.
- **Supersedes:** every earlier statement that the "allowance is last" or that the execution order is
  `set_executor, set_rule, approve` — all **SUPERSEDED by D13** (D10c note; `docs/approval-and-scheduling.md` §3, §9, §11d; the JSON
  card example; `docs/interfaces.md` §6.1; `docs/demo-runbook.md`; `sprints.md`; `backlog.md` T1 row).
- **New T1 deliverables:** `buildBaselineSetup` (allowance + `set_rule` with no executor and
  `auto_approve_limit` 0 allowed) implements the first-time "Always ask" setup (§11e); `buildTightenRule`
  refuses loosening by default; `invalid_asset` validation; card caveats (revoking the executor does not
  stop existing schedules; revoking the allowance disables ALL guard payments including owner-approved
  ones); an "allowance old → new" line with a warning when the new allowance is lower than the current.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3, §9, §11.
- **Status:** decided

## 2026-09-19 — D14: Can the Keeper Live Inside the Contract?
- **Decision (D14):** **No.** Soroban has no scheduler or timers; a contract cannot wake itself — every
  execution needs a transaction from someone.
- **What is possible:** (a) `execute_schedule` needs no auth, so anyone can trigger it — the **app can
  act as an opportunistic keeper** (on start and while open it runs due schedules) and the **payee** can
  trigger it too; (b) a future contract (**a NEW crate, per D9**, e.g. `polaris_guard_v2`) could pay a
  small **tip** to whoever triggers a due schedule so third parties run keepers — **PARKED**, not for
  the hackathon; (c) the demo keeps **D12** (keeper on the same Mac, **PROPOSED**).
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7; parked idea in
  [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

## 2026-09-20 — Chain Lane Completed and Verified Live on Testnet
- **Idea:** The chain lane (`sendPayment`, guard client, approval T1, schedules T2, suggestions T3, live adapters) is complete and verified end to end.
- **Evidence:** **922** offline tests green across 8 suites (`backlog/final-gate-chain-lane.md`); **12/12** live scenarios S0–S11 on Stellar TESTNET, independently re-read on-chain (`backlog/e2e-testnet-review.md`, all hashes `SUCCESS`); manual tool `e2e:tool` (`backlog/e2e-polish.md`).
- **Bugs the live run found:** `sendPayment` set a lower time bound (`minTime = now`) → `tx_too_early` on testnet; fixed to `minTime = 0`. Earlier rounds, independent review caught the `setRule` ABI encoding defect (`scvString`/`scvU64` instead of `scvSymbol`/`scvI128`) and the suggestions outlier threshold.
- **Status:** decided

## 2026-09-20 — Review Process Finding: Independent Review Catches What Fake-RPC Tests Cannot
- **Idea:** Every chain-lane module had a separate independent reviewer (author never reviews own code).
- **Finding:** The reviewers caught **real defects in every module** (a reject on guard-client, blocking fixes in send-payment, approval, schedule, suggest, and the e2e tooling). Offline fake-RPC tests cannot catch ABI-encoding or clock/timing bugs — those only surfaced through independent XDR/spec analysis and the live run.
- **Decision:** Keep mandatory per-module independent review before merge; treat a live testnet run as required evidence for chain-lane work.
- **Status:** decided

## 2026-09-20 — Decision: Approval Gate Is STRICT
- **Decision:** The manual `e2e:tool` approval gate is **STRICT**: it approves only the exact lowercase `y` or `yes` (at most one trailing `\n` removed); no trimming, no case folding, so `Y`, `Y `, ` y`, `YES`, `Yes`, `yes please`, `1` and EOF all abort.
- **Rationale:** approval must be explicit and default-deny; the prompt times out (120 s) and signs only the exact XDR that was displayed.
- **Pointer:** `stellar/src/live/confirm.ts`; `backlog/e2e-polish.md` (B3) and `backlog/e2e-polish-review-2.md`.
- **Status:** decided

## 2026-09-20 — Local-Only Artefacts Intentionally Not in the PR
- **Idea:** Some exploratory artefacts stay local only and are deliberately **not** part of the chain-lane PR.
- **What/where:** the test UI branch (`local/test-ui`) and the privacy/passkey spikes on local branches `spike/ct`, `spike/spp`, `spike/passkey`. Their reports live on those branches (local-only), not under `backlog/` in this PR.
- **Pointer:** chain-lane scope check in `backlog/final-gate-chain-lane.md` (Step 1: no `stellar/src/spike` or live-UI code in the diff).
- **Status:** decided
