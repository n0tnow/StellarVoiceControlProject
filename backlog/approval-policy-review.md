# Review: approval-policy

- **Date:** 2026-09-19
- **Reviewer:** W-review-T1 (DeepSeek v4.1 Flash, L4) — independent; did **not** write T1
- **Branch/worktree:** `review/approval-policy` (== `chain/approval-policy`) / `.worktrees/approval-policy-review`
- **Under review:** `git diff HEAD~2` = `2a23a75` (feat) + `510ca55` (report)
- **References:** spec `brief-t1-approval.md`; design `docs/approval-and-scheduling.md` (read via sibling worktree, correction `df9b1f6`); contract `contracts/polaris_guard/src/lib.rs` (read-only ground truth)
- **Method:** gates re-run, source read line-by-line, temporary scratch test + 4 real mutations (all reverted). No network.

## Verdict: approve with corrections

T1 implements D10/D10b/D10c faithfully and all 491 tests genuinely pass; classification, read-back, routing and the three-step builder are sound and mutation-resistant.
Two corrections are required before merge: (1) the `set_rule` ABI test asserts through a lossy `scValToNative` round-trip and is therefore falsely green against the known-broken guard encoder, and (2) the "allowance last is safe" failure-state claim is wrong under the design-mandated baseline allowance.
Neither blocks the design; both are cheap and exact.

## 1. Numbers re-run (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar      # exit 0, tsc clean
$ caffeinate -i npm run test:approval -w @polaris/stellar
 Test Files  4 passed (4)
      Tests  79 passed (79)

$ caffeinate -i npm test -w @polaris/stellar
 ℹ tests 67        (keeper: node --test, pass 67, fail 0)
 Test Files  5 passed (5)
      Tests  111 passed (111)   (anchor)
 Test Files  7 passed (7)
      Tests  121 passed (121)   (payments)
 Test Files  6 passed (6)
      Tests  113 passed (113)   (guard)
 Test Files  4 passed (4)
      Tests  79 passed (79)     (approval)
