# W10 — Embedded wallet (Rust core + TS lib)

**What.** Default signer is a wallet inside the app (testnet only): create a
BIP-39 24-word wallet or import an `S…` secret/phrase, store only the 32-byte
seed in the macOS login Keychain, sign the approved XDR locally. No browser.

**Files.** `app/src-tauri/src/wallet/*` (+`lib.rs`,`stellar_config.rs`,
`Cargo.*`,`weblog.rs`); `interfaces/src/index.ts`; `app/src/lib/{wallet.ts,
wallet.test.ts,signing.ts,anchor.ts,stellarConfig.ts}`; `app/src/debug/{redact.ts,
redact.test.ts,checks/wallet.ts}`; `docs/{wallet-track.md(new),ui-panels.md}`;
`backlog.md`, `sprints.md`.

**Contract/decisions.** Amendment 2 verbatim (camelCase): `wallet_status/list/
create/import_preview/import/select/rename/remove/sign/sign_challenge` +
`wallet_changed`; typed `{kind,message}` errors; `wallet_create` returns the phrase
once. Keychain = plain generic password (data-protection ACLs need entitlements a
dev build lacks); a rebuild may prompt "Always Allow"; a failed probe falls back
to a `0600` file store reported `file (testnet only)`. Seeds are `Zeroizing`,
never logged/serialised/returned. `wallet_sign` consumes the gate's
`take_authorized(id)`, reuses the bridge parse-free layout, re-runs `verify_signed`.
`resolve_signer` defaults `embedded`.

**Verified.** `cargo test` 340/0/5-ignored; `cargo clippy --all-targets -- -D
warnings` clean; `npm run check` clean; app tests 357/0; agent tests 182/0;
`npm run build -w @polaris/app` built.

**Needs a human.** Touch ID prompts; Keychain first-access prompt/fallback;
Friendbot + a real testnet payment; importing a Freighter/Lobstr phrase.

**Handoff.** Wallet UI is the notch track (no `panels/notch` edits). The "never
accept/repeat secrets by voice" agent rule lives in `agent/` (out of scope).
`docs/wallet-track.md` did not exist; created one. `bridge/commands.rs` got one
additive `signer` test-fixture field (required to compile `StellarConfig`).

**Review fixes (2026-09-20, `fix/w10-review`).** Applied the L4 review: Keychain
is now the only default store; the plaintext `0600` fallback requires
`POLARIS_WALLET_ALLOW_FILE_STORE=1`, otherwise create/import/sign fail with an
actionable `keychain` error and status shows `keychain unavailable`; per-account
`store: "keychain" | "file"` stops orphaned seeds when availability flips;
`wallet_sign` refuses when the active account changed; owner override only with
`embedded`; one shared signer resolver; Debug warns on non-Keychain stores;
zeroize/temp-0600/label/Debug-redaction NITs fixed. `cargo test` 362/0/5-ignored,
clippy clean; app 385/0, agent 190/0, check/build green — `backlog/w10-review-fixes.md`.
