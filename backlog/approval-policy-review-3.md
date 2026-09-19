# Review 3: approval-policy — T1 correction (fix2) delta

- **Date:** 2026-09-19
- **Reviewer:** W-review-T1c (DeepSeek v4.1 Flash, L4) — fresh session; did **not** write this delta
- **Branch/worktree:** `review/approval-policy-3` (== `chain/approval-policy`) / `.worktrees/approval-policy-review3`
- **Under review (delta):** `618b691` (`git diff HEAD~1`) — `stellar/src/approval/{enableAutoPay,types,index}.ts`, `stellar/src/approval/__tests__/{enableAutoPay,types}.test.ts`, `backlog/approval-policy.md`
- **References:** fix spec `brief-t1-fix2.md`; prior review `backlog/approval-policy-review-2.md`; contract `contracts/polaris_guard/src/lib.rs` (read-only ground truth).
- **Method:** three gates re-run, source read line-by-line, 7 independent scratch probes, 4 required mutations + the old-order regression — all reverted. No network. Scratch test and the temporary `node_modules` symlink removed; `git status --short` shows only this file.

## Verdict: approve

The correction round closes every item from review 2 (B1 + NB1/NB2/NB3/NB4/NB6) with real, mutation-sensitive tests.
The four required mutations are all caught, and the state-model prefix test still catches the old unsafe order.
No blocking issues remain; two defense-in-depth notes are recorded as non-blocking.

## 1. Numbers re-run (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar        # tsc -p tsconfig.json, clean
$ caffeinate -i npm run test:approval -w @polaris/stellar
 Test Files  4 passed (4)
      Tests  112 passed (112)
$ caffeinate -i npm test -w @polaris/stellar
 keeper:   ℹ tests 67 / pass 67 / fail 0
 anchor:   Test Files 5 passed (5) / Tests 111 passed (111)
 payments: Test Files 7 passed (7) / Tests 121 passed (121)
 guard:    Test Files 7 passed (7) / Tests 133 passed (133)
 approval: Test Files 4 passed (4) / Tests 112 passed (112)
