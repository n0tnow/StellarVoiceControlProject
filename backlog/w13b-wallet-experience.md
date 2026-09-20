# W13b — professional Wallet experience (login gate + dashboard)

## What / why
The notch Wallet page is now a real wallet experience. The Rust session is the authority:
`none` → Create/Import, `locked` (always at launch) → Touch ID unlock, `unlocked` → dashboard.
While not unlocked the panel pins itself open on Wallet and the other pages are gated.

## Files
- `lib/walletSession.ts` (+test) pure engine/store/selectors; `lib/walletSessionLive.ts` Tauri binding.
- `lib/walletAssets.ts` (+test) amount/reserve/order mappers + rich Horizon read; `lib/qr.ts` (+test) dependency-free, lazily loaded by `notch/wallet/QrCode.tsx`.
- `lib/turnFlow.ts` session gate + `UNLOCK_WALLET_SENTENCE`; `lib/walletGate.ts`.
- `notch/wallet/{useWalletSession,UnlockScreen,WalletDashboard,SendForm,QrCode,LoginGate,SessionWalletView,LegacyWalletView}.tsx`; `notch/pages/WalletPage.tsx`; gate-only edits to `History/Tasks/Rules` pages, `MoreMenu.tsx`; startup trigger + pin in `ShellSurface.tsx`.
- `notch/data/useWalletData.ts` (additive `accountDetail`, `activity[10]`, `networkPassphrase`); `debug/checks/walletSession.ts`; `docs/notch-pages-wiring.md`.

## Decisions
- Selectors + store are pure/Tauri-free; `useSyncExternalStore` gives one snapshot to shell, gate and page.
- The UI gate fails open when the session engine is absent/unread; Rust stays the fail-closed authority.
- W10b's `WalletReadView`/Create/Import/Recipients kept; the pre-session body lives in `LegacyWalletView`.
- Session types kept local to `lib/walletSession.ts` (interfaces/ out of scope); W13a may mirror them.
- QR validated 25/25 against the `qrcode` package across versions 1–10.

## Verification
- `npm run check` (root) exit 0, 0 TS errors. `npm test -w @polaris/app` 404/0; `npm test -w @polaris/agent` 190/0. `npm run build -w @polaris/app` green. QR 5/5, walletSession 8/8, walletAssets 6/6.

## Human-verify (real notch / Touch ID)
Startup auto-open+pin; Escape/hover cannot dismiss until unlocked; Touch ID unlock/cancel/refusal; picker with several wallets; live balances/trustlines/reserve/activity; Friendbot; QR scan; Send approval+Touch ID; auto-lock; remove account.

## Blocked / handoff
W13a's Rust `wallet_session`/`wallet_unlock`/`wallet_lock`/`wallet_set_auto_lock` + `locked` kind are **not in this branch**; all new surfaces are feature-detected and were exercised only against fakes, never the real engine. The typed `PromptPanel` (`app/src/notch/PromptPanel.tsx`, out of scope) still calls `executeApprovedIntent` without the gate, so its value-moving intents rely on Rust's fail-closed `locked` refusal instead of the "Please unlock…" sentence; add `decideWalletGateForTurn` there in a follow-up.
