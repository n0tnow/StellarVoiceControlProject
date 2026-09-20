# W15b — Wallet page: radically simpler

**What/why.** Rebuilt the unlocked Wallet dashboard ("everything inside the notch"): fewer
inputs, one clear action per view, no external links. The old header + "Not funded" chip +
link row + 3-input Send card (blank asset select) + Accounts + Recipients is gone.

**Files touched (all in scope).**
- `notch/wallet/WalletDashboard.tsx` — header (name, testnet chip, lock), balance hero (big XLM
  + other-asset chips; unfunded → in-app "Fund account"), address row (short, copy, inline QR),
  then Send / Contacts / Accounts.
- `notch/wallet/SendForm.tsx` — exactly two inputs on one row (To, Amount), matching-contact
  chips, asset switcher only when >1 asset (fixes blank select), one-line ✓/error result; no
  explorer link (tx hash is selectable text).
- `notch/wallet/AccountsSection.tsx` (new) — switcher only when >1 account, "Add account"
  (Connect existing / Create new), one "Manage" disclosure for rename/remove; store notice kept.
- `notch/wallet/RecipientsSection.tsx` — compact Contacts list + "Add contact" text button
  revealing Name/Address (strkey validation unchanged via `useContacts`).
- `notch/wallet/useContacts.ts`, `lib/contacts.ts` — cross-view `polaris:contacts-changed` DOM
  event (`notifyContactsChanged`); `useContacts` dispatches on add/remove and reloads on it.
- `lib/walletAssets.ts` + test — `requestFriendbotFund` (in-app faucet fetch, injected `fetchImpl`).
- `notch/wallet/SessionWalletView.tsx` — dropped `onSetAutoLock`, passes `store`.
- `notch/pages/WalletPage.tsx` unchanged; Connect/Unlock/Create/Import functionally identical.

**Decisions.** Auto-lock dropped from this page per brief (moves to Settings). Send is hidden
when unfunded so "Fund account" is the single primary action. Legacy fallback
(`LegacyWalletView`/`AccountList`/`WalletReadView`) kept for builds without the session engine.
`tauri.conf.json` untouched (CSP is `null`); Friendbot CORS verified (`access-control-allow-origin: *`).

**Verification.** `npm run check -w @polaris/app` clean; `npm test -w @polaris/app` **435 pass / 0 fail**
(7/7 in `walletAssets.test.ts`, incl. the new Friendbot test).

**Human-verify (not run here).** Live notch layout/scroll, real Touch ID send, actual Friendbot
funding + balance refresh in the app window.

**Blocked / handoff.** Logout still leaves the panel pinned (`shouldPinWallet(locked)` in
`ShellSurface.tsx`, out of scope) — the "closable after logout" fix belongs to the shell worker.
Settings page still needs the auto-lock control.
