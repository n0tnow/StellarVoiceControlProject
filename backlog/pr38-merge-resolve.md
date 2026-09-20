# Report: pr38-merge-resolve

- **Date:** 2026-09-20
- **Worker/Agent:** W-1 DeepSeek (opencode-go/deepseek-v4.1-flash)
- **Branch/Worktree:** `resolve/pr38-merge` / `.worktrees/pr38-merge-resolve`
- **PR:** _opened against `main` (see `gh pr` link in the session/commit)_

## Objective

Merge PR #38 (`integration/wallet-login`) into `main`. The merge was already in
progress when this worker started: 7 modify/delete conflicts had been resolved
(files deleted to accept wallet-login's deletion side), leaving **6 content
conflicts** to resolve, then build, test, commit, push and open a PR.

## Conflicts resolved

| File | Resolution |
|---|---|
| `app/src-tauri/Cargo.toml` | Union of the macOS-only deps: kept main's `objc2-av-foundation` (onboarding TCC) **and** wallet-login's `security-framework` (wallet Keychain). The auto-merged `[dependencies]` already carried wallet-login's `bip39`/`hmac`/`zeroize`/`stellar-xdr` and main's `ed25519-dalek`. No `[features]` section exists on either side. |
| `app/src-tauri/src/lib.rs` | Kept `mod onboarding;`, dropped `mod panels;` (panels.rs deleted by wallet-login). Dropped `panels::open_panel` from `invoke_handler`, kept every `onboarding::*` command. Kept an `on_window_event` handler but onboarding-only (dropped the `panels::*` calls). Rewrote `any_other_interactive_visible` to consider only the onboarding window. `use tauri::{AppHandle, Manager}` kept because the resign helpers use `AppHandle`. |
| `app/src-tauri/src/notch.rs` (adjacent, not a marker) | wallet-login's auto-merged `notch.rs` had dropped main's `resign_active`, which `onboarding.rs` still calls via `crate::resign_after_interactive_close`. Re-added the macOS `NSApplication::deactivate()` implementation (+ non-macOS no-op) so onboarding's focus hand-off keeps compiling. |
| `app/src/notch/ShellSurface.tsx` | Integrated main's sfx open/close effect (`playSfx` from `@/lib/sfx`) with wallet-login's wallet session UI: kept its launch auto-open, logout/auto-lock collapse and hover-leave listeners, and its "every navigation target is a notch page" effect. Imports are the union; `MoreMenu` stays deleted. |
| `app/vite.config.ts` | Kept the `rollupOptions.input` union, but **bridge is gone**: wallet-login deleted `bridge.html`, so the entries are `main` + `onboarding` (no dangling reference to a deleted file). |
| `backlog.md` | Kept **all** open-task rows from both sides (main's UI-SFX + ONBOARDING-UI rows first, then wallet-login's W18→ANCHOR-SDF2 rows). Headers/template untouched. |
| `package-lock.json` | Hand-conflict markers removed (kept main's `uint8arrays`/`uisfx` entries), then regenerated with `npm install`. Churn is expected: it drops the ~486 transitive packages of the removed `@creit.tech/stellar-wallets-kit` and adds the new `buffer`/platform-optional entries. |

## Verification

- `npm install` (repo root) — idempotent, 0 vulnerabilities, `npm ls --depth=0` clean.
- `bash scripts/check.sh` — **green**: all workspace typechecks, stellar tests (keeper + anchor vitest), vite production build (2 entries), agent smoke test, `cargo check`.
- `bash scripts/check.sh --chain` — **green**: Soroban `cargo test`, `stellar contract build` for `polaris_guard` and `polaris_p2p_escrow`.

## Unfinished (handed off)

- None from the conflict resolution itself.

## Blockers

- None. No conflict required a product/scope decision from the user.

## Review Notes

- The PR task brief said wallet-login "added wallet/anchor/bank/p2p Vite entries"; that is not what the branch does — it **removed** the multi-entry setup (and `bridge.html`) and consolidated into the main shell. The union therefore cannot keep a `bridge` entry that points at a deleted file.
- `ShellNavigation`: the merged navigation effect is wallet-login's (all targets map to notch pages, no window-open branch), matching its deleted panel-window infrastructure.
- Live-only behaviour (real Touch ID/Keychain, macOS notch hover, first-run TCC) is unchanged by this merge and still needs a human on a real Mac — inherited open items, not introduced here.

## Suggested Next Step

- Review and merge the PR; then delete the `integration/wallet-login` branch and clean up `.worktrees/pr38-merge-resolve`.
