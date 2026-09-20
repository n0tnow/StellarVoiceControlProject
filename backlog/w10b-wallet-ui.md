# W10b — Wallet login + recipients in the notch UI

Branch `feat/w10b-wallet-notch-ui` (worktree `.worktrees/w10b-wallet-ui`). English. Uncommitted.

## What
- **Onboarding** (`notch/pages/WalletPage.tsx` + `notch/wallet/**`): Connect → Create (24-word phrase
  shown once behind an "I saved it" gate) / Import (secret `S…` or 12/24-word phrase, optional index,
  live validation, derived-address preview + confirm, field cleared on submit/cancel). Active wallet →
  `AccountList` (select/rename/two-step remove, copy/explorer) over NW1's `WalletReadView` (balances,
  Friendbot when unfunded, alias book). Inputs are `type=password`, never logged, never in
  URL/localStorage/events or sent to the agent — only the typed engine command.
- **Recipients ("rumuz")**: nickname `[a-z][a-z0-9_-]{0,31}`, unique, non-reserved; address by StrKey
  checksum (lazy `@stellar/stellar-sdk`). Rust `contacts.rs` (`contacts_list/add/remove`, atomic
  `contacts.json` under app data, max 200, event `contacts_changed`). `stellar_config` merges contacts
  under env aliases: `aliases.json` < contacts < `POLARIS_ALIASES`.
- **Voice + gate**: `lib/agent.ts` drops its account/alias memo at the start of every turn, so the next
  "send 5 XLM to ali" resolves a fresh contact. Pure `decideWalletGate` (`lib/turnFlow.ts`); App speaks
  "Connect your wallet first." and opens Wallet through the NAV `navigation` request (`lib/navigation.ts`
  → `ShellSurface`), with no chain call. A build without the engine passes through.
- **Debug**: `app/src/debug/checks/contacts.ts` (non-destructive).

## Files
`lib/{walletEngine,wallet,walletFlows,contactsModel,contacts,walletGate}.ts` (+ `.test.ts` for the three
pure ones), `turnFlow.ts` (+gate,+test), `agent.ts`; `notch/wallet/**`, `pages/WalletPage.tsx`,
`data/useWalletData.ts` (additive address override), `ShellSurface.tsx` (additive nav subscription),
`App.tsx` (gate); `src-tauri/src/{contacts.rs,stellar_config.rs,lib.rs}`.

## Decisions
- Engine contract consumed via an injectable `invoke`; missing commands are feature-detected
  (`unavailable`) and the page falls back to the read-only env-owner view instead of crashing (the
  engine is another worker's parallel branch).
- `useWalletData` gained an optional active-address override so NW1's read path is reused unchanged.
- No new CSS; onboarding reuses the page's classes + small Tailwind field strings.

## Verification (ran)
- `npm run check -w @polaris/app` clean; `npm test -w @polaris/app` **374 pass / 0 fail**;
  `npm test -w @polaris/agent` **182 pass / 0 fail**; `npm run build -w @polaris/app` OK.
- `cargo test --manifest-path app/src-tauri/Cargo.toml` **324 pass / 0 fail / 5 ignored**;
  `cargo clippy --all-targets -D warnings` clean.

## Needs a human on the real notch
Touch ID create/import/remove prompts; the Keychain engine's real `wallet_status`/`wallet_changed`;
the Wallet-page open on the gate; recipient persistence across restart; Friendbot link.

## Blocked / handoff
None. Wallet engine commands (Keychain/signing) are the parallel worker's; this branch only consumes
them. Testnet only; no secret is ever held by this code.

## Merge-WALLET (`integration/wallet-login`)
- One `wallet.ts`: W10 free `wallet*` wrappers + `WalletDeps` **and** the W10b `walletEngine`
  singleton; wire types now single-sourced in `@polaris/interfaces`, with `WalletEntry`/
  `WalletActive`/`WalletCreateResult`/`WalletImportPreview` kept as aliases. `walletEngine.ts` is the
  thin injectable layer over those types; `select/rename/remove` typed to `WalletAddressOutcome`.
- `stellar_config.rs`: kept **both** behaviours — active wallet overrides `POLARIS_OWNER_ADDRESS`
  **and** saved contacts merge under env aliases (`aliases.json` < contacts < `POLARIS_ALIASES`).
- Verified: check clean; app **385/0**, agent **190/0**, stellar **112/0**; build OK; cargo
  **349/0/5-ignored**; clippy `--all-targets -D warnings` clean. Wiring read: gate → create/import →
  `wallet_status` → `ownerAddress` → approver → `wallet_sign` (embedded) / `bridge_sign` (freighter);
  WalletOnly stays in-process; phrase shown once. Touch ID / Keychain / real notch need a human.
