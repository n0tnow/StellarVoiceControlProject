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
