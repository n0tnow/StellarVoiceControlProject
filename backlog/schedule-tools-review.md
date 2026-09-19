# Review: T2 — schedule tools + local→UTC time conversion

- **Date:** 2026-09-19
- **Reviewer:** W-review-T2 (opencode-go/deepseek-v4.1-flash, L4; did **not** write the code)
- **Branch / worktree:** `review/schedule-tools` == `chain/schedule-tools` @ `cb1dbed`
  (`.worktrees/schedule-tools-review`)
- **Under review:** `c458df4` (feat: schedule tools) + `cb1dbed` (docs: worker report)
- **Spec:** `brief-t2-schedule.md`; design `docs/approval-and-scheduling.md` §5 / §11b;
  contract ground truth `contracts/polaris_guard/src/lib.rs` (read-only)

## Verdict: approve with corrections

The time conversion is correct on a full-year, multi-zone independent oracle (0 mismatches),
every XDR is decoded and asserted against the contract ABI, hostile input never escapes as a
raw `TypeError`, and all four gates reproduce the worker's numbers exactly. One design
conformance gap must be fixed before merge (mandatory SAC allowance, §4); the rest are
non-blocking.

---

## 1. Numbers re-run (verbatim)

| Gate | Worker claim | Re-run | Match |
|---|---|---|---|
| `npm run check -w @polaris/stellar` | clean | `tsc -p tsconfig.json` → no diagnostics | yes |
| `npm run test:schedule -w @polaris/stellar` | 111/111 | `Test Files 4 passed (4)` / `Tests 111 passed (111)` | yes |
| `npm test -w @polaris/stellar` — keeper | 67/0 | `tests 67 / pass 67 / fail 0` | yes |
| `npm test` — anchor | 111 | `Tests 111 passed (111)` | yes |
| `npm test` — payments | 113 | `Tests 113 passed (113)` | yes |
| `npm test` — guard | 113 | `Tests 113 passed (113)` | yes |
| `npm test` — schedule | 111 | `Tests 111 passed (111)` | yes |

Total **515 passed, 0 failed** — matches. Per-file counts on `backlog/schedule-tools.md:132-138`
are **wrong** (report table says `time 24`, `schedulePayment 47`; actual, measured file-by-file:
`time 28`, `schedulePayment 48`, `cancelSchedule 17`, `listUpcoming 18` = 111). The stated
*Total 111* is correct; only the two per-file rows drifted.

## 2. DST / time oracle results

Independent scratch harness (removed): `Intl`-derived 2026 transitions, a brute-force
minute-resolution oracle over a ±16 h window (every epoch mapping to the requested wall), and a
full-year round-trip property. **42/42 passed, 0 mismatches.**

| Attack | Method | Result |
|---|---|---|
| Existing times → exact UTC epoch | 7 zones × ~365 days at 03:37 local; format epoch back via a second `Intl` path | PASS |
| Spring-forward gap refused `time_does_not_exist` | Berlin `2026-03-29 02:30`, NY `2026-03-08 02:30`; `before`/`after` checked against oracle (`01:59:59+01:00` / `03:00:00+02:00`, `01:59:59-05:00` / `03:00:00-04:00`) | PASS |
| Fall-back overlap → **earlier** instant + `ambiguous:true` | Berlin `2026-10-25 02:30` → `2026-10-25T00:30:00Z`; NY `2026-11-01 01:30` → `05:30:00Z`; oracle confirms 2 instants and earlier wins | PASS |
| 15-min steps around **every** 2026 transition | Berlin, New York, Lord Howe (30-min DST), Chatham; transitions discovered from the tz DB, not hard-coded | PASS |
| Full-year fuzz, exotic zones | 24 zones (Kiritimati +14, Marquesas −9:30, Eucla +8:45, St_Johns, Kathmandu, Adelaide, Casablanca, Apia, …) × 50 random 2026 walls vs brute force | PASS (1200 samples) |
| `minLeadSeconds` boundary | `now+59 s` → `time_in_past`; `now+60 s` → accepted (`time.ts:245` uses strict `<`, so exactly the lead is accepted; covered by `time.test.ts:135`) | PASS |
| Invalid inputs | `2026-02-30`, `2026-13-01`, `24:00`, `12:60`, `""`, `2026-9-1`, non-string, `Mars/Olympus`, `2027-02-29`, year `10000` → all `invalid_time`; `2028-02-29` OK; `formatInZone(-1,"UTC")` → `1969-12-31T23:59:59+00:00` (no throw) | PASS |
| `hourCycle` pitfall | `hourCycle:"h23"` (`time.ts:61`) never emits `24:00`; midnight hour ∈ [0,23] in every probed zone | PASS |

