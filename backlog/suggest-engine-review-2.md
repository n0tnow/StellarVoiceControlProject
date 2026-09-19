# Review 2 (delta): T3 fixes — suggestions engine

- **Date:** 2026-09-19
- **Reviewer:** W-review-T3b (DeepSeek v4.1 Flash, L4) — did **not** write the fixes
- **Branch/worktree under review:** `review/suggest-engine-2` == `chain/suggest-engine`, HEAD `962d879`
  (delta = `962d879` only; previous review `backlog/suggest-engine-review.md`, HEAD `4ad1d05`)
- **Fix spec:** `brief-t3-fix.md`; **design (read-only):** `docs/approval-and-scheduling.md` §6/§11
- **Method:** read-only + one throwaway scratch suite (29 tests) with independent oracles,
  adversarial fixtures and 300+300 fuzz cases; 6 source mutations applied/reverted; gates re-run.
  Scratch + `node_modules` symlink removed; tree left clean.

## Verdict: approve with corrections

B2 (daily-limit ordering/per-tx cap) and B3 (future `firstRunAt`) are correctly fixed and well tested.
B1 is fixed for `auto_pay_threshold` and `unusual_payment_alert`, but **one residual B1 hole remains in
`daily_limit`**: its required `autoApproveLimit` fallback is still derived from the full, non-robust
pool, so a single outlier is proposed as the auto-approve limit. One blocking fix below.

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
      Tests  140 passed (140)
```

`npm test -w @polaris/stellar`:
```
ℹ tests 67
ℹ pass 67
ℹ fail 0
 Test Files  5 passed (5)
      Tests  111 passed (111)
 Test Files  4 passed (4)
      Tests  140 passed (140)
