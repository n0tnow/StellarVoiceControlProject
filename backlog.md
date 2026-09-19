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

## Chain-Lane Reports (2026-09-19 / 2026-09-20)

> Worker reports and independent reviews for the chain-lane modules. All are
> **merged via the chain-lane PR** (`integration/chain-lane`); the pre-PR gate is
> [`backlog/final-gate-chain-lane.md`](backlog/final-gate-chain-lane.md). Each report carries
> its own review trail.

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | C1 — real `sendPayment` ChainTool: `Intent` → unsigned XDR + decoded summary, alias book (D1 step 1) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/send-payment.md`](backlog/send-payment.md) | P0 |
| 2026-09-19 | C2 — owner/executor-side `polaris_guard` TS client + SAC allowance + `guarded` route (D1 step 2) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/guard-client.md`](backlog/guard-client.md) | P0 |
| 2026-09-19 | T1 — approval profiles + `enableAutoPay` / baseline / tighten / disable builders (D10/D10b/D10c/D13) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/approval-policy.md`](backlog/approval-policy.md) | P0 |
| 2026-09-19 | T2 — schedule tools: `schedulePayment`, `cancelSchedule`, `listUpcoming` + local→UTC helper | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/schedule-tools.md`](backlog/schedule-tools.md) | P0 |
| 2026-09-19 | T3 — deterministic, offline suggestions engine (D11) | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/suggest-engine.md`](backlog/suggest-engine.md) | P2 |
| 2026-09-19 | C3 — live TESTNET end-to-end run, S0–S11 (D1 step 3); found and fixed `tx_too_early` | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/e2e-testnet.md`](backlog/e2e-testnet.md) | P0 |
| 2026-09-20 | Manual tooling `e2e:tool` / `e2e:status`, uniform timeouts, strict `y`/`yes` gate, manual-testing README | DeepSeek v4.1 Flash (L2) | done — merged via the chain-lane PR | [`backlog/e2e-polish.md`](backlog/e2e-polish.md) | P0 |
| 2026-09-19 | Integration verification of the merged chain-lane branch (offline cross-module flow, hygiene) | DeepSeek v4.1 Flash (L4 independent) | done — merged via the chain-lane PR | [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) | P1 |
| 2026-09-20 | Final pre-PR gate: scope vs `main`, offline gates, hygiene, PR-ready summary | DeepSeek v4.1 Flash (L4 independent) | done — merged via the chain-lane PR | [`backlog/final-gate-chain-lane.md`](backlog/final-gate-chain-lane.md) | P0 |
| 2026-09-19 | Review — send-payment (found the `resolveAlias` prototype defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/send-payment-review.md`](backlog/send-payment-review.md) | P0 |
| 2026-09-19 | Review 2 (delta) — send-payment fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/send-payment-review-2.md`](backlog/send-payment-review-2.md) | P0 |
| 2026-09-19 | Review — guard-client; reject (blocking `setRule` ABI encoding defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/guard-client-review.md`](backlog/guard-client-review.md) | P0 |
| 2026-09-19 | Review 2 (delta) — guard-client ABI fix; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/guard-client-review-2.md`](backlog/guard-client-review-2.md) | P0 |
| 2026-09-19 | Review — approval-policy; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review.md`](backlog/approval-policy-review.md) | P0 |
| 2026-09-19 | Review 2 — approval-policy T1-fix delta; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review-2.md`](backlog/approval-policy-review-2.md) | P0 |
| 2026-09-19 | Review 3 — approval-policy T1 correction (fix2); approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/approval-policy-review-3.md`](backlog/approval-policy-review-3.md) | P0 |
| 2026-09-19 | Review — schedule-tools; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/schedule-tools-review.md`](backlog/schedule-tools-review.md) | P0 |
| 2026-09-19 | Delta re-review — schedule-tools fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/schedule-tools-review-2.md`](backlog/schedule-tools-review-2.md) | P0 |
| 2026-09-19 | Review — suggest-engine; approve with corrections (outlier threshold defect) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review.md`](backlog/suggest-engine-review.md) | P2 |
| 2026-09-19 | Review 2 (delta) — suggest-engine fixes; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review-2.md`](backlog/suggest-engine-review-2.md) | P2 |
| 2026-09-19 | Review 3 (final delta) — suggest-engine residual fix; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/suggest-engine-review-3.md`](backlog/suggest-engine-review-3.md) | P2 |
| 2026-09-20 | Review — live TESTNET run + live-adapter security; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-testnet-review.md`](backlog/e2e-testnet-review.md) | P0 |
| 2026-09-20 | Review — e2e-polish; approve with corrections (B1/B2/B3) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-polish-review.md`](backlog/e2e-polish-review.md) | P0 |
| 2026-09-20 | Review 2 (delta) — e2e-polish fixes; approve with corrections (4/4 mutations caught) | DeepSeek v4.1 Flash (L4 independent) | done | [`backlog/e2e-polish-review-2.md`](backlog/e2e-polish-review-2.md) | P0 |

