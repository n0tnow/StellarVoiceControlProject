# Integration verification — `integration/chain-lane`

- **Date:** 2026-09-19
- **Worker:** W-integ (DeepSeek v4.1 Flash, L4-style verifier)
- **Branch:** `integration/chain-lane` @ `da2b6e8` (merge of docs + `chain/send-payment`, `chain/guard-client`, `chain/schedule-tools`, `chain/approval-policy`; `chain/suggest-engine` not yet merged)
- **Scope:** READ-ONLY verification. One new file only. No source edits, no commit/push/add. No network.

## Verdict: integration branch healthy

- All six suites pass with the exact expected counts (sum **665**), and `tsc` is clean over the merged tree.
- The full cross-module lifecycle (baseline → guarded default → enable auto-pay → guarded auto → schedule → cancel → list) runs offline end to end through the public `index.ts` and decodes to the correct function names/argument order.
- Only findings are **non-blocking cleanup debt** (duplicated helpers) and **missing runtime wiring** for a live testnet run; neither is a correctness defect in the merged code.

## 1. Branch contents

`git log --oneline --graph -15`:

```
*   da2b6e8 merge: chain/approval-policy into integration/chain-lane
|\
| * a59f8c9 docs(review): final delta review of approval policy (approve)
| * 618b691 fix(stellar): arming call-out on the enable card, already_armed refusal, no-op tighten, asset cross-check, decoded exposure
| * ed3d5b1 docs(review): delta re-review of approval policy fixes (approve with corrections)
| * 409b534 fix(stellar): approval flow order allowance-rule-executor, baseline setup builder, raw ScVal assertions, tighten guard and card caveats
| * d99a6c9 docs(review): independent review of approval policy (approve with corrections)
| * 70d1d91 docs(backlog): approval policy worker report
| * 82299db feat(stellar): approval profiles, auto-pay enable/disable builders, stricter-than-chain guarded routing
* |   06b8793 merge: chain/schedule-tools into integration/chain-lane
|\ \
| * | eaed244 docs(review): delta re-review of schedule tools fixes (approve)
| * | 53e185b fix(stellar): mandatory allowance check in schedule tools, error mapping in listUpcoming, boundary and golden ABI tests
| * | 98797ed docs(review): independent review of schedule tools (approve with corrections)
| * | a525af9 docs(backlog): schedule tools worker report
| * | 7e61c0b feat(stellar): schedule tools - schedulePayment, cancelSchedule, listUpcoming and DST-safe local time conversion
* | | ebd2fd0 merge: chain/guard-client into integration/chain-lane
|\| |
```

`git diff 77950df --stat | tail -3` (what the branch adds vs main):

```
 stellar/src/schedule/types.ts                      | 159 ++++++
 stellar/src/schedule/view.ts                       |  44 ++
 96 files changed, 14538 insertions(+), 8 deletions(-)
```

Delta vs main is 96 files / +14,538 / −8: the four feature lanes plus their tests, reviews and docs (`backlog/*`, `docs/approval-and-scheduling.md`, `docs/confidential-payments.md`, `docs/demo-runbook.md`, `docs/interfaces.md`, `docs/reports/…`, `notes.md`, `sprints.md`).

## 2. Numbers (verbatim) vs expected

Command run for each: `caffeinate -i npm run <script> -w @polaris/stellar`. Verbatim final lines:

| Suite | Command | Verbatim summary | Expected | Match |
|---|---|---|---|---|
| keeper | `test:keeper` | `ℹ tests 67` / `ℹ pass 67` / `ℹ fail 0` | 67 | ✅ |
| anchor | `test:anchor` | `Test Files  5 passed (5)` / `Tests  111 passed (111)` | 111 | ✅ |
| payments | `test:payments` | `Test Files  7 passed (7)` / `Tests  121 passed (121)` | 121 | ✅ |
| guard | `test:guard` | `Test Files  7 passed (7)` / `Tests  133 passed (133)` | 133 | ✅ |
| approval | `test:approval` | `Test Files  4 passed (4)` / `Tests  112 passed (112)` | 112 | ✅ |
| schedule | `test:schedule` | `Test Files  5 passed (5)` / `Tests  121 passed (121)` | 121 | ✅ |

