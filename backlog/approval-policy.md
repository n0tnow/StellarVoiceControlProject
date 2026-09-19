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
| `buildEnableAutoPay` | `(deps, draft) => Promise<EnableAutoPayResult>` | 3 steps, arming order `approve, set_rule, set_executor`, one card |
| `buildBaselineSetup` | `(deps, { rule, allowanceRaw, allowanceDays, assetContractId }) => Promise<BaselineSetupResult>` | Always-ask baseline: `approve, set_rule` (NO executor) |
| `buildDisableAutoPay` | `(deps, { revokeAllowance }) => Promise<DisableAutoPayResult>` | `revoke_executor` (+ `approve(0)`) |
| `buildTightenRule` | `(deps, nextRule, { allowLoosening? }) => Promise<TightenRuleResult>` | single `set_rule`; refuses loosening by default |
| `assertTightening` | `(change) => void` | throws `use_enable_flow` on loosening/mixed/new_rule |

`ApprovalError` codes: `invalid_amount_string`, `invalid_executor`, `threshold_negative`,
`non_positive_limit`, `amount_out_of_range`, `limit_order`, `too_many_assets`, `no_assets`,
`invalid_asset`, `allowance_too_small`, `invalid_allowance_days`, `missing_asset`, `use_enable_flow`.

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

## Enable 3-step failure-state table (arming order: executor LAST)

> **Corrected in T1-fix (B2).** The SAC allowance is mandatory for every guard
> payment, so the Always-ask baseline already carries one. What ARMS unattended
> payments is the executor registration together with a positive
> `auto_approve_limit`. The executor is therefore the final step.