```

Total = 67 + 111 + 121 + 133 + 112 = **544 passed, 0 failed**. Claimed 112 approval / 544 total in
`backlog/approval-policy.md` (Review fixes 2) matches exactly. **PASS.**

## 2. Check results (table)

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Gates + numbers | **PASS** | see §1; 112 approval, 544 total. |
| 2 | B1 arming call-out | **PASS** | `ARMING_STEP_NOTE` first note (`enableAutoPay.ts:79-80,359-363`); only `set_executor` flagged (`:346-350`); baseline has no arming action/note (`:411,420-424`); flag derived from `step.kind`, no draft field can flip it. |
| 3 | `already_armed` | **PASS** (see NB-a) | `isAlreadyArmed` requires executor non-empty **and** `auto_approve_limit > 0` (`:257-261`); refusal typed, nothing built (`:306-311`); matrix verified below. |
| 4 | Tighten identical rule | **PASS** | `{ steps: [], classification: "same", confirmation: "none" }` before any guard call (`:525-527`), test asserts exact object + empty `rpc.simulated` (`enableAutoPay.test.ts:548-553`); loosening still refused by default (`:528,555-562`). No stale `.step` consumers. |
| 5 | Asset cross-check | **PASS** (see NB-b) | `assertAssetMatchesRule` (`types.ts:256-265`) called by baseline (`:284-288`) and enable validation (`:298-300`); matrix verified below. |
| 6 | Decoded exposure | **PASS** (see NB-c) | `ruleFromSetRuleXdr` decodes `set_rule` XDR (`enableAutoPay.ts:248-251`), used by enable (`:329,353-354`) and baseline (`:395,414-415`); scratch round-trip for 0 / 1 / i128::MAX exact. |
| 7 | Regression + scope | **PASS** | enable order `approve, set_rule, set_executor` (`:331-335,343`); old order makes the prefix test fail (mutation a2); `git diff HEAD~1 --name-only` = 5 `stellar/src/approval/**` + `backlog/approval-policy.md` only; no `S[A-Z2-7]{55}`; no `Buffer`/`node:` imports (comments only). |
| 8 | Mutation testing (4) | **PASS** | all 4 caught, see §6. |

Detailed notes:

- **Check 2 (attack).** The `arming` flag is spread from `step.kind === "set_executor"` (`:349`), i.e. from the **produced step's kind**, not from any draft field. `AutoPayDraft` has no field that selects which action is armed; my scratch build with a different `executor` address still yielded `[undefined, undefined, true]`. The baseline builder builds only `[approve, set_rule]` and maps actions without the flag (`:411`), so it cannot acquire one.
- **Check 3 (attack).** Scratch matrix (all via `buildEnableAutoPay`):

  | `current` | Result |
  |---|---|
  | `{ rule, executor }`, limit > 0 | `ApprovalError:already_armed` |
  | `{ rule auto=1, executor }` | `already_armed` |
  | `{ rule auto=0, executor }` | OK (partially armed) |
  | `{ rule }` / executor `undefined` | OK |
  | executor `""` | OK |
  | executor `"   "` (whitespace) | `already_armed` (conservative) |
  | executor `"nope"` (invalid G…) | `already_armed` (conservative) |
  | `{ executor }` with no rule | OK |

  Semantics vs the contract: `pay_executor` needs `registered == executor` and `amount <= auto_approve_limit` (`lib.rs:458,471`). An account with an executor and a positive limit is therefore **at least** able to auto-pay, so refusing is the fail-closed direction; the builder may over-refuse (invalid/whitespace executor, or a rule with no allowed assets) but never under-refuses given an accurate `current`. `current` remains optional by spec; when omitted the caller owns the not-armed precondition (documented `:137-145`). See NB-a.
- **Check 4 (grep).** Repo-wide search for `buildTightenRule` / `TightenRuleResult` finds only `index.ts` re-exports, the builder, its tests, and reports. No production caller reads `.step`; the rename to `.steps` is safe.
- **Check 5 (attack).** Direct `assertAssetMatchesRule` matrix: equal `C...` OK, `undefined` target OK, different valid `C...` → `invalid_asset`, empty-string / whitespace / lowercase / checksum-mutated → `invalid_asset`. Through the validators: baseline with `assetContractId = ASSET_SAC` vs `rule = BASELINE_RULE(USDC_SAC)` → `invalid_asset`; a 0-asset rule is refused earlier by `no_assets`. See NB-b.
- **Check 6 (attack).** Scratch built `set_rule` from drafts with `auto_approve_limit`/`per_tx_limit`/`daily_limit`/`allowance` = `0n`, `1n`, `I128_MAX`; `summary.exposure.thresholdRaw` equalled both the raw `scValToNative` decode of `steps[1].args[1]` and the input value each time (the typed `scvI128` hi/lo is handled by `scValToNative`, symbol keys already asserted at `enableAutoPay.test.ts:157-178`). See NB-c for the malformed/foreign sub-case.

## 3. Break attempts

| Input | Expected | Actual | Result |
|---|---|---|---|
| Enable arming flag with a different `executor` address | only `set_executor` flagged | `[undefined, undefined, true]` | PASS |
| `current` = executor + auto=1 vs auto=0 vs no rule | refuse vs OK vs OK | `already_armed` vs OK vs OK | PASS |
| executor `""` / `"   "` / `"nope"` (invalid) | fail-closed | OK / `already_armed` / `already_armed` | PASS (NB-a) |
| Tighten identical rule | `{steps:[],same,none}`, no guard call | exact, `rpc.simulated` empty | PASS |
| Tighten loosening default / new_rule default | `use_enable_flow`, nothing built | `use_enable_flow`, empty `simulated` | PASS |
| `assertAssetMatchesRule`: diff / empty / whitespace / lowercase / checksum | `invalid_asset` each | `invalid_asset` each | PASS |
| Rule with 0 assets through `validateBaselineSetup` | `no_assets` (earlier gate) | `no_assets` | PASS |
| Enable-path mismatch (`allowedAssets:[USDC_SAC]`) | n/a — `rule.allowed_assets` derived from draft | `OK` (tautological, see NB-b) | note |
| Exposure round-trip 0 / 1 / `I128_MAX` | exposure == signed XDR decode | exact | PASS |
| Foreign valid `approve` XDR returned as `set_rule` | reject with typed error | **builds; exposure limits `undefined`, no throw** | note (NB-c) |
| Malformed XDR `"AAAA"` returned as `set_rule` | typed `ApprovalError` | SDK `XdrError` (plain) | note (NB-c) |
| Old unsafe order `[set_executor,set_rule,approve]` | prefix test fails | 1 failed | PASS (mutation a2) |

## 4. Blocking issues (exact fix each) — none

No blocking issues. The correction round is accepted as-is.

## 5. Non-blocking

- **NB-a — `already_armed` is opt-in and does not validate the executor address.** `isAlreadyArmed` (`enableAutoPay.ts:257-261`) treats any non-empty string — whitespace, `"nope"` — as "registered", and does nothing when `deps.current` is omitted (`:306`). Both are fail-closed and match the spec's documented caller precondition, but the real hardening would be for the shell to always read `getRule`/`getExecutor` and pass `current`. If wanted later: validate via `StrKey.isValidEd25519PublicKey(executor)` before treating it as registered, and consider a `current`-required variant for the write path.
- **NB-b — the enable-path asset cross-check is tautological.** `validateAutoPayDraft` builds `rule` with `ruleFromDraft(draft)` (`types.ts:298`), whose `allowed_assets` is copied from `draft.allowedAssets`, so `assertAssetMatchesRule(draft.allowedAssets[0], rule)` can never mismatch. The check is load-bearing only in `validateBaselineSetup` (where `assetContractId` and `rule` are independent inputs). Harmless, but a reader could over-trust the enable-path call; a one-line comment would be enough.
- **NB-c — `ruleFromSetRuleXdr` trusts the guard's output shape.** It returns `decoded.args[1] as Rule` without asserting `functionName === "set_rule"` (`enableAutoPay.ts:248-251`). With the approved guard client this is always `set_rule(owner, rule)`, so the path is safe; but a scratch probe showing a *valid foreign* XDR (an `approve` envelope) as the `set_rule` result built successfully and produced `exposure.thresholdRaw = dailyLimitRaw = undefined` **without throwing**, while a malformed XDR throws the SDK's plain `XdrError`, not a typed `ApprovalError`. Defense-in-depth suggestion: check the decoded `functionName` and the `Rule` shape, and throw `ApprovalError` on mismatch. Not blocking — no user-controllable input reaches this private helper.
- **NB-d — `backlog/approval-policy.md` "Review fixes 2" is accurate** (formula, numbers, file list all check out); no doc drift beyond the two notes above.

## 6. Mutation results

| # | Mutation | File (reverted via `git checkout --`) | Test command | Failed? |
|---|---|---|---|---|
| a | Mark the **first** action `arming: true` (`set_executor` → `approve`) | `stellar/src/approval/enableAutoPay.ts:349` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 1 failed / 47 (`only the third action has arming`) |
| b | `already_armed` fires when `auto_approve_limit == 0` (`> 0n` → `>= 0n`) | `stellar/src/approval/enableAutoPay.ts:260` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 1 failed / 47 (partially-armed auto=0 case refused) |
| c | Identical rule builds a `set_rule` step again (drop the `"same"` early return) | `stellar/src/approval/enableAutoPay.ts:525-527` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 1 failed / 47 (`builds nothing … identical rule`) |
| d | Drop the asset cross-check in the baseline validator | `stellar/src/approval/types.ts:287` | `vitest run src/approval/__tests__/enableAutoPay.test.ts src/approval/__tests__/types.test.ts` | **YES** — 1 failed / 74 (`assetContractId` mismatch accepted) |
| a2 | Restore the old unsafe order `[set_executor, set_rule, approve]` | `stellar/src/approval/enableAutoPay.ts:331-335` | `vitest run …/enableAutoPay.test.ts -t "no prefix"` | **YES** — 1 failed (prefix 1 already pays), proving the state model still catches the regression |

All mutations reverted; `git diff HEAD` is empty. The temporary scratch test
`stellar/src/approval/__tests__/zz-review.scratch.test.ts` and the `node_modules` symlink were removed;
final `git status --short` shows only this review file. **PASS.**

---

*Reviewer note:* this delta is the cleanest of the chain — five review items, each with a dedicated
mutation-sensitive test, and the arming call-out is derived from the produced step rather than any
caller input. The only residuals are defense-in-depth (NB-a/b/c), none of which is reachable through
the public builder API with the approved guard client.
