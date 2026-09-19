# Report: monorepo-skeleton

- **Date:** 2026-09-19
- **Worker/Agent:** coordinating agent (the primary model, done without workers per the user's instruction)
- **Branch/Worktree:** `feat/monorepo-skeleton` @ `.worktrees/skeleton`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/4 (`feat/monorepo-skeleton` → `main`)

## Completed

The first code in the repository: a verifiable monorepo skeleton for all four layers, so
Owner A's M2 track (A0–A5) and Owner B's chain work can start immediately without waiting
for each other.

| Path | What landed | Verified by |
|---|---|---|
| `interfaces/` | `@polaris/interfaces` — the seam from `docs/interfaces.md` (`Intent`, `ChainToolResult`, `ChainTool`, `SigningService`, `PolarisEvent`, `AppInfo`) + `POLARIS_EVENT_NAME`, `isPolarisEvent`. Source-only (no build step). | `tsc` |
| `agent/` | Tool registry, `noop` tool, typed event bus, agent loop with `AgentLlm` interface + `MockLlm` stand-in, runnable smoke test. | `tsc` + `npm run start -w @polaris/agent` |
| `app/` | Tauri v2 shell: React 19 + Vite 8 + Tailwind 4 panel with a typed event log pane, `app_info` + `dev_self_test` commands, global `polaris-event` stream, generated icon set, shadcn-ready (`components.json`, `cn`, vendored `Button`). | `tsc`, `vite build`, `cargo check` |
| `stellar/` | Owner B's placeholder module: testnet constants, `sendPayment`/`depositTry`/`swap`/`guardPolicy` stubs throwing `NotImplementedError`, `submitSignedTx` stub. | `tsc` |
| `contracts/` | Separate Cargo workspace + `polaris_guard` crate skeleton (owner auth, per-tx limit, alias book, `check_amount`) with unit tests. | `cargo test` (3 tests) + `stellar contract build` (2.9 KB wasm) |
| root | `VERSION` 0.1.0, `CHANGELOG.md`, npm workspaces, `tsconfig.base.json`, `.env.example`, `.nvmrc`, `Makefile`, `scripts/` (`setup.sh`, `check.sh`, `dev.sh`, `generate-icons.py`). | `make check` |
| docs | `README.md` (layout + quickstart), `sprints.md` (skeleton ticked, M2 progress log), `notes.md` (decision record incl. the Vite 8/esbuild gotcha), `backlog.md`. | review |

Key decisions and the evidence for them are recorded in `notes.md` → *2026-09-19 — Monorepo
Skeleton Landed*.

Two file-set notes for the reviewer:

- `contracts/polaris_guard/test_snapshots/*.json` **are** committed on purpose: the Soroban Rust
  SDK writes a snapshot (events + final ledger state) for every test that uses an `Env`, and
  those snapshots are the project's differential-test baselines
  ([SDF guide](https://developers.stellar.org/docs/build/guides/testing/differential-tests-with-test-snapshots)).
- `app/src-tauri/gen/schemas/*.json` are **generated** and must stay untracked. The existing
  `.gitignore` pattern `src-tauri/gen/schemas/` was root-anchored and therefore never matched
  `app/src-tauri/gen/schemas/`; it is fixed to `**/src-tauri/gen/schemas/` in this branch and
  the four accidentally committed files were removed from the index. Since `.gitignore` must be
  identical in every clone (`AGENTS.md` §9), the other copy of the repository needs the same fix.

## Unfinished (handed off)

- **A0 (Owner A, P0):** global hotkey (press/release) + microphone capture to WAV, wired into
  the existing log pane; then **delete `commands::dev_self_test`** — it exists only as a
  stand-in for the hotkey path.
- **A1–A5 (Owner A):** STT (whisper.cpp/Metal), real Anthropic tool-use behind `AgentLlm`,
  TTS, screen capture, Touch ID approval + signing gate.
- **`stellar/` (Owner B, P0):** implement anchor SEP-10/38/6 client and `sendPayment` first
  (the M2 vertical slice depends on it).
- **`contracts/polaris_guard` (Owner B):** rolling daily counter, typed errors
  (`contracterror`), guarded SEP-41 payment, testnet deploy + contract ID.
- Optional: GitHub Actions mirroring `scripts/check.sh` (no CI by decision while the
  hackathon is on).

## Blockers

- None. Network access, Node 22, Rust 1.97 (+ `wasm32v1-none`), `tauri-cli` 2.11.4 and
  Python 3.14 are all present on the dev machine.

## Review Notes

Reviewer checklist for this PR:

1. `make check` is green (typecheck ×4 workspaces, vite build, agent smoke test, `cargo check`).
2. `cargo test --manifest-path contracts/Cargo.toml` is green (includes the wire-shape tests).
3. The Rust↔TS wire contract matches `docs/interfaces.md`: `events.rs`/`types.rs` tests pin
   snake_case type tags + camelCase fields (`{"type":"hotkey","state":"down"}`).
4. Nothing user-specific was committed (no `.env`, no keys, no `LOCAL.md`, no recordings).
5. Ownership boundaries hold: `stellar/` and `contracts/` are Owner B's directories and contain
   stubs only — no chain behaviour was pre-empted.

Known open item for the reviewer: `app/src-tauri/tauri.conf.json` ships `security.csp: null`
(the Tauri default) to keep Vite HMR working. A strict CSP is to be added before the demo.

## Suggested Next Step

A0 in its own worktree/branch: `tauri-plugin-global-shortcut` for press/release + `cpal` (or a
small `ffmpeg`/`afrecord` shell-out fallback) to write a WAV into the gitignored `recordings/`
directory, both emitted as `PolarisEvent`s into the existing log pane, then remove
`dev_self_test`.