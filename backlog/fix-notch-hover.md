# Report: fix-notch-hover

- **Date:** 2026-09-20 · **Worker:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `fix/notch-hover` · `.worktrees/fix-hover` · **PR:** none (coordinator commits)

## Root cause
Panels are new since the merge. `panels::open_spec` calls `window.set_focus()`, which **activates** this accessory app, and macOS delivers `addGlobalMonitorForEvents` only while the app is **not** active (Apple: "not called for events sent to your own application"). The overlay is click-through, so the local monitor cannot compensate; hiding a panel does not deactivate Polaris. So after any panel/approval interaction — the owner's failed payment — the global `mouseMoved` monitor stayed paused and hover was dead. `origin/feat/notch-shell` had no panels, so it always worked. The turn-session/reducer side is correct (new tests prove it).

## Fix (additive)
- `lib.rs` window-event handler: once the last visible panel is hidden on close, `notch::resign_active` → `NSApplication.deactivate()` (new `NSApplication` objc2 feature) restores focus and resumes the monitor.
- Diagnostics: `hover::observe` logs `polaris: notch hover inside=… state=…` per edge and stamps every sample; `shell_request_state` logs each transition; `useShellState` logs `applied/target/source` via `webLog`; new `notch_hover_health` (`HoverHealth`) + `notch_simulate_hover`; new Debug check `debug/checks/notchHover.ts` with a "Simulate hover" button.
- `turnSession.shellVoiceInputs` extracted (App uses it) + tests: failed payment → settle → hover opens the panel; a pending payment still outranks hover (F1 intact).

## Files
`app/src-tauri/{Cargo.toml,src/lib.rs,src/notch.rs,src/notch/hover.rs}`, `app/src/{App.tsx,lib/turnSession.ts,lib/turnSession.test.ts,notch/shellBridge.ts,notch/useShellState.ts,debug/checks/notchHover.ts}`.

## Verification (real output)
- `npm run check` clean (4/4); `npm test -w @polaris/app` **356 pass / 0 fail** (+2); `npm run build -w @polaris/app` OK (pre-existing warnings only).
- `cargo test` **319 pass / 0 fail / 5 ignored**; `cargo clippy --all-targets -- -D warnings` clean.

## Human verify (real Mac + notch)
Hover opens the panel **after** an approval/payment panel was opened then closed (the fix); `Debug → Notch hover` reads ok/warn and "Simulate hover" visibly expands the notch; Double-Control prompt still works.

## Blocked / handoff
None. `panels.rs` untouched — the deactivation lives in `lib.rs` using `panels`' public API.
