# Review 2 (delta): guard-client fix

- Date: 2026-09-19  - Reviewer: opencode-go/deepseek-v4.1-flash (L4, fresh session, independent)  - Branch: `review/guard-client-2` == `chain/guard-client`, delta commit `949d05f`
- Method: read-only analysis + throwaway scratch tests (offline, no network) + independent extraction of the wasm spec with `@stellar/stellar-sdk@17.1.0`. All scratch files and the root `node_modules` symlink were removed; every temporary source mutation reverted with `git checkout -- <file>`. `git status --short` ends with only this file.

## Verdict: approve

1. Blocking **B1 is fixed for real**: `setRule` now emits `scvSymbol` keys, `scvI128` limits, a `Vec<scvAddress>` allowlist and `scvBool`, and is byte-for-byte identical to `Spec.funcArgsToScVals("set_rule", …)` for 0/1/2 assets and limits `0 / 1 / i128::MAX` (`client.ts:43-55,110`).
2. The committed golden fixture is trustworthy: it is the wasm's own `ScSpecEntry` stream (sha256 `c4f65e65…98e6`), all 26 entries byte-identical to my independent `Spec.fromWasm` extraction; function list, input types, `Rule`/`Schedule` fields and the 17-case error enum all match. The wasm is not committed.
3. All four required mutations break a test; the golden test caught (a)(b)(c) with a per-arg diff. (d) is caught by `client.test.ts`, not by the golden test — see §7. Remaining items are non-blocking hardening, not correctness bugs.

## 1. Numbers re-run (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar
> tsc -p tsconfig.json
(clean, no output)

$ caffeinate -i npm run test:guard -w @polaris/stellar
 Test Files  7 passed (7)
      Tests  133 passed (133)

$ caffeinate -i npm test -w @polaris/stellar
  test:keeper   tests 67  pass 67  fail 0
  test:anchor   Test Files 5 passed (5)   Tests 111 passed (111)
  test:payments Test Files 6 passed (6)   Tests 113 passed (113)
  test:guard    Test Files 7 passed (7)   Tests 133 passed (133)
