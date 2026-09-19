# Report: suggest-engine (T3)
- **Date:** 2026-09-19
- **Worker/Agent:** W-T3 (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/suggest-engine` / `.worktrees/suggest-engine`
- **PR:** none (per task: no commit/push/tag)

## Completed

Pure, offline, deterministic suggestions engine for `docs/approval-and-scheduling.md` §6 (D11).
`t3` is self-contained: no network, clock, randomness or I/O; nothing is ever applied.

### Files (all new unless noted)
- `stellar/src/suggest/types.ts` — input/output types. Structural copies of unmerged types (`RuleView`,
  `RuleDraft`, `ScheduleDraft`, `DisableAutoPay`) are re-declared minimally and each carries the comment
  `structural copy; unify when branches merge`. A fourth `NoChange` change shape was added for the
  informational `unusual_payment_alert` (it proposes **no** rule change; docs §6.3).
- `stellar/src/suggest/constants.ts` — every threshold in one place, all marked PROPOSED.
- `stellar/src/suggest/amount.ts` — float-free `formatAmount` / `parseAmount`, `roundUpToDisplayMultiple`,
  `mulDivCeil`, `displayStepRaw`, `unitScale`, `ceilDiv`.
- `stellar/src/suggest/stats.ts` — nearest-rank percentile (documented), classic median, max,
  DST-safe `localDayKey` via `Intl`, `dailyTotals`, `spanDays`, `recipientFrequency`, `medianInt`.
- `stellar/src/suggest/suggest.ts` — `suggest()`, `explainNoSuggestions()`, `toLlmSafeEvidence()`,
  five kinds, guards, deterministic sort.
- `stellar/src/suggest/index.ts` — public surface (`export *` of the pure modules).
- `stellar/src/suggest/__tests__/` — `helpers.ts` (seeded-PRNG fixtures) + `amount.test.ts`,
  `stats.test.ts`, `suggest.test.ts`, `privacy.test.ts`.
- **Modified** `stellar/src/index.ts` — one added line: `export * as suggest from "./suggest/index.ts";`
  (nothing else in the file changed).
- **Modified** `stellar/package.json` — added `test:suggest` and appended it to `test`; no dependency
  added (`vitest` was already a devDependency).
- **New** this report.

### API

| Export | Signature | Notes |
|---|---|---|
| `suggest` | `(history, context, options?) => Suggestion[]` | Pure; sorted by kind priority then id; input-order independent. |
| `explainNoSuggestions` | `(history, context, options?) => NoSuggestionsExplanation \| null` | Returns `not_enough_history` with counts, or `null` when enough data. |
| `toLlmSafeEvidence` | `(suggestion) => { kind, evidence, proposal }` | Only aggregate evidence + numeric/action proposal; no address/alias/id/timestamp by construction. |
| `formatAmount` / `parseAmount` | `bigint ↔ decimal string` | i128-exact; no `Number` arithmetic on amounts. |
| `roundUpToDisplayMultiple` / `mulDivCeil` | integer rounding | Thresholds/limits round UP to the nearest 5 display units. |
| `percentileNearestRank` / `median` / `maxOf` / `dailyTotals` / `localDayKey` / `spanDays` | stats helpers | Made public for reuse/testing; all pure. |

### Suggestion kinds (implemented trigger | constants | output)

| Kind | Trigger (as implemented) | Constants | Output (`proposedChange`) |
|---|---|---|---|
| `auto_pay_threshold` | Enough history; pool = eligible (confirmed+public, display asset, in window) payments to `knownContacts` (all eligible recipients when the set is empty); `p90>0`; skipped when auto-pay is on and the current `autoApproveLimit ≥ p90` | `ROUNDING_STEP_DISPLAY=5` | `RuleDraft.autoApproveLimit = roundUp5(p90)`; `perTxLimit` only when the rule has none; clamped to `rule.perTxLimit` when present (rationale says so) |
| `daily_limit` | Enough history; `≥3` active local days; `p95>0`; skipped when it equals the current `rule.dailyLimit` | `DAILY_LIMIT_MULTIPLIER 3/2`, `DAILY_LIMIT_MIN_ACTIVE_DAYS=3`, `ROUNDING_STEP_DISPLAY=5` | `RuleDraft.dailyLimit = roundUp5(ceil(p95_daily × 3/2))` |
| `schedule_from_recurrence` | Per recipient: `≥3` occurrences, interval jitter `≤10%`, amount spread `≤10%` of the median | `RECURRENCE_MIN_OCCURRENCES=3`, `…JITTER_PCT=10`, `…AMOUNT_TOLERANCE_PCT=10`, `DEFAULT_SCHEDULE_RUNS=12`, `MAX_SCHEDULE_RUNS=52` | `ScheduleDraft` with median interval and a **finite** `runs` (always `12`) |
| `tighten_dormant` | `autoPayEnabled` and either no `pay_executor` route ever, or last one `>30` days ago | `DORMANT_DAYS=30` | `DisableAutoPay { kind:"disable_auto_pay", confirmation:"light" }` |
| `unusual_payment_alert` | An eligible payment `>3× p90`, timestamped within the last 7 days | `UNUSUAL_WINDOW_DAYS=7`, `UNUSUAL_MULTIPLIER=3` | `NoChange { action:"require_extra_confirmation" }` (informational; no rule change) |

Worked example (`docs/approval-and-scheduling.md` §6.8) verified exactly by tests: 14 payments,
median `9.5`, p90 `18.4`, max `22` → threshold `20`; p95 daily total `38` × 1.5 = `57` → daily limit `60`.

### Constants (all PROPOSED)

| Constant | Value | Source |
|---|---|---|
| `DEFAULT_WINDOW_DAYS` / `DEFAULT_MIN_PAYMENTS` / `DEFAULT_MIN_SPAN_DAYS` | 30 / 8 / 7 | §6.2, §11 |
| `DEFAULT_ASSET_DECIMALS` | 7 | USDC on Stellar |
| `ROUNDING_STEP_DISPLAY` | 5 | §6.3, §11 |
| `DAILY_LIMIT_MULTIPLIER_NUM/DEN` | 3 / 2 (×1.5) | §6.3 |
| `DAILY_LIMIT_MIN_ACTIVE_DAYS` | 3 | this task (stability of the daily p95) |
| `RECURRENCE_MIN_OCCURRENCES` | 3 | §6.3 |
| `RECURRENCE_MAX_INTERVAL_JITTER_PCT` / `RECURRENCE_AMOUNT_TOLERANCE_PCT` | 10 / 10 | task |
| `DEFAULT_SCHEDULE_RUNS` / `MAX_SCHEDULE_RUNS` | 12 / 52 | finite runs rule (§11b), task |
| `DORMANT_DAYS` | 30 | §6.3 |
| `UNUSUAL_WINDOW_DAYS` / `UNUSUAL_MULTIPLIER` | 7 / 3 | task |
| `CONFIDENCE_*` | medium ≥12 payments, high ≥20 & span ≥14d | this task |

### Guards / correctness
- Insufficient history (`< minPayments` confirmed public in window **or** span `< minSpanDays`) → `[]`;
  `explainNoSuggestions` returns `not_enough_history` with `count`/`spanDays`.
- Eligible records: `status:"confirmed"` only; `mode:"public"` only (confidential amounts are invisible
  to the guard — noted in code); `displayAsset` only (one asset per rule).
- Dismissal by id **or** kind is honoured.
- `auto_pay_threshold` clamped to `rule.perTxLimit` when present (else the rationale says a cap would be
  created), and never above `roundUp5(max observed)`. Auto-pay already covering p90 is not re-suggested.
- Determinism: identical output for identical input; input array shuffled/reversed yields deep-equal output.

### Test results (real numbers)
- `npm run check -w @polaris/stellar` → passes (tsc, 0 errors).
- `npm run test:suggest -w @polaris/stellar` → **4 files / 121 tests passed** (amount, stats, suggest,
  privacy). Includes worked-example evidence, percentile edges (n=1,2,even/odd,duplicates), rounding table,
  DST spring/fall + half-hour-zone bucketing, each kind fires/does-not-fire/dismissal/cap, recurrence
  jitter/tolerance/occurrences, dormant, unusual, insufficient-history reasons, confirmed+public-only,
  determinism (repeat + shuffle), LLM-safe leak test, i128 bigint safety.
- `npm test -w @polaris/stellar` → all suites green: keeper **67**, anchor **111**, suggest **121**
  (**299** total).

## Unfinished (handed off)
- **T4 history readers**: nothing here reads local encrypted history or Horizon/`Paid` events; the engine
  consumes `HistoryRecord[]` supplied by T4.
- **T5 UI**: suggestions panel (Accept/Dismiss), phrasing via an LLM using only `toLlmSafeEvidence`.
- **Unification after merge**: replace the structural copies in `types.ts` (`RuleView`, `RuleDraft`,
  `ScheduleDraft`, `DisableAutoPay`) with the canonical guard/seam types once those branches land
  (search for `structural copy; unify when branches merge`).
- **PROPOSED defaults to confirm**: `daily_limit`'s `autoApproveLimit` fallback (used only to satisfy the
  required seam field when no rule exists) and `DEFAULT_SCHEDULE_RUNS=12`.

## Blockers
- None. The engine is fully offline; `stellar/index.ts` in this base does not export `guard`/`payments`
  namespaces, so no cross-import was possible or needed.

## Review Notes
- `unusual_payment_alert` required a fourth change shape (`NoChange`). The docs type lists only
  `RuleDraft | ScheduleDraft | DisableAutoPay`; an informational alert has no rule change, so `NoChange`
  is the honest representation. Flagged for the seam decision.
- `auto_pay_threshold` uses known contacts when present, otherwise all eligible recipients; documented in
  code. This makes the "saved contacts" wording from §6.3 exact when contacts exist and still usable
  before any contact is saved.
- The `≤ roundUp5(max)` clamp is defensive: because `p90 ≤ max` and rounding is monotonic it cannot
  change a normally computed proposal; a test pins the observable behaviour.
- Recurrence `intervalDays` is a `number` for readability; amounts remain `bigint`/decimal strings only.
- Suggestion `id`s are local-only and may contain a recipient address for uniqueness; they are excluded
  from `toLlmSafeEvidence`.

## Suggested Next Step
- T4: implement the history reader that produces `HistoryRecord[]` (local encrypted store + Horizon/`Paid`
  events), then T5 wires `suggest()` into the suggestions panel with Accept/Dismiss and LLM phrasing from
  `toLlmSafeEvidence`.

## Review fixes (T3 corrections, 2026-09-19)

Applied the blocking and non-blocking corrections from `backlog/suggest-engine-review.md`. All changes stay
inside `stellar/src/suggest/**` (code + tests); no network, no commit/push. Every fix has a committed
regression test. "Fails without the fix" was proven by temporarily reverting the fix in `suggest.ts`
(backup + restore; `diff` confirmed identical), running `npm run test:suggest -w @polaris/stellar`, and
recording the failures below.

### B1 — outlier-robust auto-approve threshold (safety)
- New `stats.dropAmountOutliers(sorted, multiplier)`: drops amounts `> UNUSUAL_MULTIPLIER (3) × median`
  (median is robust) before the p90 is taken. `auto_pay_threshold` now derives its pool and p90 from the
  robust set and requires at least `minPayments` to remain, else it returns no threshold. Evidence
  (`count`/`median`/`p90`/`max`) is computed on the robust pool.
- `unusual_payment_alert` now compares against the outlier-robust baseline (robust p90 from the
  median-excluded pool) and reports that baseline as its `p90` evidence, so the 9-record `8×10 + 1×1000`
  fixture both yields a safe `10` threshold and fires the alert for the `1000`.
- Documented worked example is unchanged: 14 payments, median `9.5`, p90 `18.4`, max `22`; `3 × 9.5 =
  28.5 > 22`, so nothing is excluded and the threshold stays `20`. The exclusion factor (`3`, i.e.
  `UNUSUAL_MULTIPLIER`) was therefore kept as-is.
- Tests: `auto_pay_threshold outlier robustness (B1)` — outlier fixture (safe `10` threshold + alert
  fires), all-identical pool, and `minPayments`-after-exclusion.
- **Fails without the fix:** reverting both `dropAmountOutliers(amounts, …)` calls to `amounts` →
  **3 failed / 137 passed** (safe-threshold, alert-fires, minPayments-remain).

### B2 — `daily_limit` cap invariant
- Extracted one shared `computeAutoApproveThreshold(p90, max, context, decimals)` helper used by both the
  `auto_pay_threshold` path and the `daily_limit` fallback. It rounds up, never exceeds the rounded-up
  maximum, and clamps to `rule.perTxLimit` (reporting `capped`/`capDisplay`).
- `dailyLimitSuggestion` now clamps its fallback to `rule.perTxLimit`, carries an existing `perTxLimit`
  into the draft, and appends "capped at your existing on-chain per-transaction limit of …" to the
  rationale. A pure `isRuleDraftOrdered` check enforces `0 <= autoApproveLimit <= perTxLimit <= dailyLimit`
  and drops a draft that cannot satisfy it.
- Test: rule `{perTxLimit:"15"}` with p90 `18.4` → draft `{autoApproveLimit:"15", perTxLimit:"15",
  dailyLimit:"60"}`; plus a rule-ordering drop test.
- **Fails without the fix:** uncapping the fallback and dropping the per-tx carry → **3 failed / 137
  passed** (both B2 tests, plus the malformed-rule hygiene test).

### B3 — recurrence `firstRunAt` strictly in the future
- New bounded `advanceFirstRunAt(lastTs, interval, now)`: starts at `lastTs + interval` and advances by
  whole intervals while `<= now` (loop bounded by `MAX_FIRST_RUN_ADVANCE_STEPS`, arithmetic fallback).
- Zero/negative-amount recurrences are skipped (`medianAmount <= 0n`) so no `"0"` schedule draft is
  proposed. The existing weekly test now expects `NOW + 7d`.
- Tests: weekly recurrence ending 16 days ago → `firstRunAt > now`; zero-amount recurrence → no schedule.
- **Fails without the fix:** `firstRunAt = lastTs + interval` → **2 failed / 138 passed**; removing the
  zero-amount guard → **1 failed / 139 passed**.

### Jitter boundary
- Added exact-10 % (accepted: intervals 19s/20s/21s, range 2s, mean 20s) and just-over-10 % (rejected:
  9s/10s/10s, ≈10.34 %) fixtures.
- **Fails without the fix:** jitter reject `>` → `>=` → **1 failed / 139 passed** (exact-10 % rejected).

### Dormant over-firing
- `SuggestContext` gained optional `autoPayEnabledSince` and `lastAutoPayUse` (hint for confidential
  auto-pay usage the engine cannot see). `tighten_dormant` fires only when auto-pay has been enabled for
  more than `DORMANT_DAYS`; without `autoPayEnabledSince` it does **not** claim "never used" (conservative).
  The most recent of visible `pay_executor` history and the hint is used as "last used".
- Tests: enabled 40 days with no use fires; no `autoPayEnabledSince` does not; just-enabled does not;
  recent `lastAutoPayUse` hint suppresses; old hint fires.
- **Fails without the fix:** reverting to the old "never used always fires" logic → **2 failed / 138
  passed**.

### Data hygiene
- History is de-duplicated by `id` (first occurrence kept) inside `guard()`.
- `toLlmSafeEvidence` returns a deep copy (`structuredClone`) of evidence and proposal.
- Removed the dead `MAX_SCHEDULE_RUNS` constant; `runs = DEFAULT_SCHEDULE_RUNS` (12).
- Malformed rule strings no longer throw out of `suggest()`: rule amounts are parsed with a non-throwing
  `tryParseAmount` and only the affected suggestion kind is dropped. `SuggestInputError` +
  `validateSuggestContext()` are exposed for callers that want to fail loudly at a trust boundary.
- Tests: de-dup count, deep-copy mutation isolation, malformed `perTxLimit`/`dailyLimit` no-throw +
  per-kind drop, typed validator.
- **Fails without the fix:** removing de-dup → **1 failed**; returning evidence by reference →
  **1 failed**; making `tryParseAmount` throw → **3 failed**.

### Privacy wording (docs updated separately)
- Added to `Suggestion.title`/`rationale` doc comments: **"LOCAL-UI ONLY: may contain
  aliases/addresses; send ONLY `toLlmSafeEvidence(...)` to an LLM."**
- Confidential auto-pay usage is not visible to the engine (public-only guard); `context.lastAutoPayUse`
  is the accepted caller hint.

### Final gates (this worktree)
- `npm run check -w @polaris/stellar` → passes (tsc, 0 errors).
- `npm run test:suggest -w @polaris/stellar` → **4 files / 140 tests passed** (was 121).
- `npm test -w @polaris/stellar` → keeper **67**, anchor **111**, suggest **140** (**318** total), all green.

## Review fixes 2 (T3, 2026-09-19)

Applied the blocking B1-residual correction and the cheap, clearly-correct non-blocking items from
`backlog/suggest-engine-review-2.md`. Scope: `stellar/src/suggest/**` (code + tests) and this report
only; no network, no commit/push/add. "Fails without the fix" was proven by temporarily reverting the
daily fallback once, running the committed suite, and restoring (verified no `TEMP_REVERT` remained).

### B1-residual — `daily_limit` required `autoApproveLimit` was derived from the full pool
- Extracted a single source of truth, `deriveRobustThreshold(records, context, resolved)`, returning
  `{ pool, thresholdRaw, capped, capDisplay, stats }` (the robust pool + the rounded/clamped
  threshold). It owns the `thresholdPool` → `dropAmountOutliers(…, UNUSUAL_MULTIPLIER)` →
  `minPayments` floor → `computeAutoApproveThreshold` chain.
- `autoPayThresholdSuggestion` and the `daily_limit` fallback now **both** call it; there is no second
  threshold derivation anywhere. The daily fallback is only derived when `rule.autoApproveLimit` is
  absent (an existing threshold is carried verbatim), and if no robust value survives the suggestion
  is dropped rather than filled from the full pool.
- Repro (`9 = 8×10 + 1×1000`, no rule): before → `autoApproveLimit:"1000"`; after → `"10"`. The daily
  suggestion is dropped for `8 = 7×10 + 1×1000` (robust pool 7 < `minPayments`), since no threshold
  can be carried.
- Decision on `dailyLimit` itself: the review allowed either robustifying `dailyTotals` or documenting
  the deliberate full-pool inclusion. Chosen: **document** (comment in `suggest.ts`). An exceptional
  *day* is a real aggregate spend; the p95-of-active-days is already a robust order statistic, and
  excluding the day would under-set the mandate. Evidence (`dailyMedian`/`p95DailyTotal`/`dailyMax`)
  therefore stays full-pool; only the auto-approve fallback is robust. Flagged here for the reviewer.
- Tests (`daily_limit outlier robustness (B1-residual)`, 5 new):
  1. 9-record single-outlier repro → `autoApproveLimit === "10"` (and equals the `auto_pay_threshold`
     proposal; never `"1000"`).
  2. 8-record fixture with robust pool < `minPayments` → both `auto_pay_threshold` and `daily_limit`
     dropped.
  3. 10 records + two outliers → `"10"`.
  4. 11 records + two outliers → `"10"`.
  5. Seeded property test over **300 histories**: every `RuleDraft` in any suggestion satisfies
     `0 <= autoApproveLimit <= roundUp5(max of the robust pool)`, `autoApproveLimit <= perTxLimit <=
     dailyLimit` (when present), and never exceeds an existing `rule.perTxLimit`; proposals are
     JSON-safe. The generator produced **297/300** histories with suggestions and exercised **586**
     `RuleDraft`s (assertion `> 50`).
- **Fails without the fix:** reverting the daily fallback to full-pool `computeAutoApproveThreshold` →
  **5 failed / 140 passed** (all five new tests).

### Non-blocking items applied
- `stats.ts`: documented the majority-outlier limit of `dropAmountOutliers` (median contamination when
  > half the records are "outliers"; the roundUp5(max) bound still holds).
- `suggest.ts`: documented that `unusual_payment_alert`'s `evidence.p90` is deliberately the robust
  baseline while `median`/`max`/`count` stay full-pool.

### Non-blocking items skipped (with reason)
- **`tighten_dormant` needs `autoPayEnabledSince`**: intended conservative behaviour; already documented
  in `types.ts` `SuggestContext`. Called out here for the UI/seam owner (fresh install on 30 d history
  gets no dormant nudge until the caller supplies it).
- **Ordering-suppressed valid daily cap**: a friendlier rationale-visible drop would need a new seam
  field/behaviour; out of scope for a correctness fix. Left to the UI owner.
- **`evidence.lastUsedDays` == `unusedDays`** (design §6.3 says "last-used date"): cosmetic and changing
  the shape would ripple through the seam; left for the unification pass.
- **Bounded-loop cost**: `advanceFirstRunAt`'s arithmetic fallback could be tried first, but the loop is
  already bounded and fully tested, and the change is a non-observable micro-optimization; kept as-is to
  keep the diff focused.

### Final gates (after fixes)
- `npm run check -w @polaris/stellar` → passes (tsc, 0 errors).
- `npm run test:suggest -w @polaris/stellar` → **4 files / 145 tests passed** (was 140).
- `npm test -w @polaris/stellar` → keeper **67**, anchor **111**, suggest **145** (**323** total), all
  green.