Full run `npm test -w @polaris/stellar` (sequential `keeper && anchor && payments && guard && approval && schedule`) produced the same six summaries in order; every suite `fail 0`. **Sum = 67+111+121+133+112+121 = 665 — exact match, no mismatch to investigate.**

`npm run check -w @polaris/stellar` (`tsc -p tsconfig.json`) exited 0 with no diagnostics.

Note: payments is 121, consistent with the approval-aware guarded route (the 113→121 delta the task called out). No test depends on the old default profile; the default-profile behaviour is asserted directly in `stellar/src/payments/__tests__/sendPayment.approval.test.ts:54`.

## 3. Cross-module flow results

Throwaway test: `stellar/src/__integration_scratch__/chain-lane.test.ts` (created, run with `caffeinate -i npx vitest run src/__integration_scratch__`, then **deleted**). It imported the shared fake RPC and `invokedCall`/`ruleScVal`/`scAddress`/`okSim` read-only from `stellar/src/guard/__tests__/helpers.ts`, and used `import * as stellar from "../index.ts"`.

Public-surface check: `stellar.sendPayment` (function), `stellar.guard` / `stellar.approval` / `stellar.schedule` / `stellar.anchor` / `stellar.keeper` (namespaces) and `stellar.TESTNET` all present.

| Step | Expected | Actual |
|---|---|---|
| `import * as stellar from "../index.ts"` | exposes `sendPayment`, `guard`, `approval`, `schedule`, `anchor`, `keeper`, `TESTNET` | ✅ all present |
| `TESTNET` constants | `testnet`, soroban-testnet RPC, horizon-testnet, SDF passphrase | ✅ exact |
| USDC issuer | `GBBD47IF…LFLA5` via `defaultAssetRegistry().get("USDC").issuer` | ✅ exact |
| Guard contract id parametrisation | client built with id A returns A; id B returns B; no constant | ✅ (`createGuardClient` stores the passed id) |
| `buildBaselineSetup` | steps `[approve, set_rule]`, no executor; `approve(owner, guard, 7e9, live_until)` | ✅ order + args decoded from XDR |
| `sendPayment` guarded, **default profile** | `pay_owner`, source owner, card required | ✅ `pay_owner`, source `OWNER`, `Approval profile: always_ask`, `Approval card required: yes` |
| `buildEnableAutoPay` | steps `[approve, set_rule, set_executor]`; `set_executor(owner, executor)` | ✅ order + args (`[OWNER, EXECUTOR]`), decoded rule threshold `25e6` |
| `sendPayment` guarded, `auto_under_limit`, small (10 ≤ 25) | `pay_executor`, source executor | ✅ `pay_executor`, source `EXECUTOR`, args `[executor, owner, to, SAC, 100000000n]`, card `no` |
| `sendPayment` guarded, `auto_under_limit`, above threshold (30 > 25) | `pay_owner`, source owner | ✅ `pay_owner`, source `OWNER`, card `yes` |
| `schedulePayment` (allowance reader injected) | `create_schedule(owner, to, SAC, 50e6, firstRunAt, 86400n, 3)` | ✅ function + arg order/values decoded from XDR |
| `cancelSchedule` | `cancel_schedule(owner, id)`, `confirmation: "light"` | ✅ `[OWNER, 7]`, `confirmation: "light"`, `id: 7` |
| `listUpcoming` | one row for the schedule, alias resolved, amount `50` | ✅ `id 7`, `recipientAlias "ada"`, `amount "50"` |

