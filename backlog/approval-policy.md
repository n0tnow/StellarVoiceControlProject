# Report: approval-policy (T1)

- **Date:** 2026-09-19
- **Worker/Agent:** W-T1 (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/approval-policy` / `.worktrees/approval-policy`
- **PR:** none (per task instruction: do not commit/push/add/tag)

## Completed

Implemented decisions **D10 / D10b / D10c** (source notes 2026-09-19) as an offline,
fully-tested TypeScript approval layer plus the guarded-route tightening.

New files (`stellar/src/approval/**`):

| File | Contents |
|---|---|
| `types.ts` | `ApprovalMode`, `ApprovalProfile`, `AutoPayDraft`, `AutoPayDraftInput`, `ApprovalError`(+`code`), `makeAutoPayDraft` (decimal strings -> raw via `toRawUnits`), `validateAutoPayDraft` (contract mirror + app-stricter), `ruleFromDraft` |
| `classify.ts` | `classifyChange`, `confirmationLevel`, `profileFromChain`, `assertTightening` |
| `routing.ts` | `resolveApprovalRoute`, `requiresApprovalCard` (re-exports the guard's `GuardRoute`) |
| `readback.ts` | `readBack`, `readBackDisable`, `formatRawAmount` |
| `enableAutoPay.ts` | `buildEnableAutoPay`, `buildDisableAutoPay`, `buildTightenRule`, step/summary/exposure types, `LEDGER_SECONDS` |
| `index.ts` | namespace barrel |
| `__tests__/{types,classify,readback,enableAutoPay}.test.ts` + `fixtures.ts` | 79 tests |

Modified (only the permitted files):

- `stellar/src/payments/sendPayment.ts` — `PaymentDeps.approvalProfile?: ApprovalProfile`; the
  guarded route now runs `chooseGuardedRoute` for hard refusals, then narrows with
  `resolveApprovalRoute` (default `always_ask`); appends `Approval profile:` and
  `Approval card required: yes|no` to the decoded summary.
- `stellar/src/payments/__tests__/sendPayment.guarded.test.ts` — `guardedDeps()` fixture only
  (see "Test fixture changes").
- `stellar/src/payments/__tests__/sendPayment.approval.test.ts` — NEW (8 tests).
- `stellar/src/index.ts` — `export * as approval from "./approval/index.ts"`.
- `stellar/package.json` — added `test:approval` and appended it to `test`.

Not touched (per scope): `stellar/src/guard/**`, `keeper/**`, `anchor/**`, `contracts/**`,
`interfaces/**`, `agent/**`, `app/**`, docs, root files. No commit/push/tag. The temporary
`node_modules` symlink is removed before finishing.

## API table

| Symbol | Signature (abridged) | Notes |
|---|---|---|
| `makeAutoPayDraft` | `(input: AutoPayDraftInput) => AutoPayDraft` | `toRawUnits` conversion; allowance default `dailyLimit * 7`, days default 30 |
| `validateAutoPayDraft` | `(draft) => void` (throws `ApprovalError`) | mirrors `validate_rule`; adds app-stricter checks |
| `ruleFromDraft` | `(draft) => Rule` | exact snake_case on-chain shape |
| `classifyChange` | `(current: Rule \| undefined, next: Rule) => ChangeKind` | pure |
| `confirmationLevel` | `(change) => "card_and_touch_id" \| "light" \| "none"` | D10c |
| `profileFromChain` | `(rule, executor) => ApprovalProfile` | `always_ask` unless executor + threshold > 0 |
| `resolveApprovalRoute` | `(profile, chainRoute) => GuardRoute` | app can only narrow the chain |
| `requiresApprovalCard` | `(route) => boolean` | `route === "pay_owner"` |
| `readBack` | `(draft, { assetSymbol, timeZone?, now? }) => string` | exact D10c sentence |
| `readBackDisable` | `({ assetSymbol, revokeAllowance }) => string` | tighten read-back |
| `buildEnableAutoPay` | `(deps, draft) => Promise<EnableAutoPayResult>` | 3 steps in order, one card |
| `buildDisableAutoPay` | `(deps, { revokeAllowance }) => Promise<DisableAutoPayResult>` | `revoke_executor` (+ `approve(0)`) |
| `buildTightenRule` | `(deps, nextRule) => Promise<TightenRuleResult>` | single `set_rule` + classification |
| `assertTightening` | `(change) => void` | throws `use_enable_flow` on loosening/mixed/new_rule |

`ApprovalError` codes: `invalid_amount_string`, `invalid_executor`, `threshold_negative`,
`non_positive_limit`, `amount_out_of_range`, `limit_order`, `too_many_assets`, `no_assets`,
`allowance_too_small`, `invalid_allowance_days`, `missing_asset`, `use_enable_flow`.

### Contract mirror (`contracts/polaris_guard/src/lib.rs::validate_rule`, read-only)

| Contract check | Mirrored in the app |
|---|---|
| `per_tx_limit > 0`, `daily_limit > 0` | `non_positive_limit` |
| `auto_approve_limit >= 0` (**0 is accepted**) | `threshold_negative` only below 0 |
| `auto_approve_limit <= per_tx_limit <= daily_limit` | `limit_order` |
| `allowed_assets.len() <= 1` (effective; structural `MAX_ALLOWED_ASSETS = 10`) | `too_many_assets`, `MAX_ALLOWED_ASSETS = 1` |
| `i128` range | `amount_out_of_range` |
| — (app-stricter) | `no_assets` (needs an asset to `approve`), `allowance >= daily_limit`, `allowance_days` 1..90, executor is a valid `G...` |

## Classification table

| current -> next | result |
|---|---|
| `undefined` -> any | `new_rule` |
| identical limits/assets/known | `same` |
| any limit increases | `loosening` |
| any limit decreases | `tightening` |
| allowed-asset set grows | `loosening` |
| allowed-asset set shrinks | `tightening` |
| allowed-asset set replaced (A -> B) | `mixed` (grows **and** shrinks) |
| `known_recipients_only` true -> false | `loosening` |
| `known_recipients_only` false -> true | `tightening` |
| at least one loosening **and** one tightening signal | `mixed` |

`confirmationLevel`: `loosening`/`mixed`/`new_rule` -> `card_and_touch_id`;
`tightening` -> `light`; `same` -> `none`.

## Enable 3-step failure-state table (safe ordering: allowance LAST)

| Failure point | Resulting on-chain state | Unattended-payment exposure |
|---|---|---|
| step 1 `set_executor` fails | transaction atomic; executor, rule, allowance all unchanged | none — no new path |
| step 1 ok, step 2 `set_rule` fails | new executor registered; rule = whatever it was | from the expected `always_ask` start (no rule or `auto_approve_limit == 0`) none. Caveat: if a positive-threshold rule **and** a live allowance already existed, the new executor could act under the OLD rule; this flow assumes an `always_ask` start (documented in code/report) |
| step 2 ok, step 3 `approve` fails | executor + rule armed; guard has no allowance | none — `transfer_from` reverts with `InsufficientAllowance` (#116). Retry only the `approve` step |

## Test fixture changes caused by the new default profile

The default `approvalProfile` is now `always_ask`, so a fixture that wanted the *chain*
decision had to opt in explicitly. Only one fixture was changed:

- `stellar/src/payments/__tests__/sendPayment.guarded.test.ts` — the shared `guardedDeps()`
  helper now adds `approvalProfile: { mode: "auto_under_limit" }`. Without this, these three
  existing tests would have flipped from `pay_executor` to `pay_owner`:
  1. `routes a small payment through pay_executor and decodes the summary from the XDR`
  2. `uses pay_executor for a known recipient under known_recipients_only`
  3. `allows a guarded XLM payment when its SAC id is supplied`

  No assertion was weakened or removed. The new default is covered by the new file
  `sendPayment.approval.test.ts`, which deliberately supplies **no** profile.

## Tests (real numbers)

| Suite | Command | Result |
|---|---|---|
| typecheck | `npm run check -w @polaris/stellar` | clean (`tsc` exit 0) |
| approval (new) | `npm run test:approval -w @polaris/stellar` | **4 files, 79 tests passed** |
| payments (incl. new) | `npm test -w @polaris/stellar` | **7 files, 121 passed** (was 113; +8 new) |
| guard | (full run) | **6 files, 113 passed** |
| anchor | (full run) | **5 files, 111 passed** |
| keeper | (full run) | **67 passed** |

Full gate `npm test -w @polaris/stellar`: keeper 67 + anchor 111 + payments 121 + guard 113
+ approval 79 = **491 passed, 0 failed**.

Coverage highlights: every validation rule; full `classifyChange` table (limit up/down,
assets grow/shrink/replace, known toggling, `undefined`); `confirmationLevel`;
`profileFromChain`; exact read-back strings incl. `0.3` (no float artifacts); all three
enable steps decoded from XDR with argument order/values
(`set_executor(owner, executor)`, `set_rule(owner, rule)`, `approve(from, spender=guard id,
amount, live_until_ledger)`); `live_until = current + days*17280`; exposure dates (UTC +
America/New_York); disable with/without allowance revoke; tighten classification; and a
250-iteration property-style check that the app policy never yields `pay_executor` when
`chooseGuardedRoute` would not.

## Unfinished (handed off)

- **Live testnet run** of the three-step enable (sign + submit + read-back of
  `get_rule`/`get_executor`/SAC `allowance`) — needs network and owner keys; not done here.
- **UI / approval card** for the enable profile, settings tab and voice wiring — Owner A (T5).
- **Voice draft parsing** ("don't ask me for payments under 25 USDC") into `AutoPayDraft` —
  the agent lane.
- **`guard/allowance.ts` revoke helper:** `buildApproveAllowance` rejects `amount <= 0`, so
  `buildDisableAutoPay` builds the `approve(0)` step locally via the guard's read-only
  `buildUnsignedInvoke`/`buildGuardCallSummary`. A `revokeAllowance` helper (or allowing 0)
  in `stellar/src/guard/allowance.ts` would remove the duplication; out of this task's scope.
- **Suggestions engine** (D11, `stellar/src/suggest/`) consumes `AutoPayDraft` but is a
  separate task (T3).

## Blockers

- None functional. `docs/approval-and-scheduling.md` is **not present in this worktree**
  (`chain/guard-client` base) — implementation is grounded on the mandated scratchpad source
  notes (`source-notes-approval-scheduling.md`) and the frozen contract source. If the doc
  lands on `main` with stricter copy, the exact read-back strings in `readback.ts` should be
  re-checked against it.

## Review Notes

- **Default profile:** `resolveApprovalRoute(undefined, chainRoute)` returns `pay_owner`; the
  app can only narrow the chain, never widen it (property test enforces this).
- **`readBack` options `timeZone`/`now`** are accepted (per spec) but the sentence itself is
  intentionally clock-free so read-back tests are exact and deterministic; the card dates live
  in `summary.exposure`.
- **`MAX_ALLOWED_ASSETS = 1`** mirrors the *effective* contract limit (`validate_rule` refuses
  `len() > 1`), not the structural `10`. The app additionally requires at least one asset so an
  `approve` step exists.
- **Failure-after-step-1 caveat:** the enable flow is safe from the intended `always_ask`
  start; a pre-existing positive rule + live allowance is the one case where a newly registered
  executor could inherit an old mandate. Flagged in code and above rather than silently
  assumed away.
- **No signing/submission:** all builders return unsigned XDR + `payloadHash`; nothing calls
  `sign`/`send`. Summaries are decoded from the XDR via the guard's `decodeInvocation`.
- The temporary root `node_modules` symlink was used only to run tests and is removed.

## Suggested Next Step

1. Reviewer: re-run the three gates and attack the validation mirror and the 3-step safe order.
2. Add the `guard/allowance.ts` revoke helper (or allow `amount === 0`) to drop the local
   `approve(0)` builder.
3. Owner A wires the enable card (3 actions, 1 Touch ID) to `buildEnableAutoPay`; the agent
   lane parses voice into `AutoPayDraft`; then a live testnet smoke run.
