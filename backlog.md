# backlog.md — Master Index of Unfinished Work

> This file is the **master index of all unfinished / handed-off work.**
> Every worker and sub-agent writes unfinished work as a detailed report in `backlog/<task-name>.md`
> and adds a single-line entry here. **Goal: never lose track of any task.**
> All entries and reports are written in **English**.
>
> Index row format:
> `| Date | Task | Worker/Agent | Status | Report | Priority |`

## Open Tasks

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | **A0 — harness**: global hotkey (press/release) + microphone capture to WAV + wire both into the existing log pane; delete the temporary `dev_self_test` command | Owner A | open — live work: [PR #14](https://github.com/n0tnow/StellarVoiceControlProject/pull/14) on `feat/a0-push-to-talk-notch` (superseded the closed PR #6; rescue copy preserved on `rescue/a0-harness` (`7a024a6`)) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |

## Round-2 Reports (2026-09-19)

> Index of the round-2 worker reports. PRs #10 (`a8c4416`), #9 (`259dbe9`) and #11 (`a01d6a1`)
> merged 2026-09-19, so `backlog/guard-rules-schedule.md`, `backlog/keeper.md` and
> `backlog/anchor-sep6.md` are already on `main`; `backlog/rule-types-docs.md` lands with PR #8
> (independent, awaiting Owner A review). The rescued #5/#6 reports land with this docs PR.
> See `backlog/2026-09-19-closed-prs-and-round2-plan.md`.

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Anchor SEP-6 client (deposit + withdraw) with explain-log — round-2 hardening complete | Owner B / W4, W4b | merged 2026-09-19 — [PR #11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`; resolved the shared files and completed the unified test wiring) | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md) | P0 |
| 2026-09-19 | Off-chain keeper triggering due `polaris_guard` schedules | Owner B / W3 | merged 2026-09-19 — [PR #9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`) | [`backlog/keeper.md`](backlog/keeper.md) | P1 |
| 2026-09-19 | On-chain rule engine + scheduler for `polaris_guard` (testnet deployment) | Owner B / W1 | merged 2026-09-19 — [PR #10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`) | [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) | P1 |
| 2026-09-19 | Rule/schedule types, guard ABI and 2026-09-19 decisions | Owner B / W5 | open (draft) — [PR #8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8) (awaits Owner A review) | [`backlog/rule-types-docs.md`](backlog/rule-types-docs.md) (file lands with PR #8) | P1 |
| 2026-09-19 | A0 — push-to-talk harness (report rescued) | Owner A | closed unmerged — [PR #6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6); preserved on `rescue/a0-harness` (`7a024a6`) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |
| 2026-09-19 | Model ladder restore (local-only; report rescued) | coordinating agent | closed unmerged — [PR #5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5); preserved on `rescue/model-ladder-restore` (`4ac06b0`) | [`backlog/2026-09-19-model-ladder-restore.md`](backlog/2026-09-19-model-ladder-restore.md) | P2 |

## Round-3 Reports (2026-09-19)

> Reports produced for the round-3 plan below. All three are **local until this docs PR merges**.
> Decisions they feed (D1–D8) are recorded in `docs/confidential-payments.md` and `notes.md`.

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Contracts audit (DeepSeek L2) — `polaris_guard` v0.1 findings F-01…F-12, N-01…N-03 | opencode-go/deepseek-v4.1-flash (L2) | done — local until this PR merges | [`backlog/contracts-audit.md`](backlog/contracts-audit.md) | P1 |
| 2026-09-19 | Independent review of the contracts audit (DeepSeek L4) — accepted with corrections | opencode-go/deepseek-v4.1-flash (L4) | done — local until this PR merges | [`backlog/contracts-audit-review.md`](backlog/contracts-audit-review.md) | P1 |
| 2026-09-19 | Slice gap analysis — interfaces drift, chain/voice gaps, minimal slice S1–S10 | opencode-go/deepseek-v4.1-flash (L2) | done — local until this PR merges | [`backlog/2026-09-19-slice-gap-analysis.md`](backlog/2026-09-19-slice-gap-analysis.md) | P1 |

## Round-3 Plan (2026-09-19)

> Order and decisions: `docs/confidential-payments.md` §9 (D1), `sprints.md` (M2b / M3b).

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Chain-lane headless slice: real `sendPayment` ChainTool + `polaris_guard` owner-side TS client + headless e2e (`Intent → XDR → sign → submit`, `#105` rejection) | Owner B / worker TBD | planned (next after integration pause) | [`backlog/2026-09-19-slice-gap-analysis.md`](backlog/2026-09-19-slice-gap-analysis.md) | P0 |
| 2026-09-19 | Confidential-payments **CT spike** (2h cap, testnet, after slice) | worker TBD | planned | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P1 (after slice) |
| 2026-09-19 | Confidential-payments **SPP spike** (2h cap, testnet, after CT) | worker TBD | planned | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P2 |
| 2026-09-19 | `polaris_guard` **v0.2 hardening** as a **new crate `polaris_guard_v2`** (single new deployment, after slice works) | worker TBD | planned | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | Read-only verify of the deployed wasm hash on-chain (`stellar contract fetch` + sha256 vs `DEPLOYED.md`) | worker TBD | planned | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | **Interface drift fixes**: wrong Rust mirror path in `interfaces/src/index.ts`; `SigningService.sign(payloadHash)` vs `Signer.signTransaction(xdr)` (**PROPOSED: standardise on XDR**); missing `withdraw` kind | Owner A (agreement) | planned | [`docs/interfaces.md`](docs/interfaces.md) §7 | P1 (needs Owner A) |
| 2026-09-19 | README stale on A2 (still calls it "mock/Anthropic") | docs worker | planned | [`README.md`](README.md) | P2 |
| 2026-09-19 | Doc-only fixes: `contracts/scripts/demo.sh:81` comment (F-09) + `stellar/src/keeper/README.md:146` error example (F-10) | docs worker (W-docs) | done in this PR | [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md) §Known limitations | — |
| 2026-09-19 | Cleanup of merged worktrees/branches | coordinating agent | planned | — | P3 |
| 2026-09-19 | `.gitignore` `node_modules/` (trailing slash) does not match a `node_modules` **symlink** | coordinating agent | planned | [`backlog/contracts-audit-review.md`](backlog/contracts-audit-review.md) §4 | P3 |
| 2026-09-19 | **T1 — approval policy + profiles**: `approvalPolicy` routing (`always_ask` \| `auto_under_limit`), profile→on-chain mapping, `enableAutoPay(draft)` (three unsigned calls + ONE combined summary, safe order `approve` → `set_rule` → `set_executor` per D13), `buildBaselineSetup()`, `buildTightenRule()`, `disableAutoPay()` | Owner B | planned | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3, §9, §11 | P0 |
| 2026-09-19 | **T2 — schedule tools**: `schedulePayment`, `cancelSchedule`, `listSchedules` ChainTools + explicit-timezone local→UTC helper | Owner B | planned | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §5, §9 | P0 |
| 2026-09-19 | **T3 — suggestions engine**: pure `suggest()` + fixtures + tests (`stellar/src/suggest/`, PLANNED) | Owner B | planned | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6, §9 | P2 |
| 2026-09-19 | **T4 — history readers**: local encrypted history store + Horizon/`Paid` events reader | Owner B | planned | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6, §9 | P2 |
| 2026-09-19 | **T5 — UI**: Settings "Security" profiles, "Upcoming payments" list with Cancel, suggestions panel with Accept/Dismiss, auto-pay enable card | Owner A | planned | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3–§5, §9 | P1 |
| 2026-09-19 | **T6 — demo runbook**: keeper start/rehearse/verify, scheduled-payment demo, approval-profile demo | Owner B | skeleton in this PR; complete after T1/T2/T5 | [`docs/demo-runbook.md`](docs/demo-runbook.md) | P1 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
| 2026-09-19 | Owner B: fill in `stellar/` (anchor SEP-10/38/6 client, `sendPayment` tool) — stubs threw `NotImplementedError` | Owner B | [#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`), [#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`), [#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`) merged 2026-09-19 | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md), [`backlog/keeper.md`](backlog/keeper.md), [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) |
| 2026-09-19 | Monorepo skeleton: `interfaces/`, `agent/`, `app/` (Tauri v2 + React), `stellar/`, `contracts/` (Soroban), tooling (`Makefile`, `scripts/`, `VERSION`, `CHANGELOG.md`) | coordinating agent (no workers, per user instruction) | [PR #4](https://github.com/n0tnow/StellarVoiceControlProject/pull/4) (merged 2026-09-19T12:01:56Z, commit `a559403`) | `backlog/2026-09-19-monorepo-skeleton.md` |

---

## Sub-Report Template — `backlog/<task-name>.md`

```markdown
# Report: <task-name>
- **Date:** YYYY-MM-DD
- **Worker/Agent:** <name/model>
- **Branch/Worktree:** <branch>
- **PR:** <link or "none">

## Completed
- ...

## Unfinished (handed off)
- ...

## Blockers
- ...

## Review Notes
- ...

## Suggested Next Step
- ...
```