| Failure point | Resulting on-chain state | Unattended-payment exposure |
|---|---|---|
| step 1 `approve` fails | transaction atomic; allowance, rule and executor all unchanged | none — nothing armed |
| step 1 ok, step 2 `set_rule` fails | only the allowance changed (possibly lower); rule unchanged (`auto_approve_limit == 0` in the baseline) | none — no executor and threshold 0 |
| step 2 ok, step 3 `set_executor` fails | allowance + new positive rule live, but **no executor** | none — `pay_executor` requires a registered executor (#107 `NoExecutor`) |
| all three ok | executor + positive rule + allowance | armed; unattended payments possible up to the mandate |

No prefix of the sequence (0, 1 or 2 steps) can let `pay_executor` succeed; only
the full sequence arms it. Enforced by the pure state-model test in
`enableAutoPay.test.ts`.

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
- **Prefix safety (was the "failure-after-step-1 caveat"):** with the executor registered LAST,
  no prefix of the enable sequence can let `pay_executor` succeed — see the corrected
  failure-state table and the pure state-model test. The earlier allowance-last ordering left a
  window (executor + new positive rule against the mandatory baseline allowance), which T1-fix
  removed.
- **No signing/submission:** all builders return unsigned XDR + `payloadHash`; nothing calls
  `sign`/`send`. Summaries are decoded from the XDR via the guard's `decodeInvocation`.
- The temporary root `node_modules` symlink was used only to run tests and is removed.

## Suggested Next Step

1. Reviewer: re-run the three gates and attack the validation mirror and the arming order.
2. Add the `guard/allowance.ts` revoke helper (or allow `amount === 0`) to drop the local
   `approve(0)` builder.
3. Owner A wires the enable card (3 actions, 1 Touch ID) to `buildEnableAutoPay`; the agent
   lane parses voice into `AutoPayDraft`; then a live testnet smoke run.

---

## Review fixes (T1-fix, 2026-09-19)

Applied the corrections from `backlog/approval-policy-review.md` (independent review, verdict
"approve with corrections"). Scope stayed inside `stellar/src/approval/**` plus this report; no
commit/push/tag; `stellar/src/guard/**` untouched.

| # | Review item | Fix |
|---|---|---|
| B2 | "allowance last is safe" was false once the mandatory baseline allowance exists | Reordered `buildEnableAutoPay` to **`approve` → `set_rule` → `set_executor`** (executor last = the arming step). Updated `order`, `steps`, `summary.actions`, code comments and the failure-state table. Added a pure state-model test proving that prefixes of 0/1/2 steps cannot let `pay_executor` succeed and only the full sequence can. |
| B1 | `set_rule` test asserted through a lossy `scValToNative` round-trip (falsely green against the old ABI bug) | Replaced it with RAW ScVal assertions: `scvSymbol` map keys, `scvI128` for the three limits, `scvAddress` for every `allowed_assets` element, `scvBool` for `known_recipients_only`. Passes now that the guard encoder fix has landed. |
| gap §11e | No builder for the Always-ask baseline | Added `buildBaselineSetup(deps, { rule, allowanceRaw, allowanceDays, assetContractId })` → `steps: [approve, set_rule]` (no executor), `confirmation: "card_and_touch_id"`, XDR-decoded summary + exposure, "Always ask" note. Validation mirrors the contract's `validate_rule` (`per_tx > 0`, `daily > 0`, `0 <= auto_approve_limit <= per_tx <= daily`, one asset in v0.1) plus allowance `>= daily` and days 1..90. Tests: happy path, decoded order/args, every validation error, and the "no executor → no auto-pay" state model. |
| §5 | `buildTightenRule` did not refuse loosening itself | Calls `assertTightening` by default (typed `ApprovalError("use_enable_flow")`, builds nothing). Explicit opt-out `{ allowLoosening: true }` builds the step and still returns `card_and_touch_id`. Tested both ways (loosening + new_rule). |
| §5 / F-06 | Asset ids were not validated | Added typed `invalid_asset` (`StrKey.isValidContract`) for every `allowed_assets` element and for the baseline `assetContractId`. Fixtures use the real testnet USDC SAC id `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` from `contracts/DEPLOYED.md`. |
| §5 | Disable card omitted the design caveats | `buildDisableAutoPay` notes now always state "Revoking the executor does not stop schedules that already exist (cancel them separately)." and, when the allowance is revoked, "Revoking the allowance disables ALL guard payments, including ones you approve yourself." Enable/baseline notes state that schedules need the allowance to cover their total. |
| §5 | The flow did not surface the current allowance | Added optional `currentAllowanceRaw` to the enable/baseline deps. When provided the summary shows `Allowance: <old> -> <new>` and a WARNING line when the new allowance is lower ("may break scheduled payments"). Tested both directions plus the unknown case. |
| §5 | Duplicated `describeValue` | `guard/describe.ts` does not export its helper and `guard/` is out of scope, so the local copy stays with a `TODO(T1-fix)` pointing at the export-and-delete follow-up. |

### Gates re-run (T1-fix)

```
$ caffeinate -i npm run check -w @polaris/stellar        # tsc exit 0
$ caffeinate -i npm run test:approval -w @polaris/stellar
 Test Files  4 passed (4)
      Tests  98 passed (98)
$ caffeinate -i npm test -w @polaris/stellar
 keeper:  ℹ tests 67 / pass 67 / fail 0
 anchor:  Test Files 5 passed / Tests 111 passed
 payments: Test Files 7 passed / Tests 121 passed
 guard:   Test Files 7 passed / Tests 133 passed   (incl. the golden ABI tests)
 approval: Test Files 4 passed / Tests 98 passed
```

Total = 67 + 111 + 121 + 133 + 98 = **530 passed, 0 failed**.

Acceptance: `git status --short` lists only `stellar/src/approval/**` and
`backlog/approval-policy.md`; the temporary root `node_modules` symlink is removed.

---

## Review fixes 2 (T1-fix2, 2026-09-19)

Applied the corrections from `backlog/approval-policy-review-2.md` (delta re-review, verdict
"approve with corrections"). Scope stayed inside `stellar/src/approval/**` plus this report; no
commit/push/tag; `stellar/src/guard/**` untouched.

| # | Review item | Fix |
|---|---|---|
| B1 | Enable card never called out step 3 as the arming step | Added `ARMING_STEP_NOTE` as the **first** `summary.notes` entry and marked the `set_executor` action with `arming: true` (new optional field on `ApprovalActionSummary`). Tests: note is first, only the third action is flagged, and the baseline has no arming action/note. |
| NB1 | Prefix-safety precondition was stated but not enforced | Added optional `current?: { rule?; executor? }` to `EnableAutoPayDeps`. When provided and the account is already armed (executor registered **and** `auto_approve_limit > 0`), `buildEnableAutoPay` refuses with typed `ApprovalError("already_armed")` and builds nothing; the message points at the tighten/disable flows. Omitted `current` keeps behaviour unchanged (documented caller precondition). Tests: armed refusal, both partially-armed cases, and the omitted case. |
| NB3 | Identical-rule tighten built a pointless no-op `set_rule` | `buildTightenRule` now returns `{ steps: [], classification: "same", confirmation: "none" }` without calling the guard. `TightenRuleResult.step` became `steps: BuiltApprovalStep[]`; existing tighten tests updated. Test asserts the exact no-build result and an empty `rpc.simulated`. |
| NB4 | `assetContractId` was not cross-checked against `rule.allowed_assets` | Added `assertAssetMatchesRule(assetContractId, rule)` (typed `invalid_asset`) called from both `validateBaselineSetup` and `validateAutoPayDraft`. Tests: baseline mismatch, helper match/unknown/mismatch, and the enable draft passes its own matching asset. |
| NB2 | State model omitted invariant contract gates | Added a comment above `ChainState` listing the gates deliberately not modelled (rule present, asset allowed, `per_tx`/`daily` caps, `known_recipients_only`) and why they are constant across the sequence. |
| NB6 | Exposure limits were read from the input, not the signed XDR | Added `ruleFromSetRuleXdr` and both enable/baseline `exposure.thresholdRaw`/`dailyLimitRaw` now decode back from the produced `set_rule` XDR. Tests assert exposure equals the decoded values for both builders. |

### Gates re-run (T1-fix2)

```
$ caffeinate -i npm run check -w @polaris/stellar        # tsc exit 0
$ caffeinate -i npm run test:approval -w @polaris/stellar
 Test Files  4 passed (4)
      Tests  112 passed (112)
$ caffeinate -i npm test -w @polaris/stellar
 keeper:  ℹ tests 67 / pass 67 / fail 0
 anchor:  Test Files 5 passed / Tests 111 passed
 payments: Test Files 7 passed / Tests 121 passed
 guard:   Test Files 7 passed / Tests 133 passed
 approval: Test Files 4 passed / Tests 112 passed
```

Total = 67 + 111 + 121 + 133 + 112 = **544 passed, 0 failed** (was 530; +14 approval tests).

Acceptance: `git status --short` lists only `stellar/src/approval/**` and
`backlog/approval-policy.md`; the temporary root `node_modules` symlink is removed.
