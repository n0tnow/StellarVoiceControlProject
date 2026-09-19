# Review: independent verification of the live TESTNET end-to-end run + security review of the live adapters

- **Date:** 2026-09-20
- **Reviewer:** W-review-e2e (DeepSeek v4.1 Flash, L4 — did not write the code under review)
- **Branch/worktree:** `review/e2e-live` @ `.worktrees/e2e-live-review` (HEAD `1b4c40f`, equals `chain/e2e-live`)
- **Under review:** `git diff HEAD~2` — `stellar/src/live/**` (+ offline tests), `stellar/src/payments/sendPayment.ts` (+ test), `stellar/package.json`, `backlog/e2e-testnet.md`
- **Method:** all network access read-only testnet (`soroban-testnet.stellar.org` JSON-RPC, `horizon-testnet.stellar.org` GET). No transaction was sent, no Friendbot, no deploy, no other host. The reviewer read `~/.polaris-e2e/results-*.json` (public) but never `keys.json`.

## Verdict: approve with corrections

1. The central claim is fully true: all 16 report hashes (plus the 4 setup hashes) are `SUCCESS` on-chain, at the claimed ledgers, with the claimed function/op, source account and arguments; current chain state matches the report's final state exactly.
2. The one real bug (`sendPayment` `tx_too_early`) is genuinely fixed, the regression test genuinely fails on the old code, `S5`'s simulation-only evidence is technically sound, and the measured 17 s schedule delay reproduces exactly.
3. Security of the live adapters is sound (testnet-only enforcement is airtight, no secret ever leaves `keys.json`); the corrections are documentation and small hardening items — **no blocking correctness or security issue was found**.

## 1. Hash verification table

Independently re-read with `getTransaction` (Soroban RPC) / Horizon. Envelope decoded with `@stellar/stellar-sdk` (`TransactionBuilder.fromXDR` + `scValToNative`) in a scratch script (since deleted). Amounts are raw units (7 dp).

| Scenario | Hash (short) | Status | Function / op (decoded args) | Source account | Ledger | Matches report? |
|---|---|---|---|---|---|---|
| S1 | `b36551fc4e` | SUCCESS | SAC `approve(owner, guard, 50000000000, exp 5284002)` | owner `GBKTFHHL…` | 4765604 | yes |
| S1 | `cf3c45cd89` | SUCCESS | `set_rule(owner, {auto:0, per_tx:5000000000, daily:20000000000, [SAC], known:false})` | owner | 4765605 | yes |
| S2 | `ae174d866a` | SUCCESS | `set_alias(owner, "ada", recipient GBKBLL2I…)` | owner | 4765607 | yes |
| S3 | `b8e3ac393c` | SUCCESS (classic) | `payment` 25.0000000 E2EUSD → recipient; `timeBounds.minTime=0` | owner | 4765609 | yes |
| S4 | `6a4642d31d` | SUCCESS | `pay_owner(owner, recipient, SAC, 400000000)` = 40 | owner | 4765611 | yes |
| S6 | `ea24a30b71` | SUCCESS | SAC `approve(owner, guard, 50000000000)` | owner | 4765614 | yes |
| S6 | `6513b71106` | SUCCESS | `set_rule(owner, {auto:1000000000, per_tx:5000000000, daily:20000000000})` | owner | 4765615 | yes |
| S6 | `fc1cc92c27` | SUCCESS | `set_executor(owner, executor GDFX76I4…)` | owner | 4765616 | yes |
| S7 | `711c326ffe` | SUCCESS | `pay_executor(executor, owner, recipient, SAC, 300000000)` = 30 | **executor** | 4765618 | yes |
| S7 | `875ced2377` | SUCCESS | `pay_owner(owner, recipient, SAC, 1500000000)` = 150 | owner | 4765620 | yes |
| S8 | `37368b7d63` | SUCCESS | `create_schedule(owner, recipient, SAC, 200000000, first_run 1789851780, interval 0, runs 1)` | owner | 4765622 | yes |
| S8 | `30bb69e63e` | SUCCESS | `execute_schedule(13)` | **keeper `GB5NFVLP…`** | 4765642 | yes |
| S9 | `459f49d0ee` | SUCCESS | `create_schedule(owner, recipient, SAC, 50000000, first_run 1789855380, interval 0, runs 1)` | owner | 4765644 | yes |
| S9 | `0b6391c7fe` | SUCCESS | `cancel_schedule(owner, 14)` | owner | 4765646 | yes |
| S10 | `853181d765` | SUCCESS | `revoke_executor(owner)` | owner | 4765647 | yes |
| S10 | `c17ad29c14` | SUCCESS | `set_rule(owner, {auto:0, per_tx:1000000000, daily:20000000000})` | owner | 4765649 | yes |
| setup | `984fab395d` | SUCCESS (classic) | `change_trust` E2EUSD | owner | 4765597 | ledger blank in report |
| setup | `0d986a3855` | SUCCESS (classic) | `change_trust` E2EUSD | recipient | 4765598 | ledger blank in report |
| setup | `8660aba011` | SUCCESS (classic) | `payment` 10000.0000000 E2EUSD → owner | issuer `GADH3U7N…` | 4765599 | yes |
| setup | `cad9caf010` | SUCCESS | `create_contract` (hostFunctionTypeCreateContract = SAC deploy) | owner | 4765601 | yes |

