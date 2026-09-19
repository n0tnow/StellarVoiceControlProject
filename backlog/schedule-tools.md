# Report: schedule-tools — `schedulePayment`, `cancelSchedule`, `listUpcoming` + local→UTC time helper

- **Date:** 2026-09-19
- **Worker/Agent:** W-T2 (opencode-go/deepseek-v4.1-flash, L2)
- **Branch/Worktree:** `chain/schedule-tools` / `.worktrees/schedule-tools` (based on `chain/guard-client`)
- **PR:** none (per task: no commit/push/tag)
- **Task:** `docs/approval-and-scheduling.md` §5 / `brief-t2-schedule.md`

## TL;DR

- Added `stellar/src/schedule/**`: a contract-id-parametrised client for unsigned
  `create_schedule` / `cancel_schedule`, an "Upcoming payments" projection, and a pure
  local-wall-clock → UTC epoch resolver with explicit IANA timezone.
- Drafts (`ScheduleDraft`) resolve the recipient **only** through the alias book (raw `G...`
  addresses and prototype keys are refused), validate amount like `payments`, and map
  `repeat` → fixed-second intervals (`day` 86400, `week` 604800, `custom`); `repeat` absent is
  a one-shot (`interval_secs 0, runs 1`). Monthly/end-of-month repeats are refused.
- Every summary is decoded from the produced XDR (function name + arg order), never from the
  intent text. Pre-checks run against the owner's on-chain rule, active-schedule count and the
  injected SAC-allowance reader, in the documented order.
- All tests are offline (fake RPC, injected allowance reader/clock). No network calls.
- **Gates green:** `check` clean; `test:schedule` **111/111**; full `test` =
  keeper 67 + anchor 111 + payments 113 + guard 113 + schedule 111 = **515 tests, 0 failures**.

## Completed

### New files — `stellar/src/schedule/`
| File | Purpose |
|---|---|
| `errors.ts` | `ScheduleRefusal { code, details }`, `ScheduleAmbiguous { code, candidates }`, `isScheduleRefusal` / `isScheduleAmbiguous` |
| `types.ts` | `ScheduleDraft`, `FirstRun`, `Repeat`, `ScheduleDeps`, `ResolvedLocalTime`, result/view-model types |
| `time.ts` | `resolveLocalTime`, `formatInZone`, `intervalWords`, `isValidTimeZone` — pure, dep-free beyond `Intl` |
| `summary.ts` | `buildCreateScheduleSummary`, `buildCancelScheduleSummary` — decode the XDR and render the approval card |
| `internal.ts` | dependency guards (`not_configured`), case-insensitive SAC lookup, guard-error → refusal mapping, own-key reverse alias map |
| `view.ts` | `assetCodeFor`, `nextRunUtc`, `candidateFor` (shared by cancel + list) |
| `schedulePayment.ts` | `schedulePayment(deps)(draft)`; `MAX_SCHEDULES = 25`, `DEFAULT_POLL_SECONDS = 15` |
| `cancelSchedule.ts` | `cancelSchedule(deps)({ id?, recipient?, which? })` |
| `listUpcoming.ts` | `listUpcoming(deps)({ now?, timeZone })` |
| `index.ts` | barrel for the `schedule` namespace |
| `__tests__/` | `helpers.ts`, `time.test.ts` (24), `schedulePayment.test.ts` (47), `cancelSchedule.test.ts` (17), `listUpcoming.test.ts` (18) |

### Modified
- `stellar/src/index.ts` — `export * as schedule from "./schedule/index.ts";` (nothing else).
- `stellar/package.json` — added `test:schedule`; appended it to `test`.
- `backlog/schedule-tools.md` — this report.

### Not touched (read-only imports)
`stellar/src/guard/**`, `stellar/src/payments/**` (aliases, asset registry, amount rules),
`stellar/src/keeper/**` (error-name table via guard), `contracts/**`, `interfaces/**`,
`agent/**`, `app/**`, docs, root files.

## API table

`Deps` = `{ ownerAddress, aliases, guard, assets, guardAssetContracts, networkPassphrase,
explorerBase?, now?, txTimeoutSeconds?, pollSeconds?, getAllowance? }`. `guard` is a
`createGuardClient` built with the deployed contract id (D9). `getAllowance(assetContractId)`
is an optional injected SAC-allowance reader (the guard client itself cannot read allowances).

