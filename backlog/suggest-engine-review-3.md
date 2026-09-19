# Review 3 (final delta): T3 residual-B1 fix — suggestions engine

- **Date:** 2026-09-19
- **Reviewer:** W-review-T3c (DeepSeek v4.1 Flash, L4, fresh session) — did **not** write the fix
- **Branch/worktree under review:** `review/suggest-engine-3` == `chain/suggest-engine`, HEAD `3ff6b09`
  (delta = `3ff6b09` only; previous review `backlog/suggest-engine-review-2.md`, HEAD `d668187`)
- **Fix spec:** `brief-t3-fix2.md`; **design (read-only):** `docs/approval-and-scheduling.md` §6/§4
- **Method:** read-only + one throwaway scratch suite (4 tests, 500 seeded adversarial histories,
  independent oracles, constructed repros); 4 source mutations applied/reverted; gates re-run.
  Scratch test + root `node_modules` symlink removed; tree left clean (only this review file).

## Verdict: approve with corrections

- **B1-residual is closed.** Across 500 independent adversarial histories (784 `RuleDraft`s, 0 violations)
  and the exact 9-record repro, no `autoApproveLimit` is ever above the outlier-excluded bound or an
  existing `rule.perTxLimit`, and ordering holds; the required daily fallback now comes from the same
  `deriveRobustThreshold` helper as `auto_pay_threshold`.
- **Single source of truth confirmed; all gates green** (tsc 0 errors; suggest 145; keeper 67 + anchor 111
  + suggest 145 = 323); the documented worked example still yields threshold 20 / daily 60.
- **No blocking issues.** The corrections are non-blocking and about accuracy/hygiene: the backlog's
  "p95-of-active-days is already a robust order statistic" justification is wrong for <20 active days;
  `RobustThreshold.pool` is dead; the contacts-filtered daily fallback can newly suppress a valid daily
  suggestion. The `dailyLimit` full-pool decision itself is acceptable (see §3).

---

## 1. Numbers re-run (verbatim)

`npm run check -w @polaris/stellar` (tsc):
```
> @polaris/stellar@0.1.0 check
> tsc -p tsconfig.json
```
(0 errors)

`npm run test:suggest -w @polaris/stellar`:
```
 Test Files  4 passed (4)
      Tests  145 passed (145)
```

`npm test -w @polaris/stellar`:
```
ℹ tests 67
ℹ pass 67
ℹ fail 0
 Test Files  5 passed (5)
      Tests  111 passed (111)
 Test Files  4 passed (4)
      Tests  145 passed (145)
```
**Confirmed:** keeper 67 + anchor 111 + suggest 145 = **323**. Report claims (145 / 323) are exact, and
the "5 new tests fail without the fix" claim is independently reproduced (mutation (a), §6).

## 2. Fuzz + repro results

**Independent adversarial fuzz — 500 seeded histories, 0 violations.** Generator: count `8..40`,
base amount `1..20` display units, `0..3` outliers of `5×..100×` the base, first record pinned to
day 29 so the window/span can be met. Existing-rule shapes: absent, `perTxLimit` only,
`perTxLimit`+`dailyLimit`, `autoApproveLimit` only, `autoApproveLimit`+`perTxLimit`, and all three;
`knownContacts` either empty or a random address subset. For every `RuleDraft` in every
`auto_pay_threshold`/`daily_limit` suggestion the assertions were:
`0 <= autoApproveLimit <= perTxLimit <= dailyLimit` (when present), `autoApproveLimit <=
roundUp5(max of the outlier-excluded pool)` for engine-derived values, and
`autoApproveLimit <= existing rule.perTxLimit`. Result:
```
FUZZ500 drafts=784 derived=651 carried=133 itersWithoutRuleDraft=44 violations=0
```
Every length/ordering/robust-bound/rule-cap assertion held; all drafts `JSON.stringify`-safe. The
oracle was independently confirmed to have teeth: it flags violations under mutations (b), (c) and (d).

**9-record repro (8 × `10` + 1 × `1000`, no rule) — exactly what `suggest()` returns:**
```
auto_pay_threshold  {"autoApproveLimit":"10","perTxLimit":"10", ...}          id auto_pay_threshold:USDC:10
daily_limit         {"autoApproveLimit":"10","dailyLimit":"1515", ...}        id daily_limit:USDC:1515
unusual_payment_alert {"kind":"none","action":"require_extra_confirmation"}   (fires for 1000)
daily evidence: {"count":9,"median":"10","p90":"1000","max":"1000",
                 "p95DailyTotal":"1010","dailyMedian":"10","dailyMax":"1010"}
```
No suggestion carries `autoApproveLimit` above `10` (the robust value rounded per the 5-unit rule);
the pre-fix `"1000"` is gone. The unusual alert fires for the `1000` (baseline p90 `10`). **PASS.**

**30 small days + one `1000` day:** `daily_limit:USDC:15` → `{autoApproveLimit:"10", dailyLimit:"15"}`,
evidence `p95DailyTotal:"10"`, `dailyMax:"1000"`. With 30 samples the nearest-rank p95 is the
second-largest value, so the single outlier day is naturally excluded. **PASS.**

**Worked example (14 payments, p90 18.4 → threshold 20, daily 57 → 60):** still exactly
`auto_pay_threshold` 20 and `daily_limit` 60. **PASS.**

## 3. Daily-limit evidence decision

The worker's decision: "daily limit evidence stays full-pool by design; only the autoApprove fallback
is robust." **Classification: acceptable (non-blocking), but the stated justification is inaccurate.**

Observed proposals:
- 8 × `10` + 1 × `1000` (8 active days): `dailyLimit:"1515"` (p95 daily total `1010` × 1.5), i.e. far
  above the user's actual mandate of ~`10`/day.
