# Review: suggestions engine (T3)

- **Date:** 2026-09-19
- **Reviewer:** W-review-T3 (DeepSeek v4.1 Flash, L4) — did not write the code
- **Branch/worktree under review:** `review/suggest-engine` == `chain/suggest-engine` (HEAD `4ad1d05`), last 2 commits `d1bb44e` (engine) + `4ad1d05` (report)
- **Spec:** T3 brief; `docs/approval-and-scheduling.md` §6/§11; `docs/interfaces.md` §6.1
- **Method:** read-only + a throwaway scratch test with an independent oracle; 6 source mutations applied and reverted; all gates re-run.

## Verdict: approve with corrections

The engine is pure, deterministic, timezone-independent and the statistics/rounding are correct against an independent oracle. Three safety-relevant defects (outlier threshold, daily-limit cap invariant, past `firstRunAt`) must be fixed before this becomes the UI's proposal source.

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
      Tests  121 passed (121)
```
`npm test -w @polaris/stellar`:
```
ℹ tests 67
ℹ pass 67
ℹ fail 0
 Test Files  5 passed (5)
      Tests  111 passed (111)
 Test Files  4 passed (4)
      Tests  121 passed (121)
```
**Confirmed:** keeper 67 + anchor 111 + suggest 121 = **299**. The worker's claimed numbers are exact.

## 2. Oracle results (tables)

Independent oracle written from scratch (nearest-rank defined as "smallest value whose cumulative share ≥ p%"; median with integer mean of middles). Result: **all PASS**.

| Check | Cases | Result |
|---|---|---|
| `percentileNearestRank` vs oracle | n=1, n=2, n=3, even/odd, duplicates, all-equal | PASS |
| `percentileNearestRank` vs oracle | 1000 random arrays, n∈[1,60], p∈{1,50,90,95,100} | PASS |
| `median` vs oracle | odd, even, duplicates, all-equal | PASS |
| worked example p90 | 13th of 14 = `18.4` | PASS |
| p95 daily total | `38` | PASS |
| `dailyTotals` bucketing | UTC, `Europe/Berlin` spring-forward, `America/New_York` fall-back, `Asia/Kolkata` +05:30, 23:59:59 / 00:00:00 local midnight | PASS |
| bigint near i128 max | format/round/daily-sum, no `e`/`Infinity` | PASS |
| rounding table (0, 1, 4.9999999, 5, 5.0000001, 19.9999999, 20, 57, 60.0000001) × decimals {0,2,7} | round UP, exact multiples unchanged | PASS |
| process timezone | `TZ=UTC` vs `TZ=Pacific/Kiritimati`, `context.timeZone="Australia/Eucla"` | **identical JSON** (PASS) |
| purity scan | no `Date.now`, `new Date()`, `Math.random`, `process.`, `fs`, `node:`, network in non-test code; `Number()`/`parseFloat` absent from the money path | PASS |

The only `Math.*`/`new Date` in non-test code are `new Date(unixSeconds*1000)` + `Intl` with an **explicit** timeZone (`stats.ts:69`), integer arithmetic on counts (`stats.ts:25,100,118`), and `cadenceDays.toFixed(1)` in a rationale string (`suggest.ts:380`) — none touch a money value. `Number.isInteger` in `amount.ts` is validation of small integers only. No floats in the money path.

## 3. Adversarial histories (input | proposal | acceptable?)

| Input | Proposal | Acceptable? |
|---|---|---|
| 9 payments: 8×`10`, 1×`1000` (in 7-day window), span 8d | `auto_pay_threshold` p90=**1000**, autoApproveLimit=**1000**, `unusual_payment_alert` **none** | **NO — blocking #1** |
| 11 payments: 10×`10`, 1×`1000` | threshold `10`, unusual alert fires | yes |
| 10 payments all `13` | threshold `15`, no unusual | yes |
| confidential/private/failed `9999` mixed into 9×`10` | excluded everywhere (max stays `10`, no alert, no schedule) | yes |
| `knownContacts={a0,a1,a2}` + 3 recurrent payments to `GUNKNOWN999` | threshold count=3 (contacts only); `schedule_from_recurrence` recipient=`GUNKNOWN999` | yes (approval-gated) — see non-blocking |
| bursty day 4×`10` same day (others `2`) | dailyMax `40`, dailyLimit `60` | yes |
| 3 weekly payments ending 16d ago | `firstRunAt = now − 9d` (**in the past**) | **NO — blocking #3** |
| 3 zero-amount recurrent payments | `schedule_from_recurrence` amount `"0"` | undesirable — non-blocking |
| duplicated record ids (9× same id) | count=9, evidence inflated | data-integrity risk (T4) — non-blocking |
| future-dated record `ts = now + 5d` | excluded | yes |
| 200 seeded random histories, shuffled order | deep-equal, output order-independent | yes |

## 4. Blocking issues (exact fix each)

**B1 — `auto_pay_threshold` can auto-approve up to an outlier.** For `n ≤ 9` the nearest-rank p90 **is the maximum** (`stats.ts:20-28`; e.g. n=9 → rank 9). A single `1000` among eight `10`s therefore yields `p90 = 1000` and the engine proposes `autoApproveLimit = 1000` (`suggest.ts:188-196`), while `unusual_payment_alert` cannot fire because `3×p90 = 3000` (`suggest.ts:459-465`). This is exactly the "unusual payment through unattended" case the brief asks to flag. The `≤ roundUp5(max)` clamp (`suggest.ts:195`) does not help because p90 already equals max.
*Fix:* before deriving the threshold, drop outliers from the pool (`amountRaw > UNUSUAL_MULTIPLIER × p90`), or cap the proposal at `min(roundUp5(p90), roundUp5(median) × K)`, or require `count > 10` for the threshold kind. Add a regression test with the 9-record outlier fixture.

**B2 — `daily_limit` draft violates `auto_approve_limit ≤ per_tx_limit`.** When a rule has `perTxLimit` but no `autoApproveLimit`, `dailyLimitSuggestion` falls back to `roundUp5(p90)` with no cap (`suggest.ts:279-289`). Repro: rule `{perTxLimit:"15"}`, p90=18.4 → draft `autoApproveLimit:"20"` > 15. The `auto_pay_threshold` path caps correctly (`suggest.ts:200-208`); the daily path does not, and its rationale never mentions a cap. The daily draft also omits `perTxLimit`, so applying it can drop the existing per-tx cap.
*Fix:* in `dailyLimitSuggestion`, parse `rule.perTxLimit`, clamp the fallback to it (and set `capped`/rationale), and carry `perTxLimit` into the draft when the rule has one. Reuse one helper for both kinds.

**B3 — `schedule_from_recurrence.firstRunAt` can be in the past.** `firstRunAt = last.ts + interval` (`suggest.ts:358`). A weekly recurrence ending 16 days ago (still inside the 30-day window) yields `firstRunAt = now − 9d`. Accepting that draft would create an on-chain schedule whose first run is already due, so the next keeper tick settles an unattended payment immediately.
*Fix:* advance to the first regular slot strictly after `now`, e.g. `firstRunAt = last.ts + interval; while (firstRunAt <= now) firstRunAt += interval;` (or at minimum `Math.max(last.ts + interval, now + interval)`). Add a regression test.

## 5. Non-blocking

- **`tighten_dormant` over-fires on "never used".** `neverUsed` bypasses the `> DORMANT_DAYS` test (`suggest.ts:427-430`), so enabling auto-pay immediately yields "no pay_executor payment was used in the last 30 days → revoke". `SuggestContext` has no `autoPayEnabledSince`, so the engine cannot distinguish "just enabled" from "idle 31 days". Consider requiring `windowDays > DORMANT_DAYS` and no usage before firing.
- **`tighten_dormant` ignores confidential auto-pay.** Eligible records are `public` only (`suggest.ts:80-97`), so a user whose only `pay_executor` usage is confidential/private is told auto-pay is unused. Document or add a caller-supplied "last auto-pay used" hint.
- **Test gap — jitter boundary.** No committed test pins jitter **exactly** 10 %; mutation (e) escaped the suite (see §6). Add the `[19,21]`-second 3-occurrence fixture.
- **`knownContacts` only restricts the threshold pool.** Recurrence/daily/unusual still consider unknown recipients. Acceptable because every non-threshold suggestion is approval-gated, but the §6.3 wording ("payments to known contacts") does not apply uniformly.
- **Zero-amount schedule.** `schedule_from_recurrence` has no `amountRaw > 0` guard (`suggest.ts:346-372`); a `"0"` amount draft is proposed.
- **Duplicate record ids** are not de-duplicated (`suggest.ts:80-97`), inflating counts/percentiles and potentially emitting duplicate `unusual_payment_alert` ids. T4's responsibility, but the engine could defensively dedupe by id.
- **`toLlmSafeEvidence` returns the evidence object by reference** (`suggest.ts:542-548`), not a copy. No privacy impact (evidence has no identifiers), but a caller mutating it mutates the suggestion.
- **`title`/`rationale` do contain recipient aliases/addresses** for `schedule_from_recurrence` (`suggest.ts:360,377-381`) and `tighten_dormant`/`unusual` contain no ids. This is fine **only if** the UI sends `toLlmSafeEvidence` (never `title`/`rationale`) to the LLM; the docs should state this explicitly since the LLM "may phrase from these".
- **`MAX_SCHEDULE_RUNS = 52` is unreachable** while `DEFAULT_SCHEDULE_RUNS = 12` (`suggest.ts:357`); harmless dead constant.
- `parseAmount` throws on malformed `rule.perTxLimit`/`dailyLimit` strings — the pure engine is not defensive against a bad rule (input-contract assumption).

## 6. Mutation results

Each mutation applied to non-test source, targeted tests run, then `git checkout -- <file>`.

| # | Mutation | Caught by committed tests? | Which test |
|---|---|---|---|
| a | nearest-rank → linear interpolation (`stats.ts`) | **YES** | `stats.test.ts` 4 fail; `suggest.test.ts` 4 fail |
| b | rounding ceil → floor (`amount.ts:69-73`) | **YES** | `amount.test.ts` 3 fail; `suggest.test.ts` 4 fail |
| c | include `status:"failed"` records (`suggest.ts` guard) | **YES** | `suggest.test.ts:117` "ignores failed records" |
| d | drop the `rule.perTxLimit` cap (`suggest.ts:204`) | **YES** | `suggest.test.ts:167` "is capped by the rule per_tx_limit" |
| e | recurrence jitter `<=` → `<` (`suggest.ts:340`) | **NO** | committed suite passed (49/49); only the reviewer's exact-10 % boundary test caught it |
| f | let confidential/private feed suggestions (`suggest.ts` guard) | **YES** | `suggest.test.ts` "ignores confidential records" + "ignores private records" (2) |

Working tree confirmed clean after all six (`git diff --stat` empty).

## 7. Gaps vs design doc

- **§6.3 trigger not enforced.** `auto_pay_threshold` is described as "payments … **cluster under** a p90"; the implementation never checks clustering (B1).
- **§6.3 `unusual_payment_alert` for n ≤ 9** is self-defeating: the outlier is inside the p90 it is compared against, so no alert (B1).
- **§11c `DisableAutoPay` shape.** The engine emits `{kind:"disable_auto_pay", confirmation:"light"}` (`types.ts:101-104`), not the canonical `{steps, summary, confirmation:"light"}`. The report flags it as a reduced "describes the change" copy; still a divergence to reconcile at merge.
- **`NoChange`** is a fourth change shape not in §6.3/`interfaces.md` §6.1 (`RuleDraft | ScheduleDraft | DisableAutoPay`). The worker flagged it; the seam decision is still open.
- **Structural copies** (`RuleView`, `RuleDraft`, `ScheduleDraft`, `DisableAutoPay`) are all marked `structural copy; unify when branches merge` (`types.ts:49,65,79,96`) — good, and this base genuinely has no guard/payments exports to import.
- **Privacy split** (§6.6) is implemented correctly via `toLlmSafeEvidence`, but §6.6/`interfaces.md` should name that `title`/`rationale` are local-UI-only.
- **Scope/hygiene:** changed files are exactly the allowed set (`stellar/src/suggest/**`, `stellar/src/index.ts`, `stellar/package.json`, `backlog/suggest-engine.md`); `index.ts` adds only the `suggest` namespace; `package.json` adds only `test:suggest` (+ append to `test`); no `S[A-Z2-7]{55}` secrets; no `Buffer`/`node:`; constants live in one PROPOSED `constants.ts`. All PASS.
- **Seam fidelity:** `Suggestion`/`RuleDraft` match `docs/interfaces.md` §6.1 (flat camelCase, decimal strings; `autoApproveLimit` required). Every output is `JSON.stringify`-safe (no bigint leaks) — verified. `ScheduleDraft` is not defined in §6.1; the field set is reasonable but should be registered there.