| Tool | Chain call | Signer (tx source) | Returns |
|---|---|---|---|
| `schedulePayment(deps)(draft)` | `create_schedule(owner,to,asset,amount,first_run_at,interval_secs,runs)` | owner | `{ unsignedXdr, summary, payloadHash, warnings[] }` |
| `cancelSchedule(deps)({id?},{recipient?,which?})` | `cancel_schedule(owner,id)` | owner | `{ unsignedXdr, summary, payloadHash, confirmation:"light", id, recipientAlias }` |
| `listUpcoming(deps)({now?,timeZone})` | `list_schedules(owner)` (read) | — | `UpcomingPayment[]` sorted by next run |
| `resolveLocalTime({localDate,localTime,timeZone,now,minLeadSeconds})` | — (pure) | — | `{ epochSeconds, utcIso, localIso, offsetMinutes, ambiguous }` |
| `formatInZone(epochSeconds, timeZone)` | — (pure) | — | local ISO-8601 with offset |
| `intervalWords(seconds)` | — (pure) | — | e.g. `every week`, `one-shot (no repeat)` |

Draft → chain mapping: `repeat.every "day"` → `86400`; `"week"` → `604800`;
`"custom"` → `customSeconds`; `repeat` absent → `0` + `runs 1`. Recurring `runs` defaults to
1 when omitted. `amount` becomes raw units via `toRawUnits` (7 decimals); `firstRunAt` is
`BigInt(epochSeconds)`; `asset` is the SAC contract id from `guardAssetContracts`
(case-insensitive).

## Refusal-code table

