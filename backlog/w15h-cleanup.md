# W15h — delete the panel-window infrastructure

The notch is now the only surface. Every former panel is a notch page and the
approval card is inline, so the old popup-window layer is removed.

## What was done

- **Webview:** deleted `app/src/panels/**` and `lib/panels.ts`. Moved the only
  still-used pieces with `git mv`: `panels/wallet/walletModel.ts` →
  `lib/address.ts` (kept `shortAddress` only), `panels/suggestions/suggestionsModel.ts`
  → `lib/suggestionsModel.ts` (dropped the panel-bound `acceptTarget`/`suggestionDraft`).
  `quitPolaris` moved to a new `lib/app.ts` (SettingsView updated). All 6
  `shortAddress` importers and the `suggestions` Debug check repointed.
- **Routing:** `main.tsx` no longer parses a panel hash — it always renders `App`.
- **Rust:** deleted `src/panels.rs` and `capabilities/panels.json`; removed
  `mod panels`, `open_panel` registration, the panel export and the
  `.on_window_event` panel close/resign-active handler in `lib.rs`; removed the
  now-unused `notch::resign_active` and its stale hover-health string.
- **Docs:** replaced `docs/ui-panels.md` with a 38-line `docs/notch-ui.md`; fixed
  the README section, `docs/debug-panel.md`, `docs/demo-script.md`,
  `docs/notch-pages-wiring.md`, `docs/reviews/w4b-wiring-review.md`, and the
  `voice_health.rs` doc link.

## Decisions

- Only `shortAddress` and the suggestions engine were still referenced outside
  `panels/`; both moved to `lib/` and were trimmed to what is used (no dead code).
- Historical mentions remain intentionally in `backlog.md` and `sprints.md` rows.

## Verification (run in this worktree)

- `npm run check` — clean (all 4 workspaces).
- `npm test -w @polaris/app` — 412 passed / 0 failed.
- `npm test -w @polaris/agent` — 231 / 0; `npm test -w @polaris/stellar` — 112 / 0.
- `npm run build -w @polaris/app` — built.
- `cargo test --manifest-path app/src-tauri/Cargo.toml` — 364 passed / 0 failed / 5 ignored.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `git grep -n "open_panel\|openPanel\|PanelRoot\|MORE_MENU"` — only `backlog.md`/`sprints.md` history.

## Human-verify

- Notch hover/prompt/panel/quit behave as before after the window handler removal.
  Changes are left uncommitted for the coordinator.