- 30 small days + one `1000` day (30 active days): `dailyLimit:"15"` (p95 `10`), i.e. **not** inflated.

Why acceptable: `docs/approval-and-scheduling.md` §6.3 explicitly defines `daily_limit` = p95 daily
total × 1.5 (not an outlier-robust estimator); raising `daily_limit` is a **loosening** that requires
read-back + **one card + Touch ID** and is never auto-applied (D11; §4), so it is not the unattended
per-payment risk that B1 was about; the evidence already surfaces `dailyMax`/`p95DailyTotal` so the
user sees the `1010` day; the actually-unattended value (`autoApproveLimit`) is now robust at `10`; and
`review-2` explicitly allowed the "document that daily p95 includes every confirmed public day"
alternative. The full-pool behavior is also pre-existing (present before this delta), so it is not a
regression introduced here.

Why it still needs a correction: the backlog's rationale ("the p95-of-active-days is already a robust
order statistic") is **false for <20 active days** — nearest-rank p95 is the maximum whenever
`ceil(0.95n) = n`, i.e. `n <= 19` (and for two outliers, `n <= 39`). One exceptional day can therefore
set an arbitrarily large daily mandate (`1515` vs a ~`15` typical day here). This is user-gated, so not
blocking, but the claim must not be repeated. Optional hardening (non-blocking): build the daily target
from an outlier-robust daily-total pool (mirror `deriveRobustThreshold`), or gate the p95 on
`activeDays >= 20` / cap it against a robust daily-total maximum.

## 4. Blocking issues (exact fix each) — or none

**None.** The blocking B1-residual item from `suggest-engine-review-2.md` is fully resolved:
`deriveRobustThreshold` (`suggest.ts:325`) is the single derivation, both `autoPayThresholdSuggestion`
(`suggest.ts:356`) and the `daily_limit` fallback (`suggest.ts:446`) call it, and if no robust value
survives `minPayments` the daily suggestion is dropped rather than filled from the full pool.

## 5. Non-blocking

- **Inaccurate justification (fix the report wording).** `backlog/suggest-engine.md` "Review fixes 2"
  says the daily p95 "is already a robust order statistic"; it is only robust for `n >= 20`. Correct it
  to state the real small-sample behavior (p95 = max for `n <= 19`), matching the code comment at
  `suggest.ts:425-427` (which is accurate). Add the small-sample note next to the daily-limit code.
- **Dead field.** `RobustThreshold.pool` (`suggest.ts:304-315`) is returned but never read by either
  caller (both destructure `{ stats, thresholdRaw, capped, capDisplay }`). Drop it or use it.
- **New contacts-filtered suppression.** The daily fallback now derives from `thresholdPool` (contacts-
  filtered when `knownContacts` is non-empty). With a non-empty contact list and `<8` robust contact
  payments, `daily_limit` is dropped even when all-records daily totals are sufficient and no
  `rule.autoApproveLimit` exists. Conservative and arguably per the fix spec ("the SAME outlier-robust
  pool as auto_pay_threshold"), but it is a behavior change worth documenting for the UI/seam owner.
- **Still-open review-2 items, correctly deferred** with sound reasons: `tighten_dormant` requires
  `autoPayEnabledSince`; ordering can suppress a valid daily cap with no friendlier rationale;
  `evidence.lastUsedDays == unusedDays`; bounded-loop cost. All match the worker's "skipped" list.
- **Positive/hygiene notes:** `dropAmountOutliers` majority-outlier limit and the overloaded
  `unusual_payment_alert` `evidence.p90` are now documented; no secrets.

## 6. Mutation results

All mutations applied to non-test source, committed suggest suite run (145 tests), then
`git checkout -- stellar/src/suggest/suggest.ts`; `suggest.ts` confirmed pristine and tree clean after
each.

| # | Mutation | Caught by committed suite? | Which committed test(s) |
|---|---|---|---|
| a | daily fallback back to the full-pool `computeAutoApproveThreshold` (`suggest.ts:446`) | **YES** (5 fail) | all five `daily_limit outlier robustness (B1-residual)` tests (incl. the 300-history property test) |
| b | drop the `perTxLimit` clamp in `computeAutoApproveThreshold` (`suggest.ts:273-276`) | **YES** (3 fail) | "is capped by the rule per_tx_limit and says so"; "clamps the fallback to the rule perTxLimit…"; the property test |
| c | drop the outlier exclusion in the helper (`suggest.ts:333` → `robustAmounts = amounts`) | **YES** (7 fail) | both `auto_pay_threshold outlier robustness (B1)` tests + all five `daily_limit (B1-residual)` tests |
| d | drop the final ordering validation (`isRuleDraftOrdered` → always `true`) | **YES** (1 fail) | "drops the daily suggestion when the rule ordering cannot hold" |

The scratch fuzz additionally caught (a), (b), (c) and (d), so the independent oracle is not vacuous.

**Regression + scope (all PASS):** purity scan of non-test `stellar/src/suggest/**` found no
`Date.now`/`Math.random`/`process.`/`fs`/`node:`/`fetch(`/`require(` (only a comment mention in
`__tests__/helpers.ts`); previous fixes intact and covered — recurrence `firstRunAt > now`
(`suggest.test.ts:533-539`), id de-dup (`:812`), deep-copy `toLlmSafeEvidence` (`:822`),
JSON-safety (`:470`, `:805`) — and untouched by the delta; `git diff HEAD~1 --name-only` is exactly
`backlog/suggest-engine.md`, `stellar/src/suggest/__tests__/suggest.test.ts`,
`stellar/src/suggest/stats.ts`, `stellar/src/suggest/suggest.ts` (scope OK); no `S[A-Z2-7]{55}` secret
anywhere in the repo.

DONE T3-review-3
