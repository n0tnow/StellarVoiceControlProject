# RMTRAY — remove the menu-bar tray; the notch is the only entry

Removed the W0 tray (`setup_tray`/`handle_tray_menu`/`TRAY_MENU_*`) and the
`tauri` `tray-icon` feature; `panels::open`/`open_panel` stay. Added the notch
"⋯" menu (`MoreMenu.tsx`; entries + `quitPolaris` in `lib/panels.ts`; mounted in
`ShellSurface.tsx`) opening each former tray panel via `open_panel` and Quit via
new `quit_app` (`app.exit(0)`).
Files: `src-tauri/{src/lib.rs,src/commands.rs,src/panels.rs,Cargo.toml}`,
`notch/{MoreMenu.tsx,MoreMenu.test.ts,ShellSurface.tsx}`, `lib/panels.ts`,
`docs/ui-panels.md`, `backlog.md`, `sprints.md`.
Decision: menu model sits in `lib/panels.ts` so `MoreMenu.test.ts` runs under
`node:test` with no DOM. `Cargo.lock` unchanged — lockfiles are feature-independent
(`cargo tree -i tray-icon` is empty); accessory policy untouched (no Dock icon).
Tests: check clean (4 workspaces); app 357/0; build ok; cargo 317/0/5 ignored;
clippy `--all-targets -D warnings` clean.
Human-verify: no menu-bar icon; ⋯ opens each panel; Quit exits; Esc/click-outside close.
Handoff: tray wording in `README.md`, `docs/debug-panel.md`, `docs/demo-script.md`,
`docs/pitch.md` (out of scope).
