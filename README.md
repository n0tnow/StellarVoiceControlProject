# Polaris

> **Under construction.** Working product name: **Polaris** — a push-to-talk voice
> assistant for Stellar (hackathon track: Genesis, 19–20 Sep 2026).
>
> This README is refreshed by a dedicated agent at the end of every milestone
> (see `AGENTS.md` §6). It currently describes the **skeleton** stage: the structure is
> in place and builds; the voice pipeline is not wired yet.

| Where things stand | |
|---|---|
| Milestones | see `sprints.md` (M0 done · M1 done · M2 in progress) |
| Architecture & decisions | `docs/architecture.md`, `notes.md` |
| Owner-to-owner contract | `docs/interfaces.md` (= `interfaces/src/index.ts`) |
| Work handoff queue | `backlog.md` + `backlog/*.md` |
| Research archive | `docs/reports/` |

## What it does

Hold a global hotkey, speak, and Polaris thinks, answers and can act on Stellar:
it knows the ecosystem, can move testnet value (**always gated by Touch ID**), can see the
screen, and can scaffold/develop a Stellar project by voice. Scope and non-goals
(mainnet, real money, our own anchor) are defined in `docs/architecture.md` §1.

## Repository layout

```
interfaces/   @polaris/interfaces — the ONLY typed seam between owners (source-only pkg)
agent/        @polaris/agent      — agent loop, tool registry, event bus        (Owner A)
app/          @polaris/app        — Tauri v2 desktop shell: Rust core + React UI (Owner A)
  src/            React 19 + Vite 8 + Tailwind 4 panel, event log pane
  src-tauri/      Rust: window, typed event stream, (later) hotkey/audio/Touch ID
stellar/      @polaris/stellar    — anchor client, protocol integration, bindings (Owner B)
contracts/    Soroban Cargo workspace: polaris_guard (spending policy + alias book) (Owner B)
scripts/      setup / check / dev / icon generation
docs/         architecture, interfaces, research reports
```

Ownership rules and the worktree/PR workflow are in `AGENTS.md` / `CLAUDE.md`.
Directory ownership is fixed by `docs/interfaces.md` §5: never edit the other owner's layer
without agreeing in PR review.

## Quickstart

Requirements: macOS (Apple silicon), Node >= 22, Rust stable, `cargo-tauri`
(`cargo install tauri-cli --version ^2`) or the local `@tauri-apps/cli`, and
**stellar-cli >= 25.2.0** (`brew install stellar-cli`) for contract builds — soroban-sdk v28
refuses a plain `cargo build --target wasm32v1-none`.

```bash
make setup        # npm install + generate app icons + create .env from .env.example
make check        # typecheck all workspaces, vite build, agent smoke test, cargo check
make dev          # run the desktop shell (Tauri dev with Vite HMR)
make check-chain  # full check including the Soroban crate build + tests
```

Other entry points:

```bash
npm run agent                               # agent skeleton smoke test (prints PolarisEvents)
make build                                  # bundle Polaris.app (release)
make build-contracts                        # polaris_guard -> wasm (release)
python3 scripts/generate-icons.py --check   # verify the committed icon set
```

Long operations are wrapped in `caffeinate -i` by the scripts (`AGENTS.md` §4).

## What is wired today (and what is not)

**Wired**
- The **typed event stream**: Rust (`app/src-tauri/src/events.rs`) emits `PolarisEvent`s on the
  `polaris-event` channel; the UI subscribes through `app/src/lib/polaris.ts` and renders them
  in the log pane. The wire shape (snake_case type tags, camelCase fields) is pinned by Rust
  unit tests, and the same TypeScript union lives in `interfaces/`.
- `app_info` (version/network in the header) and the panel shell with its log pane and status.
- The agent skeleton: tool registry + `noop` tool + loop, runnable without an API key
  (`MockLlm`).
- `polaris_guard` contract skeleton (owner auth, per-tx limit, alias book) with unit tests.

**Not wired yet** (step order in `sprints.md`)
- hotkey + microphone capture (`A0`) — the `Hold to talk` button is disabled on purpose and
  `dev_self_test` is a temporary stand-in for the hotkey path,
- speech-to-text (`A1`), the real Anthropic tool-use model (`A2`), speech output (`A3`),
  screen reading (`A4`), Touch ID approval + signing (`A5`),
- `stellar/` is stubs only: every chain tool throws `NotImplementedError` (Owner B, Milestone 3).

## Security & secrets

- Testnet only. No mainnet, no real money.
- Keys never enter the repository: `.env` is gitignored (`.env.example` is the template),
  signing keys live in the macOS Keychain, and no value-moving step executes without an
  explicit Touch ID approval.

## Versioning

`VERSION` + `CHANGELOG.md` follow SemVer with the pre-1.0 policy from `AGENTS.md` §9
(`v0.x.y`, one bump per milestone, coordinator cuts the tags).
