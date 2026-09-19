# Review: guard-client

- Date: 2026-09-19  - Reviewer: opencode-go/deepseek-v4.1-flash (L4, independent)  - Reviewed: branch `chain/guard-client` (last 2 commits, `git diff HEAD~2`)
- Method: read-only code/XDR analysis + a throwaway scratch test (all offline, no network). All temporary files/mutations removed; `git status --short` before writing this file showed only the `node_modules` symlink and the scratch test, both now deleted.

## Verdict: reject

1. **Blocking ABI bug:** `setRule` encodes the `Rule` struct argument as an `ScMap` with **`scvString` keys**, **`scvU64` i128 fields** and **`scvString` addresses**; the contract expects **`scvSymbol` keys**, **`scvI128` values** and **`scvAddress`** elements. On-chain `set_rule` cannot succeed, so an owner can never publish a rule through this client.
2. The execution path (`pay_owner`/`pay_executor`), routing policy, amount math, error mapping, allowance helper, contract-id parametrisation and the guarded `sendPayment` summary all checked out and resisted the break attempts below.
3. Fix is small and localized to `stellar/src/guard/client.ts` (+ a real assertion in `client.test.ts`); after that this can be approved with the non-blocking notes.

## 1. Numbers I re-ran (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar
> tsc -p tsconfig.json
(clean, no output)

$ caffeinate -i npm run test:guard -w @polaris/stellar
 Test Files  6 passed (6)
      Tests  113 passed (113)

$ caffeinate -i npm test -w @polaris/stellar
 test:keeper   tests 67  pass 67  fail 0
 test:anchor   Test Files 5 passed (5)   Tests 111 passed (111)
 test:payments Test Files 6 passed (6)   Tests 113 passed (113)
 test:guard    Test Files 6 passed (6)   Tests 113 passed (113)