```

Total = 67 + 111 + 121 + 113 + 79 = **491 passed, 0 failed**. Matches the worker's claim exactly (`backlog/approval-policy.md:116-128`). **PASS.**

## 2. Validation fidelity table

Contract ground truth `contracts/polaris_guard/src/lib.rs:859-882` (`validate_rule`).

| Contract check | T1 check (`stellar/src/approval/types.ts`) | Match? |
|---|---|---|
| `per_tx_limit <= 0 \|\| daily_limit <= 0` → `InvalidRule` | `perTxLimitRaw <= 0n \|\| dailyLimitRaw <= 0n` → `non_positive_limit` (`:180`) | ✅ |
| `auto_approve_limit < 0` → `InvalidRule` | `thresholdRaw < 0n` → `threshold_negative` (`:176-178`) | ✅ |
| `auto_approve_limit == 0` **accepted** by contract | accepted (`:176` only rejects `< 0`); test `types.test.ts:108` | ✅ |
| `auto_approve_limit > per_tx_limit \|\| per_tx_limit > daily_limit` → `InvalidRule` | `thresholdRaw > perTxLimitRaw \|\| perTxLimitRaw > dailyLimitRaw` → `limit_order` (`:193-198`) | ✅ |
| `allowed_assets.len() > MAX_ALLOWED_ASSETS (10)` → `InvalidRule` | `> MAX_ALLOWED_ASSETS` with `MAX_ALLOWED_ASSETS = 1` (`:87,202`); superseding the `>1` rule | ✅ (stricter-or-equal) |
| `allowed_assets.len() > 1` → `InvalidRule` (effective v0.1) | same `too_many_assets` (`:202-207`) | ✅ |
| empty `allowed_assets` accepted (agent pays nothing) | **rejected** `no_assets` (`:208-210`) | ✅ app-stricter, justified (needs an asset to `approve`); documented |
| `i128` range (network/ABI) | `> I128_MAX` → `amount_out_of_range` (`:154-158,187-190`) | ✅ |
| — (not a rule field) | allowance `> 0`, `>= daily_limit`; `allowance_days` int 1..90; executor valid `G...` (`:183,213-229`) | ✅ app-stricter, justified |
| — (asset id validity) | **not checked**: `allowedAssets: ["not-a-contract-id"]` is ACCEPTED (probe) | ⚠️ non-blocking (deferred to SDK / caller per F-06) |

No draft T1 accepts can be rejected on-chain by `validate_rule`, and every stricter rejection is either a documented app-only rule or a genuine pre-condition. **PASS** (one non-blocking gap). Note: the "max allowed assets = 1" brief is satisfied via `MAX_ALLOWED_ASSETS = 1`; the structural constant `10` is correctly explained in the doc comment.

## 3. Break attempts

| Input | Expected | Actual | Result |
|---|---|---|---|
| `classifyChange` full grid: 3 limits × {down,eq,up} × assets {grow,shrink,same} × known {on→off,off→on,same-off,same-on} = 324, vs independent partial-order oracle (my scratch) | impl == oracle; loosening/mixed/new never light | 324/324 match; all loosening/mixed/new → `card_and_touch_id` | PASS |
| 200 seeded random rule pairs vs the same partial-order oracle | impl == oracle; ≥3 distinct classes exercised | match every iteration; all 5 classes produced | PASS |
| read-back `0.3`, `0.1+0.2`, `0.0000001`, `922337203685.4775807`, `999999999999.9999999`, single/multi asset, known true/false | exact, no float artifact, no sci-notation | `0.3`, `0.0000001`, i64-scale exact, no `e+`; known toggles wording | PASS |
| `validateAutoPayDraft` boundary probes (0 threshold, 0/negative limits, threshold>per_tx, per_tx>daily, 2 assets, empty assets, allowance<daily) | contract boundaries respected | matched each intended code; invalid asset string ACCEPTED (see §5) | PASS |
| `setRule` rule argument — raw ScVal types | `scvI128`×3, `scvAddress` asset, **symbol** map keys | actual: `scvU64`×3, `scvString` asset, `scvString` keys (`{auto_approve_limit:"scvU64", per_tx_limit:"scvU64", daily_limit:"scvU64", allowed_assets:["scvString"], known_recipients_only:"scvBool"}`) | **FAIL** (guard bug; T1 test is green — see §4/§1) |
| enable builder, draft passed with distinct raw values | 3 steps in order; decoded args `set_executor(owner,executor)`, `set_rule(owner,rule)`, `approve(from,spender=guard,amount,live_until)` | matches exactly; `live_until = current + days*17280` | PASS |
| `buildTightenRule(current, loosening)` | never `light` | `classification="loosening"`, `confirmation="card_and_touch_id"` | PASS |
| guarded route default (no `approvalProfile`), amount ≤ `auto_approve_limit`, executor present | `pay_owner` (chain would allow `pay_executor`) | `pay_owner`, source=owner, summary "card required: yes" | PASS |
| guarded route `auto_under_limit`/`custom` | defer to `chooseGuardedRoute` | `pay_executor` for ≤, `pay_owner` above/unknown/no-executor | PASS |
| step-2-ok / step-3-fail with the design-mandated **baseline allowance already present** | no unattended path (claim) | executor + new positive rule + live baseline allowance → `pay_executor` succeeds | **FAIL** (claim only; see §4/2) |

## 4. Blocking issues (exact fix each)

**B1 — `set_rule` test is falsely green against the known ABI bug (paper-over).**
- Evidence: `stellar/src/approval/__tests__/enableAutoPay.test.ts:72-78` (and the line check at `:103`) assert `scValToNative(call.args[1])` equals the intended JS object. `scValToNative` decodes `scvU64`→`bigint`, `scvString`→`string`, so it cannot distinguish `scvU64` from `scvI128`, nor `scvString` from `scvAddress`. My probe shows the current `setRule` (`stellar/src/guard/client.ts:89`, `nativeToScVal(rule)`) emits `scvU64` limits, `scvString` asset entries and `scvString` keys, which the contract cannot decode as `Rule` — yet the T1 test passes. The decoded card summary (`describeValue`) likewise prints the intended numbers/strings, so the card also looks correct.
- Fix (T1 file only): replace the round-trip assertion with a raw-type assertion, e.g. in `enableAutoPay.test.ts` after obtaining the `set_rule` rule `ScVal`, assert `type === "scvI128"` for `auto_approve_limit`/`per_tx_limit`/`daily_limit`, `"scvAddress"` for each `allowed_assets` element, and symbol map keys. (Scratch reproduction available in the reverted `zz-review.scratch.test.ts`.) This is expected to fail until `chain/guard-client` lands the encoder fix; coordinate the two PRs so the guard fix lands first/same time.

**B2 — "allowance last" is not safe once the baseline allowance exists.**
- Evidence: `stellar/src/approval/enableAutoPay.ts:25-27` and `backlog/approval-policy.md:99` state that after step 1 `set_executor` and step 2 `set_rule`, a failed step 3 leaves "executor + rule armed but the guard has no allowance ... no money can move". But the design makes the allowance MANDATORY in the Always-ask baseline (`docs/approval-and-scheduling.md:65-71`, §11e): the first-time setup already creates `approve(owner→guard)` plus `set_rule` (auto_approve_limit 0). Therefore after step 2 the executor is registered and the new positive rule is live **against the pre-existing allowance** — the exact window the ordering claims to eliminate. (After step 1 alone it is still safe because the baseline rule has threshold 0.)
- Fix (minimum): correct the comment block and the report's failure-state row to state the real state: "step 2 ok, step 3 fails → executor + new rule armed; a pre-existing baseline allowance (mandatory, design §2) still funds unattended payments up to the old allowance; the app must re-read the allowance and report it." (Preferred): change the order to `approve → set_executor → set_rule` (still exactly 3 calls; a failure at any point leaves either no executor or the old threshold-0 rule, so no window), and escalate the ordering change to the design owner since §3.1/§11d currently mandate allowance-last. Retrieving the line numbers for the reorder is `enableAutoPay.ts:206-210`.

## 5. Non-blocking

- `profileFromChain` (`classify.ts:70`) is exported but unused in production (only tests). Intended for the shell; fine, but dead until T5 wires it.
- Asset ids are not validated as `C...` contract addresses (`types.ts:202-210`); an invalid string passes validation and only fails later in the SDK/network. Cheap fix: assert `StrKey.isValidContract` per asset (would become visible once B1's guard fix lands).
- `buildTightenRule` returns the classification but does not call `assertTightening` itself (`enableAutoPay.ts:313-324`). A careless shell that ignores `confirmation` could submit a loosening under a "light" label. Recommend an opt-out `assertTightening` call by default (the helper already exists at `classify.ts:83`).
- `buildDisableAutoPay` summary omits two design caveats: revoking the executor does not stop existing schedules, and revoking the allowance also disables `pay_owner` (`docs/approval-and-scheduling.md:142-145,341`). Add them to the card lines.
- The enable flow does not read the current allowance; if the baseline allowance is **larger** than the draft's, `approve(new)` silently lowers it, which can break schedules the design says the allowance must cover (`:136`). Read current allowance and surface an increase/decrease.
- `describeValue` is duplicated in `enableAutoPay.ts:139-149` and `guard/describe.ts:67-79`.
- `buildRevokeAllowanceCall` (`enableAutoPay.ts:243-269`) re-implements approval plumbing because `guard/allowance.ts:73-81` rejects `amount <= 0`; documented honestly in the report's Unfinished.
- The property test's generator (`classify.test.ts:165-206`) always yields `auto_approve_limit >= 1`, so the `0` case is covered only by `profileFromChain` unit tests — acceptable.
- Hygiene: no secrets, no `Buffer`/`node:`, no hard-coded `C...` ids in `stellar/src/approval/**`; `stellar/src/payments/__tests__/sendPayment.guarded.test.ts` changed only the `guardedDeps()` fixture (+5 lines) to opt into `auto_under_limit`, which preserves (not weakens) the chain-routing tests; the new default is covered by the new `sendPayment.approval.test.ts`. `stellar/src/index.ts` adds only the `approval` namespace; `package.json` only adds `test:approval` (+ appended to `test`); `stellar/src/guard/**` untouched.

## 6. Mutation results table

| # | Mutation | File mutated / reverted | Test command | Failed? |
|---|---|---|---|---|
| a | Swap enable step order (`set_rule` before `set_executor`) | `stellar/src/approval/enableAutoPay.ts:206-210` | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 4 failed / 18 |
| b | `known_recipients_only` true→off classified as tightening | `stellar/src/approval/classify.ts:40` | `vitest run src/approval/__tests__/classify.test.ts src/approval/__tests__/zz-review.scratch.test.ts` | **YES** — 3 failed / 40 (worker test + oracle) |
| c | `always_ask` falls through to the chain route | `stellar/src/approval/routing.ts:24-25` | `vitest run src/approval/__tests__/classify.test.ts src/payments/__tests__/sendPayment.approval.test.ts` | **YES** — 6 failed / 39 |
| d | Drop the expiry `days * LEDGERS_PER_DAY` multiplication | `stellar/src/guard/allowance.ts:49` (dependency used by the builder) | `vitest run src/approval/__tests__/enableAutoPay.test.ts` | **YES** — 6 failed / 18 |

All mutations reverted via `git checkout -- <file>`; no residual edits.

## 7. Gaps vs design doc

1. **No baseline-setup builder (main gap).** Design §11e: the first-time flow is `approve` (allowance, mandatory) → `set_rule` (Always ask: no executor, `auto_approve_limit = 0`) → aliases (`docs/approval-and-scheduling.md:580`). T1 provides only enable (`set_executor,set_rule,approve`), disable and tighten. There is no builder for the "Always ask" baseline that even `pay_owner` requires. Concrete proposal: add `buildBaselineSetup(deps, { rule, allowanceRaw, days, assetContractId })` returning `steps: [approve, set_rule]` (no `set_executor`), `confirmation: "card_and_touch_id"`, using the same XDR-decoded summaries; then have `buildEnableAutoPay` assert the baseline allowance exists (or read+raise it, see §5).
2. **Allowance-last safety claim** — see B2; requires doc/comment correction (and ideally reorder).
3. **Schedules interlock** — the enable/disable builders do not mention that `allowance < largest schedule total` breaks scheduled payments, nor that a partial disable leaves schedules running (`docs/approval-and-scheduling.md:140-145,334`). Out of T1's file scope (`keeper`/T2) but the card copy should say it.
4. **Live testnet run, UI card and voice parsing** correctly deferred (report Unfinished; T5/agent lanes).

Scope/hygiene: changed files are exactly the allowed set; the review's temporary `node_modules` symlink and scratch test are removed before finishing.

---

*Reviewer note:* reproduced B1 by decoding the raw `ScVal` of the `set_rule` argument (expected `scvI128`/`scvAddress`/symbol keys; observed `scvU64`/`scvString`/string keys). The worker's report honestly flags the guard encoder as unfinished work, but does not flag that its own step-2 test cannot detect it.
