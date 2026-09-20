# W10 embedded wallet — independent review (L4)

**Scope reviewed:** `git diff origin/main...HEAD` (27 files, +2493/−52); `ddd6a73`, `e1207d0`. Reviewed as a wallet security audit: key custody, Touch ID, `wallet_sign` gate, SEP-5/derivation, redaction. No code was changed; nothing committed.

**Verdict: APPROVE WITH CORRECTIONS.** No BLOCKER: the signing gate, derived keys and redaction are correct and independently re-verified. Two MAJOR custody/robustness issues should be fixed or explicitly accepted before merge.

## Findings

### MAJOR-1 — Plaintext seed fallback is automatic and quiet (opt-in wanted)
`keychain.rs:97-111` probes the Keychain once at startup; on any failure it silently stores raw 32-byte seeds in `~/Library/Application Support/Polaris/seeds/signer-<addr>.seed` (`file.rs:72-122`, mode `0600`). `0600` only stops *other users*; any process running as the user, a backup, or Full Disk Access reads it. A local attacker can force the fallback by denying the "Always Allow" prompt or locking the login Keychain, after which the next create/import writes a plaintext seed. "Loud" is only stderr + `wallets.json`-adjacent status string; the Debug check reports it as `ok` (see MINOR-4). Scenario: user denies the rebuild prompt → creates a wallet → seed is now a readable file. **Fix:** make the fallback opt-in (explicit flag/consent), or refuse create/import while the Keychain is unavailable; make the Debug check `warn`.

### MAJOR-2 — Store backend is chosen once, so seeds orphan when Keychain availability flips
`build_store` (`keychain.rs:97-111`) picks exactly one store for the whole process, but `wallets.json` is shared. Create/import during a Keychain outage writes the seed to the file store; on a later run where the probe succeeds, `active_key` (`mod.rs:470-476`) reads the Keychain and gets `seed not found` — the account is listed but cannot sign. The reverse (Keychain→file after a denied prompt) is equally reachable. **Fix:** persist which store holds each seed, or try Keychain then file per lookup, or keep the choice sticky and migrate; at minimum surface "seed not found in the active store" distinctly.

### MINOR-3 — Several secret copies are not wiped
`Zeroizing` covers the seed returned from `seed_from_phrase`/`seed_from_secret` and the phrase from `generate_phrase`, and `ed25519-dalek`'s `zeroize` feature is on (`SigningKey` wipes on drop — verified in `cargo tree`), but: `keys.rs:63` `decoded` (contains the seed) is a plain `Vec`; `keys.rs:47` `mnemonic.to_entropy()` allocates a seed-equivalent `Vec` just to read `.len()`; `file.rs:90-105` / `keychain.rs:60-73` read into a plain `Vec` before copying; `bip39`'s optional `zeroize` feature is not enabled (`Cargo.toml:67`), so the `Mnemonic` indices linger. Not remotely reachable, but avoidable. **Fix:** use `to_entropy_array().1`/`word_count()`, enable `bip39` `zeroize`, wrap read buffers in `Zeroizing`.

### MINOR-4 — Fallback not surfaced as a warning in the Debug check
`debug/checks/wallet.ts:53-59` returns `makeResult("ok", … "seed store: file (testnet only)" …)`. The Rust `wallet_health` correctly returns `Warn` for `STORE_FILE`, but the TS check never calls it. **Fix:** return `warn` when `status.store !== "keychain"`.

### MINOR-5 — Temp file is briefly world-readable
`file.rs:46-54` does `fs::write(temp)` (default 0644 under umask) *then* `set_private` chmod 0600, before the rename. **Fix:** create the temp with `OpenOptions::mode(0o600)`.

### MINOR-6 — `ownerAddress` override ignores an explicit `freighter` signer
`stellar_config.rs:186` makes the active embedded wallet's address the owner unconditionally, while `signer` is resolved independently (`:195`). With `POLARIS_SIGNER=freighter` and an embedded wallet present, the owner is the embedded `G…` but signing goes to the browser bridge → every payment fails on source mismatch. A test (`:324-338`) enshrines this. The docs claim Freighter stays usable. **Fix:** only override the owner when the resolved signer is `embedded`.

