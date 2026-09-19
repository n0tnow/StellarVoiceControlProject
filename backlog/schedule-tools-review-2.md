# Delta re-review: T2 fixes — schedule tools (mandatory allowance, error mapping, golden ABI)

- **Date:** 2026-09-19
- **Reviewer:** W-review-T2b (opencode-go/deepseek-v4.1-flash, L4; fresh session, did **not** write these fixes)
- **Branch / worktree:** `review/schedule-tools-2` == `chain/schedule-tools` @ `53e185b`
  (`.worktrees/schedule-tools-review2`)
- **Delta:** `53e185b` (`fix(stellar): mandatory allowance check …`) vs `98797ed`; previous review
  `backlog/schedule-tools-review.md`; fix brief `brief-t2-fix.md`; design
  `docs/approval-and-scheduling.md` (read-only); contract ground truth
  `contracts/polaris_guard/src/lib.rs` (read-only) + guard fixture
  `stellar/src/guard/__tests__/fixtures/polaris_guard.spec.json`.

## Verdict: approve

Every blocking item from the prior review is fixed and independently reproduced: the allowance
reader is mandatory at compile time (`TS2741`) and at runtime (`not_configured` with the promised
message), the XLM/skip paths are gone, `listUpcoming` maps guard errors, and the new golden ABI
test is a genuine byte-for-byte check that two deliberate encoding drifts both fail. All four
mutation tests are caught; the previous per-file count drift is corrected. Remaining items are
non-blocking.

---

## 1. Numbers re-run (verbatim)

| Gate | Worker claim | Re-run (this worktree) | Match |
|---|---|---|---|
| `npm run check -w @polaris/stellar` | clean | `tsc -p tsconfig.json` → no diagnostics (`EXIT=0`) | yes |
| `npm run test:schedule -w @polaris/stellar` | 121/121 | `Test Files  5 passed (5)` / `Tests  121 passed (121)` | yes |
| `npm test` — keeper | 67/0 | `ℹ tests 67` / `ℹ pass 67` / `ℹ fail 0` | yes |
| `npm test` — anchor | 111 | `Test Files  5 passed (5)` / `Tests  111 passed (111)` | yes |
| `npm test` — payments | 113 | `Test Files  6 passed (6)` / `Tests  113 passed (113)` | yes |
| `npm test` — guard | 133 | `Test Files  7 passed (7)` / `Tests  133 passed (133)` | yes |
| `npm test` — schedule | 121 | `Test Files  5 passed (5)` / `Tests  121 passed (121)` | yes |

Full `npm test -w @polaris/stellar` = **545 passed, 0 failed** (67 + 111 + 113 + 133 + 121) —
matches the report exactly.

Per-file schedule counts re-measured file-by-file (`vitest run <file>`), all matching
`backlog/schedule-tools.md`: `time 28`, `schedulePayment 51`, `cancelSchedule 17`,
`listUpcoming 21`, `abi-golden 4` = **121** (the old 24/47/48 drift is fixed).

## 2. Mandatory-allowance verification

- **Compile-time required.** A scratch file declaring `const d: ScheduleDeps = { … }` with the
  full shape but **no** `getAllowance` made `tsc` fail:
  `zz-review-mandatory.scratch.test.ts(3,14): error TS2741: Property 'getAllowance' is missing …
  but required in type 'ScheduleDeps'`. The field is non-optional at `types.ts:96`; the scratch
  file was removed.
- **Runtime refusal.** `schedulePayment.ts:235-240` refuses `ScheduleRefusal("not_configured")`
  with the exact promised text *"the SAC allowance is mandatory for every guard payment; inject
  getAllowance"*. `schedulePayment.test.ts:161-170` deletes the field from a JS object and asserts
  the code + both message fragments. Reproduced independently (scratch): `ORDER-ATTACK:
  not_configured`.
- **No skip path.** `grep getAllowance` in `stellar/src/schedule/**` finds only the construction
  guard, the mandatory call at `schedulePayment.ts:298`, the type, docs and tests. The old
  `if (typeof deps.getAllowance === "function")` wrapper is gone; the check always runs. The only
  remaining `typeof … "function"` guards are for `guard.createSchedule`/`cancelSchedule`/
  `listSchedules`/`assets.get`, not the allowance.
