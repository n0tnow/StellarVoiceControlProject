# W10b — Wallet login + recipients in the notch UI

Branch `feat/w10b-wallet-notch-ui` (worktree `.worktrees/w10b-wallet-ui`). English. Uncommitted.

## What
- **Wallet page onboarding** (`notch/pages/WalletPage.tsx` + `notch/wallet/**`): Connect → Create
  (24-word phrase shown once behind an "I saved it" gate) / Import (secret `S…` or 12/24-word phrase,
  optional index, live validation, derived-address preview + confirm, field cleared on submit/cancel).
  Active wallet → `AccountList` (select/rename/two-step remove, copy/explorer) over the NW1
  `WalletReadView` (balances, Friendbot when unfunded, alias book). All input `type=password`, never
  logged, never in URL/localStorage/events, never sent to the agent — only the typed engine command.
- **Recipients ("rumuz")**: nickname `[a-z][a-z0-9_-]{0,31}`, unique, non-reserved; address by StrKey
  checksum (lazy `@stellar/stellar-sdk`). Rust `contacts.rs` (`contacts_list/add/remove`, atomic
  `contacts.json` under app data, max 200, event `contacts_changed`). `stellar_config` merges contacts
  under env aliases: `aliases.json` < contacts < `POLARIS_ALIASES`.
- **Voice sees contacts immediately**: `lib/agent.ts` drops its memo at the start of every turn, so
  the next "send 5 XLM to ali" resolves the new alias.
- **Onboarding gate**: pure `decideWalletGate` in `lib/turnFlow.ts`; App speaks "Connect your wallet
  first.", opens the Wallet page via `lib/walletGate.ts` (`onWalletPageRequest` → `ShellSurface`), no
  chain call. A build without the engine passes through.
- **Debug**: `app/src/debug/checks/contacts.ts` (non-destructive).

## Files
`app/src/lib/{walletEngine,wallet,walletFlows,walletFlows.test,walletEngine.test,contactsModel,contacts,contactsModel.test,walletGate}.ts`,
`turnFlow.ts(+gate,+test)`, `agent.ts`; `app/src/notch/wallet/**`, `pages/WalletPage.tsx`,
`data/useWalletData.ts` (additive address override), `ShellSurface.tsx` (additive nav subscription);
`app/src/App.tsx` (gate); `app/src-tauri/src/{contacts.rs,stellar_config.rs,lib.rs}`.
Speculative abstractions: none.

## Decisions
- Engine contract coded against the fixed commands with an injectable `invoke`; missing commands are
  feature-detected (`unavailable`) and the page falls back to the read-only env-owner view instead of
  crashing. Engine calls are never made before it exists (parallel worker).
- `useWalletData` gained an optional active-address override so NW1's read path is reused unchanged.
- No new CSS; onboarding reuses the page's existing classes + small Tailwind field strings.

## Verification (ran)
- `npm run check -w @polaris/app` clean. `npm test -w @polaris/app` **374 pass / 0 fail**.
  `npm test -w @polaris/agent` **182 pass / 0 fail**. `npm run build -w @polaris/app` OK.
- `cargo test --manifest-path app/src-tauri/Cargo.toml` **324 pass / 0 fail / 5 ignored**.
- `cargo clippy --all-targets -D warnings` clean.

## Needs a human on the real notch
Touch ID create/import/remove prompts; the Keychain engine's real `wallet_status`/`wallet_changed`;
the Wallet-page open on the gate; recipient list persistence across restart; Friendbot link.

## Blocked / handoff
None. The wallet engine commands (Keychain/signing) are the parallel worker's; this branch only
consumes them. `Polaris` testnet only; no secret ever held by this code.