Rounding note: `possibleInstants`/`findTransition` (`time.ts:101-135`) are second-accurate and
survived all transition probes. `formatInZone` floors sub-second input.

## 3. Break attempts (tool level)

| Input / attack | Expected | Actual | Result |
|---|---|---|---|
| `schedulePayment(draft)` with null/undefined/42/`"x"`/array/bool | typed refusal | `invalid_intent` / `unsupported_asset` (array) | PASS (no `TypeError`) |
| `recipient` = `constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty`, `prototype` | refused | `unknown_recipient` | PASS |
| `recipient` = raw `G...` (even a known alias's address) | refused | `unknown_recipient` | PASS |
| `amount` accepted set | `50`, `0.0000001`, `00010.5000000`, `922337203685.4775807` | accepted (pre-check bypassed with a huge rule) | PASS |
| `amount` rejected set | `0`, `0.0`, `-1`, `+1`, `1e2`, `1.12345678`, `" 1"`, `"1,5"`, `NaN`, `Infinity`, `""`, `50`(number), null, `{}` | `invalid_amount` | PASS |
| `customSeconds` = 0 / −1 / 1.5 / > `MAX_SAFE_INTEGER` / `"3600"` | refused | `unsupported_repeat` | PASS |
| `runs` = 0 / −1 / 1.5 / 2³² / `"8"` | refused | `invalid_intent` | PASS |
| one-shot with `runs:5`; `month`; `end_of_month` | refused | `unsupported_repeat` | PASS |
| XDR arg order/values | `create_schedule(owner,to,asset,amount,first_run_at,interval_secs,runs)` | decoded exactly; `interval_secs 0/604800/86400/custom`, `runs` u32, amount i128 | PASS |
| 25 active schedules / exactly 25 → refuses; 24 → allows | `too_many_schedules` at **≥ 25**, counts ACTIVE only (`schedulePayment.ts:272-279`) | PASS |
| allowance = `amount×runs` exactly | accepted | accepted | PASS |
| allowance − 1 raw | refused | `allowance_insufficient`, `details.neededRaw`, message "approve a larger allowance first" | PASS |
| `getAllowance` **absent** | design says allowance is mandatory | **silently skipped** | **FAIL (see §4)** |
| pre-check order | rule → asset → per_tx → count → allowance | exact order, each short-circuits; `NotConfigured #100` → `guard_rule_missing` | PASS |
| cancel: null/string/`{which}`/bad id/bad `which` | typed | `invalid_intent` / `unknown_recipient` | PASS |
| cancel: prototype-key recipient; unknown alias | refused | `unknown_recipient` | PASS |
| cancel: 2 matches, no `which` | never guess | `ScheduleAmbiguous` with candidates | PASS |
| cancel: `which:"next"`/`"last"`, incl. tie on `next_run_at` | earliest / latest, tie → id | deterministic | PASS |
| cancel: another owner's id / cancelled / finished | `schedule_not_found` | `schedule_not_found` (only `listSchedules(owner)` is consulted) | PASS |
| `confirmation` | `"light"` | `"light"` | PASS |
| listUpcoming due/delayed boundary | `<2 polls` due, `≥2 polls` delayed | `-29 s` due, `-30 s` delayed; injectable poll | PASS |
| listUpcoming two aliases → one address | deterministic | picks lexicographically first (`internal.ts:78` sorts keys) | PASS |
| listUpcoming unknown address / unknown SAC | `null` / raw SAC id | PASS | PASS |
| listUpcoming amounts | no floats | `fromRawUnits` string, `amountRaw` string | PASS |
| summary decoded from XDR (not intent) | `Total: 150 USDC (3 × 50)` etc. | PASS | PASS |

## 4. Blocking issues

1. **The SAC allowance pre-check is optional and silently skipped** when `deps.getAllowance` is
   not injected; the corrected normative rule is that the allowance is **MANDATORY for every
   guard payment** (`docs/approval-and-scheduling.md` §2 "Normative rule — the allowance is
   mandatory", §11e). Code: `stellar/src/schedule/types.ts:88` (`getAllowance?`),
   `stellar/src/schedule/schedulePayment.ts:282` (`if (typeof deps.getAllowance === "function")`),
   documented as intentional at `backlog/schedule-tools.md:103-105` ("runs only when
   `deps.getAllowance` is injected; otherwise it is skipped … for XLM the app may legitimately
   not inject it").
   **Exact fix:** make the reader required in `ScheduleDeps` (or, if it must remain injectable,
   refuse `not_configured` with a message like *"the SAC allowance is mandatory for every guard
   payment; inject `getAllowance`"* when it is absent). Remove the XLM exception — native XLM
   settles through the same SEP-41 `approve`/`transfer_from` path, so it is not exempt. Update
   `backlog/schedule-tools.md` §"Allowance / XLM note" and add a test asserting the refusal when
   the reader is missing.

## 5. Non-blocking

- **Report per-file counts are wrong** (`backlog/schedule-tools.md:132-138`): `time 24 → 28`,
  `schedulePayment 47 → 48`; total 111 is right. Fix the table.
- **`DEFAULT_POLL_SECONDS` is not used by its consumer:** exported at `schedulePayment.ts:30`
  but `listUpcoming.ts:64` hard-codes `?? 15`. Import the constant (or move it to a shared
  module) so the default cannot drift.
- **`listUpcoming` does not translate guard read errors** (`listUpcoming.ts:73`): a
  `GuardClientError` from `listSchedules` propagates raw, unlike `schedulePayment`/`cancelSchedule`
  which map through `scheduleRefusalFromGuard`. Still typed and non-`TypeError`, but inconsistent.
- **`parseFirstRun` type-lies:** `schedulePayment.ts:85-87` casts non-strings with `as never`
  and relies on `resolveLocalTime` to reject them. Correct behaviour (verified), but the casts
  erase the compile-time check for no benefit.
- **Design §5.7 status "failing/retrying" is not modelled** (`types.ts:132` only has
  scheduled/due/delayed/finished). Reasonable for offline data (F-12 requires keeper-side failure
  history the contract does not expose), but it is a real gap vs the UI contract; note it for T5.
- **A repeat with `runs` omitted silently becomes 1 run** (`schedulePayment.ts:114`) rather than
  the design's "ask for how many" (§11b). Safe default, but the agent layer must still ask; worth
  an explicit note in the tool docs.
- **Worker tests miss two exact boundaries** (confirmed by mutation, §6): allowance `==
  amount×runs` and the `→ delayed` at exactly `2 × poll`. Add explicit tests.
- The scratch oracle used `now = 2020` so all 2026 samples were future; the `time_in_past` +
  DST combination is covered only indirectly.

## 6. Mutation results

Each mutation applied to source, targeted suite run, then reverted with `git checkout --`.

| # | Mutation | File | Target suite | Test failed? |
|---|---|---|---|---|
| a | fall-back picks the **later** instant (`instants[0]` → last) | `time.ts:240` | `time.test.ts` | **YES** (2: Berlin + NY overlap) |
| b | drop the spring-forward gap check (`if (false)`) | `time.ts:217` | time + schedulePayment | **YES** (3: both gaps + DST-gap draft) |
| c | 25-cap off-by-one (`>=` → `>`) | `schedulePayment.ts:273` | `schedulePayment.test.ts` | **YES** (2: cap + order) |
| d | weekly interval `604800` → `86400` | `schedulePayment.ts:39` | `schedulePayment.test.ts` | **YES** (1) |
| e | due/delayed `<` → `<=` | `listUpcoming.ts:56` | `listUpcoming.test.ts` | **YES** (1: injected poll) |
| f | allowance `<` → `<=` | `schedulePayment.ts:289` | `schedulePayment.test.ts` | **NO** — no exact-equality allowance test |

5 of 6 mutations caught; (f) is the boundary gap listed in §5.

## 7. Gaps vs design doc

- §2 / §11e **mandatory allowance** — not enforced (§4, blocking).
- §5.7 UI status **"failing/retrying"** — not modelled (non-blocking, no on-chain signal).
- §11b **default `runs` for "every X" = ask, never infinite** — the tool defaults to 1 instead
  of asking; the agent must resolve this before calling the tool (non-blocking).

**Verified-good items explicitly in scope:** T2 depends only on schedule-related client methods
(`getRule`, `listSchedules`, `getSchedule`/`nextScheduleId` unused, `createSchedule`,
`cancelSchedule`) plus `toRawUnits`/`describe`; it never touches `setRule`, so the concurrent
guard-client `setRule` ABI bug cannot affect it. No `scvMap` or loose XDR decode in T2 — the
summary is decoded through the shared `decodeInvocation`/`scValToNative` and asserted against
`contractId` + function name. No `Buffer`/`node:` in browser-safe modules, no hard-coded contract
ids, no secrets (`S[A-Z2-7]{55}`), no dead exports beyond the noted constant duplication.
`git diff HEAD~2 --stat` touches only the allowed paths; `stellar/src/index.ts` adds only the
`schedule` namespace; `stellar/package.json` adds only `test:schedule` (and appends it to `test`).
