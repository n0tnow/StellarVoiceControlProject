# Review: docs-plan (delta)

- Date: 2026-09-19
- Reviewer: opencode-go/deepseek-v4.1-flash (L4, fresh independent session — did not write the PR)
- Reviewed: branch `review/docs-plan-2`, delta `git diff 2462364..HEAD` (fix commit `096a6a9`) over base `77950df`
- Ground truth: `source-notes-confidential.md` (D1–D8, CT/SPP facts), `backlog/docs-plan-review.md`, `backlog/contracts-audit*.md`

## Verdict: approve

1. Both blocking issues from `backlog/docs-plan-review.md` are fixed: the personal name is gone (`git grep <collaborator name>` empty) and N-03 is now "N" with a "documented only" note mirrored in the v0.2 spec.
2. All seven non-blocking suggestions B3–B9 are applied; the new §12 adds ten concrete, grounded PROPOSED defaults without inventing CT/SPP contract behaviour or contradicting D1–D8.
3. No regression: the PR is docs-only plus the two intended one-line fixes, tables are intact, no user-specific data and no non-English text; remaining items are cosmetic/prose nits only.

## Check table

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Personal name removed; replacements natural | PASS | `grep -rn "<collaborator name>" --include="*.md" .` and `git grep <collaborator name>` both empty; `docs/confidential-payments.md:411` "**Owner A**"; `backlog/2026-09-19-slice-gap-analysis.md:14` "Owner A's branches"; `:176` "`app/`, plus Owner A's branches". |
| 2 | DEPLOYED.md N-03 = N + note; v0.2 says documented-not-fixed; deployment data untouched | PASS | `contracts/DEPLOYED.md:317` ends "documented only … no demo impact. | N"; `backlog/guard-v0.2-hardening.md:11` "N-03 is documented, not fixed, in v0.2"; `git diff 77950df..HEAD -- contracts/DEPLOYED.md` = `40 0` (additions only, no deleted lines). |
| 3 | Non-blocking B3–B9 applied | PASS | B3 R6 `docs/confidential-payments.md:446` ("Default candidate … Open Question 3"); B4 R7 `:447` + note `notes.md:149`; B5 "stable (plain SEP-41 …)" `:68`; B6 illustrative address `:200`; B7 "3 consecutive failed runs" `backlog/guard-v0.2-hardening.md:50`; B8 D6 §7 `:310`, §8 `:346` cross-refs with §1 `:33-35` keeping the full statement; B9 `backlog.md:30` "(file lands with PR #8)". |
| 4 | §12 exists: 10 rows, concrete, no invented contract facts, consistent with D1–D8 and §4–§8 | PASS | `docs/confidential-payments.md:458` heading, rows C1–C10 `:468-477` (exactly 10). Spike-dependent cells: C1 `:468` "(spike: whether the ops can be combined in one tx)", C5 `:472` "settled by the SPP spike", C7 `:474`, C9 `:476`. Fail-closed C2 `:469`/C3 `:470`/C9 `:476`; no dictated addresses; batch IN (C6/C10) vs scheduled OUT (§1 `:33`); SPP second (C1 CT, C5 SPP); mode names `public|confidential|private`; seam fields still reserved-only. |
| 5 | I2/I4 measurable acceptance matching §12 row 8 (C8) | PASS | `backlog/confidential-payments.md:74` (I2) and `:76` (I4): "on testnet, a headless script produces the … transfer + decoded summary that matches the §5 approval-card checklist **and** a refusal case returns the machine-readable `refusal` (design §12 C5/C8)" — same pass condition as C8 `docs/confidential-payments.md:475`. |
| 6 | Regression sweep of the whole PR | PASS | `git diff 77950df..HEAD --name-only`: all `.md` except `contracts/scripts/demo.sh` (only non-md); the two one-line fixes are exactly `contracts/scripts/demo.sh:81` and `stellar/src/keeper/README.md:146`. Table pipe-counts consistent: `backlog.md` 5 blocks, `docs/confidential-payments.md` §12 = 7 unescaped-pipe fields × all rows, `contracts/DEPLOYED.md` 8 blocks; `sprints.md` has no markdown tables (checklist form). New paths `stellar/config/aliases.json`, `payroll.json`, `stellar/src/confidential/`, `stellar/src/spp/` are marked planned/absent; `backlog/rule-types-docs.md` now annotated. No `/Users/`, emails, or personal names (token scan clean); no Turkish/non-English text. |

## Blocking issues

none

## Non-blocking

- **Cross-reference precision (CT).** `backlog/confidential-payments.md:74` points I2 (CT) at "§12 C5/C8", but C5 is titled "SPP summary shape and refusal" (`docs/confidential-payments.md:472`). The generic `refusal` object lives in C5 so the link resolves, yet a CT reader may expect a CT-specific row; consider noting in C5/C8 that the refusal shape is mode-agnostic.
- **Registration-state duplication.** C2 (`docs/confidential-payments.md:469`) places `ctRegistered`/`sppReady` in the local contacts file and requires a LIVE chain re-check, while C3 (`:470`) puts the same flags in the **committed** `stellar/config/aliases.json`. Harmless if the committed file is only a demo seed and the cache is display-only, but the two rows should say which one is the seeded value and which the live value.
- **Reserved-shape extension.** C5 (`docs/confidential-payments.md:472`) proposes a top-level `refusal` field on the result, which D7's reserved shape (§4.1 `:129-136`) does not list (it reserves only `TxSummary.privacy`). Acceptable because §12 is explicitly PROPOSED, but the eventual seam note should add `refusal` explicitly.
- **Historical review edited.** `backlog/docs-plan-review.md:10,31` was rewritten to mask the name inside the prior review text. A redaction edit to a past artifact is fine, but future readers should know the report was touched, not only the findings.

---

*Scope: this review created only `backlog/docs-plan-review-2.md`; no file was committed, staged, added, pushed or tagged (`git status --short` shows a single new file). No network access, no work outside the worktree. Ground truth: `source-notes-confidential.md`, `backlog/docs-plan-review.md`, `backlog/contracts-audit.md`, `backlog/contracts-audit-review.md`.*
