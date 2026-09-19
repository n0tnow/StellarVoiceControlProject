# Review 2: approval-policy — T1-fix delta

- **Date:** 2026-09-19
- **Reviewer:** W-review-T1b (DeepSeek v4.1 Flash, L4) — fresh session; did **not** write the T1 fixes
- **Branch/worktree:** `review/approval-policy-2` (== `chain/approval-policy`) / `.worktrees/approval-policy-review2`
- **Under review (delta):** `409b534` (`git diff HEAD~1`) — `stellar/src/approval/{enableAutoPay,types,index}.ts`, `stellar/src/approval/__tests__/{enableAutoPay.test,fixtures}.ts`, `backlog/approval-policy.md`
- **References:** fix spec `brief-t1-fix.md`; design `docs/approval-and-scheduling.md` (D13, read-only); contract `contracts/polaris_guard/src/lib.rs` (read-only ground truth); prior review `backlog/approval-policy-review.md`
- **Method:** three gates re-run, source read line-by-line, 17 independent scratch probes, 4 required mutations + 2 extra (B1 untyped encoder, full old unsafe order) — all reverted. No network. Scratch tests and the `node_modules` symlink removed; `git status --short` clean.

## Verdict: approve with corrections

The two blocking T1-review findings are genuinely fixed: the enable order is now `approve → set_rule → set_executor`, the raw `ScVal` assertions are real and mutation-sensitive, and the baseline/tighten/asset/allowance-copy work is correct and well tested.
One design-mandated detail is still missing: the enable card lists the three actions in the right order but never **calls out the executor step as the arming step** (design §11d row 4, §13 T1, and the fix spec's decision paragraph).
Everything else verified clean; the state-model test does catch the old unsafe order.

## 1. Numbers re-run (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar        # tsc exit 0, clean
$ caffeinate -i npm run test:approval -w @polaris/stellar
 Test Files  4 passed (4)
      Tests  98 passed (98)
$ caffeinate -i npm test -w @polaris/stellar
 keeper:   ℹ tests 67 / pass 67 / fail 0
 anchor:   Test Files 5 passed / Tests 111 passed
 payments: Test Files 7 passed / Tests 121 passed
 guard:    Test Files 7 passed / Tests 133 passed
 approval: Test Files 4 passed / Tests 98 passed
```

Total = 67 + 111 + 121 + 133 + 98 = **530 passed, 0 failed**. Matches the claim in `backlog/approval-policy.md:239-248` exactly. **PASS.**

## 2. D13 order & state-model verification

- **Enable order:** `buildEnableAutoPay` builds `[approve, set_rule, set_executor]` (`enableAutoPay.ts:282-286`) and returns the same `order` (`:294`); the card `summary.actions` is derived from `steps`, so it is in the same order (`:297`). Tests assert both (`enableAutoPay.test.ts:107-114`, `:181-187`). **PASS.**
- **Arming line:** the card does **not** call out the executor step as the arming step. Reconstructed summary (scratch): title `"Enable automatic payments (3 owner signatures, 1 approval)"`, three `ACTION` entries, `notes` = schedule note + allowance delta only; nothing labels step 3 as arming. Required by design §11d row 4 ("calls out step 3 as the **arming** step"), §13 T1, and the fix-spec decision ("with the arming step called out"). No test asserts it. **FAIL → §4 B1.**
- **State model encodes the real changing conditions:** `ChainState` tracks `executorRegistered` / `autoApproveLimit` / `allowance` and `canPayExecutor` mirrors the contract's `pay_executor` gates that vary across the sequence — registered-and-equal executor (`lib.rs:452-460`), `amount <= auto_approve_limit` (`:471`), `allowance >= amount` via `settle` (`:1003`). `rule present`, `asset allowed`, `per_tx`/`daily` and `known_recipients_only` are not modelled, but all four are invariant and satisfied across this sequence, so they do not affect the prefix argument. **PASS** (see §5 NB2).
- **The model really proves the prefix property:** reordering the builder back to the old unsafe sequence `[set_executor, set_rule, approve]` (steps + `order`) makes the dedicated test `no prefix of the sequence can let pay_executor succeed` (`enableAutoPay.test.ts:220-235`) **fail** (1 failed) — because at prefix 2 the executor and the new positive rule are both live against the pre-existing baseline allowance. **PASS.**
- **Pre-armed precondition:** from a *not-armed* baseline (no executor, `auto_approve_limit == 0`) the test starts with the mandatory allowance present (`:224`) and verifies prefixes 0/1/2 are closed. From a **pre-armed** state the claim legitimately does not hold (my probe: prefix 0 already pays; after step 1 `approve` the old executor + old positive rule still pay). The code comment (`enableAutoPay.ts:17-28`) and the failure-state table (`backlog/approval-policy.md:96-112`) do state the baseline start (`auto_approve_limit == 0`, no executor), so the precondition is documented but **not enforced** (no current-rule read / `already_armed` refusal). **PASS with note → §5 NB1.**
- **Disable order:** `buildDisableAutoPay` pushes `revoke_executor` first, then optional `approve(0)` (`enableAutoPay.ts:419-430`); tests cover both orders. Matches D13. **PASS.**

## 3. Break attempts (input | expected | actual | result)

| Input | Expected | Actual | Result |
|---|---|---|---|
| Baseline `allowanceRaw == daily_limit` / `daily_limit - 1` | OK / `allowance_too_small` | OK / `allowance_too_small` | PASS |
| Baseline `allowanceDays` 1, 90 / 0, 91, 1.5, NaN, Infinity | OK / `invalid_allowance_days` | OK / `invalid_allowance_days` | PASS |
| Baseline `auto==per==daily` / `auto>per` / `per>daily` | OK / `limit_order` / `limit_order` | OK / `limit_order` / `limit_order` | PASS |
| `assetContractId` or rule asset = `G...`, `""`, lowercase, wrong checksum (`…B`), `123`, `null` | `invalid_asset` each | `invalid_asset` each | PASS |
| 2 allowed assets / 0 allowed assets | `too_many_assets` / `no_assets` | same | PASS |
| `assetContractId` valid `C...` but **not** `rule.allowed_assets[0]` | reject (probe) | **accepted** (no cross-check) | non-blocking (§5 NB4) |
| `buildBaselineSetup` on 2 identical valid assets (with `MAX_ALLOWED_ASSETS = 1`) | `too_many_assets` | `too_many_assets` | PASS |
| Tighten: equal rule | classification `same`, no refusal | `same`, builds no-op `set_rule`, confirmation `none` | PASS (§5 NB3) |
| Tighten: mixed, `undefined` current, assets grow, `known_recipients_only` on→off | `use_enable_flow`, nothing built | `use_enable_flow`, `rpc.simulated` empty | PASS |
| Tighten opt-out `{ allowLoosening: true }` for loosening/mixed/new_rule | builds, `card_and_touch_id` | builds, `card_and_touch_id` | PASS |
| Enable/baseline `currentAllowanceRaw`: lower / equal / higher / undefined | old→new line; WARNING only when lower | `900 -> 700` + WARNING; `700 -> 700` no WARNING; `500 -> 700` no WARNING; no line when undefined | PASS |
| `currentAllowanceRaw` set vs unset | XDR unchanged, notes only | step `unsignedXdr` identical | PASS |
| Disable notes `revokeAllowance: true` / `false` | both schedule caveat; kill-switch only when revoking | exact texts as specified | PASS |
| Pre-armed state prefix 0 / after step 1 `approve` | (attack) may pay | pays — claim only holds from not-armed baseline | note (§5 NB1) |
| Routing default (`profile` undefined), amount ≤ threshold, executor present | `pay_owner` | `pay_owner` (`routing.ts:20-26`) | PASS |
| Contract copy accuracy: `settle` always `transfer_from` + allowance check; `pay_owner` also routes through `settle`; `execute_schedule` not executor-gated | card copy accurate | matches `lib.rs:994-1008`, `:428`, `:639-654` | PASS |

## 4. Blocking issues (exact fix each)

**B1 — the enable card does not call out the arming step (D13 / §11d).**
- Evidence: `buildEnableAutoPay` (`stellar/src/approval/enableAutoPay.ts:292-308`) builds `steps` and `summary.actions` in the correct order but `summary.notes` contains only the schedule-allowance note and the allowance delta. There is no label/line marking `set_executor` as the step that arms unattended payments. Design `docs/approval-and-scheduling.md:119` (row 4) requires the card to "call out step 3 as the **arming** step" (also §13 T1 and `brief-t1-fix.md` decision: "with the arming step called out"). My reconstructed summary reprinted in §2 confirms the omission, and no test asserts it.
- Exact fix (T1 file only): add a constant, e.g. `const ARMING_STEP_NOTE = "Step 3, set_executor, registers the agent and arms unattended payments.";`, include it first in the enable `notes` (`enableAutoPay.ts:305`), and add an assertion in `enableAutoPay.test.ts` such as `expect(res.summary.notes.join(" ")).toMatch(/arm/i)`. No ordering/behaviour change.

## 5. Non-blocking

- **NB1 — prefix-safety precondition is stated but not enforced.** The builder never reads the current rule/executor and does not reject an already-armed (`executor + positive auto_approve_limit`) caller, so a re-run on an armed account does not "fail closed" at prefixes 0/1 (probe: payment succeeds). The code comment (`enableAutoPay.ts:17-28`) and report table do document the `never-armed baseline` start, which is the flow D13 assumes. Cheap hardening: read `getRule`/`getExecutor` and refuse with a typed `already_armed` (or route to the tighten flow).
- **NB2 — state model omits invariant contract gates.** `canPayExecutor` (`enableAutoPay.test.ts:71-79`) does not model `rule present`, `asset allowed`, `per_tx`/`daily` caps or `known_recipients_only`; all are constant and satisfied across this sequence, so the prefix proof is valid, but a comment stating that would prevent future readers from over-trusting the abstraction.
- **NB3 — `buildTightenRule(current == next)` builds a no-op `set_rule` with confirmation `none`.** Harmless (a same-rule write), but the shell could submit a pointless owner signature. Consider returning `{ confirmation: "none" }` without building, or documenting the intent.
- **NB4 — `validateBaselineSetup` does not cross-check `assetContractId` against `rule.allowed_assets`.** A valid-but-different `C...` passes (probe); the later owner path may then use an asset the rule does not list. The design treats `allowed_assets` as agent-facing, so this is not a correctness bug for the Always-ask baseline, but an equality check would be cheap and honest.
- **NB5 — `describeValue` duplication remains, honestly documented.** `TODO(T1-fix)` at `enableAutoPay.ts:192-199` explains that `guard/describe.ts` does not export its helper and `guard/**` is out of scope. Correct call; export-and-delete when `guard/` is next touched.
- **NB6 — baseline exposure `thresholdRaw`/`dailyLimitRaw` are taken from the input rule, not decoded back from the XDR** (`enableAutoPay.ts:353-355`); the enable flow does the same. The XDR is built from the same validated values so this is consistent, but decoding would match the module's own "card is proof of the signed XDR" claim.

## 6. Mutation results

| # | Mutation | File (reverted via `git checkout --`) | Test command | Failed? |
|---|---|---|---|---|
| a | Swap `set_rule`/`set_executor` in the enable `steps`/`order` | `stellar/src/approval/enableAutoPay.ts:282-286,294` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 5 failed / 37 |
| a2 | Full **old unsafe order** `[set_executor, set_rule, approve]` | `stellar/src/approval/enableAutoPay.ts:282-286` | `vitest run … -t "no prefix"` | **YES** — the state-model test fails (1 failed), proving it catches B2 itself |
| b | Baseline builder's second step kind `set_rule` → `set_executor` | `stellar/src/approval/enableAutoPay.ts:338-341` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 2 failed / 37 |
| c | Drop the default `assertTightening` call | `stellar/src/approval/enableAutoPay.ts:461` | `vitest run …/enableAutoPay.test.ts …/zz-review2.scratch.test.ts` | **YES** — 5 failed / 51 |
| d | `MAX_ALLOWED_ASSETS` 1 → 2 (allow 2 assets in baseline) | `stellar/src/approval/types.ts:88` | `vitest run …/enableAutoPay.test.ts …/types.test.ts` | **YES** — 2 failed / 60 |
| e | (B1) Revert guard `ruleToScVal` to untyped `nativeToScVal(rule)` | `stellar/src/guard/client.ts:43-55` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 2 failed, exactly `step 2 set_rule argument has the RAW contract types` (enable) and `decodes step 2 as set_rule(owner, rule) with raw contract types` (baseline) |

All mutations reverted; final `git diff HEAD` empty and `git status --short` shows only this review file. **PASS.**

---

*Reviewer note:* the B2 fix is real — reordering to executor-last does remove the pre-existing-allowance window, and the state-model test fails under the old order. The only correction needed is the missing arming call-out on the card (B1), plus the non-blocking hardening items above. The raw-type test (B1 of the prior review) now genuinely distinguishes `scvI128`/`scvAddress`/symbol keys and is mutation-sensitive.