Result: `Test Files 1 passed (1)` / `Tests 3 passed (3)`. Every produced XDR was decoded with `decodeInvocation`/`invokedCall` (contract id, function name, native args) — no summary was trusted from intent text.

## 4. Duplicated helpers (input for a cleanup task; nothing changed)

| # | Helper | Location 1 | Location 2 (and 3) | Notes |
|---|---|---|---|---|
| D1 | `describeValue(value)` | `stellar/src/guard/describe.ts:67` (private) | `stellar/src/approval/enableAutoPay.ts:219` (private) | Self-documented TODO in the approval copy (`:211-218`): export the guard one and delete the copy. |
| D2 | Amount regex + `MAX_STROOPS` + `assertPositiveAmount` | `stellar/src/guard/amount.ts:27,39` (`AMOUNT_RE`, `toRawUnits`) | `stellar/src/payments/sendPayment.ts:117,119,121`; `stellar/src/schedule/schedulePayment.ts:36,38,54` | Three copies of the same `^\d{1,12}(\.\d{1,7})?$` + int64 cap + stroop conversion; payments/schedule duplicate instead of delegating to `toRawUnits`. |
| D3 | `guardAssetContract(deps, code)` (case-tolerant code→SAC lookup) | `stellar/src/payments/sendPayment.ts:261` | `stellar/src/schedule/internal.ts:39` | Same body; the reverse mapping `assetCodeFor` also lives at `stellar/src/schedule/view.ts:14`. |
| D4 | `GUARD_REFUSAL_BY_NAME` (guard error name → refusal code) | `stellar/src/payments/sendPayment.ts:268` | `stellar/src/schedule/internal.ts:46` | Same guard names, two target code enums; could share one name→code table. |
| D5 | Alias-resolution refusal block (trim/lowercase + `resolveAlias` + two identical messages) | `stellar/src/payments/sendPayment.ts:192-205` | `stellar/src/payments/sendPayment.ts:313-323` (same file, guarded route); `stellar/src/schedule/schedulePayment.ts:196-206`; `stellar/src/schedule/cancelSchedule.ts:76-86` | Four near-identical copies; a single `resolveRecipientOrRefuse` would remove them. |
| D6 | `toHex(bytes)` | `stellar/src/guard/describe.ts:25` | `stellar/src/payments/summary.ts:28` | Both are **publicly exported** from their namespaces, so `stellar.guard.toHex` and `stellar.payments`-re-exported `toHex` collide conceptually. |
| D7 | `stroopsToXlm(stroops)` | `stellar/src/guard/describe.ts:32` | `stellar/src/payments/summary.ts:41` | Identical implementation; both publicly exported. |
| D8 | `shortKey(address)` | `stellar/src/guard/describe.ts:40` (exported) | `stellar/src/payments/summary.ts:48` (private) | Same `GABC…WXYZ` rendering. |
| D9 | `formatInTimeZone` vs `formatInZone` (IANA-zone date rendering) | `stellar/src/approval/enableAutoPay.ts:264` | `stellar/src/schedule/time.ts:271` | Different signatures (Date vs epoch seconds) but overlapping intent. |

## 5. Hygiene

| Check | Result |
|---|---|
| `git grep -n "<collaborator name>" -- '*.md' '*.ts'` excluding `CLAUDE.md`/`AGENTS.md` | ✅ empty |
| Secret-like `S[A-Z2-7]{55}` | ✅ none |
| Merge markers (`<<<<<<<` / `>>>>>>>` / `=======`) | ✅ none |
| `stellar/package.json` valid JSON | ✅ `JSON.parse` OK |
| All test scripts in `test` | ✅ `test` = `test:keeper && test:anchor && test:payments && test:guard && test:approval && test:schedule`; all six sub-scripts present |
| `stellar/src/index.ts` exports exactly once each | ✅ no duplicate export names (`tsc` would fail on a duplicate identifier); 10 export statements, each name unique |
| Guard contract id hard-coding | ✅ `CDRLSFJ5…` only in `stellar/src/guard/__tests__/source-scan.test.ts:14` (test) and `stellar/src/keeper/README.md:157` (docs). No hard-coded id in non-test/non-doc `stellar/src`. A source-scan test enforces it. |

