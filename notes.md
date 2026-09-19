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

<!-- New notes are appended chronologically at the bottom. -->
