# Report: closed PRs #5/#6 and round-2 merge plan

- **Date:** 2026-09-19
- **Worker/Agent:** coordination docs worker (L3)
- **Branch/Worktree:** `docs/round2-status` @ `.worktrees/docs-round2`
- **PR:** docs PR opened from this branch (link in the coordinator hand-off)

## Closed unmerged PRs (#5, #6)

Both PRs were closed **unmerged** on 2026-09-19 with **no explanatory comment** (0 comments
on each PR):

| PR | Branch | Title | Closed at | Comments |
|---|---|---|---|---|
| [#5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5) | `fix/ladder-restore` | docs: record model ladder restore report | 2026-09-19T12:46:55Z | none |
| [#6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6) | `feat/a0-harness` | feat(a0): push-to-talk harness — global hotkey + microphone capture | 2026-09-19T12:46:54Z | none |

The work is **not lost**. It is preserved in local rescue branches:

| Rescue branch | Tip commit | Preserves |
|---|---|---|
| `rescue/a0-harness` | `7a024a6` | A0 push-to-talk harness code + `backlog/2026-09-19-a0-harness.md` |
| `rescue/model-ladder-restore` | `4ac06b0` | `backlog/2026-09-19-model-ladder-restore.md` (the model-ladder file itself is gitignored/local-only) |

The remote branches `origin/feat/a0-harness` and `origin/fix/ladder-restore` still exist; the local
feature branches were deleted. The rescue branches are local-only and were not pushed.

### How to resume

1. `git checkout -b feat/a0-harness-resume rescue/a0-harness` (same pattern for the ladder restore).
2. `git rebase main` and resolve conflicts (main has moved since; the monorepo skeleton `a559403`
   and round-2 work may touch the same files).
3. Push the branch and open a fresh PR against `main`; link the original PRs #5/#6 in the
   description and note that the reports were rescued into `backlog/`.

The rescued reports are now indexed in the root `backlog.md` under "Round-2 Reports (2026-09-19)":

- [`backlog/2026-09-19-a0-harness.md`](2026-09-19-a0-harness.md) (added by this docs PR; PR link
  inside corrected from `pull/5` to `pull/6`)
- [`backlog/2026-09-19-model-ladder-restore.md`](2026-09-19-model-ladder-restore.md) (added by
  this docs PR)

## Round-2 merge plan

**Merge order: `#8` → `#10` → `#9` → `#11` → docs PR (this one).**

| Order | PR | Branch | Title | Status (2026-09-19) |
|---|---|---|---|---|
| 1 | [#8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8) | `docs/rule-types-and-decisions` | docs: rule/schedule types, guard ABI and 2026-09-19 decisions | open (draft); **awaits Owner A review** — the only gate |
| 2 | [#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10) | `feat/guard-rules-schedule` | feat(guard): on-chain rule engine + scheduler for `polaris_guard`, deployed to testnet | open (draft); locally reviewed (`review-pr10` worktree); tests green per [`backlog/guard-rules-schedule.md`](guard-rules-schedule.md) |
| 3 | [#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9) | `feat/keeper` | feat(keeper): off-chain keeper that triggers due `polaris_guard` schedules | open (draft); first of the shared-file pair (`stellar/package.json`, `stellar/tsconfig.json`) to merge — no rebase needed if it lands here |
| 4 | [#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11) | `feat/anchor-sep6` | feat(anchor): SEP-6 anchor client (deposit + withdraw) with explain-log | open (draft); locally reviewed (`review-pr11`); 111/111 anchor tests green per [`backlog/anchor-sep6.md`](anchor-sep6.md); **rebases over #9** (shared files, see below) |
| 5 | docs PR | `docs/round2-status` | docs: round-2 status, rescued reports and merge plan | this PR; merges last so its index links resolve |

> PR [#7](https://github.com/n0tnow/StellarVoiceControlProject/pull/7) (notch research) is open and
> non-draft; it is **not** part of this plan and is unaffected by the merge order above.

### Shared-file rule (PR #9 ↔ PR #11)

PR #9 and PR #11 both change `stellar/package.json` and `stellar/tsconfig.json`.
**Whichever merges second rebases onto `main` and resolves the conflict as follows:**

- keeper keeps `node --test` **scoped to `src/keeper`** (`node --test "src/keeper/**/*.test.ts"`);
- anchor keeps `vitest` **scoped to `src/anchor`** (`test:anchor`);
- the combined `test` script (running both scopes) and the `scripts/check.sh` integration
  (a single entry point for all workspaces) land as a **small follow-up PR after both merge**.
  Do not cross-reference the other PR's scripts from either PR — they are not on `main` yet.

### Test-runner decision (interim)

- Interim rule: **per-PR scoped scripts only** (`node --test` for keeper, `vitest` for anchor).
- No cross-references between the PRs' scripts; neither PR's `test` script may invoke the other's
  runner or assume the other's source tree.
- The unified test entry point is the follow-up above, owned by the coordinator after #9 and #11
  are both on `main`.

### Cleanup items (pending, do after the corresponding merge)

- Worktrees to remove: `review-pr10`, `review-pr11` (both detached HEAD), `local-notes`
  (branch `chore/local-notes` already merged via
  [PR #1](https://github.com/n0tnow/StellarVoiceControlProject/pull/1)), and after their merges
  `anchor-sep6`, `guard-rules`, `keeper`, `rule-types-docs`, plus `docs-round2` (this one).
  Command: `git worktree remove .worktrees/<name>` (from the main clone).
- Local branches to delete after their PRs merge: `feat/anchor-sep6`, `feat/guard-rules-schedule`,
  `feat/keeper`, `docs/rule-types-and-decisions`, `docs/round2-status`, `chore/local-notes`.
- Remote branches to delete after merge (GitHub may auto-delete): the same branch names under
  `origin`, including the already-closed `origin/feat/a0-harness` and `origin/fix/ladder-restore`
  whose work lives on in the rescue branches.

## Open questions / uncertainty

- The root `backlog.md` index rows for PRs #8–#11 link report files that only exist on those
  branches until the respective PR merges; the docs PR is intentionally last in the merge order so
  the links are valid on `main` immediately after the docs PR merges.
- GitHub shows no recorded review decision on #8–#11; local review worktrees exist for #10/#11.
