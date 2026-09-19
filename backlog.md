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
| 2026-09-19 | **A0 — harness**: global hotkey (press/release) + microphone capture to WAV + wire both into the existing log pane; delete the temporary `dev_self_test` command | Owner A | open — [PR #6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6) closed unmerged; resume from `rescue/a0-harness` (`7a024a6`) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |
| 2026-09-19 | Owner B: fill in `stellar/` (anchor SEP-10/38/6 client, `sendPayment` tool) — stubs throw `NotImplementedError` today | Owner B | merged 2026-09-19 — [#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`), [#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`), [#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`) | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md), [`backlog/keeper.md`](backlog/keeper.md), [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) | P0 |

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
| 2026-09-19 | Rule/schedule types, guard ABI and 2026-09-19 decisions | Owner B / W5 | open (draft) — [PR #8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8) (awaits Owner A review) | [`backlog/rule-types-docs.md`](backlog/rule-types-docs.md) | P1 |
| 2026-09-19 | A0 — push-to-talk harness (report rescued) | Owner A | closed unmerged — [PR #6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6); preserved on `rescue/a0-harness` (`7a024a6`) | [`backlog/2026-09-19-a0-harness.md`](backlog/2026-09-19-a0-harness.md) | P0 |
| 2026-09-19 | Model ladder restore (local-only; report rescued) | coordinating agent | closed unmerged — [PR #5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5); preserved on `rescue/model-ladder-restore` (`4ac06b0`) | [`backlog/2026-09-19-model-ladder-restore.md`](backlog/2026-09-19-model-ladder-restore.md) | P2 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
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