Result: **20/20 SUCCESS, 0 not-found, 0 mismatched**. Every scenario's function/op, source account (owner vs executor vs keeper exactly as claimed), ledger and argument values match `backlog/e2e-testnet.md` and the results JSON. The one "not-separately-verifiable" fact — that the whole final run was one uninterrupted `--reset` + run — is consistent with the coherent single-run ledger ordering (4765597 → 4765649) and the shared owner key; an earlier results file (`20-55-54`) shows a prior run (different owner, S3/S5 failing), i.e. the expected fix-then-rerun iteration, and its existence does not contradict the final clean run.

## 2. State verification

Re-derived now from chain (Horizon balances; guard getters via read-only `simulateTransaction` with the real owner public key as simulation source — no signature needed):

| Quantity | Report says | Independently measured | Match |
|---|---|---|---|
| Owner E2EUSD balance | (implied 10000 − payments) | `9735.0000000` | ✓ (10000 − 265) |
| Recipient E2EUSD balance | sum of payments | `265.0000000` | ✓ (25+40+30+150+20) |
| Anything else affecting the sum | none | none (keeper/issuer hold 0 E2EUSD) | ✓ |
| `get_rule` | auto 0 / per_tx 100 / daily 2000 / SAC allowed / known false | `auto 0, per_tx 1000000000, daily 20000000000, [SAC], known false` | ✓ |
| `get_executor` | revoked → null | `null` | ✓ |
| `get_alias(owner,"ada")` | recipient | recipient `GBKBLL2I…` | ✓ |
| `spent_today` | 240 E2EUSD | `2400000000` | ✓ |
| SAC `allowance(owner, guard)` | 4800 E2EUSD | `48000000000` | ✓ (5000 − 180 − 20) |
| `get_schedule(13)` | inactive, runs_left 0 | `active=false, runs_left=0, amount 200000000` | ✓ |
| `get_schedule(14)` | inactive (cancelled) | `active=false, runs_left=1, next_run 1789855380` | ✓ |
| `list_schedules(owner)` | — | `[]` (both inactive/deindexed) | ✓ |

No discrepancy. The report's state paragraph is accurate.

## 3. Timing