- **XLM included.** `schedulePayment.test.ts:181-197` injects a reader that records the SAC id and
  returns `0n`, and asserts `allowance_insufficient` with `seen == [XLM_SAC]` — native XLM is not
  exempt.
- **Equality / off-by-one / overflow.** Equality `amount × runs` is accepted
  (`schedulePayment.test.ts:139`); one raw unit less is refused with `neededRaw`/`availableRaw`
  (`:148`). Scratch check: `amount = 922337203685.4775807` (int64 max stroops) × `runs = 2^32-1`
  yields the exact `neededRaw` via BigInt with no overflow; accepted when the reader returns it,
  refused when it returns `needed − 1n`.
- **Pre-check order unchanged.** rule → asset → per_tx → count → allowance, each short-circuiting
  (`schedulePayment.ts:250-308`); covered by `schedulePayment.test.ts:398-466` (rule before
  count, per-tx before count, count before allowance) plus the `#100 → guard_rule_missing` test.
- **Attack — rule missing AND reader missing.** The reader check is at **construction**, before
  the async body, so `schedulePayment(deps)` throws `not_configured` before the rule is ever read.
  This is sensible (the tool cannot function at all without the mandatory reader) and documented
  in the refusal table (`backlog/schedule-tools.md` §Refusals: `not_configured` … "thrown at tool
  construction"). It does **not** reorder the five value pre-checks, which still run in the
  documented order.

## 3. Break attempts (input | expected | actual | result)

| Input / attack | Expected | Actual | Result |
|---|---|---|---|
| `ScheduleDeps` object without `getAllowance` (tsc) | compile error | `TS2741 Property 'getAllowance' is missing` | PASS |
| `deps.getAllowance` deleted (JS caller) | `not_configured` + message | `not_configured`; message contains "SAC allowance is mandatory" + "getAllowance" | PASS |
| rule missing **and** reader missing | reader refusal first | `not_configured` at construction (before any rule read) | PASS |
| XLM with short allowance | same check as any asset | `allowance_insufficient`; reader called with `XLM_SAC` | PASS |
| allowance `== amount × runs` | accepted | accepted | PASS |
| allowance `== amount × runs − 1` | refused | `allowance_insufficient`, correct `neededRaw` | PASS |
| max-stroop amount × `U32_MAX` runs | no overflow/TypeError | exact BigInt product; accept/refuse by comparison | PASS |
| `listUpcoming` guard `Error(Contract, #100)` | `guard_rule_missing` | `ScheduleRefusal guard_rule_missing`, `details.guardErrorName = NotConfigured` | PASS |
| `listUpcoming` token error `#5` | typed, never raw `TypeError` | `GuardClientError` (`SacAuthentication`, code 5), rethrown | PASS |
| `listUpcoming` non-Error object throw | typed, never raw `TypeError` | `GuardClientError` (`name Error`, kind rpc) | PASS |
| `listUpcoming` string throw | typed, never raw `TypeError` | `GuardClientError` (`name Error`, kind rpc) | PASS |
| `parseFirstRun` field `null` / number / object / array | `invalid_time`, no cast-driven `TypeError` | `invalid_time` for all four | PASS |
| DST oracle: Berlin 2026-03-29 02:30 / NY 2026-03-08 02:30 | `time_does_not_exist` | `time_does_not_exist` | PASS |
| DST oracle: Berlin 2026-10-25 02:30 / NY 2026-11-01 01:30 | earlier instant + `ambiguous` | `2026-10-25T00:30:00Z` / `2026-11-01T05:30:00Z`, `ambiguous:true` | PASS |
| prototype keys, non-string inputs, 25-cap, ambiguity (regression) | still pass | full schedule suite 121/121; `schedulePayment.test.ts:306/312`, `:420`; `cancelSchedule.test.ts:66` | PASS |

## 4. Golden ABI test verification

`stellar/src/schedule/__tests__/abi-golden.test.ts` loads
`../../guard/__tests__/fixtures/polaris_guard.spec.json` with `readFileSync` (the **only** file
read outside tests is none — `grep readFileSync|node:fs` in `stellar/src/schedule/**` matches the
test file only), builds `new contract.Spec(fixture.specEntries)`, and compares the base64 XDR of
`invokedCall(res.unsignedXdr).args` against `spec.funcArgsToScVals(fn, {…})` for four cases:
one-shot `create_schedule`, weekly `604800 × 8`, the u64/`runs` boundary
(`9999-12-31 23:59` UTC × `runs = U32_MAX`), and `cancel_schedule`. It is a real spec-derived
expectation vs. tool-produced invocation, not a self-comparison.

Two deliberate mutations (temporary, reverted with `git checkout --`):

| Mutation | Result |
|---|---|
| swap `interval_secs`/`runs` in the `createSchedule` builder (`schedulePayment.ts:313-321`) | **caught** — 3 create tests fail (cancel passes) |
| encode `first_run_at` as u32 (`guard/client.ts:189`, `scU64` → `scU32`) | **caught** — 3 create tests fail; boundary throws `invalid value (253402300740) for type u32` |

Fixture path resolves from this package (the test passes in the normal run). No non-test module
reads files.

*Non-blocking observation:* unlike `guard/__tests__/abi-golden.test.ts:48`, this test does not pin
`fixture.wasmSha256`; the guard test pins the same committed fixture, so a swap is still caught by
the full suite.

## 5. Blocking issues (exact fix each) — or none

**None.** The single blocking item from `backlog/schedule-tools-review.md` (mandatory allowance)
is fixed at both compile and run time, the XLM exception is removed, and no code path skips the
check.

## 6. Non-blocking

1. **Golden test does not pin `wasmSha256`.** Add the same sha assertion as the guard golden test
   (or share a helper) so a fixture swap is caught even when the schedule test runs in isolation.
2. **Single `ScheduleDeps` forces read-only tools to carry the mandatory reader.**
   `cancelSchedule`/`listUpcoming` never call `getAllowance`, yet the required field is on the
   shared interface; app bootstrap must supply it for listing/cancel. This is exactly what the fix
   brief mandated, so it is accepted — a `Pick`/split interface could be a later ergonomic tidy.
3. **Allowance pre-check is per-schedule only** (`amount × runs`), not against the owner's total
   outstanding schedules; the design's "size it to cover all schedules" is an app/bootstrap
   responsibility. Pre-existing, unchanged by this delta.
4. **`runs` omitted = 1** and **"failing/retrying" not modelled** remain as documented agent/UI
   hand-offs (tool doc comment, `types.ts:47`, `types.ts:140`, `backlog/schedule-tools.md`); claims
   are accurate.

## 7. Mutation results

Each mutation applied to source, targeted suite run, then reverted with `git checkout -- <file>`.

| # | Mutation | File | Target suite | Test failed? |
|---|---|---|---|---|
| a | remove the mandatory-allowance runtime refusal | `schedulePayment.ts:233-240` | `schedulePayment.test.ts` | **YES** (1: "refuses with not_configured when the allowance reader is missing") |
| b | allowance `<` → `<=` | `schedulePayment.ts:302` | `schedulePayment.test.ts` | **YES** (1: equality boundary) |
| c | `listUpcoming` delayed `<` → `<=` | `listUpcoming.ts:69` | `listUpcoming.test.ts` | **YES** (2: exact `2×poll` boundary + injected poll) |
| d | skip `listUpcoming` error mapping (drop try/catch) | `listUpcoming.ts:86-91` | `listUpcoming.test.ts` | **YES** (1: guard-error translation) |
| e | swap `interval_secs`/`runs` in the builder | `schedulePayment.ts:313-321` | `abi-golden.test.ts` | **YES** (3 of 4) |
| f | encode `first_run_at` as u32 | `guard/client.ts:189` (temporary) | `abi-golden.test.ts` | **YES** (3 of 4) |

**6 of 6 caught.** Post-revert `npm run check` is clean and `test:schedule` is 121/121; the working
tree shows no tracked modifications (only the allowed review file is added).

DONE T2-review-2