## 6. Gaps before a live testnet run

The code is deliberately dependency-injected and produces **unsigned** XDR; nothing in the merged lanes signs, submits or loads config. Concretely, a live run still needs:

1. **A runtime guarded-payment wiring.** `defaultPaymentDeps` (`stellar/src/payments/index.ts:86`) only wires Horizon `loadAccount`; it does **not** set `route: "guarded"`, `guard`, `guardAssetContracts`, or `approvalProfile`. The process-wide `configurePayments` (`:58`) therefore installs a **direct-route** tool. A `guardedPaymentDeps(env)`/`defaultGuardClient` factory (real `new rpc.Server(TESTNET.rpcUrl)` + `createGuardClient({ contractId: GUARD_CONTRACT_ID, … })` + USDC SAC table) is missing.
2. **No runtime schedule deps factory.** `schedulePayment`/`cancelSchedule`/`listUpcoming` take a full `ScheduleDeps` (`stellar/src/schedule/types.ts:69`), but no `defaultScheduleDeps` exists. Missing wiring: the guard client above, `guardAssetContracts`, `assets`, and the **mandatory** `getAllowance` closure (must call `guard.getAllowance(rpc, { assetContractId, from: owner, spender: guard.contractId, networkPassphrase })`, `stellar/src/guard/allowance.ts:129`). `listUpcoming` needs no allowance read but shares the deps.
3. **No config loader for the new env keys.** `GUARD_CONTRACT_ID` is read only by the keeper (`stellar/src/keeper/config.ts:77`). There is no loader in `payments`/`guard`/`approval`/`schedule` that reads `GUARD_CONTRACT_ID`, `STELLAR_RPC_URL`, `STELLAR_NETWORK_PASSPHRASE` or a USDC-SAC id. `.env.example` documents `GUARD_CONTRACT_ID`/`SOROBAN_RPC_URL`/`NETWORK_PASSPHRASE` for the keeper only.
4. **No signer + submit-and-wait helper for guard/schedule/approval XDR.** Guard and schedule return `unsignedXdr`; the only submit path is `submitSignedTx` in `stellar/src/anchor/chainTools.ts:140`, which uses the anchor context/Horizon and refuses sequence-0 envelopes — it is not wired for a Soroban guard invoke, and there is no owner/executor `Keypair` signing step. The keeper has a private `SorobanChain.submitAndWait` (`stellar/src/keeper/chain.ts:277`) but it is not exported/reusable.
5. **No alias-file path plumbing for the app.** `loadAliasBook(path)` (`stellar/src/payments/loadAliases.ts`) exists and `stellar/config/aliases.json` is committed, but no code resolves a default path or feeds it into `PaymentDeps.aliases` / `ScheduleDeps.aliases`. `defaultPaymentDeps` still takes `aliases` as a caller argument.
6. **No owner/executor addresses wired from config.** `defaultPaymentDeps` needs `ownerAddress`; the approval builders need `owner`; the schedule tools need `ownerAddress`. `POLARIS_TEST_SECRET` exists in `.env.example` for the anchor e2e only; there is no owner key/address loading for the guard flows.
7. **`getAllowance` is required but never auto-wired.** `schedulePayment` throws `not_configured` if `deps.getAllowance` is absent (`stellar/src/schedule/schedulePayment.ts:235`); the helper `guard.getAllowance` exists but nothing connects it to `ScheduleDeps`.

These are all **wiring gaps**, not logic bugs; they are the natural content of the end-to-end script task.

---

*Verification performed offline with `caffeinate -i`; temporary `node_modules` symlink to the repo root removed after the run, and the scratch test folder deleted. `git status --short` shows only this report.*
