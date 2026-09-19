# Review: docs-plan
- Date: 2026-09-19
- Reviewer: opencode-go/deepseek-v4.1-flash (L4, independent session)
- Reviewed: branch docs/audit-and-confidential-plan (commits after 77950df)

## Verdict: approve with corrections

The documentation is faithful to the ground-truth notes D1–D8 and the CT/SPP facts check out; the two
tiny fixes (F-09/F-10) and the audit-finding table are correct, and the deployment table/contract
IDs/hashes were left untouched. Two concrete issues remain: a real personal name (masked here as `Owner A`) was
introduced into committed files (constitution "no user-specific data"), and finding N-03 is marked
"v0.2: Y" in `DEPLOYED.md` although the v0.2 spec has no corresponding item. Both are small, exact fixes.

## Check table

| # | Check | Result | Evidence (file:line) |
|---|---|---|---|
| 1 | Decision fidelity D1–D8 | PASS | D1 `docs/confidential-payments.md:356-370`, `notes.md:122-129`, `sprints.md:85-86`; D2 `docs/confidential-payments.md:15-42`, `notes.md:110-114`, `sprints.md:109-117`; D3 `docs/confidential-payments.md:79-107`; D4 `:250-273`; D5 `:275-294`; D6 `:325-350`; D7 `:113-150`, `docs/interfaces.md:80-118`; D8 `:298-321`, `backlog/guard-v0.2-hardening.md:8-18`. No decision missing/altered/softened; fail-closed, no dictated addresses, payroll IN / scheduled OUT, SPP second, docs-only reservation all present. |
| 2 | Invented facts (CT/SPP) | PASS | Every concrete CT/SPP claim maps to the source notes: ops `docs/confidential-payments.md:66` vs notes §2; Pedersen/UltraHonk/Noir/Barretenberg/CAP-74/CAP-75 `:65` vs notes §2; SPP Circom/Groth16/Soroban/ASP/view keys `:51-53,65` vs notes §3; dates/links `:72-75` vs notes §2-3. No function name, address, package or proof-time number is invented (proof time/memory and SDK are explicitly open, `:426,430`). |
| 3 | Audit findings F-01…F-12, N-01…N-03 | FAIL (minor) | IDs/severities/descriptions all match `backlog/contracts-audit.md:88-99` and `backlog/contracts-audit-review.md:94-98` (`contracts/DEPLOYED.md:301-317`). Deployment table/IDs/hashes untouched: `git diff 77950df..HEAD -- contracts/DEPLOYED.md` shows additions only. **Except:** `contracts/DEPLOYED.md:317` marks N-03 "v0.2? Y", but `backlog/guard-v0.2-hardening.md:32-127` has no N-03 item (V2-01…V2-09; source notes §4 v0.2 list omits N-03). |
| 4 | Interface reservation | PASS | `docs/interfaces.md` diff is append-only (new §6/§7, `git diff 77950df..HEAD -- docs/interfaces.md`); `interfaces/src/**` untouched (`git diff 77950df..HEAD --stat -- interfaces/` empty); `interfaces/src/index.ts` has no `mode`/`privacy`/`TxSummary`; `ls app/src-tauri/src` → no `interfaces.rs` (claim at `docs/interfaces.md:124-127` correct). Drift list matches slice-gap A.1 (`backlog/2026-09-19-slice-gap-analysis.md:42-47`). |
| 5 | The two tiny fixes | PASS | F-09: comment now `live_until_ledger` (`contracts/scripts/demo.sh:81`) and real flag `--live_until_ledger` (`:96`). F-10: README example now `name:"SacAllowanceError","code":9,"kind":"allowance_missing"` (`stellar/src/keeper/README.md:146`), matching `stellar/src/keeper/errors.ts:106` (code 9 = SacAllowanceError, kind allowance_missing; code 5 = SacAuthentication, `:102`). |
| 6 | backlog.md / sprints.md hygiene | PASS | Table column counts consistent (scripted check); A0 row now PR #14 open (`backlog.md:15`); Owner B row moved to archive (`backlog.md:66`); only intended rows changed (`git diff 77950df..HEAD -- backlog.md`); M3 guard item ticked (`sprints.md:102`); M2b/M3b added, no milestone renumbered/deleted. |
| 7 | Cross-file consistency | PASS (note) | Mode names identical (`docs/confidential-payments.md:69`, `docs/interfaces.md:94,102`); planned paths `stellar/src/confidential/`, `stellar/src/spp/` marked PLANNED and absent as expected (`ls` → missing); branches `spike/ct`,`spike/spp` and report names `backlog/confidential-spike-ct.md`/`-spp.md` consistent (`backlog/confidential-payments.md:25,40,48,64`). One broken link is **pre-existing at 77950df** and outside this diff: `backlog.md:30` → `backlog/rule-types-docs.md` (text says it lands with PR #8). |
| 8 | Policy rules | FAIL (minor) | TRY path SEP-6 only, SEP-24 never (`docs/confidential-payments.md:37-38`, `stellar/src/anchor/README.md:176`); English everywhere; `docs/model-ladder.md` not tracked (`git ls-files`) and only referenced as local-only (`notes.md:135`). **Except:** real personal name introduced in committed files — `docs/confidential-payments.md:413`, `backlog/2026-09-19-slice-gap-analysis.md:14,176`. |
| 9 | Usefulness test | PASS (gaps listed) | See "Implementability gaps" — 10 concrete gaps, none blocking the design stage. |
| 10 | Length / quality | PASS (notes) | 454-line design doc is dense and mostly concrete; D6 rationale is repeated in §1/§3/§7/§8 (acceptable for a decision record but noted); risk defaults R6/R7 introduce new choices not in D1–D8 (see non-blocking). |

## Blocking issues (must fix before merge)

1. **Personal name in committed files.** `docs/confidential-payments.md:413` ("**Owner A** (name redacted)"),
   `backlog/2026-09-19-slice-gap-analysis.md:14` ("**Owner A's branches**") and `:176`
   ("`app/`, plus Owner A's branches"). This violates the constitution rule that nothing user-specific
   goes into committed files (`AGENTS.md` "Local notes"; review check 8).
   **Fix:** replace each occurrence with "Owner A" (e.g. `**Owner A**`, `Owner A's branches`) so the
   committed tree keeps only the role label, as `notes.md`/`sprints.md` already do.

2. **N-03 v0.2 mapping contradiction.** `contracts/DEPLOYED.md:317` sets N-03 `v0.2? = Y`, but the v0.2
   spec `backlog/guard-v0.2-hardening.md:32-127` contains no N-03 item, and the ground-truth v0.2 list
   (source notes §4) omits N-03. As written a reader expects v0.2 to fix the keeper bumping the owner's
   `Rule` TTL, which nothing planned does.
   **Fix (pick one):** change the N-03 cell at `contracts/DEPLOYED.md:317` from `Y` to `N`, **or** add a
   `V2-10` item that stops/documents the `Rule` TTL bump on the unauthenticated `execute_schedule` path.

## Non-blocking suggestions

- **R6 pre-empts an open question.** `docs/confidential-payments.md:446` states a "Default: a separate
  Keychain item" for the history key while §6/§10 Q3 mark key custody OPEN (`:290-291,:427`). Reword as
  "default candidate, pending the spike" or move it under §10 to avoid reading as a decision.
- **R7 mixed-mode batches** (`docs/confidential-payments.md:447`) is a new policy absent from D1–D8 and
  the notes. Record it as a dated note in `notes.md` (or mark PROPOSED) so it is not an undocumented decision.
- **Public mode labelled "production"** (`docs/confidential-payments.md:68`) on a testnet-only project;
  consider "stable / SEP-41".
- **Example vs card inconsistency (cosmetic).** The §4.3 summary truncates the address
  (`GARXWVN...`, `docs/confidential-payments.md:200`) while §5 requires the full address on the card
  (`:257`). Say the example is illustrative or show the full address.
- **Pre-existing broken link** `backlog.md:30` → `backlog/rule-types-docs.md` (file lands with PR #8).
  Not introduced here; fixing it would be a hygiene bonus.
- **V2 thresholds left open** ("pick the number and document it", `backlog/guard-v0.2-hardening.md:49`):
  fine as a spec, but give a default (e.g. 3 consecutive failures) so the implementer is not blocked.
- **Repetition of D6** in `docs/confidential-payments.md` §1 (`:30-35`), §3 (`:98`), §7 (`:310-312`),
  §8 (`:347-350`). Consider one short cross-reference instead of the fourth full restatement.

## Invented-fact list

**None found.** Every concrete CT/SPP claim in `docs/confidential-payments.md` and
`docs/reports/2026-09-19-privacy-on-stellar-research.md` traces to the source notes §2–§6
(operation sets, Pedersen/UltraHonk/Noir/Barretenberg, CAP-74/75, Circom/Groth16/Soroban, ASP/view-key,
registration prerequisite, OpenZeppelin/Nethermind attribution, dates and URLs). Two items are new
*design defaults* rather than facts and are flagged above (R6 `:446`, R7 `:447`); the JSON examples'
`USDC:GBBD47…` / `GARXWVN…` values are real repo constants copied from `contracts/DEPLOYED.md:58,38`
and `backlog/2026-09-19-slice-gap-analysis.md:287-288`, not invented.

## Implementability gaps (max 10, by importance)

1. **CT send composes two actions but the tx model is undefined.** §4.3 shows one `unsignedXdr`
   (`docs/confidential-payments.md:194`) yet §8 step 4 builds "deposit + `confidential_transfer`" and
   step 7 submits "N txs" (`:337,343`). Nothing says whether that is one transaction with two ops or two
   txs, how the single approval card maps to it, or how partial failure is handled.
2. **Registration/`ctRegistered` storage unspecified.** §7 says CT registration is tracked separately
   per contact (`:313-316`), but where the flag lives and how the precheck reads it is never defined
   (the alias book stays the single contact list only).
3. **`aliases.json` is referenced but never specified.** D1 says "committed `aliases.json` first"
   (`:360`, notes D1) with no path, schema, or precedence rule versus the on-chain `get_alias`.
4. **Mode disambiguation missing.** "secretly"/"privately" both map to `confidential` **or** `private`
   (`:102-103`); no rule tells the agent which of CT/SPP to choose when the user says "privately".
5. **SPP summary shape is an ellipsis.** `TxSummary.privacy` reserves only `mode`/`recipientRegistered`
   and "...provisionally: pool/ASP status, pending/merge state" (`:131-135`); SPP precheck/summary
   (`:264`) cannot be implemented from this.
6. **Payroll list undefined.** §8 step 1 refers to "a saved payroll list" (`:330`) with no storage,
   schema, or resolution rule for "the salaries".
7. **Local encrypted history has no format/criteria.** §6 lists stored fields but no encryption scheme,
   record format or key provisioning, so it has no testable acceptance (`:275-294`, Q3 `:427`).
8. **No acceptance criteria for the integration tasks.** Spike acceptance is concrete
   (`backlog/confidential-payments.md:34-35,58-60`) but I2/I4 are "build CT/SPP transfer + summary"
   (`:74,76`) with no measurable pass condition.
9. **Guard boundary cap is unresolved.** Whether the deposit cap is contract-enforced or client-only is
   open Q9 (`:318-321,433`), so the §7 guarantee cannot be implemented yet (correctly disclosed).
10. **SPP refusal has no machine-readable state.** §4.4 gives prose for the not-registered refusal
    (`:241-246`); the SPP "not on the allow-list" variant has no error/state field to branch on.

## Scope statement

Only `backlog/docs-plan-review.md` was created; no other file changed, committed, added or pushed.
`git status --short` shows a single new review file. Ground truth used:
`source-notes-confidential.md` (D1–D8, CT/SPP facts, audit findings, spike definition) plus
`backlog/contracts-audit.md`, `backlog/contracts-audit-review.md`,
`backlog/2026-09-19-slice-gap-analysis.md`, `CLAUDE.md`/`AGENTS.md`.