```
**Confirmed:** keeper 67 + anchor 111 + suggest 140 = **318**. Worker's claimed numbers are exact.

## 2. Adversarial histories (input | proposal | acceptable?)

`auto_pay_threshold` proposal unless stated; `alertFor` = whether the unusual alert fired (amount).

| Input | threshold | alert | Acceptable? |
|---|---|---|---|
| 9 = 8×`10` + 1×`1000` | `10` | `1000` fires | **YES** — B1 fixed |
| 10 = 8×`10` + 2×`1000` | `10` | `1000` fires | YES (two outliers can't move median) |
| 11 = 9×`10` + 2×`1000` | `10` | `1000` fires | YES |
| 14 = 12×`10` + 2×`1000` | `10` | `1000` fires | YES |
| 9 = 8×`1000` + 1×`10` (low outlier) | `1000` | none | YES (1000s are the norm; low outlier ignored) |
| 10 all `13` | `15` | none | YES (= roundUp5(13)) |
| 20 bimodal 10×`5` + 10×`50` | `50` | none | YES (50 is a real modal value) |
| 100 all `28` (tight, under cutoff 84) | `30` | none | YES |
| 100 = 80×`28` + 20×`80` (creep to cutoff) | `80` | none | Acceptable — threshold ≈ cutoff, bounded by roundUp5(max)=`80` |
| 9 = 6×`10` + 3×`1000` (<`minPayments` after exclusion) | none | `1000` fires | YES (dropped, not unsafe) |
| 9 = 4×`10` + 5×`1000` (>half outliers → median shifts) | `1000` | none | Acceptable — "outliers" are the majority spend; bounded by roundUp5(robust max) |

`daily_limit` on the first fixture is the exception: it proposes
`{autoApproveLimit:"1000", perTxLimit:"1000", dailyLimit:"1515"}` — see §4.

## 3. Property/fuzz results

- **Threshold bound (300 seeded histories):** 298 produced an `auto_pay_threshold`; in all 298 the
  proposal was `<= roundUp5(max(robust pool))` and `<= rule.perTxLimit` (when present). **PASS.**
- **B2 ordering (300 random rules incl. missing fields):** 185 produced a `daily_limit`; every
  `auto_pay_threshold`/`daily_limit` draft satisfied `0 <= autoApproveLimit <= perTxLimit <= dailyLimit`;
  `perTxLimit` was carried verbatim. **PASS.** Every output `JSON.stringify`-safe.
- **Worked example:** p90 `18.4` → threshold `20`; daily p95 `38` × 1.5 = `57` → `60`. **PASS.**
- **B3:** `firstRunAt > now` (strict) for weekly/daily/10-day cadences ending 0/1/16/29 d ago. A 1-second
  cadence last seen 30 d ago and a 1-second cadence 10 y ago both terminate in <1 ms and land at
  `now+1` (bounded loop + arithmetic fallback). **PASS.**
- **Independent oracle:** `percentileNearestRank`/`median`/`roundUpToDisplayMultiple` match a from-scratch
  oracle on 2000 random arrays (n∈[1,60], p∈{1,10,50,90,95,100}, decimals 7). **PASS.**

## 4. Blocking issues (exact fix each)

**B1-residual — `daily_limit` reintroduces the outlier as the auto-approve limit.**
`suggest.ts:389` computes `stats` from the **full** eligible pool, and `suggest.ts:399` feeds its
`p90Raw`/`maxRaw` into `computeAutoApproveThreshold` for the required `autoApproveLimit`. The
`auto_pay_threshold` path was made robust (`suggest.ts:315-317`) but the shared helper's daily caller
was not. Repro (9 = 8×`10` + 1×`1000`, no rule): `suggest` returns both
`auto_pay_threshold:USDC:10` (safe) **and**
`daily_limit:USDC:1515` with `autoApproveLimit:"1000"` — accepting the daily draft arms unattended
auto-pay up to the outlier. No committed test covers this (the B2 test masks it with `perTxLimit:"15"`).

*Exact fix:* in `dailyLimitSuggestion`, build a robust pool for the fallback:
```ts
const robustAmounts = dropAmountOutliers(sortBigints(result.records.map((r) => r.amountRaw)), UNUSUAL_MULTIPLIER);
const robustStats = amountStatsFromSorted(robustAmounts, resolved.decimals);
const fallback = computeAutoApproveThreshold(robustStats.p90Raw, robustStats.maxRaw, context, resolved.decimals);
```
Do the same for `dailyTotals` (or document that daily p95 deliberately includes every confirmed public
day) so an outlier day cannot inflate `dailyLimit` (`1515` here). Add a regression asserting the daily
draft's `autoApproveLimit` is `10` for the 9-record fixture.

## 5. Non-blocking

- **Majority-outlier case** (fix spec asked about it): with >half the records outliers the median is
  contaminated and the robust pool is no help (threshold `1000`). By then the "outlier" is the normal
  spend, so this is defensible; the property bound still holds. Worth a comment in `stats.ts`.
- **`tighten_dormant` is unusable without `autoPayEnabledSince`.** Intended per the fix spec
  (conservative), but a fresh install on an existing 30 d history will never get the dormant nudge
  until the caller supplies the field — call it out for the UI/seam owner.
- **Ordering can suppress a valid daily cap.** Rule `{perTxLimit:"100"}` drops the `60` daily suggestion
  because `perTx > proposed daily`. Correct per the contract ordering but potentially surprising; a
  rationale-visible drop would be friendlier.
- **`evidence.p90` is overloaded** for `unusual_payment_alert` (set to the robust baseline) while
  `median`/`max` stay full-pool. Privacy-safe, but the mixed baseline is worth a comment.
- **`evidence.lastUsedDays` == `unusedDays`**; design §6.3 says "last-used date". Cosmetic.
- **Bounded loop cost:** `MAX_FIRST_RUN_ADVANCE_STEPS = 10_000` is per group, so a pathological
  (1 s cadence, years-old) history costs up to `10_000 × groups` iterations. Bounded, but the
  arithmetic fallback could be tried first.
- **Test gap:** no committed test covers the daily-limit robust-pool fallback (it is the enabler of §4).

## 6. Mutation results

All mutations applied to non-test source, committed suggest suite run (`140` tests → scratch removed),
then `git checkout -- <file>`. Working tree confirmed clean after each.

| # | Mutation | Caught? | Which committed test |
|---|---|---|---|
| a | revert outlier exclusion (`suggest.ts:315` → `const robustAmounts = amounts`) | **YES** (2 fail) | "never lets a single outlier become the auto-approve threshold"; "requires minPayments to remain after outlier exclusion" |
| b | drop per-tx cap in daily fallback (`suggest.ts:399` → unclamped `roundUp5(p90)`) | **YES** (1 fail) | "clamps the fallback to the rule perTxLimit and carries the cap into the draft" |
| c | revert `firstRunAt = last.ts + interval` (`suggest.ts:516`) | **YES** (2 fail) | "fires for a weekly cadence with 4 occurrences"; "never proposes a firstRunAt in the past (B3)" |
| d | skip id de-dup (`suggest.ts:133-141` removed) | **YES** (1 fail) | "de-duplicates history records by id (keeps the first occurrence)" |
| e | `toLlmSafeEvidence` returns the reference (`suggest.ts:732-733`) | **YES** (1 fail) | "toLlmSafeEvidence returns a deep copy" |
| — | jitter `>` → `>=` (`suggest.ts:495`) | **YES** (1 fail) | "accepts interval jitter at exactly 10% (boundary)" — the old review's escaped mutation is now caught |

**Other regression checks:** purity scan of non-test `stellar/src/suggest/**` found no `Date.now`,
`Math.random`, `process.`, `fs`, `node:`, `fetch`, `require`; `MAX_SCHEDULE_RUNS` is removed;
`title`/`rationale` carry the LOCAL-UI-ONLY comment (`types.ts:195-202`); `SuggestInputError` is thrown
only by `validateSuggestContext`; no `S[A-Z2-7]{55}` secret in `stellar/src/suggest/**` or
`backlog/suggest-engine.md`; `TZ=UTC` vs `TZ=Pacific/Kiritimati` produce byte-identical output for a
fixed context; delta scope = `stellar/src/suggest/**` + `backlog/suggest-engine.md` only. All PASS.