- `first_run_at` decoded from the **create** tx args (`37368b7d…`, arg 4) = **1789851780** (the report's `getSchedule(13).next_run_at` value is identical).
- Ledger close time of the **execute** tx (`30bb69e63e…`, RPC `createdAt`) = **1789851797**.
- Delay = 1797 − 1780 = **17 s**. Reproduces the report exactly (keeper poll 5 s + contract/ledger skew).

## 4. S5 assessment

**Verdict: adequate and honest.**

- The report's root-cause explanation is technically correct. Simulation assembles a `SorobanAuthorizedInvocation` whose root carries the *original* function arguments; patching the `i128` amount after simulation (without re-simulating) makes the host's auth check fail with `invalid_action` ("Unauthorized function call … require_auth") **before** the contract's limit logic runs. I reproduced the observed contract-side decision independently: read-only `pay_owner(600)` and `pay_owner(200)` both simulate to `OverPerTxLimit #103`; `pay_executor(10)` and a raw `pay_executor(150)` now simulate to `NoExecutor #107` (post-revoke state).
- A submitted over-limit rejection genuinely cannot be produced with this client: `buildUnsignedInvoke` simulates by design, so the client throws before any envelope exists. The only way to submit a failing tx is a **race** (simulate under a permissive rule, then change the rule before inclusion) — non-deterministic and explicitly flagged in the report's Known limitations #4. No cheaper deterministic construction exists without hand-assembling resources/footprint, which the RPC `sendTransaction` would reject for other reasons.
- Simulation *is* a real execution of the frozen WASM against current on-chain state, so it is legitimate evidence for the contract's `#103` decision path; it is not evidence of the submit/fee/error-surfacing path, and the report says so (B-2). The scenario-table label "rejected on-chain" is slightly generous but immediately qualified ("at simulation; no tx, no balance change") in the same table and section. Wording is honest.

## 5. Security review of the live adapters (checklist)

| # | Check | Status | Evidence |
|---|---|---|---|
| a1 | Secrets only in `~/.polaris-e2e/keys.json` | PASS | `keys.ts` is the only secret store; repo/results/log grep clean |
| a2 | Dir `0700` / file `0600` enforced on create | PASS | `writeKeys` → `mkdirSync(…,0o700)`+`chmodSync(dir,0700)`+`writeFileSync(…,{mode:0o600})`+`chmodSync(path,0600)`; key test asserts modes |
| a3 | Permissions **verified/repaired on load** | **FAIL (non-blocking)** | `loadOrCreateKeys` read path only `JSON.parse` + `validateKeys`; it never `stat`/`chmod`s. The write path repairs, and a live `e2e:setup` calls `writeKeys`, so the on-disk state is correct (`drwx------` / `-rw-------` confirmed), but a pre-existing wrong-mode file is not corrected by `e2e:run` alone |
| a4 | Secrets never logged/printed/stringified | PASS | every `process.stdout/stderr` writes public keys, hashes, balances or plan text only; `signer.ts` errors echo the passphrase/secret-error message, never a secret; keeper child gets `KEEPER_SECRET` via env, never argv/stdout |
| a5 | Results JSON cannot contain secrets | PASS | `Recorder.write` payload = generated time, network, guard id, public `asset`, public `addresses`, scenario `detail`/`txs` — no secret fields; grep of both results files clean |
| a6 | Wrong-mode pre-existing dir | PARTIAL (non-blocking) | repaired on write (`chmodSync`), not on read; same root cause as a3 |
| a7 | Atomic write (temp + rename) | **FAIL (non-blocking)** | `writeKeys` writes in place; a crash mid-write can corrupt `keys.json`. Mitigated by `--reset` (regenerates) and throwaway keys |
| b1 | Refuse mainnet passphrase | PASS | scratch run: `assertTestnet`/`loadLiveConfig` throw `not_testnet` |
| b2 | Refuse `https://horizon.stellar.org` | PASS | same |
| b3 | Refuse `http://` downgrade | PASS | same (`rpcUrl` exact-match; `createServer` also requires `https://`) |
| b4 | Refuse look-alike `soroban-testnet.stellar.org.evil.com` | PASS | exact string equality, not suffix/substring |
| b5 | Refuse userinfo trick `https://soroban-testnet.stellar.org@evil.com` | PASS | exact equality rejects the whole string |
| b6 | No other hosts contacted | PASS | only `fetch` in `friendbot.ts` (pinned testnet URL); RPC/Horizon via SDK Server bound to asserted URLs; `stellar.expert` appears only as a display-link string, never fetched |
| c1 | Signer asserts testnet passphrase | PASS | `assertTestnetPassphrase` before parsing/signing |
| c2 | Signer refuses envelope whose source ≠ signer | PASS | `source_mismatch` `SignRefusal`; test covers it |
| c3 | Cannot be tricked into signing another network's envelope | PASS | network is fixed by `assertTestnetPassphrase`; a foreign envelope signed with the testnet passphrase yields a signature invalid on the foreign network (signature commits to network id) |
| c4 | Fee-bump envelopes | PASS | explicitly refused (`not_soroban`) |
| d1 | `submit.ts` bounded polling / no infinite loop | PASS | `for(;;)` with `now() >= deadline` (default 60 s) → `WaitTimeout`; poll default 1 s |
| d2 | Network calls timeout-bounded | PARTIAL (non-blocking) | guard-client calls go through `withTimeout` (30 s); `sendTransaction`/`getTransaction` in `submit.ts` are **not** wrapped, so a hung transport call is bounded only by the SDK/fetch. Polling itself is deadline-bounded |
| d3 | Returned hash == signed tx hash | PASS | `hashOf(parsed signed tx)`; classic path returns Horizon's `res.hash` (same value) |
| d4 | Failure mapping preserves raw error | PASS | `describeSendError`/`describeFailure`/`classifyThrown` keep `firstLine` of the raw message; contract error decoded from diagnostic events (`sceContract` → `#103`) |
| e1 | `e2e:run`/`e2e:setup` **without** `--live` do no network I/O | PASS | scratch run stubbing `fetch` + `http`/`https.request` executed both `main([])` → **0 network calls**, plan printed only |
| f1 | `--reset` overwrite behaviour documented | **FAIL (correction)** | `--reset` silently replaces `keys.json` (new keys, drops the asset record); no backup/confirmation. Acceptable for throwaway keys but **not stated in `backlog/e2e-testnet.md`** as required |
| g1 | No key material in branch / results / worker log | PASS | `git grep -E "S[A-Z2-7]{55}"` over HEAD and over `HEAD~2..HEAD` patches = none; both results JSONs = none; `…/scratchpad/w-e2e.log` = none; `keys.json` untracked |

## 6. The `sendPayment` fix

- **Change:** `timebounds: { minTime: now, … }` → `minTime: 0`, upper bound unchanged at `now + 300 s` (with an explanatory comment). **Correct and safe.** `minTime: 0` is the SDK default and the root cause (`tx_too_early` when the ledger close time lags the client clock) is eliminated. The validity window is still bounded above by `maxTime` (~300 s) and bound to the account sequence number, so the "signed but unsubmitted" replay surface is unchanged in length — only the lower edge moved from "client now" to "immediately", which is the intended fix for clock skew.
- **Regression test genuinely fails without the fix:** restoring the old line made `sendPayment.test.ts > "…no lower bound"` fail with `AssertionError: expected 1789819200 to be +0`; reverted with `git checkout --`.
- **No other production change:** `git diff HEAD~2 --stat -- stellar/src/payments stellar/src/guard stellar/src/approval stellar/src/schedule` shows only `sendPayment.ts` (+5/−2) and `sendPayment.test.ts`. The full diff is exactly the file list in the task (`stellar/src/live/**`, `package.json`, the report).

## 7. Gates (verbatim)

`npm run check -w @polaris/stellar` → `tsc -p tsconfig.json`, exited 0, no diagnostics.

`npm run test:live -w @polaris/stellar`:
```
 Test Files  7 passed (7)
      Tests  36 passed (36)
```

`npm test -w @polaris/stellar`:
```
test:keeper     ℹ tests 67   / ℹ pass 67   / ℹ fail 0
test:anchor     Test Files  5 passed (5)  / Tests  111 passed (111)
test:payments   Test Files  7 passed (7)  / Tests  121 passed (121)
test:guard      Test Files  7 passed (7)  / Tests  133 passed (133)
test:approval   Test Files  4 passed (4)  / Tests  112 passed (112)
test:schedule   Test Files  5 passed (5)  / Tests  121 passed (121)
test:live       Test Files  7 passed (7)  / Tests   36 passed (36)
```
Sum = 67+111+121+133+112+121+36 = **701 passed, 0 failed**. Matches the report.

## 8. Blocking issues (exact fix each) — none

No correctness, security or reproducibility problem blocks this work. The corrections below are required to fully satisfy the brief/report obligations and should accompany the merge, but none changes the verified conclusions:

- **COR-1 (documentation, required by the brief):** add one sentence to `backlog/e2e-testnet.md` stating that `e2e:setup --reset` overwrites the previous throwaway `~/.polaris-e2e/keys.json` (new keys; asset record dropped; no backup). Exact fix: append a note under "How to re-run".
- **COR-2 (hardening, small):** in `keys.ts::loadOrCreateKeys`, `chmodSync(dir, 0o700)` / `chmodSync(path, 0o600)` (and fail loudly if `chmod` fails) after a successful load, so the "verified/repaired on load" property holds; optionally write via temp file + `renameSync` for atomicity.

## 9. Non-blocking

- **`submit.ts` has no per-call timeout** on `sendTransaction`/`getTransaction` (the guard client's calls are wrapped by `withTimeout`). Wrap them for a uniform hard 30 s bound and a whole-run deadline.
- **`e2e:run` is not idempotent against a used setup:** scenario assertions assume the S0 baseline (fresh balances, no rule/executor). A second `e2e:run --live` without `--reset` will fail mid-way. The report's "how to re-run" does say to start from `--reset`, but this assumption should be stated explicitly.
- **Missing tester conveniences:** no `e2e:status` (print addresses, balances, `get_rule`, `get_allowance`, schedules), no cleanup command, no `--help`/usage text (a bare run prints the plan, which is a good fallback), and no docs page for manual build/sign/submit. Suggest `e2e:status` + a short `stellar/src/live/README.md`.
- **Iteration trail:** two `results-*.json` exist (an earlier 20:55 run with S3/S5 failing, then the clean 21:03 run). Not a problem — it corroborates the fix-then-rerun story — but the report's "one uninterrupted run" phrase could note that earlier attempts existed.
- **S5 / #104 coverage** remains simulation-only / uncovered, as the report itself states; independent confirmation agrees this is honest rather than a gap in the claim.
- **`maskSecret()` is exported but unused**; harmless, but either use it on any future secret-adjacent output or drop it.
