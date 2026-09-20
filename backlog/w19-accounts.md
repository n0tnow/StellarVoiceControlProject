# W19 — Add another account while logged in (secret key + nickname), switch, remember

**Worker:** opencode worker (deepseek-v4.1-flash) · **Branch:** `feat/w19-accounts` · **PR:** none (uncommitted)

**What/why:** the owner had nowhere to enter a second account's secret key. Added an account switcher at the top of the unlocked dashboard and made the add-account flow work while unlocked.

**Files:** `notch/wallet/AccountSwitcher.tsx` (new; replaces deleted `AccountsSection.tsx`), `WalletDashboard.tsx` (header title is the switcher), `ImportWallet.tsx` (two inputs: secret + Name, passes `label`, "That account is already added." on kind `exists`), `CreateWallet.tsx` (optional `label`), `SessionWalletView.tsx` (onboarding renders whenever `mode !== "none"`), `lib/walletFlows.ts` (name in the import reducer + `MAX_ACCOUNT_LABEL`/`defaultAccountLabel`/`normalizeAccountLabel`/`validateAccountLabel`/`accountSwitcherRows`), `walletFlows.test.ts` (+4 tests). No Rust changes.

**Decisions:** nickname = trimmed, ≤24, unique case-insensitive, blank → `Account N`; switcher shows nickname + short address, ✓ on active, "+ Add account", Manage (rename/remove), `StoreNotice`. The locked Unlock screen already lists every account by nickname and unlocks the chosen one. Index field dropped for the two-visible-input rule.

**Blocker / handoff:** Rust `wallet_create` refuses when a wallet exists, so it cannot add a second account; the create link maps that error to "Polaris already holds a wallet. Connect another by pasting its secret key." A second account must go through `wallet_import`.

**Verified:** `npm run check` (all workspaces) clean; `npm test -w @polaris/app` **420/0** (walletFlows 13/0). **Human-verify:** real Touch ID on import/unlock, live Keychain, switcher look, restart persistence.
