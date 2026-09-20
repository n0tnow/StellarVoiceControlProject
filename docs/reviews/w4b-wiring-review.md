# Independent review — W4b-2 TS wiring (approval → Touch ID → Freighter → submit → explorer)

- **Reviewer:** independent (L4), did not write the code. Branch `review/w4b2-wiring` vs `origin/main`; the change under review is commits `65b557c..b3505f9`.
- **Verdict: APPROVE WITH CORRECTIONS.** No fail-open on the approval decision and no BLOCKER; two MAJOR defects must be fixed before the value path is trusted live.

## Commands run (real)

```
npm run check                                              -> clean (interfaces/agent/stellar/app)
npm test -w @polaris/app                                   -> tests 159  pass 159  fail 0
npm test -w @polaris/agent                                 -> tests 126  pass 126  fail 0
npm test -w @polaris/stellar                               -> 12 files / 112 passed (unchanged by W4b-2)
cargo test --manifest-path app/src-tauri/Cargo.toml        -> 180 passed; 0 failed; 5 ignored
cargo clippy --manifest-path app/src-tauri/Cargo.toml -- -D warnings -> Finished (no warnings)
npm run build -w @polaris/app                              -> built, 852 modules (see MAJOR-2)
```
All pasted report numbers reproduce. Tests are meaningful (they assert real labels, hash equality, gate re-read, sequence 0); none are tautological.

## Verified correct

- **Fail-closed decision.** `approver.ts:246-260` returns `true` only on gate `authorized`; denied/expired/timeout/superseded/`null`/`consumed` all map to `false`. A fabricated `approval_result` cannot flip it — the event only triggers a re-read of the authoritative `approval_status` (`approver.ts:158-163`), and a rejected `approval_begin` propagates.
- **Id↔XDR binding.** The TS passes only `id` to `bridge_sign` (`signing.ts:143`); Rust `take_authorized` returns the stored blob and consumes the id (`approval.rs:686-707`), and `begin` rejects a hash mismatch (`approval.rs:462`). `bridge_sign` itself is not on this branch (W4b-1), so its use of `take_authorized` is **not verified here**.
- **Submission uses Rust's signed envelope**, not a webview copy (`signing.ts:157`); `submitSignedTx` re-checks `assertSameTransaction(expected, signed)` (`chainTools.ts:156`). Hash equality between Rust `txHash` and the network result exists and is case-normalised (`signing.ts:165`).
- **Auto-approve** is unreachable in the app: `resolveRuntimeApprover` checks `isTauri()` first (`chain.ts:71-78`); the placeholder needs the flag *and* no Tauri runtime. `POLARIS_ALLOW_AUTO_APPROVE` never applies to real chain tools inside the shell.
- **Spoken success only after submission**: `App.tsx:194` gates `submittedSentence` on `status === "executed" && txHash` (set only post-submit). `tx_submitted_emit` validates 64 lowercase hex + exact canonical testnet URL and emits nothing on refusal (`tx_events.rs:60-90`), unit-tested.

## Findings

**MAJOR-1 — Touch ID wait outlives the shell's `thinking` watchdog; value can move with no confirmation.**
`APPROVER_TIMEOUT_MS = 130_000` (`approver.ts:49`) but `THINKING_WATCHDOG_MS = 60_000` (`turnSession.ts:155`). A user who takes >60 s to authenticate gets the notch flipped to `failed: "Timed out"` (`App.tsx:102-111`) while the approval card is still open; the in-flight `executeApprovedIntent` is never cancelled, so it still signs, submits and returns a `txHash`. The `.then` guard `isCurrentTurn(sessionRef.current, turnId)` (`App.tsx:193`) then drops the outcome, so the payment succeeds silently with no spoken/visible confirmation — a false failure on a money path.
*Fix:* cancel/abort the turn (or suppress the watchdog) while an approval is pending, or raise the thinking watchdog above the approver budget and let the approver be the single bound.

**MAJOR-2 — Static import chain re-adds the Stellar SDK to the eager bundle, defeating the documented lazy load.**
`chain.ts:46` now statically imports `@/lib/signing`, which statically imports `@polaris/stellar` (`signing.ts:30`); `checks/submit.ts:9` and `checks/network.ts:21` do too, and `registry.ts:83` globs every check **eagerly** (the Debug surface ← main.tsx). The built `app/dist/index.html` now `modulepreload`s `transaction_builder-*.js` (303 kB) and `server-*.js` (274 kB) on the notch overlay. This contradicts `chain.ts:146-148` ("imported lazily … must not pay for it at shell startup") and `vite.config.ts:64-67`.
*Fix:* keep `@polaris/stellar` out of statically-reachable modules — inject `submit`/`explorerTxUrl` via `SigningDeps`, make the `submit`/`network` checks dynamic, or lazy-load the Debug panel.

**MINOR-1 — `signAndSubmit` can throw despite "never throws".** `bridge.txHash.toLowerCase()` (`signing.ts:165`) is outside any try; `isBridgeSigned` only checks `ok === true`, so a malformed success shape (missing/non-string `txHash`) throws. It is caught only by App's generic `.catch` and labelled "Chain error". Validate `txHash`/`signedXdr` are strings in `isBridgeSigned`.

**MINOR-2 — `tx_submitted_emit` cannot prove a submission; `WalletPanel` trusts it.** Any webview caller can emit any well-formed hash + canonical URL (`tx_events.rs:74-90`), and `WalletPanel.tsx:20` shows it as "Latest transaction". The module doc ("cannot put an arbitrary string") overstates the guarantee. It does **not** fake the spoken confirmation (driven by the returned outcome), so impact is display-only.

**MINOR-3 — stale header in `chain.ts:27-32`** still says the approver is deny-all and "Replacing the selection below … is the only change needed"; Touch ID is now selected. Similarly `agent/src/speech.ts:11-13` still describes the intent confirmation as spoken, which `App.tsx` no longer does for intents (only post-submit/failure). Update the comments.

**NITs.** `approver.ts:242` awaits `deps.open` *before* the deadline is armed (`approver.ts:167`), so a hanging open has no bound. Concurrent polls from repeated matching events only track the last `pollTimer` (`approver.ts:154`); extra timers fire harmlessly.

## Not verified (needs a human / W4b-1)

Touch ID prompt, card opening, real Freighter signing and a live testnet payment; `bridge_sign`/`bridge_selftest`/`bridge_health` do not exist on this branch.
