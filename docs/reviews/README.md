# Independent review archive

Reports written by a reviewer who did **not** write the code (project rule, `CLAUDE.md` §3).
Only reviews that were not already filed under `backlog/` are copied here.

| Review | Verdict | What was fixed |
|---|---|---|
| [`w8a-p2p-escrow-review.md`](w8a-p2p-escrow-review.md) | APPROVE WITH CORRECTIONS (no BLOCKER/MAJOR) | Corrections are documentation only: the archival/restore of untouched offers (R-1/R-2), token error codes (R-3), no arbiter (R-4) and id-space cost (R-5) are recorded in `contracts/DEPLOYED.md` (this docs PR). |
| [`w4b-wiring-review.md`](w4b-wiring-review.md) | APPROVE WITH CORRECTIONS | MAJOR-1 (approval wait outliving the thinking watchdog) fixed by `shouldSurfaceOutcome` + a 90 s approval bound; MINOR-1 malformed-success guard, MINOR-3 stale comments fixed. MAJOR-2 (eager SDK bundle) only partially — see `backlog/w4b2-fix.md`. The Freighter path was later removed entirely (`chore/remove-freighter-bridge`). |
| [`w10-embedded-wallet-review.md`](w10-embedded-wallet-review.md) | APPROVE WITH CORRECTIONS | Fixed by `fix/w10-review` (`backlog/w10-review-fixes.md`): Keychain-only default, per-account `store`, zeroize/temp-file hardening, `warn` on file store, owner override tied to the resolved signer, one signer resolver. |
| [`w10-review-fixes.md`](w10-review-fixes.md) | W10 fix report (not a review) | Records how each W10 finding was resolved, with the branch and test counts. Kept here because the W10 review it answers is not in `backlog/`. |
| [`w11a-executor-rust-review.md`](w11a-executor-rust-review.md) | APPROVE WITH CORRECTIONS | Central invariant verified. Findings at the reviewed commit (**all fixed since**, see `backlog/w11a-executor-rust-review-fixes.md`): MAJOR-1 (no fee/resource/precondition cap) and MAJOR-2 (unbounded `stellar-xdr` decode) — fixed. |

Human-only items (Touch ID, Keychain, mic, real windows, live anchor/Freighter) are listed in each
report and are not covered by the automated suites.
