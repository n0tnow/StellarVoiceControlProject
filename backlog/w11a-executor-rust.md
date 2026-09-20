# W11a — Rust executor key, safe `executor_sign_pay`, batch approval

**What/why.** Rust half of AUTOPAY (TS half = W11b). The owner registers an executor key on `polaris_guard`; payments inside the rule are signed by that key with `pay_executor`, no Touch ID. That unprompted signature is why `executor_sign_pay` decodes the transaction itself and signs only one exact shape. Enabling auto-pay is several transactions, so one Touch ID now authorises a batch.

**Files.** `wallet/executor.rs` (new); `approval.rs` (batch gate); `wallet/mod.rs` (`Metadata.executors` + module); `wallet/file.rs` (test literal); `lib.rs`; `Cargo.toml`/`.lock` (+`stellar-xdr`); `interfaces/src/index.ts`, `app/src/lib/wallet.ts`, `app/src/debug/checks/executor.ts`.

**Decisions.** `stellar-xdr` 28 `default-features=false, features=["base64"]` (7 lock packages; 28.x has no `curr` feature — that is an older major, the generated types are current). Signer checks: unlocked session, v1 envelope, source == executor, seq > 0, exactly one op with no op-level source, `invoke-contract` of `GUARD_CONTRACT_ID` calling `pay_executor`, args[0]==executor and args[1]==active owner, no owner/delegated auth entry, amount > 0 and ≤ `POLARIS_AUTOPAY_HARD_CAP` (default 100 whole × 10^7, independent of the rule). Executor address (public) in `wallets.json` `executors[owner]`, seed under `executor-<owner>` in the wallet store; `executor_create` is idempotent and `funded` is `null` from Rust (needs Horizon). Batch is additive on `ApprovalSnapshot` (`batch`, no XDR); `wallet_sign(id)` releases each step once; deny/expiry/lock reject all. Fixtures generated with `@stellar/stellar-sdk` 17.1.0 (Node one-off over `Contract.call`), base64 pasted with the generation note.

**Verified.** `cargo test --lib` **393 pass / 0 fail / 5 ignored** (10 executor: wrong contract/function, two ops, non-invoke, wrong source, owner mismatch, over-cap, seq-0, owner-auth, locked, 1500-iteration fuzz; 6 batch). Clippy `--all-targets -D warnings` clean. `npm run check` green; app **421/0**, stellar **112/0**, agent **213/0**.

**Human-verify.** Real Touch ID for `executor_create`, real Keychain item, live on-chain `pay_executor` with a funded executor.

**Handoff.** W11b consumes these commands; `funded` stays `null` (read Horizon on the TS side).