### MINOR-7 — Signer fallbacks disagree
`signing.ts resolveSigner` falls back to `freighter` on a failed `stellar_config` read; `stellarConfig.ts getSigner` defaults to `embedded`. A failed read therefore routes an embedded build to the browser bridge (fails closed, but confusing). **Fix:** one shared resolver with one documented default.

### NITs
- `mod.rs:416-435` `rename` rejects a bad label with `InvalidSecret` → UI says "that is not a valid Stellar secret key".
- `mod.rs:209-215` `CreateOutcome` derives `Debug` over the recovery phrase (test-only today, latent leak).
- `mod.rs:97-107` `Storage` always maps to kind `keychain`, even for the file store.
- `mod.rs:570-575` `short_address` slices `&address[..4]`, which can panic if `wallets.json` was hand-edited with a multibyte address (`wallet_health` is a command).
- `file.rs` (`atomic_write`/`FileStore`/`sanitize`) and `keychain.rs` have no unit tests; `docs/wallet-track.md` omits `wallet_health` from the command list.

## Verified correct (not just re-run)
- **Gate:** `wallet_sign` (`commands.rs:182-197`) is the only consumer of `ApprovalStore::take_authorized`, which marks the entry `Consumed` (`approval.rs:718-741`); it signs `released.unsigned_xdr` only. One-time consumption, foreign/tampered source and hash mismatch are tested (`mod.rs:775-821`).
- **Wrong active account at sign time fails:** `signing.rs:33-37` rejects `unsigned.source != public`; covered by `sign_refuses_a_tampered_or_foreign_transaction`.
- **Layout:** `sign_transaction`/`sign_challenge` reproduces `hint(4)||00000040||sig(64)` exactly, reuses `verify_signed`/`verify_challenge`, and the SEP-5 signing vector matches `@stellar/stellar-sdk` (`mod.rs:761-772`).
- **Challenge:** sequence-0 enforced in Rust (`signing.rs:65`), owner-sourced refused (`:70`), exactly one prior signature, payment fixture refused (`mod.rs:823-836`).
- **Derivation:** SEP-5 published vectors for indices 0 and 1 pass (`keys.rs:210-216`); hardened-only path; `index > i32::MAX` rejected; `S…` version byte + CRC16-XModem checked, bad checksum rejected.
- **Touch ID:** create/import/remove call the real `SystemAuthenticator` (`lib.rs:135`); fakes only in tests; create re-checks existence after the prompt. `select`/`rename` are metadata-only by design.
- **No secret leakage:** `wallet_import_preview` stores nothing (`mod.rs:694-703`), input zeroized in commands; status/list/health/metadata contain no phrase/seed (asserted); redaction covers `S…` seeds and 12+‑word mnemonics in both `weblog.rs` and `redact.ts`.
- **Metadata:** no secrets, atomic rename, JSON-escaped + trimmed/capped labels (no path injection).

## Commands run (all in-worktree)
```
export PATH="$HOME/.cargo/bin:$PATH"
caffeinate -i cargo test --manifest-path app/src-tauri/Cargo.toml
  → 340 passed; 0 failed; 5 ignored
caffeinate -i cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings
  → Finished, no warnings
caffeinate -i npm run check                         → clean (interfaces/agent/stellar/app)
caffeinate -i npm test -w @polaris/app              → 357 pass / 0 fail
caffeinate -i npm test -w @polaris/agent            → 182 pass / 0 fail
caffeinate -i npm test -w @polaris/stellar          → 112 pass / 0 fail
caffeinate -i npm run build -w @polaris/app         → built in 566 ms
```
Report's claimed counts match. Human-only items (Touch ID prompt, Keychain first-access/deny, Friendbot/testnet payment, real mic) remain **not verified**.

## Corrections requested before merge (or explicit coordinator acceptance)
1. MAJOR-1 opt-in (or refuse) the plaintext fallback; MAJOR-2 stop seeds orphaning when the store flips.
2. MINOR-4 warn on the file store; MINOR-5 create temp as `0600`; MINOR-6 tie the owner override to the resolved signer.
3. MINOR-3 is optional hardening.