| Code | When | Notes |
|---|---|---|
| `invalid_intent` | draft/request not an object, missing target, bad `runs` | never a raw `TypeError` |
| `invalid_amount` | not positive / >7 dp / >12 int digits / > int64 / > i128 | same rule as `payments` |
| `unsupported_asset` | code not USDC/XLM, or no SAC id configured | XLM needs `guardAssetContracts.XLM` |
| `unknown_recipient` | empty/raw-address/prototype-key (`constructor`, `__proto__`) recipient | alias book only |
| `invalid_time` | bad zone/date/time, bad `now`/`minLeadSeconds` | |
| `time_does_not_exist` | DST spring-forward gap | `details.before` / `details.after` local ISO |
| `time_in_past` | at/inside `minLeadSeconds` of `now` | `details.minLeadSeconds` |
| `unsupported_repeat` | monthly/end-of-month, one-shot with many runs, bad custom | fixed-second intervals only |
| `guard_rule_missing` | no rule published, or `NotConfigured` (#100) | |
| `asset_not_allowed` | asset SAC not in `allowed_assets` | |
| `amount_over_per_tx_limit` | `amount > per_tx_limit` (`OverPerTxLimit`/`OverDailyLimit`) | |
| `too_many_schedules` | ≥25 active (`TooManySchedules` #114) | checked via `list_schedules` (active only) |
| `allowance_insufficient` | `available < amount × runs` | `details.neededRaw` / `availableRaw` |
| `schedule_not_found` | no active schedule by id/recipient | |
| `not_configured` | deps missing/null, no guard client | thrown at tool construction |

`ScheduleAmbiguous` (`code: "schedule_ambiguous"`) is thrown with `candidates[]` when >1 active
schedule matches a recipient and `which` was not given. Unmapped guard errors are rethrown as the
typed `GuardClientError` so the refusal-code set stays exactly the documented one.

### Pre-check order (`schedulePayment`)
local draft validation → time resolution → **1** rule exists → **2** asset allowed →
**3** `amount ≤ per_tx_limit` → **4** active count `< 25` → **5** allowance `≥ amount × runs`
→ build XDR. Each step short-circuits the later ones (covered by explicit order tests).

### Allowance / XLM note
The allowance pre-check runs only when `deps.getAllowance` is injected; otherwise it is skipped
(the guard client has no allowance method). For XLM the app may legitimately not inject it.

## DST behaviour table

`scheme` = `resolveLocalTime` result; `2026` transitions computed from `Intl` and asserted in tests.

| Zone | Case | 2026 instant | Result |
|---|---|---|---|
| `Europe/Berlin` | summer / winter | 2026-07-01 / 2026-01-15 | `+02:00` / `+01:00` |
| `Europe/Berlin` | spring gap | 2026-03-29 02:30 | `time_does_not_exist` → before `01:59:59+01:00`, after `03:00:00+02:00` |
| `Europe/Berlin` | fall overlap | 2026-10-25 02:30 | earlier instant `2026-10-25T00:30:00Z`, `ambiguous: true`, `+02:00` |
| `America/New_York` | spring gap | 2026-03-08 02:30 | `time_does_not_exist` → before `01:59:59-05:00`, after `03:00:00-04:00` |
| `America/New_York` | fall overlap | 2026-11-01 01:30 | earlier instant `2026-11-01T05:30:00Z`, `ambiguous: true`, `-04:00` |
| `Europe/Istanbul` | no DST | 2026-03-29 02:30 | valid, `+03:00` |
| `Asia/Kolkata` | half-hour | any | `+05:30`, `offsetMinutes 330` |
| `UTC` | zero offset | any | `+00:00` |

Fall-back ambiguity is surfaced as a **warning** on the approval card, not a refusal.

## Warnings (never block)
1. F-03 — schedules do not re-check `known_recipients_only` at run time.
2. Fall-back ambiguity — earlier instant chosen; double-check.
3. Daily limit — a single run `>= daily_limit` may be rejected at run time.
4. Keeper dependency — runs only while a keeper is online (~15–25 s after due).

## Tests (offline)

| File | Tests | Focus |
|---|---|---|
| `time.test.ts` | 24 | zone offsets, DST gap/overlap, past/lead, invalid input, `formatInZone`, `intervalWords` |
| `schedulePayment.test.ts` | 47 | arg order + decoded summary, repeat/one-shot mapping, warnings, full refusal matrix, pre-check order, XLM, contract-id, allowance |
| `cancelSchedule.test.ts` | 17 | by id / recipient, ambiguity + `which`, refusals, inactive exclusion, contract-id |
| `listUpcoming.test.ts` | 18 | view model, statuses with injected clock, poll override, sorting, validation |
| **Total** | **111** | every XDR is decoded; no network |

## Gates (final lines)

- `npm run check -w @polaris/stellar` → clean (no `tsc` diagnostics).
- `npm run test:schedule -w @polaris/stellar` → `Test Files 4 passed (4)` / `Tests 111 passed (111)`.
- `npm test -w @polaris/stellar` → keeper `tests 67 / pass 67 / fail 0`; anchor `111 passed`;
  payments `113 passed`; guard `113 passed`; schedule `111 passed` (515 total, 0 failures).

## Unfinished (handed off)
- **Live run:** nothing here was submitted; the e2e "create → keeper fires → cancel" demo on
  testnet (T6 runbook) is not run in this task.
- **Agent-side date parsing:** turning "tomorrow 15:00" into `localDate`/`localTime` +
  timezone is the agent's job (T2 takes explicit values; relative parsing is out of scope).
- **UI "Upcoming payments":** `listUpcoming` provides the view models; the list + Cancel button
  are Owner A's (T5).
- **Keeper hosting:** the "keeper online" dependency is warned about but not solved here (T6).
- **Allowance reader wiring:** the app must inject `deps.getAllowance` (wire to
  `guard.getAllowance(rpc, { assetContractId, from: owner, spender: guard.contractId, ... })`).

## Blockers
- None for the offline scope. A live run needs a funded testnet owner/keeper and a deployed
  `GUARD_CONTRACT_ID` + SAC ids (integration step).

## Review Notes
- `ScheduleDraft` has no schema in `docs/approval-and-scheduling.md`; the shape here follows the
  brief. **Assumption to confirm:** recurring `runs` defaults to 1 when omitted (safe: cannot
  overspend). Monthly repeats intentionally refused (`unsupported_repeat`).
- `ScheduleAmbiguous` is a separate class (code `"schedule_ambiguous"`), not a `ScheduleRefusal`
  code, matching the brief's `(+ ScheduleAmbiguous)`.
- `guard_client_error` was deliberately **not** added to the refusal union: unknown guard errors
  are rethrown as the already-typed `GuardClientError` instead.
- `cancelSchedule` with both `id` and `recipient` resolves by `id` (documented); `which` only
  applies to recipient matches.
- `listUpcoming.amountRaw` is a decimal string (JSON-safe), `asset` falls back to the raw SAC id
  when the code is not in `guardAssetContracts`.

## Suggested Next Step
- Wire the app bootstrap (`defaultScheduleDeps`) to a real `Horizon`/guard client + allowance
  reader, then run the T6 testnet demo (create a schedule, watch the keeper fire ~15–25 s after
  due, cancel a second one by recipient). Then T5 renders `listUpcoming` with a Cancel button.
