# Report: e2e-live (live TESTNET end-to-end run of the chain-lane code)

- **Date:** 2026-09-19
- **Worker/Agent:** W-e2e (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/e2e-live` @ `/Users/bilalkaya/StellarVoiceControlProject/.worktrees/e2e-live` (based on `integration/chain-lane`)
- **PR:** none (not committed/pushed per task; other workers run in parallel worktrees)

## Summary verdict

**PASS — 12/12 scenarios (S0–S11) on Stellar TESTNET, from ONE uninterrupted `e2e:setup --reset --live` + `e2e:run --live` run on freshly generated throwaway keys, in 240 s.** Every recorded transaction hash was re-read independently from Soroban RPC / Horizon and is `SUCCESS` on-chain. Offline gates stay green: `npm run check` clean, `npm test` = **701 tests** (665 pre-existing + 36 new `test:live`), all passing.

One real production bug was found and fixed (`sendPayment` lower time bound → `tx_too_early`), with an offline regression test. No contract bug was observed; the frozen guard behaved exactly as `contracts/DEPLOYED.md` documents.

## Environment (public data only)

| | |
|---|---|
| Network | Stellar **testnet** (`Test SDF Network ; September 2015`) |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` |
| Friendbot | `https://friendbot.stellar.org` |
| Protocol version | 28 (from `getLatestLedger`) |
| Guard contract | `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` |
| Asset | `E2EUSD:GADH3U7N26OP74VVUDZWEH3ILSJ5WWMAZFRALEM7MOKAJUAH5V7EA5SA` |
| SAC contract | `CBRBMTWR44FTXXKWFYD7NVL6PEXKH2FTJIYWT477ZOQVKEYYAKQ6K4KK` |
| Owner | `GBKTFHHLB62NDBK6EGNXODHZO2AWZTT2HEGDM4IQTNWYDIHG3TODO7QU` |
| Executor | `GDFX76I436JEQW5XWHATLQAJT6LF62TJRTI6YCFEEDHRUEKE5XQXU4OK` |
| Recipient | `GBKBLL2ICQZP5CJDURR3AA5TOJZQVW5UV2QR2EH36I2HGFG53EPY42WC` |
| Issuer | `GADH3U7N26OP74VVUDZWEH3ILSJ5WWMAZFRALEM7MOKAJUAH5V7EA5SA` |
| Keeper | `GB5NFVLPAO7EPRDN7QQSFLODFVTF4BMYPQO5ZGHOPE2V2O76XTNI44RO` |
| Results JSON (public) | `~/.polaris-e2e/results-2026-09-19T21-03-56-289Z.json` |

Secrets are only in `~/.polaris-e2e/keys.json` (dir `0700`, file `0600`); they are not in this report, the results JSON or the repo.

### Setup transactions (fresh `--reset` run)

| Step | Tx hash | Ledger |
|---|---|---|
| changeTrust owner | `984fab395d5420d110a97cd58cdcae94b539faaa53a3d810c804e7c76cbe318f` | — |
| changeTrust recipient | `0d986a3855d7608ee1ee5385987dfde16e2146bb903fccf1a896421eabc46fba` | — |
| mint 10000 E2EUSD to owner | `8660aba01193b5d8632049fdf09694bca8bc23564d66c9428eba15326694a67a` | 4765599 |
| deploy SAC | `cad9caf01025c1eeebca75d32f69fca8542fc9be996939fbce67ecabe08d0a30` | — |

## Scenario table

Explorer links: `https://stellar.expert/explorer/testnet/tx/<hash>`. "Verified" = independently re-read via RPC `getTransaction` (Soroban) or Horizon (classic) **and** by state (balances / guard getters).

| ID | What | Tx hash(es) | Ledger | On-chain verification | Pass |
|---|---|---|---|---|---|
| S0 | accounts, asset, SAC, owner balance | — | — | owner E2EUSD = 10000.0000000; SAC `decimals` simulation = 7 | ✅ |
| S1 | baseline Always-ask: SAC `approve` + `set_rule` | [`b36551fc…`](https://stellar.expert/explorer/testnet/tx/b36551fc4ebed26a14c7a4703bbdbad838e48a04f9ba2720df15d21da421631a), [`cf3c45cd…`](https://stellar.expert/explorer/testnet/tx/cf3c45cd896ea4c821debf226f08450a98221f3765be3118d9fa82de57fba27d) | 4765604, 4765605 | `getRule` = auto 0 / per_tx 500 / daily 2000 / SAC allowed; allowance 5000; `getExecutor` null | ✅ |
| S2 | `set_alias("ada", recipient)` | [`ae174d86…`](https://stellar.expert/explorer/testnet/tx/ae174d866a5affc9914b0525c3bce78528bc7a90b8bb0bd2c3db7e686fefaf65) | 4765607 | `getAlias` = recipient; `isKnownRecipient` true | ✅ |
| S3 | direct classic payment 25 E2EUSD to `ada` | [`b8e3ac39…`](https://stellar.expert/explorer/testnet/tx/b8e3ac393c234ca5f467ddd743670704e09fd2cb429a47366f301b241a2519ea) | 4765609 | recipient balance +25 | ✅ |
| S4 | guarded `send_payment` default profile → `pay_owner` 40 | [`6a4642d3…`](https://stellar.expert/explorer/testnet/tx/6a4642d31d95e562c90e3af6295a402f205230ba5908b1928d1f5dc4aeb9565d) | 4765611 | recipient +40; `spent_today` = 40; summary route `pay_owner`, card yes | ✅ |
| S5 | over `per_tx_limit` rejected on-chain (#103) | none (rejected at simulation) | — | `pay_owner(600)` → `GuardClientError OverPerTxLimit` #103; recipient balance unchanged | ✅ |
| S6 | enable auto-pay: `approve` → `set_rule` → `set_executor` | [`ea24a30b…`](https://stellar.expert/explorer/testnet/tx/ea24a30b71c2cf4f0d9a31e4abd10a3e81037145dc1e2a07599a3f266da99420), [`6513b711…`](https://stellar.expert/explorer/testnet/tx/6513b711068d7b586af7a8dae9d83e91a989a095b974fd0a194a5c7a4c19777d), [`fc1cc92c…`](https://stellar.expert/explorer/testnet/tx/fc1cc92c27fdf62c8d7170a18088fa629c492b7e23d603a8a0413ba685551da8) | 4765614–4765616 | `profileFromChain` = `auto_under_limit` | ✅ |
| S7 | auto-pay: executor 30, owner 150, raw executor 150 rejected | [`711c326f…`](https://stellar.expert/explorer/testnet/tx/711c326ffe2f07e9fe2c7bace9bcf37fff79491361fb994e7eaff90e49f830e6), [`875ced23…`](https://stellar.expert/explorer/testnet/tx/875ced237792f711c8769bc27f8bc6cee762d44d7757a7f072d0769ffe9a001e) | 4765618, 4765620 | recipient +180; first route `pay_executor` (executor signed), second `pay_owner`; raw `pay_executor(150)` → #105 `NeedsOwnerApproval` | ✅ |
| S8 | one-shot schedule 20 to `ada`, fired by the **keeper CLI** | create [`37368b7d…`](https://stellar.expert/explorer/testnet/tx/37368b7d63e203a464688b97f917fbd80839323e49c933235f9ed6fd4c4ac368) (4765622), execute [`30bb69e6…`](https://stellar.expert/explorer/testnet/tx/30bb69e63e48e516c9c5a14267fc807cb1deb2dfc6abc921bcdf722a638d5648) (4765642) | 4765622, 4765642 | recipient +20; schedule #13 `active=false`, `runs_left=0` | ✅ |
| S9 | far-future schedule then cancel by recipient | create [`459f49d0…`](https://stellar.expert/explorer/testnet/tx/459f49d0ee2117ce750bcb895898216aef325455fd619c364457b98d6c15c01f) (4765644), cancel [`0b6391c7…`](https://stellar.expert/explorer/testnet/tx/0b6391c7fe0e1e04e70497da56a305b98eafc76bf7f36c4e91ec227bb1ff13e8) (4765646) | 4765644, 4765646 | `listUpcoming` showed #14 `scheduled`; after cancel `getSchedule(14).active=false`, `next_run_at` far future | ✅ |
| S10 | disable executor (#107) + tighten `per_tx` (#103) | revoke [`853181d7…`](https://stellar.expert/explorer/testnet/tx/853181d765afa12d1b9bca2e307dc48ad0c65cd70b5f5fe4fa092ef4243c3494), set_rule [`c17ad29c…`](https://stellar.expert/explorer/testnet/tx/c17ad29c14e65a000dc187b90bf271a71b1bfdd01ec2f9a6afd29e85d8880316) | 4765647, 4765649 | `pay_executor` → #107 `NoExecutor`; `getRule.per_tx` = 100; `pay_owner(200)` → #103 | ✅ |
| S11 | schedule refused when allowance < amount×runs | none (typed refusal) | — | real allowance read 5000 < 100×60 = 6000 → `ScheduleRefusal allowance_insufficient` | ✅ |

All 16 recorded hashes re-verified on-chain by an independent script (`16 ok, 0 bad`).

### Measured schedule delay

- `first_run_at` (`getSchedule(13).next_run_at`) = `1789851780`
- execution ledger close time (`getTransaction(30bb69e6…).createdAt`) = `1789851797`
- **delay = 17 s** (keeper poll 5 s; contract-time vs wall-clock skew included).

### Final guard state after the run (independent read)

`getRule` = `{ auto_approve_limit: 0, per_tx_limit: 1000000000 (100 E2EUSD), daily_limit: 20000000000 (2000), allowed_assets: [CBRBMTWR…], known_recipients_only: false }`; `getExecutor` = `null`; `spent_today` = 2400000000 (240 E2EUSD = 40+30+150+20); SAC allowance = 48000000000 (5000 re-approved in S6, minus 180+20 spent after it).

## Bugs found by the live run

### B-1 — `sendPayment` lower time bound makes the payment fail `tx_too_early` (real bug, fixed)

- **Symptom (live):** S3 direct payment failed with `{"transaction":"tx_too_early"}`; the guarded/Soroban paths were unaffected.
- **Root cause:** `stellar/src/payments/sendPayment.ts` built the classic payment with `timebounds: { minTime: now, maxTime: now + 300s }`, where `now` is the client wall clock. Stellar rejects a transaction whose `minTime` is greater than the ledger close time. On testnet the ledger clock can lag the client by a few seconds, so a freshly built payment is intermittently "too early". The Soroban paths use `setTimeout` (no lower bound) and never hit this.
- **Fix (minimal):** set `minTime: 0` for the payment (upper bound unchanged). `stellar/src/payments/sendPayment.ts:235-244`.
- **Regression test:** `stellar/src/payments/__tests__/sendPayment.test.ts` — "sets a 300s upper time bound from the injected clock and no lower bound" asserts `Number(tb.minTime) === 0` and `maxTime` = clock + 300 s. It fails on the old code (which asserted `minTime` = the clock) and passes with the fix.

### B-2 — test-design finding (not a product bug): a submitted over-limit payment cannot be produced

- **What was tried:** to obtain a concrete failed-transaction hash for S5, an assembled `pay_owner` call was arg-patched above `per_tx_limit` and submitted. It failed with `invokeHostFunctionTrapped`, whose diagnostic events show `auth: invalid_action` ("Unauthorized function call for address owner … require_auth").
- **Root cause:** the Soroban `SorobanAuthorizedInvocation` returned by simulation binds the **authorized arguments**; changing the amount without re-simulating invalidates the authorization, so the host traps before the contract's limit logic runs. This is not a client defect.
- **Consequence / resolution:** the client simulates before signing **by design**, so an over-limit `pay_owner` is always rejected at simulation (`OverPerTxLimit #103`), never submitted. S5 therefore records the chain's simulation rejection (real contract execution against current on-chain state) with no hash and no balance change, which is the honest evidence. No workaround was applied.
- **Note:** the error-classification path (`stellar/src/live/submit.ts::describeFailure`) was checked against the live SDK v17 XDR shapes and correctly decodes `scvError` / `sceContract` errors (and the keeper's sibling decoder uses the same correct shape); the observed `invalid_action` is an auth error, not a contract error, and is intentionally not mapped to a guard code.

## Contract findings

None. The frozen `polaris_guard` v0.1 (`CDRLSFJ5W…`) behaved exactly as documented: multi-tenant owner auth, `set_rule` typed-struct encoding accepted on-chain (the previously feared ScVal-encoding class is green live), `pay_owner` / `pay_executor` routing, `NeedsOwnerApproval #105`, `NoExecutor #107`, `OverPerTxLimit #103`, schedules (`create_schedule` / `execute_schedule` / `cancel_schedule`), and the SAC `approve` / `transfer_from` allowance. No contract change was made (D9 respected).

## How to re-run

```bash
# 0. from the worktree root, link the shared node_modules (removed again afterwards)
ln -s /Users/bilalkaya/StellarVoiceControlProject/node_modules node_modules

# 1. fresh throwaway keys, accounts, E2EUSD asset + SAC, keeper funded
caffeinate -i npm run e2e:setup -w @polaris/stellar -- --reset --live     # ~30 s
#    (without --live it only prints the plan and touches no network)

# 2. all scenarios S0–S11
caffeinate -i npm run e2e:run -w @polaris/stellar -- --live              # ~4 min (S8 waits for the schedule)

# 3. offline gates
caffeinate -i npm run check -w @polaris/stellar
caffeinate -i npm test -w @polaris/stellar                               # incl. test:live

rm node_modules                                                          # remove the symlink
```

Config precedence: flags `--live`, `--reset`; env `GUARD_CONTRACT_ID`, `SOROBAN_RPC_URL`/`STELLAR_RPC_URL`, `HORIZON_URL`, `NETWORK_PASSPHRASE`, `E2E_KEYS_PATH`; guard id also falls back to `contracts/scripts/demo.env` `GUARD=`. The run refuses to start on any non-testnet host or passphrase.

## Known limitations

1. **S5 has no tx hash** — see B-2; the client pre-simulates, so an over-limit call never reaches submission. `#104 OverDailyLimit` was also not exercised: reaching it needs ~2000 E2EUSD of same-day spending, which would consume the daily budget and break S8's schedule run. It is therefore listed as not covered, not as passed.
2. The keeper CLI scans the **global** id space from cursor 0, so during S8 it may also attempt other owners' due schedules on the shared guard. In this run only our schedule was due; the side effect is inherent to the existing keeper and was not changed.
3. The direct classic route (`sendPayment`, non-guarded) is paid from the owner's classic balance, not through the guard; the balance deltas for guarded scenarios are read from the asset's Horizon trustline (the SAC wraps the same classic asset).
4. The `simulate`-based rejections (S5 raw, S7 raw, S10 raw) prove the contract's decision path, not a fee-charging failed submission; a submitted failure requires a rule change between simulation and submission, which is a race and not deterministic.

## Test numbers (real output)

`npm run check -w @polaris/stellar` → `tsc` exited 0, no diagnostics.

`npm test -w @polaris/stellar` (keeper `node:test` + Vitest suites, sequential):

| Suite | Command | Verbatim result |
|---|---|---|
| keeper | `test:keeper` | `ℹ tests 67` / `ℹ pass 67` / `ℹ fail 0` |
| anchor | `test:anchor` | `Test Files 5 passed (5)` / `Tests 111 passed (111)` |
| payments | `test:payments` | `Test Files 7 passed (7)` / `Tests 121 passed (121)` |
| guard | `test:guard` | `Test Files 7 passed (7)` / `Tests 133 passed (133)` |
| approval | `test:approval` | `Test Files 4 passed (4)` / `Tests 112 passed (112)` |
| schedule | `test:schedule` | `Test Files 5 passed (5)` / `Tests 121 passed (121)` |
| **live (new)** | `test:live` | `Test Files 7 passed (7)` / `Tests 36 passed (36)` |

Sum = 67 + 111 + 121 + 133 + 112 + 121 + 36 = **701 passed, 0 failed**.

## Unfinished / handed off

- S5 submitted-failure hash and an `#104 OverDailyLimit` live check remain uncovered (rationale in Known limitations). A cheap way to cover `#104` would be a second throwaway owner with a small `daily_limit`, at the cost of another baseline + allowance.
- No PR was opened (task: repo read-only apart from the allowed paths); the reviewer should open/merge via the normal async review flow.

## Review notes — what to re-verify on-chain

- **Hashes (Soroban, via RPC `getTransaction`):** `b36551fc…`, `cf3c45cd…`, `ae174d86…`, `6a4642d3…`, `ea24a30b…`, `6513b711…`, `fc1cc92c…`, `711c326f…`, `875ced23…`, `37368b7d…`, `30bb69e6…`, `459f49d0…`, `0b6391c7…`, `853181d7…`, `c17ad29c…` (all `SUCCESS`).
- **Classic hash (Horizon `transaction()`):** `b8e3ac39…` (`successful=true`, ledger 4765609).
- **Guard getters (simulate `get_rule` / `get_executor` / `get_schedule` / `list_schedules` for owner `GBKTFHHL…`):** rule `per_tx=100`, `daily=2000`, `auto=0`, SAC-allowed, `known_recipients_only=false`; executor `null`; schedule #13 inactive/runs_left 0; schedule #14 inactive.
- **SAC (`CBRBMTWR…`, `simulate allowance(owner, guard)`):** 4800 E2EUSD.
- **Schedule delay:** `get_schedule(13).next_run_at = 1789851780` vs `getTransaction(30bb69e6…).createdAt = 1789851797` → 17 s.
- Re-running the verification script against `~/.polaris-e2e/results-2026-09-19T21-03-56-289Z.json` should reproduce `16 ok, 0 bad`.

## Polish (2026-09-20, W-e2e)

Follow-up round on the non-blocking review items (`backlog/e2e-testnet-review.md` §9). This does not change the 12/12 result above; the full report for this round is `backlog/e2e-polish.md`.

- **Iteration trail / "one uninterrupted run" wording:** the live run above is **one uninterrupted `e2e:setup --reset --live` + `e2e:run --live`**, but it was not the project's first attempt. An earlier results file (`results-2026-09-19T20-55-54-163Z.json`) records a prior run in which S3 failed `tx_too_early` and S5 failed; that failure produced the `sendPayment` fix, after which the run was repeated cleanly. "One uninterrupted run" refers to that final clean run (ledgers 4765597 → 4765649), not to the first attempt.
- **`e2e:setup --reset` overwrite:** `--reset` replaces the previous throwaway `~/.polaris-e2e/keys.json` with a new key set and drops the stored asset record; there is no backup. Now stated in the setup plan output and in `stellar/src/live/README.md`.
- **`e2e:run` is not idempotent:** its scenario assertions assume the fresh S0 baseline (empty rule/executor, untouched balances). A second `e2e:run --live` without a fresh `--reset` setup fails mid-way. Now stated in the run plan output and in the README.
- **Uniform network timeouts (review #1):** `sendTransaction`, `getTransaction`, `submitTransaction` and `loadAccount` are hard-bounded at 30 s and every submission honours a whole-operation deadline (120 s), surfacing typed `NetworkTimeout` / `OperationTimeout` errors; offline tests drive them with a hanging fake server.
- **Key-file hardening (review COR-2):** `loadOrCreateKeys` now repairs and re-checks `0700`/`0600` on load, not just on write; the unused `maskSecret` helper was removed.
- **Manual-testing tooling:** `e2e:status` and `e2e:tool` (plus `stellar/src/live/README.md`) exercise the same chain-lane code the app will use, with a decoded approval card and an explicit confirmation step. See `backlog/e2e-polish.md`.