## Docs-Plan Reviews (2026-09-19)

> Independent reviews of the design/docs plan; already on `main` via
> [PR #17](https://github.com/n0tnow/StellarVoiceControlProject/pull/17).

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Review — docs plan; approve with corrections (personal name + N-03 flag) | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review.md`](backlog/docs-plan-review.md) | P1 |
| 2026-09-19 | Review 2 (delta) — docs-plan fixes; approve | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review-2.md`](backlog/docs-plan-review-2.md) | P1 |
| 2026-09-19 | Review 3 — approval/scheduling docs + D9; approve with corrections | DeepSeek v4.1 Flash (L4 independent) | done — merged 2026-09-19 via PR #17 | [`backlog/docs-plan-review-3.md`](backlog/docs-plan-review-3.md) | P1 |

## Round-3 Plan (2026-09-19)

> Order and decisions: `docs/confidential-payments.md` §9 (D1), `sprints.md` (M2b / M3b).

| Date | Task | Worker/Agent | Status | Report | Priority |
|---|---|---|---|---|---|
| 2026-09-19 | Confidential-payments **CT integration** — spike done on local branch `spike/ct` (GO/NO-GO report local-only); integration pending | worker TBD | open (spike done — see `notes.md` 2026-09-20) | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P1 |
| 2026-09-19 | Confidential-payments **SPP integration** — spike done on local branch `spike/spp` (GO/NO-GO report local-only); integration pending | worker TBD | open (spike done — see `notes.md` 2026-09-20) | [`backlog/confidential-payments.md`](backlog/confidential-payments.md) | P2 |
| 2026-09-19 | `polaris_guard` **v0.2 hardening** as a **new crate `polaris_guard_v2`** (single new deployment) | worker TBD | parked | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | Read-only verify of the deployed wasm hash on-chain (`stellar contract fetch` + sha256 vs `DEPLOYED.md`) | worker TBD | planned | [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md) | P2 |
| 2026-09-19 | **Interface drift fixes**: wrong Rust mirror path in `interfaces/src/index.ts`; `SigningService.sign(payloadHash)` vs `Signer.signTransaction(xdr)` (**PROPOSED: standardise on XDR**); missing `withdraw` kind | Owner A (agreement) | planned | [`docs/interfaces.md`](docs/interfaces.md) §7 | P1 (needs Owner A) |
| 2026-09-19 | README refresh: A2 still called "mock/Anthropic"; reflect the current codebase (constitution requirement) | docs worker | planned | [`README.md`](README.md) | P2 |
| 2026-09-19 | Doc-only fixes: `contracts/scripts/demo.sh:81` comment (F-09) + `stellar/src/keeper/README.md:146` error example (F-10) | docs worker (W-docs) | done in this PR | [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md) §Known limitations | — |
| 2026-09-19 | Cleanup of merged worktrees/branches | coordinating agent | planned | — | P3 |
| 2026-09-19 | `.gitignore` `node_modules/` (trailing slash) does not match a `node_modules` **symlink** | coordinating agent | planned | [`backlog/contracts-audit-review.md`](backlog/contracts-audit-review.md) §4 | P3 |
| 2026-09-19 | **T4 — history readers**: local encrypted history store + Horizon/`Paid` events reader | Owner B | open | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6, §9 | P2 |
| 2026-09-19 | **T5 — UI**: Settings "Security" profiles, "Upcoming payments" list with Cancel, suggestions panel with Accept/Dismiss, auto-pay enable card | Owner A | open | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3–§5, §9 | P1 |
| 2026-09-19 | **T6 — demo runbook execution**: keeper start/rehearse/verify, scheduled-payment demo, approval-profile demo (skeleton written) | Owner B | open — complete after T1/T2/T5 | [`docs/demo-runbook.md`](docs/demo-runbook.md) | P1 |
| 2026-09-19 | **Passkey wallet integration** (bonus, after M4 items) | worker TBD | open | [`docs/architecture.md`](docs/architecture.md) | P3 |
| 2026-09-19 | **Keeper hosting decision (D12)** — same-Mac demo vs always-on server | coordinating agent | open (PROPOSED — needs user confirmation) | [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7 | P2 |
| 2026-09-20 | `e2e:tool` non-blocking notes: prototype-named flags accepted; `RpcTimeoutError` alias mislabel; symlinked-dir `chmod` case | worker TBD | open | [`backlog/e2e-polish-review-2.md`](backlog/e2e-polish-review-2.md) | P3 |
| 2026-09-20 | `describeValue` duplicate cleanup: export the guard helper, delete the approval copy (`TODO(T1-fix)`) | worker TBD | open | [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) §4 (D1) | P3 |
| 2026-09-20 | **Version tag `v0.2.0` candidate** — cut after the chain-lane PR merges (coordinator) | coordinating agent | open | [`CHANGELOG.md`](CHANGELOG.md) | P2 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
| 2026-09-19 | Owner B: fill in `stellar/` (anchor SEP-10/38/6 client, `sendPayment` tool) — stubs threw `NotImplementedError` | Owner B | [#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) (`a8c4416`), [#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) (`259dbe9`), [#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) (`a01d6a1`) merged 2026-09-19 | [`backlog/anchor-sep6.md`](backlog/anchor-sep6.md), [`backlog/keeper.md`](backlog/keeper.md), [`backlog/guard-rules-schedule.md`](backlog/guard-rules-schedule.md) |
| 2026-09-19 | Monorepo skeleton: `interfaces/`, `agent/`, `app/` (Tauri v2 + React), `stellar/`, `contracts/` (Soroban), tooling (`Makefile`, `scripts/`, `VERSION`, `CHANGELOG.md`) | coordinating agent (no workers, per user instruction) | [PR #4](https://github.com/n0tnow/StellarVoiceControlProject/pull/4) (merged 2026-09-19T12:01:56Z, commit `a559403`) | `backlog/2026-09-19-monorepo-skeleton.md` |
| 2026-09-20 | Chain-lane slice C1/C2/C3: real `sendPayment`, owner-side guard client, headless live TESTNET e2e (S0–S11) | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/send-payment.md`](backlog/send-payment.md), [`backlog/guard-client.md`](backlog/guard-client.md), [`backlog/e2e-testnet.md`](backlog/e2e-testnet.md), [`backlog/integration-chain-lane.md`](backlog/integration-chain-lane.md) |
| 2026-09-20 | T1 — approval policy + `enableAutoPay` / baseline / tighten / disable builders | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/approval-policy.md`](backlog/approval-policy.md), [`backlog/approval-policy-review-3.md`](backlog/approval-policy-review-3.md) |
| 2026-09-20 | T2 — schedule tools + local→UTC helper | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/schedule-tools.md`](backlog/schedule-tools.md), [`backlog/schedule-tools-review-2.md`](backlog/schedule-tools-review-2.md) |
| 2026-09-20 | T3 — deterministic, offline suggestions engine | Owner B | merged via the chain-lane PR (`integration/chain-lane`) | [`backlog/suggest-engine.md`](backlog/suggest-engine.md), [`backlog/suggest-engine-review-3.md`](backlog/suggest-engine-review-3.md) |

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
