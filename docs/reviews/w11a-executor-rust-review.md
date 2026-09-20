# W11a review — executor key, `executor_sign_pay`, batch approval

**Reviewer:** independent (L4). Read-only; nothing changed.
**Scope.** Commit `9009d79` (`wallet/executor.rs` + batch half of `approval.rs` + metadata/interfaces wiring). `origin/main` is far behind this branch (merge-base `4f52db7`; `9009d79^` = `311cb2c`), so `git diff origin/main...HEAD` is dominated by unrelated integration history; I reviewed `git show 9009d79` in isolation and inspected the guard contract at `contracts/polaris_guard/src/lib.rs`.

## Commands run (exact)
- `npm run check` → all 4 workspaces tsc, exit 0.
- `npm test -w @polaris/app` → **421 passed / 0 failed**; `-w @polaris/stellar` → **112/0**; `-w @polaris/agent` → **213/0**.
- `cargo test --manifest-path app/src-tauri/Cargo.toml` → **393 passed / 0 failed / 5 ignored** (the 5 are unrelated stt/tts manual `#[ignore]` tests).
- `cargo test --manifest-path app/src-tauri/Cargo.toml executor` → **10 passed / 0 failed / 0 ignored** (fuzz included; not ignored).
- `cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings` → clean.

## Verified correct (attacked and found sound)
- **Envelope shape**: only `TransactionEnvelope::Tx` (v1) accepted; v0 and fee-bump hit `_` → `Invalid`. `from_xdr` uses `read_xdr_to_end`, so trailing bytes are rejected and the stellar-xdr body matches the parse-free `verify` body used for the hash.
- **Source/op**: muxed source → `WrongSource`; op-level source rejected; exactly one op; only `HostFunction::InvokeContract`. Contract compared as raw 32-byte hash via the local StrKey decoder (len 56, version `0x10`, CRC16), function name compared byte-exact.
- **Args** (contract is `pay_executor(executor, owner, to, asset, amount)`): `args[0] == registered executor`, `args[1] == active owner`, `args[4]` decoded as signed i128 (`(hi<<64)|lo`), `amount > 0` and `≤` hard cap; negative/overflow rejected.
- **Hard cap** `POLARIS_AUTOPAY_HARD_CAP` (default 100×10⁷) is read from the process env, not the webview, and is independent of the on-chain rule.
- **Presence/owner**: `sign_pay` calls `session.ensure_unlocked()` first; only the active owner's executor seed is read; seed is `Zeroizing`, never logged/serialized/returned. `executor_create` checks unlocked + Touch ID *before* generating, and is idempotent (existing key cannot be silently replaced).
- **Auth entries**: owner `Address`/`AddressV2` credentials and `AddressWithDelegates` are refused. The unvalidated `root_invocation` (see MINOR-3) is **not exploitable**: per CAP-46-11 the host matches entries to actual `require_auth` invocations and ignores unmatched entries, so an extra auth entry cannot cause an extra state change.
- **Batch**: `WalletOnly` rejected on the webview path; per-item digest re-hash; one prompt; deny/lock/expiry reject the whole batch; superseding removes the batch; entries immutable; `MAX_BATCH_ITEMS = 8`; each item released once by `wallet_sign(id)`.

## Findings
**BLOCKER** — none. I found no path that signs a tx other than the one guard `pay_executor` call, no way to skip the session, and no way to move owner funds outside the on-chain rule/allowance.

**MAJOR-1 — no fee / Soroban-resource / precondition validation (executor.rs:309-399).** The validator checks the operation but never `tx.fee`, `tx.ext` (`SorobanTransactionData.resource_fee`), `tx.cond`, or `tx.memo`. A compromised webview can call `executor_sign_pay` with a correctly-shaped `pay_executor` op yet a maximal `fee` (u32::MAX ≈ 429 XLM) and arbitrary resource fee; the executor pays it. It can also sign a tx with far-future/never time bounds. For an *unprompted, value-moving* signer this is a real fail-open on cost. Fix: cap `tx.fee` (and reject a `SorobanTransactionData` whose fee exceeds a small bound), require no/empty time bounds; extend the tests.

