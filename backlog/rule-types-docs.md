# Report: rule-types-docs
- **Date:** 2026-09-19
- **Worker/Agent:** W5 (Claude Sonnet 5)
- **Branch/Worktree:** `docs/rule-types-and-decisions` / `.worktrees/rule-types-docs`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/8 (draft)

## Completed
- `interfaces/src/index.ts`: extended `IntentKind`; added `Rule`, `RuleDraft`, `Schedule`, `ScheduleDraft`, `GuardError`; added `anchor_step` and `approval_required` to `PolarisEvent`. Additive only, decimal-string amounts.
- `app/src/lib/polaris.ts` (OUT OF SCOPE, minimal consumer fix): two new `case`s in `describeEvent` because its exhaustive switch stopped compiling (TS2366). Same commit as the type change so every commit passes the check.
- `docs/interfaces.md`: §1/§4 mirrored, §5 review-rule bullet, new §6 (autonomy model, types, target guard ABI table).
- `notes.md`: five dated notes (Owner B pivot + Touch ID nuance; SEP-24 not used on the Turkey path; measured anchor facts; MPP position & P2P interpretation; work plan & cut order).
- `sprints.md`: M3 "Owner B Track: Autonomous Wallet (step-by-step)" sub-section; the Rule/Schedule types item is ticked (2026-09-19).
- Verified: `npm ci && npm run check --workspaces --if-present` passes (interfaces, agent, stellar, app).

## Unfinished (handed off)
- **Rust mirror** (`app/src-tauri/src/events.rs`, `types.rs`) does not know the new event variants / intent kinds. Owner A follow-up (the `interfaces/src/index.ts` header requires the mirror to be in sync).
- **`GuardError` names** are string names only; align with the real on-chain error codes once W1 reports the contract (`contracts/`). Also reconcile the ABI table in `docs/interfaces.md` §6.3 with any W1 deviations.
- `backlog.md` was not edited (per task); the coordinator may want an index row for this report.
- `docs/architecture.md` still says "every value-moving step needs Touch ID" (§1 item 4, §6); the superseding nuance lives only in `notes.md` (old text intentionally untouched). A later architecture refresh should fold it in.
- README section "how the SEP flow works and why SEP-24 is not used in Turkey" is tracked in `sprints.md`, not written.

## Blockers
- None. No `needs-owner-a-review` label exists in the repo, so none was applied (the review request is stated in the PR description and `docs/interfaces.md` §5).

## Review Notes
- Owner A must review (seam change, §5). Look at: (1) type names/shapes in §6.2, (2) the `describeEvent` consumer fix, (3) the auth column of the ABI table (`revoke_executor`, `set_alias`, `cancel_schedule` are marked "owner" without mandating Touch ID because they tighten or are low-risk; `set_rule`, `set_executor`, `create_schedule` require Touch ID per the "create or loosen" rule; these are my reading of the brief and W1 may adjust).
- `Schedule` fields (`id`, `owner`, `nextRunAt` in unix seconds, `runsRemaining`, `active`) were not specified in the brief; they are my proposal for the on-chain mirror.
- Reviewer must be a different agent than the author (constitution §3); record the outcome here.

## Suggested Next Step
- Owner A reviews and merges; then Owner A updates the Rust mirror. W1 implements the ABI and reports deviations; W3/W4 build against these types.

## Raven calls
1. `search` (kind: skill) "agentic payments MPP HTTP 402 charge session channel" -> hit `skills.stellar-dev.agentic-payments`.
2. `execute` `codemode.skill.read("skills.stellar-dev.agentic-payments", { sections: ["quick-decision", "file:mpp.md"] })`.
- **Result:** confirmed. MPP is a payment-method-agnostic HTTP 402 protocol (Challenge/Credential exchange); on Stellar, **Charge** = one SAC token transfer per request, **Session** = channel-backed off-chain commits over a one-way payment channel (one deposit + one close; older docs call it "Channel mode"). It is for machine/agent payments to paid APIs, not user-to-user transfers. The `notes.md` wording follows this.
- Not found in these sources: the "agent wallet" idea (bounded-balance account because MPP pull-mode has the client sign Soroban auth entries directly); it stays recorded as an open idea in `notes.md`.
