# Report: w11b-autopay-ui
- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/w11b-autopay-ui` / `.worktrees/w11b-autopay`
- **PR:** none (coordinator commits)

## Completed
- `app/src/lib/autopay.ts` (pure): `buildAutoPayPlan` (D13 order: executor create/fund → approve → set_rule → set_executor LAST → aliases; defaults per-tx 2×, daily 10×, asset XLM, known-recipients true; `always_ask` = revoke-executor disable path), `decideAutoPayRoute` (fail-closed table incl. daily remaining + app hard cap), `mapAutoPayError` (#103–#107, #116 → one sentence), `batchViewFromPlan`.
- `app/src/lib/autopayLive.ts`: injectable invoke wrappers for `executor_status/create/sign_pay` + `approval_begin_batch/authorize_batch`, `isAutoPaySupported` feature detection, `runAutoPaySetup` (executor create → build plan → ONE batch approval → sign/submit each step).
- `app/src/lib/autopayWiring.ts`: real composition — `runGuardPolicySetup` (voice **and** Rules page) and `tryAutoPaySend` (guarded `pay_executor` via `executor_sign_pay`, no card; `null` ⇒ normal owner path; records `approvalMode: "auto"` on the running History turn).
- `app/src/lib/chain.ts`: `guard_policy` proposals now run the setup; `send` tries the auto route first (small/additive).
- Batch approval UI: `approval.ts` gains optional `batch` snapshot + `authorizeBatch`; `BatchApprovalCard.tsx`; `ApprovalPanel.tsx` renders it (single-item card untouched).
- Functional Rules page: `notch/rules/{rulesModel.ts,useRulesEditor.ts,RulesEditor.tsx}` + rewired `RulesPage.tsx` (status/limits/asset/executor+fees/contacts N of M/spent-today, save/sync/disable through the same batch flow).
- Debug check `app/src/debug/checks/autopay.ts` (warn when not armed); live proof `scripts/e2e-autopay.mjs` + root `e2e:autopay`; docs/backlog/sprints notes.

## Tests / verification
- `npm run check` (all workspaces) green; `npm run build -w @polaris/app` green.
- `npm test -w @polaris/app` 441/0; `npm test -w @polaris/agent` 213/0; `npm test -w @polaris/stellar` all suites green (guard/approval/suggest/p2p/live).
- Live `npm run e2e:autopay`: approve `43284404`, set_rule `2c79cfef`, set_executor `245b78a7`, set_alias `d7e3ba05`, **pay_executor 1 XLM (no card) `ca6f5d16` SUCCESS**, 15 XLM `REJECTED #105 NeedsOwnerApproval`, pay_owner 5 XLM `671d4340` SUCCESS (testnet explorer links in the script output).
- New node:test coverage: plan order/defaults/disable, routing table, error mapping, batch view (`autopay.test.ts`); command wiring + orchestrator fakes (`autopayLive.test.ts`).

## Decisions
- Setup runs through `runAutoPaySetup`/`runGuardPolicySetup` so voice and the Rules page share ONE batch card + ONE Touch ID.
- `approval_current` exposing `batch` is assumed (contract §W11a); the panel routes to `approval_authorize_batch` when present, else the single path.
- Allowance default = daily×7, 30 days (existing D10c default), rebuilt by the wiring.
- Batch steps are sequenced `base+1..base+N` up front; `lib/approval.ts` gained an additive optional `batch` field + `approvalAuthorizeBatch` wrapper (small scope extension).

## Blocked / handoff
- Rust W11a commands (`executor_*`, `approval_*_batch`) not in this branch: all auto-pay paths feature-detect and fall back (no silent payment, no crash). Batch-card rendering + live auto-pay need them (human verify: Touch ID, real Tauri runtime).
- `recordApprovalMode` patches the newest in-progress turn log entry because `turnSession`/`App.tsx` (outside scope) do not thread a turn id into `chain.ts`.
