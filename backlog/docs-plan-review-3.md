# Review: docs-plan (approval/scheduling delta + D9)

Reviewer: W-review-docs (fresh session, did not write these docs). Delta = `af1528e` (D10–D12 + demo
runbook) plus the unreviewed D9 commit `44dcdc5`. Ground truth: source notes for this round,
`stellar/src/keeper/README.md`, `.env.example`, `contracts/DEPLOYED.md`,
`contracts/polaris_guard/src/lib.rs`, PR #8 `docs/rule-types-and-decisions`.

## Verdict: approve with corrections

1. The design is faithful to D9–D12 and every concrete number traces to code/config/docs, with one
   exception: a contract-behaviour claim about the allowance in §2 that is contradicted by `settle()`.
2. Two doc-level corrections are required before T1/T2: fix the allowance claim and reconcile the two
   conflicting `RuleDraft` shapes (this doc vs PR #8 / the new `docs/interfaces.md` §6.1).
3. Everything else (keeper explanation, PR #8 Touch ID policy, contract F-codes, D9 wording, hygiene) is
   consistent and reviewable; remaining items are non-blocking.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Decision fidelity (D9–D12 across docs; D12 PROPOSED; defaults) | PASS | `notes.md` D10/D10b/D10c/D11/D12 notes; `sprints.md` M2b/M3c + C7; `backlog.md` T1–T6; `docs/demo-runbook.md:84` (D12 PROPOSED); `docs/approval-and-scheduling.md:25-29,65-68,149-151`. D12 never presented as decided anywhere. Default profile/mandate/one-card+Touch ID/lighter tightening/stricter-only all present. |
| 2 | Invented facts trace to notes/config/code | **FAIL** | All numbers verified except one: `docs/approval-and-scheduling.md:61` claims allowance "only needed if schedules are used" — see Blocking. Verified OK: 15 s poll, 30 s tx timeout, `KEEPER_MAX_PER_TICK` 5, `KEEPER_MAX_FEE_STROOPS` 5000000, log `info` (`keeper/README.md:124-135`); `17280 ledgers/day` and `~180 days` (`contracts/DEPLOYED.md:142-144`); 25 active (`lib.rs:76`, `#114`); `runs==0`/one-shot `#112` (`lib.rs:136,530`); three owner calls (`DEPLOYED.md:116`); latency ~15–25 s (source notes); `daily_limit*7` + suggestion thresholds marked PROPOSED. |
| 3 | Keeper explanation matches README/.env.example; commands verbatim | PASS | `docs/approval-and-scheduling.md:437-450` table == `keeper/README.md:124-135`; `.env.example:32-46`; down/one-settle + skip semantics (`README.md:51-60`); dry-run (`README.md:121`). Runbook commands `npm run keeper -w @polaris/stellar -- --dry-run`, `npm run keeper:once -w @polaris/stellar`, `caffeinate -i npm run keeper …` exist in `keeper/README.md:119-121` and `stellar/package.json` scripts `keeper`/`keeper:once`. |
| 4 | PR #8 Touch ID policy consistency | PASS | `docs/approval-and-scheduling.md:136-151` matches `origin/docs/rule-types-and-decisions:docs/interfaces.md` §6.1 (Touch ID to create/loosen rules & schedules and above the auto-approve limit; `cancel_schedule` not mandated; tightening app-decided). No divergence. |
| 5 | Contract facts vs `lib.rs` / `contracts-audit.md` | PASS | Paths `pay_owner`/`pay_executor`/schedules and hard-caps-vs-full-rule split (`lib.rs:16-17,422-489`); `validate_rule` accepts `auto_approve_limit == 0` (rejects only `< 0`, `lib.rs:860`), so §2's "0" is code-legal; `pay_executor` requires a registered matching executor (`lib.rs:455-461`); max 25 per owner (`lib.rs:76,547`); `runs==0`/one-shot (`lib.rs:530`); F-01/F-03/F-12 and missed-run skip (`lib.rs:633-668`, `DEPLOYED.md:310-321`). |
| 6 | Confidential / D6 consistency | PASS | §5.9 out of scope; §8.1 "invisible to the guard"; `DEPLOYED.md` privacy note says the guard never sees the amount. `git diff 77950df..HEAD --stat -- interfaces/` is empty → reservations are docs-only. |
| 7 | Hygiene | PASS | Table column counts OK (the §9 row "mismatch" is escaped `\|` in `always_ask` \| `auto_under_limit`); all links resolve or PLANNED; no personal names in the two new docs (only Owner A/B + demo alias `bob`); English; no TBD in `docs/demo-runbook.md` (uses "requires Tn"); `git diff 77950df..HEAD -- contracts/DEPLOYED.md` = 47 additions + the single Known-limitations column-header rename; deployment table unchanged. |
| 8 | Implementability | GAPS | See below. |

## Blocking issues

1. **False/self-contradicting allowance claim.** `docs/approval-and-scheduling.md:61` ("Allowance only
   needed if schedules are used") is wrong: `settle()` always reads `token.allowance(owner, guard)` and
   calls `transfer_from` (`contracts/polaris_guard/src/lib.rs:994-1007`), so the SAC allowance is
   mandatory for **every** guard payment, including `pay_owner`. `contracts/DEPLOYED.md:118` calls it
   "Step 0 (off-contract, mandatory)", and the same doc contradicts itself at
   `docs/approval-and-scheduling.md:132,299` ("revoking the allowance … also disables `pay_owner`").
   **Fix:** replace the sentence with "Allowance is mandatory for any guard payment (`transfer_from`);
   size it to cover the mandate and all schedules."
2. **Conflicting `RuleDraft` shapes.** `docs/approval-and-scheduling.md:177-192` defines a `RuleDraft`
   as `{ kind, source, rule: { auto_approve_limit, per_tx_limit, … }, readBack }` (snake_case, nested),
   while PR #8 `docs/rule-types-and-decisions:docs/interfaces.md` §6.2 and the new
   `docs/interfaces.md` §6.1 define `RuleDraft` as flat camelCase (`autoApproveLimit`, …). A T1/T2
   implementer cannot satisfy both. **Fix:** either align §4.2 to the PR #8/`interfaces` `RuleDraft`
   (or explicitly name §4.2 an internal on-chain `Rule` payload, distinct from the seam `RuleDraft`).

## Non-blocking

- `docs/approval-and-scheduling.md:477` labels the privacy decision set "D1–D9"; D9 is contract
  evolution, not a privacy mode. Should read D1–D8 (matches the C-table wording in
  `docs/confidential-payments.md`: "grounded in D1–D8").
- `docs/approval-and-scheduling.md:346-354` (§6.3) thresholds are not individually marked PROPOSED,
  although §6.2 and §6.4 are. Add "(PROPOSED)" to the §6.3 header for consistency.
- `docs/approval-and-scheduling.md:409-412` and §6.3 say "round-up"/"rounded" without a granularity
  (p90 18.4 → 19 by ceil, 20 shown; 57 → 60). State the rounding step (e.g. round up to nearest 5).
- T6 owner differs: `docs/approval-and-scheduling.md:504` says "A", `backlog.md` says "docs worker
  (W-docs)". Pick one.
- `docs/interfaces.md` new §6.1 lists `TxSummary` inside the "not yet in `interfaces/src`" block while
  its prose says `TxSummary` already exists as the Rust mirror (`app/src-tauri/src/types.rs:48`).
  Clarify it is new to `interfaces/src` only.

## Invented-fact list (or none)

- **Invented/unsupported:** "Allowance only needed if schedules are used" (`docs/approval-and-scheduling.md:61`) — contradicted by `lib.rs:994-1007` and `DEPLOYED.md:118`.
- Everything else checked out. `CBIELTK6…DAMA` (real testnet USDC SAC) and all demo addresses are
  grounded in `contracts/DEPLOYED.md:39-58`; "~180 days" is in `DEPLOYED.md:143-144`; `#112`/`#114`,
  25-schedule cap, `runs==0`, three-call enable, `17280`/day, keeper defaults all trace to code/config.

## Implementability gaps

1. Allowance requirement is mis-stated (Blocking 1) — a developer would skip the mandatory approval step.
2. `RuleDraft` has two incompatible shapes (Blocking 2).
3. No derivation rule for `daily_limit`/`per_tx_limit` from voice: the read-back invents "max 100/day"
   from a "under 25" request with no specified mapping or default.
4. Rounding/precision for suggestion thresholds undefined (§6.3/§6.8); acceptance test T3 hard-codes
   20/60, so the "round" rule must be pinned.
5. Natural-language time parsing unspecified: "tomorrow at 15:00", "every Friday", default `runs` when
   omitted, and which timezone source is authoritative (device vs setting vs ask); DST left as an open
   question.
6. `DisableAutoPay` is referenced (`§6.4`, PR #8) but never defined as a type/flow; `disableAutoPay()`
   output shape is only described in prose.
7. No acceptance criteria for the "stricter-only app preference" invariant, nor for the combined-card
   partial-failure re-read (§3.2), so they cannot be tested as written.
8. Suggestion identity/lifecycle undefined: how `Suggestion.id` is generated, how "don't suggest again"
   is persisted, and how `confidence` is computed.
