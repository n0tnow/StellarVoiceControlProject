# W10-fix — apply the wallet security review

**Branch/worktree:** `fix/w10-review` in `.worktrees/w10-fix` (from `integration/wallet-login`).
**What.** Applied every finding in `backlog/w10-embedded-wallet-review.md`.

## Decisions
- **MAJOR-1.** The Keychain is the only store by default. The `0600` file store is
  usable only with `POLARIS_WALLET_ALLOW_FILE_STORE=1`. Without it, a failed
  probe makes create/import/sign return `KeychainUnavailable` (`kind: "keychain"`,
  message names Keychain Access / login keychain) and status reports `keychain
  unavailable`. With it, status is `file (testnet only, plaintext)` and
  `wallet_health`/the Debug check warn.
- **MAJOR-2.** `wallets.json` records `store: "keychain" | "file"` per account
  (no secret); lookups/remove read the recorded store, old entries default to
  `keychain`. Flip tests cover both directions.
- **MINOR-3/5.** `bip39` `zeroize` feature, `to_entropy_array`, `Zeroizing` read
  buffers in file/keychain, temp file created `0600`.
- **MINOR-4.** Debug check returns `warn` for any non-Keychain store.
- **MINOR-6.** `stellar_config` overrides the owner with the embedded address only
  when the resolved signer is `embedded`.
- **MINOR-7.** One shared `resolveWalletSigner` in `wallet.ts`; `signing.ts` and
  `stellarConfig.ts` delegate to it (default `embedded`).
- **Correctness.** `wallet_sign` refuses with `SignerChanged` → `address_mismatch`
  when the active account differs from the approved XDR's source; test added. The
  approved payload's source is the signer address, so `approval.rs` was untouched.
- **NITs.** `rename` → `InvalidLabel`; `CreateOutcome` `Debug` redacts the phrase;
  file errors get `kind: "file"`; `short_address` is char-safe; `file.rs` and
  `keychain.rs` gained unit tests.

## Files
`wallet/{mod,file,keychain,keys,signing}.rs`, `Cargo.toml`, `stellar_config.rs`,
`interfaces/src/index.ts`, `lib/{wallet,walletEngine,signing,stellarConfig}.ts`,
`debug/checks/wallet.ts`, `notch/wallet/*`, `notch/pages/WalletPage.tsx`,
`.env.example`.

## Verified (real output)
- `npm run check` clean; `npm test -w @polaris/app` 385/0; `@polaris/agent` 190/0;
  `npm run build -w @polaris/app` built in 766 ms.
- `cargo test` 362 pass / 0 fail / 5 ignored;
  `cargo clippy --all-targets -- -D warnings` clean.

## Needs a human (not verified)
Touch ID; real Keychain first-access/deny; the flag on a real machine;
Friendbot/testnet payment; real notch window.

## Blocked / handoff
Scope notes (all minimal, needed by the review): `Cargo.toml` (bip39 zeroize),
`interfaces` (additive `"file"` kind), `signing.ts`/`stellarConfig.ts` (MINOR-7),
`notch/pages/WalletPage.tsx` (one store prop), `docs/wallet-track.md` (kept in
sync with the new store rules). `stellar_config` stays the wire source.