```

Comparison with the worker's claims (`backlog/guard-client.md` §"Test results"): **all exact.** `check` clean; guard 113; payments 113; keeper 67; anchor 111. (The `check` command failed on my scratch file only because of its loose test-only typing; re-running against the deliverable alone was clean. `check` is not part of the final state.)

Count correction (documentation only): the report says "126 new tests (113 guard, **13** payments)"; the new `sendPayment.guarded.test.ts` actually contains **16** `it(` cases (`grep -c "  it("`), so new tests = 129. Guards + payments total tests still match.

## 2. ABI fidelity table

Ground truth: `contracts/polaris_guard/src/lib.rs`. Client method arg order, XDR arg types and tx source all match **except `setRule` value/key encoding**. The client sets the tx source to the first actor argument for every write, which is exactly the address each contract fn calls `require_auth()` on.

| Client method | Contract fn | lib.rs line | args match? | signer matches `require_auth`? |
|---|---|---|---|---|
| `setRule(owner, rule)` | `set_rule(owner, rule)` | 326 | **NO — arg TYPES wrong** (emits an ScMap with string keys / u64 values / string addresses; contract wants symbol keys / i128 / addresses) | yes (owner) |
| `getRule(owner)` | `get_rule(owner)` | 335 | yes | n/a (read) |
| `setExecutor(owner, executor)` | `set_executor(owner, executor)` | 341 | yes | yes (owner) |
| `revokeExecutor(owner)` | `revoke_executor(owner)` | 351 | yes | yes (owner) |
| `getExecutor(owner)` | `get_executor(owner)` | 356 | yes | n/a |
| `setAlias(owner, alias, address)` | `set_alias(owner, alias, address)` | 369 | yes | yes (owner) |
| `removeAlias(owner, alias)` | `remove_alias(owner, alias)` | 386 | yes | yes (owner) |
| `getAlias(owner, alias)` | `get_alias(owner, alias)` | 397 | yes | n/a |
| `isKnownRecipient(owner, to)` | `is_known_recipient(owner, to)` | 405 | yes | n/a |
| `payOwner(owner,to,asset,amount)` | `pay_owner(owner,to,asset,amount)` | 414 | yes (scvAddress×3 + scvI128) | yes (owner) |
| `payExecutor(executor,owner,to,asset,amount)` | `pay_executor(executor,owner,to,asset,amount)` | 443 | yes, correct order (scvAddress×4 + scvI128) | yes (executor) |
| `spentToday(owner)` | `spent_today(owner)` | 502 | yes | n/a |
| `createSchedule(owner,to,asset,amount,firstRunAt,intervalSecs,runs)` | `create_schedule(...)` | 516 | yes (addr×3, i128, u64, u64, u32) | yes (owner) |
| `cancelSchedule(owner,id)` | `cancel_schedule(owner,id)` | 598 | yes (addr,u32) | yes (owner) |
| `getSchedule(id)` | `get_schedule(id)` | 716 | yes | n/a |
| `listSchedules(owner)` | `list_schedules(owner)` | 722 | yes | n/a |
| `nextScheduleId()` | `next_schedule_id()` | 743 | yes (no args) | n/a |
| `buildApproveAllowance(...)` | SAC `approve(from,spender,amount,live_until_ledger)` (SEP-41) | n/a | yes: addr, addr, i128, **u32** (correct per DEPLOYED.md/SDK, not `expiration_ledger`) | yes (`from`) |
| `getAllowance(...)` | SAC `allowance(from,spender)` | n/a | yes | n/a |

Struct/type mirrors:

| TS type | contract struct | field names/order | types |
|---|---|---|---|
| `Rule` (`types.ts:26`) | `Rule` (`lib.rs:166`) | exact (snake_case) | `bigint`×3, `string[]`, `boolean` — all read/decode correctly |
| `Schedule` (`types.ts:40`) | `Schedule` (`lib.rs:187`) | exact | `number,string,string,string,bigint,bigint,bigint,number,boolean` — correct |

Map key ordering: `nativeToScVal` sorts object keys alphabetically (`scval.js:107`) and the contract derive sorts fields alphabetically too (`soroban-sdk-macros-28.0.0/src/derive_struct.rs:29`), so ordering is fine; only the key **type** and the value types are wrong.

Negative i128: all amount fields are validated `> 0` before build (`route.ts:53`, `allowance.ts:75`), so the i128 hi/lo sign path is never exercised with a negative; `scValToNative`/`nativeToScVal(i128)` handling for the read path is correct. u64/u32 ranges: `createSchedule` uses `scU64`/`scU32` and `nextScheduleId`/`cancelSchedule`/`getSchedule` use `scU32`, matching lib.rs.

## 3. Break attempts (input | expected | actual | result)

All run in a temporary scratch test against the real source (deleted afterwards).

| Input / attack | Expected | Actual | Result |
|---|---|---|---|
| Inspect raw `setRule` ScMap: key types | `scvSymbol` | `scvString` | **FAIL (blocking)** |
| Inspect raw `setRule` ScMap: i128 fields | `scvI128` | `scvU64` | **FAIL (blocking)** |
| Inspect raw `setRule` ScMap: `allowed_assets` elements | `scvAddress` | `scvString` | **FAIL (blocking)** |
| `toRawUnits("922337203685.4775807")` | `9223372036854775807n` | same | PASS |
| `toRawUnits("170141183460469231731687303715884105728")` (> i128) | refuse | `InvalidAmount` | PASS |
| `toRawUnits("0.00000001")` (8 dp) | refuse | `InvalidAmount` | PASS |
| `toRawUnits` non-ASCII digits `"١٠"` | refuse | `InvalidAmount` | PASS |
| 20 random raw values `fromRawUnits→toRawUnits` | identity | identity | PASS |
| Route: `amount == auto_approve_limit` | `pay_executor` | `pay_executor` | PASS |
| Route: `amount == per_tx_limit` | `pay_owner` (soft cap wins) | `pay_owner` | PASS |
| Route: `amount == per_tx_limit + 1n` | `OverPerTxLimit` | `OverPerTxLimit` | PASS |
| Route: `amountRaw == 0`, `< 0` | `InvalidAmount` | `InvalidAmount` | PASS |
| Route: `amountRaw > i128::MAX` | refuse | `InvalidAmount` | PASS (falls through `> per_tx`) |
| Route: asset ∉ `allowed_assets` | `AssetNotAllowed` | `AssetNotAllowed` | PASS |
| Route: unknown recipient, `known_recipients_only` off | `pay_executor` | `pay_executor` | PASS |
| Route: no executor | `pay_owner` | `pay_owner` | PASS |
| Route: executor registered, `auto_approve_limit == 0` | `pay_owner` | `pay_owner` | PASS |
| Guarded `sendPayment`, alias `ada`: decode XDR; compare summary `to`/`amount`/`asset` with invocation args | equal | equal (`pay_executor` and `pay_owner`) | PASS |
| Guarded recipient `"constructor"`, `"__proto__"`, `"toString"` | `unknown_recipient` | `unknown_recipient` | PASS |
| Guarded non-string `amount`/`asset`/`recipient` | typed refusals, no `TypeError` | `invalid_amount`/`unsupported_asset`/`unknown_recipient` | PASS |
| Simulated `#104` (OverDailyLimit) | `guard_limit_exceeded` + name `OverDailyLimit` + raw host text preserved | same, message contains `HostError: Error(Contract, #104)` | PASS |
| Two clients, different contract ids | different XDR, correct id each | differing XDR, ids correct (`client.test.ts:135`) | PASS |
| Grep deployed id / any `C…56` in non-test guard+payments | none | none (only `source-scan.test.ts:14` test fixture) | PASS |
| `Buffer` / `node:` in guard non-test modules | none | none (only comments + test `fs`) | PASS |

Is the decision ever looser than the chain? **No.** `chooseGuardedRoute` refuses `<=0`, disallowed asset and `> per_tx_limit`, and otherwise only returns `pay_executor` when a registered executor, `<= auto_approve_limit` and (if required) a known recipient all hold — exactly `pay_executor`'s checks. Strictly, `pay_owner` on-chain ignores `allowed_assets`, but refusing a non-allowlisted asset up front is required by the brief (req. 3) and `DEPLOYED.md` F-06, so the extra strictness is justified. Daily limit is intentionally not checked client-side (no spend counter); the contract enforces it and a `#104` write-simulation surfaces as `guard_limit_exceeded` (verified above) — acceptable, and documented in the worker report and `route.ts:20`.

## 4. Blocking issues (exact fix each)

**B1 — `setRule` mis-encodes the `Rule` struct argument.**
Evidence:
- `stellar/src/guard/client.ts:89` → `nativeToScVal(rule)` with no type spec.
- SDK `node_modules/@stellar/stellar-sdk/lib/esm/base/scval.js:105-116`: a plain object is encoded with `scvString` keys and inferred value types (non-negative bigint → `scvU64`, string → `scvString`).
- Contract derive `soroban-sdk-macros-28.0.0/src/derive_struct.rs:53,66` encodes/looks up struct fields with `ScSymbol(field_name)`, and `lib.rs:166-177` types them `i128`/`Vec<Address>`/`bool`.
- Scratch test raw output of the built XDR: keys `scvString`, `auto_approve_limit/daily_limit/per_tx_limit` = `scvU64`, `allowed_assets` elements = `scvString`. (Correct encoding, produced with an explicit type spec, is `scvSymbol` / `scvI128` / `scvAddress`.)
- Not caught because `client.test.ts:37` only asserts `args[1].type === "scvMap"`, and the fake RPC accepts every simulation.

Exact fix (replace the `scAddress`/`setRule` usage in `client.ts`):

```ts
import { Address, nativeToScVal } from "@stellar/stellar-sdk";

const ruleToScVal = (rule: Rule): xdr.ScVal =>
  nativeToScVal(
    { ...rule, allowed_assets: rule.allowed_assets.map((a) => new Address(a)) },
    {
      type: {
        auto_approve_limit: ["symbol", "i128"],
        per_tx_limit: ["symbol", "i128"],
        daily_limit: ["symbol", "i128"],
        allowed_assets: ["symbol", "address"],
        known_recipients_only: ["symbol", "bool"],
      },
    },
  );

setRule(owner: string, rule: Rule): Promise<GuardCall> {
  return this.write(owner, "set_rule", [scAddress(owner), ruleToScVal(rule)]);
}
```

(Encoding `allowed_assets` as `Address` instances is deliberate: with the SDK's array spec `["address"]`, only the first Vec element is typed as an address and the 2nd+ degrade to `scvString` — currently moot because v0.1 rejects `allowed_assets.len() > 1`, but the `Address`-instance form is robust.) Add a test in `client.test.ts` that asserts, for the decoded `set_rule` map: every key is `scvSymbol`, the three limits are `scvI128`, and every `allowed_assets` element is `scvAddress`. That test currently fails against the submitted code.

No other blocking issues found.

## 5. Non-blocking suggestions

1. `client.test.ts` asserts argument **types** only for `setRule`/`setExecutor`/`payExecutor` etc.; it should also assert decoded argument **values** (the guarded-payment test caught the arg-order mutation, the guard's own suite did not).
2. Fix the report's test count: new guarded tests are 16, not 13 (new total 129, not 126).
3. `toRawUnits` caps the integer part at 12 digits (`amount.ts:27`), stricter than i128. It is consistent with `sendPayment`'s `MAX_STROOPS`/`AMOUNT` (`sendPayment.ts:108`) and safe, but the docstring says only "at most 7 fraction digits" — mention the 12-integer-digit bound.
4. `allowanceExpiryLedger` does not bound `currentLedger + days*17280` to `u32`; an absurd `days` would surface a raw `TypeError` from `nativeToScVal(..., {type:"u32"})` rather than a typed `GuardClientError`.
5. `buildApproveAllowance` trusts the caller's `spender` with no cross-check against a guard id (D9-consistent, but a documented footgun). Consider accepting the guard id and asserting equality.
6. `guardedPayment` evaluates `toRawUnits(amount)` outside its `try` (`sendPayment.ts:374`); it cannot throw after `assertPositiveAmount`, but moving it inside keeps every guard failure a typed `PaymentRefusal`.
7. `buildGuardCallSummary`/`buildGuardedPaymentSummary` throw plain `Error` on a contract/route mismatch, not a typed error; low risk since the client builds the XDR, but the caller's `catch` assumes typed errors.
8. UNVERIFIED (no network, worker acknowledges): real `rpc.Server.simulateTransaction` + `assembleTransaction` assembly (footprint/auth/resource fee/restore) and any live testnet run. Static structure mirrors the keeper and is fine.

## 6. Mutation / test-quality notes

Plausible-mutation analysis for the 5 key behaviours:

| Behaviour | Plausible mutation | Caught? |
|---|---|---|
| `pay_executor` arg order | swap `scAddress(executor)`/`scAddress(owner)` | YES by `sendPayment.guarded.test.ts` (value assertion); **NO** by `client.test.ts` (types only) |
| owner vs executor route choice | `>` → `>=` on `auto_approve_limit` | YES (`route.test.ts:34`) |
| allowance ledger math | `17_280` → `17_281` | YES (`allowance.test.ts:24`) |
| error mapping | rename a `GUARD_ERRORS` variant | YES (drift guard vs lib.rs) |
| summary decoded from XDR | read `to` from the wrong offset | YES (`sendPayment.guarded.test.ts`) |

Real mutations executed (edit → targeted test → `git checkout --` revert), all reverted:

1. `client.ts` `payExecutor` arg order swapped → `client.test.ts` **PASSED** (weak types-only assertion) but `sendPayment.guarded.test.ts` **FAILED** — recorded as a test-quality gap, not a code bug.
2. `route.ts` `amountRaw > auto_approve_limit` → `>=` → `route.test.ts` **FAILED** ("routes exactly at auto_approve_limit to pay_executor").
3. `allowance.ts` `LEDGERS_PER_DAY = 17_281` → `allowance.test.ts` **FAILED** (3 cases).
4. `keeper/errors.ts` `103: OverPerTxLimit` → `OverPerTxLimitBROKEN` → `errors.test.ts` **FAILED** two drift guards (the one comparing `GUARD_ERROR_NAMES` to the `#[contracterror]` enum parsed from `lib.rs`). Reverted.
5. `describe.ts` summary `args[offset + 1]` → `args[offset]` → `sendPayment.guarded.test.ts` **FAILED**.

Conclusion on mutation coverage: the routing, allowance, drift-guard and XDR-summary behaviours are genuinely test-backed; `setRule`'s actual encoding is **not** (the fake RPC + `scvMap`-only assertion let the blocking B1 through), and `client.test.ts`'s type-only assertions leave value/order regressions to the payments suite only.
