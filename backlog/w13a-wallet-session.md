# W13a — wallet session (login / logout / auto-lock), Rust-enforced
Adds `none → locked → unlocked` for the embedded wallet (W13b builds the UI). Rust
refuses secret-touching paths while locked, withholds `stellar_config.ownerAddress`,
and rejects the previous session's approval on lock.

Files (additive): `wallet/session.rs` (new: `SessionStore`, `WalletSession`, commands
`wallet_session`/`wallet_unlock`/`wallet_lock`/`wallet_set_auto_lock`, `spawn_auto_lock`,
12 tests); `wallet/mod.rs` (`Locked`, `Metadata.autoLockMinutes`); `wallet/commands.rs`
(gate + session event); `stellar_config.rs` (`with_locked_owner`); `approval.rs`
(`Locked`, `invalidate_for_lock`, begin/authorize checks); `events.rs`
(`PolarisEvent::WalletSessionChanged(WalletSession)`); `lib.rs`; `interfaces/src/index.ts`
(`WalletSession` + `"locked"` kinds); `app/src/lib/wallet.ts` (wrappers +
`onWalletSessionChanged`); `app/src/debug/checks/walletSession.ts`; `DebugPanel.tsx` (1 line).

Decisions: Touch ID via the existing `biometric.rs` `Authenticator`; locked is fail-
closed; auto-lock uses an injected clock (tests never sleep); create/import leave the
session unlocked, restart is always locked; sign/challenge report a locked refusal via
`not_authorized`, while the `{kind,message}` commands and approval path use `"locked"`.

Verification: `npm run check` green; app **385/0**; cargo test **362/0/5-ignored**;
`cargo clippy --all-targets -D warnings` clean. Human-verify: real Touch ID prompt, real
auto-lock, lock surviving a restart, and the W13b UI.

Handoff: `ownerAddress` is withheld for every signer while locked (a Freighter-only user must log in first, per contract); `DebugPanel.tsx` got one case for the new tagged event.

## MERGE-WALLET2 — W13a + W13b onto the security-fixed engine (branch `integration/wallet-login`)
Merged `feat/w13a-wallet-session` then `feat/w13b-wallet-experience`; resolved `wallet/mod.rs` (kept both `SignerChanged→address_mismatch` and `Locked→not_authorized`), `interfaces/index.ts`, `backlog.md`, `sprints.md`, `WalletPage.tsx` (W13b session page; W10b body preserved in `LegacyWalletView`), and the `debug/checks/walletSession.ts` add/add (one check on `walletSessionEngine` + auto-lock detail).
Reconciliation: one `WalletSession`/`WalletSessionState` definition in `@polaris/interfaces`; `walletSession.ts` is the pure store/engine using them; removed W13a's duplicate command wrappers from `wallet.ts`. Fixed `walletSessionLive.ts` event drift: it now listens on `polaris-event` and filters the `wallet_session_changed` tag (was the wrong channel). Fixed merge-bit Rust tests (`file.rs` Metadata field, `session.rs` `WalletService::new(Stores,…)`).
E2E read-confirmed: launch locked/none → panel pins Wallet → Touch ID unlock → `ownerAddress` set → payment → approver → `wallet_sign` → submit; locked refuses before `take_authorized`. Kept W13a's fail-closed bridge code (`not_authorized`) for `wallet_sign` while locked; typed kind is `"locked"`. WalletOnly stays webview-unreachable, Keychain-only default, seeds never leave Rust, auto-approve placeholder untouched.
Verification: `npm run check` green; app **404/0**, agent **190/0**, stellar **112/0**; `npm run build -w @polaris/app` green; cargo test **375/0/5-ignored**; `cargo clippy --all-targets -D warnings` clean.
Human-verify: real Touch ID unlock/cancel, real idle auto-lock, locked-next-restart, live notch pin/unlock/dashboard.

