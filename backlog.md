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
| 2026-09-19 | Owner B: fill in `stellar/` (anchor SEP-10/38/6 client, `sendPayment` tool) — stubs throw `NotImplementedError` today | Owner B | open | `backlog/2026-09-19-monorepo-skeleton.md` | P0 |
| 2026-09-19 | Modifier-gesture hardening: VoiceOver on/off toggle (needs a settings surface) + `NSWorkspace` sleep/lock force-stop | opencode worker | open | `backlog/2026-09-19-modifier-only-and-horizontal-expand.md` | P2 |
| 2026-09-19 | Review follow-ups: engine-side stuck-`recording` hardening (timeout→`Error` + `catch_unwind`) and WAV retention policy (owned by A1) | independent reviewer | open | `backlog/2026-09-19-a0-review.md` | P1 |

## Completed Tasks (Archive)

| Date | Task | Worker/Agent | Closed By | Report |
|---|---|---|---|---|
| 2026-09-19 | Monorepo skeleton: `interfaces/`, `agent/`, `app/` (Tauri v2 + React), `stellar/`, `contracts/` (Soroban), tooling (`Makefile`, `scripts/`, `VERSION`, `CHANGELOG.md`) | coordinating agent (no workers, per user instruction) | pending PR review | `backlog/2026-09-19-monorepo-skeleton.md` |
| 2026-09-19 | **A0 — push-to-talk + notch overlay**: global `control+option+space` hotkey, `cpal`→WAV capture, AppKit notch overlay driven by the event stream; `dev_self_test` deleted | opencode worker (deepseek-v4.1-flash) | pending PR review (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-a0-push-to-talk-notch.md` |
| 2026-09-19 | **Notch shape fix**: idle pill matches the measured cutout (179x32, was 199x36), four derived corner radii flow through the `NotchGeometry` seam, geometry-driven silhouette | opencode worker (deepseek-v4.1-flash) | pending user visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-notch-shape-fix.md` |
| 2026-09-19 | **Modifier-only Control+Option hold (default gesture) + horizontal-only expansion**: native `flagsChanged` latch with 300 ms arming, Command/Shift exclusion, Accessibility gate + preserved `Control+Option+Space` fallback, 1 s watchdog; notch height no longer transitions | opencode worker (deepseek-v4.1-flash) | pending user runtime/visual check (branch `feat/a0-push-to-talk-notch`) | `backlog/2026-09-19-modifier-only-and-horizontal-expand.md` |
| 2026-09-19 | **Independent review of A0**: verdict APPROVE — no blockers; 3 MAJOR follow-ups (VoiceOver letter-chord blind spot, wedged-driver stuck-`recording`, unbounded WAV growth), 3 MINOR, 5 NITs | independent reviewer | done (branch `review/a0`) | `backlog/2026-09-19-a0-review.md` |

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