**MAJOR-2 — unbounded decode / self-DoS (executor.rs:316, command at 560-583).** `executor_sign_pay` is a sync Tauri command taking an unrestricted `String xdr` and parses it with `stellar_xdr::Limits::none()`, i.e. `depth = u32::MAX, len = usize::MAX` (verified in stellar-xdr 28 `generated.rs:348`). `ScVal::Vec`/`Map` are recursive (`generated/sc_val.rs:288-310`), so a crafted, valid-up-to-the-args envelope containing a deeply nested `ScVal` (≈12 bytes/level) recurses until the stack overflows → `SIGABRT` of the whole app. Unlike the approval gate (`MAX_XDR_BYTES = 16 KiB`), there is no size cap here. The fuzz test only truncates ≤128 bytes and feeds ≤400 random bytes, so it never exercises this. Fix: `Limits::depth(...)` + a length cap (or reuse `MAX_XDR_BYTES`), and run the decode on `spawn_blocking`.

**MINOR-1 — batch deny/lock reports the wrong item (approval.rs:1039, 1156-1186).** `deny` on a batch returns `batch.entries[0].payload_hash` regardless of which step was denied, and `invalidate_for_lock` returns only the first hash, so for an N-step batch only one `approval_result` is emitted and it may carry a different step's hash. `approval_status` is authoritative, so impact is limited, but events are mis-bound. Fix: return the denied entry's hash (or all hashes for a batch).

**MINOR-2 — executor seed outlives the account (wallet/mod.rs:640-669).** `remove` deletes only `signer-<addr>`; the `executor-<addr>` seed and the `executors[addr]` metadata row are left behind. Removing does invalidate signing (active address changes), but a later re-import of the same address silently resumes unprompted executor signing from the old key without a fresh Touch ID/`executor_create`, and the Keychain/plaintext seed is orphaned. Fix: drop `executors[addr]` and delete the executor seed on removal (or document the recovery intent).

**MINOR-3 — auth tree not validated (executor.rs:383-398).** The `SourceAccount` entry's `root_invocation`/`sub_invocations` are never compared to the `pay_executor` call. Not exploitable today (CAP-46-11 matching; unmatched entries ignored), but requiring the root invocation to equal the operation (and empty sub-invocations) is cheap hardening for a no-prompt signer.

**MINOR-4 — `executor_create` check-then-write race (executor.rs:248-269).** The idempotency check and the metadata insert are not under one lock; two concurrent creates (webview double-invoke) can interleave so the Keychain seed is one key while `executors[owner]` names the other, leaving an executor that always fails `verify_signed`. Fix: re-check/insert under the metadata lock, or serialize creation.

**NITs.** `read_seed` (executor.rs:222-242) may silently fall back to the plaintext file store even when the seed was created in the Keychain, unlike `Stores::get`'s recorded-kind rule. The `approval_request` event for a batch (approval.rs:1479-1488, snapshot at 453-500) carries an empty `payloadHash` and synthesized intent — W11b consumers must use ids. `ASSET_DECIMALS` is hardcoded 7, so the backstop is miscalibrated if the allowed asset has other decimals. `validate_never_panics_on_mutations` gives false confidence (no deep-nesting/large-input cases).

## Verdict
**APPROVE WITH CORRECTIONS.** The central invariant holds: the executor key can sign nothing but one guard `pay_executor` call for the active owner, session-locked is fail-closed, and the unvalidated auth tree cannot move extra funds. Before merge: fix MAJOR-1 (fee/resource/precondition cap) and MAJOR-2 (bounded depth/length + input size cap); MINOR-1/2 and NITs can follow.

**Not verified (human):** real Touch ID for `executor_create`, real Keychain item, a live on-chain `pay_executor` with a funded executor, Horizon funding of the executor.
