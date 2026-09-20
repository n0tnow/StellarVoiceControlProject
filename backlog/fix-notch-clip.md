# fix-notch-clip — wallet gate panel collapsed by the native hover watchdog

**Symptom.** Release build of `integration/wallet-login`: on the wallet import/login screen the shell stayed an ~86 pt strip (top bar "Ready" + "⋯", nav row, import tabs), everything below clipped. React had `applied=panel` (the "⋯" menu/nav rendered) while the OS window was at the collapsed frame.

**Root cause (verified).** Precedence was fine — the W13b pin faked an attention voice, so the reducer resolved `panel`. The native side diverged: the pinned panel is `interactive`, and `hover.rs`'s click-through watchdog force-collapsed any interactive shell whose cursor sat outside for 1.5 s (`force_click_through` → `mark_forced_collapse`). Launch → panel opens → cursor not over the notch → native collapses; no event tells React and `target` never changes, so the full panel is painted into the small window.

**Fix.** `shellState.ts` gains an optional `pin` source ranked `hotkey > attention voice > pin > hover > ambient voice > collapsed`; `useShellState` takes `pin`, records resolved diagnostics, and calls the new `shell_set_pinned`. `ShellSurface.tsx` passes the real `voiceAttention` and `pin: walletPin || panelRequest` (attention turns incl. F1 payment stages still take the surface; the pin returns after). Rust `notch.rs`: runtime `pinned`; `outside_for_longer_than` ignores a pinned gate; `shell_set_pinned`; `mark_forced_collapse` clears the pin (teardown/frozen webview); `HoverHealth` adds `pinned` + `windowHeight`. Debug "Notch hover / state" prints applied/target/source/attention, pin, native height. `index.css`: `.panel-body { min-height: 0 }` so the fixed 420 pt panel scrolls.

**Files.** `app/src/notch/{shellState,shellState.test,useShellState,ShellSurface,shellBridge,shellDiagnostics}.ts(x)`, `app/src/debug/checks/notchHover.ts`, `app/src/index.css`, `app/src-tauri/src/{notch.rs,lib.rs}`.

**Verification.** `npm run check` clean; `npm test -w @polaris/app` **407/0**; `npm run build -w @polaris/app` ok; `cargo test` **377/0/5-ignored**; `cargo clippy -D warnings` clean.

**Human-verify.** Real Mac: gate opens at 420 pt and survives cursor-away; dashboard scrolls; a recording during the gate takes the strip then returns to the panel; unlock unpins (Escape/close work). Not verified: real window/Touch ID/mic.
