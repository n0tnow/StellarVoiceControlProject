# Changelog

All notable changes to Polaris are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) with the pre-1.0 policy from `AGENTS.md` §9
(MINOR for features, PATCH for fixes, one bump per milestone, coordinator cuts tags).

## [Unreleased]

### Added
- Step A0 harness: global push-to-talk hotkey **Ctrl+Option+Space** (default; fully
  user-configurable in a later settings step), hold-to-talk button fallback, microphone
  capture to 16-bit WAV via `cpal` + `hound` (files in the OS app-data `recordings/` dir),
  and the additive `audio_captured` `PolarisEvent` variant (seam doc bumped to v0.2).
- `NSMicrophoneUsageDescription` for the bundled macOS app.

### Changed
- The temporary `dev_self_test` command was removed now that real push-to-talk exists;
  the UI's recording indicator is driven by wire events, not local state alone.

## [0.1.0] — 2026-09-19

### Added
- Monorepo skeleton (npm workspaces): `interfaces/`, `agent/`, `app/`, `stellar/`, `contracts/`.
- `@polaris/interfaces` — the single TypeScript seam from `docs/interfaces.md`
  (`Intent`, `ChainToolResult`, `ChainTool`, `SigningService`, `PolarisEvent`).
- `app/` — Tauri v2 + React 19 + Vite 8 + Tailwind 4 desktop shell with an event log pane,
  a Rust→UI `polaris-event` stream (`PolarisEvent` mirror in `src-tauri/src/events.rs`)
  and a `dev_self_test` command that exercises the stream end to end.
- `agent/` — agent-core skeleton: tool registry with a `noop` tool and a mock loop that
  emits `PolarisEvent`s (real Claude tool-use wiring lands with step A2).
- `stellar/` — typed placeholder module for the chain layer (Owner B fills it in).
- `contracts/` — Soroban Rust workspace with the `polaris_guard` crate skeleton.
- Tooling: `Makefile`, `scripts/` (setup / check / dev / icon generation), `.env.example`,
  `VERSION`, workspace-pinned toolchain versions.