```

Total = 67 + 111 + 113 + 133 = **424**, matching the worker's claim exactly. `abi-golden.test.ts` has 20 vitest cases (17 per-function + fixture-list + 2 struct round-trips); `sendPayment.guarded.test.ts` has 16 `it(` cases (report's corrected count). Report claim "133 guard (113 + 20)" is accurate.

## 2. B1 verification

Scratch test built `setRule` through the real client and decoded the raw `ScVal` of `args[1]` (base64 of the transaction), for three rules: 0 assets / limits `0`; 1 asset / limits `1`; 2 assets / limits `i128::MAX`.

- Keys: every map key `scvSymbol` (5 entries) — PASS.
- `auto_approve_limit`, `per_tx_limit`, `daily_limit`: `scvI128` — PASS.
- `allowed_assets`: `scvVec` whose every element is `scvAddress` (0, 1 and 2 elements) — PASS.
- `known_recipients_only`: `scvBool` — PASS.
- Stronger: the full produced args array is **byte-for-byte equal** (base64 XDR) to `spec.funcArgsToScVals("set_rule", {owner, rule})` for all three rules — PASS.

Source: `client.ts:43-55` (`ruleToScVal`, explicit `["symbol","i128"|"address"|"bool"]` spec; each asset wrapped in `new Address`), called at `client.ts:110`. The 2-element case confirms the previous reviewer's concern about only the first vector element degrading to `scvAddress` is moot with `Address` instances. Test-only assertions added at `client.test.ts:38-61`.

## 3. Fixture independence check

I verified the wasm sha256 (`shasum -a 256` = `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6` = expected = `fixture.wasmSha256`), then independently extracted the spec with `contract.Spec.fromWasm(readFileSync(wasm))` and compared `spec.entries.map(e => e.toXDR("base64"))` with the fixture.

- Entry sets: `myEntries=26 fixtureEntries=26 missing=0 extra=0` → all 26 entries **byte-identical**.
- `Rule` fields (my extraction, alphabetical): `allowed_assets: Vec<Address>, auto_approve_limit: i128, daily_limit: i128, known_recipients_only: bool, per_tx_limit: i128` = fixture.
- `Schedule` fields: `active: bool, amount: i128, asset: Address, id: u32, interval_secs: u64, next_run_at: u64, owner: Address, runs_left: u32, to: Address` = fixture.
- Error enum: 17 cases `NotConfigured 100 … InsufficientAllowance 116` = fixture.

| function | my spec (input types, in order) | fixture | equal? |
|---|---|---|---|
| set_rule | owner:Address, rule:Rule(struct) | same | yes |
| get_rule | owner:Address | same | yes |
| set_executor | owner:Address, executor:Address | same | yes |
| revoke_executor | owner:Address | same | yes |
| get_executor | owner:Address | same | yes |
| set_alias | owner:Address, alias:String, address:Address | same | yes |
| remove_alias | owner:Address, alias:String | same | yes |
| get_alias | owner:Address, alias:String | same | yes |
| is_known_recipient | owner:Address, to:Address | same | yes |
| pay_owner | owner:Address, to:Address, asset:Address, amount:i128 | same | yes |
| pay_executor | executor:Address, owner:Address, to:Address, asset:Address, amount:i128 | same | yes |
| spent_today | owner:Address | same | yes |
| create_schedule | owner:Address, to:Address, asset:Address, amount:i128, first_run_at:u64, interval_secs:u64, runs:u32 | same | yes |
| cancel_schedule | owner:Address, id:u32 | same | yes |
| get_schedule | id:u32 | same | yes |
| list_schedules | owner:Address | same | yes |
| next_schedule_id | (none) | same | yes |
| execute_schedule | id:u32 (keeper-only, NOT_WRAPPED) | same | yes |
| list_due | cursor:u32, limit:u32 (keeper-only, NOT_WRAPPED) | same | yes |

("equal" means the entry XDR is byte-identical, so the signature is identical.) Fixture is 16,010 bytes, contains only public contract metadata/doc strings, no `S[A-Z2-7]{55}` secrets; `git ls-files | grep -i wasm` is empty (wasm not committed). PASS.

## 4. Mutation results

Each mutation edited a source file, ran the targeted suite, then `git checkout -- <file>` (verified clean before the next).

| # | Mutation | abi-golden | Overall suite | Caught? |
|---|---|---|---|---|
| a | `ruleToScVal` → untyped `nativeToScVal(rule)` | FAIL (`set_rule`, per-arg diff: spec `scvSymbol/scvI128/scvAddress` vs client `scvString/scvU64/scvString`); 19 others pass | — | YES (golden) |
| b | `pay_executor` swap `owner` ⇄ `executor` args | FAIL (`pay_executor`, per-arg diff) | — | YES (golden) |
| c | `create_schedule.first_run_at` `scU64` → `scU32` | FAIL (`create_schedule`, per-arg diff) | — | YES (golden) |
| d | rename `set_rule` → `set_rule_renamed` | **PASS (20/20)** | FAIL (`client.test.ts:35` name assertion) | YES (client.test.ts), NOT golden |

Extra probe: renaming the read method `get_rule` → `get_rule_renamed` left **all 9 guard test files / 140 tests green** — no test checks a read method's emitted function name. See §7.

## 5. Other changed files

- `backlog/guard-client.md`: accurate. Counts (133/424/149/129/16), the B1 description, the mutation record and the "fake RPC cannot validate the ABI" note all match my measurements. No secrets.
- `stellar/src/guard/allowance.ts`: **documentation only** (`:33-40` documents the untyped `u32` overflow risk). Behaviour unchanged. Re-verified `allowanceExpiryLedger` = `currentLedger + days * 17280`, 30-day window (`allowance.test.ts:24,67`) and `approve(from,spender,amount,live_until_ledger)` arg order/types `address,address,i128,u32` (`allowance.test.ts:59-64`). The *committed guard fixture does NOT cover the SAC `approve`/`allowance` ABI* (it is the guard contract's spec), so the SEP-41 `u32` `live_until_ledger` is still only asserted by `allowance.test.ts`, exactly as before; unchanged.
- `stellar/src/guard/amount.ts`: **documentation only** (`:33-38` notes the 12-integer-digit cap). `toRawUnits` regex/logic unchanged; behaviour identical.
- `stellar/src/guard/__tests__/helpers.ts`: test-only. `ruleScVal`/`scheduleScVal` entries reordered to the contract's alphabetical derive order (`Rule` at `:100-108`, `Schedule` at `:111-123`), values unchanged. Correct — independently confirmed the spec order is alphabetical — and required for the golden byte-equality round-trips.
- `stellar/src/guard/__tests__/client.test.ts`: added the reviewer's direct `set_rule` map assertions (`:38-61`) — correct and sufficient for the single-asset fixture; asserts the exact failure B1 had.

No scope creep; no behaviour change outside `client.ts`'s `setRule` encoding.

## 6. Blocking issues (exact fix each)

None.

## 7. Non-blocking

1. **The golden test never asserts the emitted function name.** `captureArgs` (`abi-golden.test.ts:194-200`) discards `op.func.invokeContract.functionName`, and `expectSameArgs` only compares args, so renaming a wrapped method's string passes `abi-golden` (mutation d: 20/20 green). Writes are backstopped by `client.test.ts` name assertions for all 9 write methods, but the 8 read methods are covered by nothing: renaming `get_rule` → `get_rule_renamed` left the entire guard suite green. Exact fix: in the per-case golden test compare the name too, e.g. after `captureArgs`, assert `op.func.invokeContract.functionName.toString() === testCase.fn`.
2. **No edge values in the committed golden cases.** The 17 cases use mid-range amounts/timestamps and `alias: "ada"`; there is no `i128::MAX`, `u64::MAX`, empty alias or max-length alias, and `client.test.ts` only checks `allowed_assets` with one element. I verified these encode correctly by hand (scratch, §2), so it is a coverage gap, not a bug. Exact fix: add one case per family (an amount `i128::MAX`, a `u64::MAX` `first_run_at`, `set_alias` with `""` and a max-length string, and a 2-asset `Rule`).
3. **Fixture drift is manual.** The drift guard compares fixture-vs-client, not wasm-vs-client: the test cannot re-read the wasm (it is not committed), so a rebuilt contract requires regenerating the fixture by hand. `wasmSha256` pins the binary but is not re-derived. Acceptable for a committed fixture; worth one sentence in the report (it already says "extracted offline").
4. Pre-existing, still open (carried from review 1, correctly deferred as out of scope): value-level assertions, `buildApproveAllowance` spender cross-check, typed errors in the summary builders, and live RPC assembly / testnet verification (UNVERIFIED, offline).
