# W15e — Rules & Tasks pages: simple, voice-first, complete

## What / why
Make the notch Rules and Tasks pages match the "everything inside the notch" design: one
plain-language summary + one control, no panel windows, honest empty/loading/error states.

## Done
- **Rules** (`notch/rules/{RulesEditor,rulesModel,useRulesEditor}`): live plain-language
  summary, single **"Ask me only above [ n ] XLM"** + Save, and a text **Advanced** button
  revealing per-payment/per-day limits, saved-contacts-only and the full on-chain read-back.
  Save uses the existing auto-pay flow (`guard_policy` → `runAutoPaySetup`: executor setup
  automatic + ONE batch Touch ID); a blank/zero threshold means "always ask" (`normalizeForm`),
  and an armed rule gets a "Turn off automatic payments" text button.
- **Tasks** (`pages/TasksPage.tsx`, new `notch/tasks/{newSchedule,NewScheduleForm}`,
  `data/useTasksData.ts`): real schedules + Cancel, and a text **New schedule** button revealing
  To / Amount / Every / First run → Create through the same approval pipeline. Empty state is one
  line; demo rows now appear only outside Tauri.

## Decisions (honest deviations from the sketch)
- Summary says **XLM**, not USD: the rule's asset is the chain's native XLM (a USD figure would
  be invented data).
- **No "month" repeat**: the chain stores fixed-second intervals and refuses monthly; the select
  is One time / Day / Week.
- **Raw `G…` recipients refused**: `schedulePayment` accepts only alias names, so a pasted
  address is matched to a saved contact or refused in one sentence.
- Repeats use a finite run count (`REPEAT_RUNS = 8`); Rules step progress is the native batch
  card (one Rust gate), and the schedule libs have no pause, so Cancel is the only row action.

## Verification
- `npm run check -w @polaris/app` clean. `npm test -w @polaris/app`: **442 pass / 0 fail**
  (new `newSchedule.test.ts` + `normalizeForm`/`ruleSummary` cases). Rust untouched.
- Human-verify: real Touch ID batch + live `pay_executor`, real notch render, live create/list.

## Blocked / handoff
None. `useRulesData.ts`/`rulesView` left intact (still tested).
