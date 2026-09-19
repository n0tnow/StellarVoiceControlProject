# Review: send-payment (delta)

- **Date:** 2026-09-19
- **Reviewer:** opencode-go/deepseek-v4.1-flash (L4, fresh session; did **not** write this code)
- **Reviewed:** fix commit `d0db693` on branch `review/send-payment-2` (== `chain/send-payment`), delta = `git diff HEAD~1`
- **Prior review:** `backlog/send-payment-review.md`; **fix spec:** `scratchpad/brief-send-fix.md`
- **Method:** read the delta and surrounding code; re-ran all gates; wrote a throwaway probe (`stellar/src/payments/__tests__/zz-review2.scratch.test.ts`, 32 tests, run then deleted); performed four live mutations (edit → targeted test → `git checkout` revert) to prove the new tests can fail. `node_modules` symlink and scratch test both removed at the end; `git status --short` shows only this file.

## Verdict: approve

All three fixes from the prior review are implemented and independently reproduced, and the B1 attack surface is closed:
`resolveAlias` now reads own properties only, the parsed book has a null prototype, and reserved names are rejected at parse time.
Every new test-quality item is present and **can fail** (four mutations attempted, all caught). No blocking issues remain.

## 1. Check table

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Gates re-run: `check`, `test:payments`, `npm test` | **PASS** | §2 summary; payments 97/97, keeper 67/67, anchor 111/111, tsc exit 0 |
| 2 | B1: own-property `resolveAlias`, null-proto parsed book, reserved names rejected; re-attack | **PASS** | `aliases.ts:61` (`Object.create(null)`), `aliases.ts:63-65` (reserved throw), `aliases.ts:96-100` (hasOwnProperty); scratch: 8 attack names → `unknown_recipient`, `JSON.parse('{"__proto__":…}')` → reserved error |
| 3 | Suggestion 1: non-string `asset`/`recipient`, whole intent null/undefined/array/string → typed refusals | **PASS** | `sendPayment.ts:111-116`, `:133-138`, `:149-155`; scratch: asset null/number/object/bool, recipient null/number/object/array, whole intent null/undefined/array/string/number (32/32) |
| 4 | `trustline_check_failed` only for trustline read failure; `account_not_found` only for `loadAccount`; docs updated | **PASS** | `sendPayment.ts:177` (inside `checkTrustline` catch), `sendPayment.ts:194` (inside `loadAccount` catch), only occurrences of each code; `backlog/send-payment.md:98-99` |
| 5 | Test-quality (a)-(d) implemented **and** able to fail | **PASS** | §4 mutation table: all four mutations caught |
| 6 | Scope / secrets / browser-safety | **PASS** | `git diff HEAD~1 --name-only` = 6 files, only `stellar/src/payments/**` + `backlog/send-payment.md`; no `S[A-Z2-7]{55}` secret in the diff; only comment mentions of `Buffer` and no `node:` import in the 4 pure modules |

## 2. Numbers I re-ran (verbatim)

Environment: worktree root `node_modules -> /Users/bilalkaya/StellarVoiceControlProject/node_modules` (removed afterwards). Caveat (same as the prior review): the symlink's workspace links (`@polaris/interfaces`) resolve to the main checkout; `interfaces/` is not part of this diff and tests import the worktree's own relative sources, so the results are valid for the reviewed code.

```
$ caffeinate -i npm run check -w @polaris/stellar
> tsc -p tsconfig.json
EXIT=0                                            # no output

$ caffeinate -i npm run test:payments -w @polaris/stellar
 Test Files  5 passed (5)
      Tests  97 passed (97)
EXIT=0

$ caffeinate -i npm test -w @polaris/stellar      # keeper -> anchor -> payments
# keeper (node:test):
ℹ tests 67
ℹ pass 67
ℹ fail 0
# anchor (vitest):
 Test Files  5 passed (5)
      Tests  111 passed (111)
# payments (vitest):
 Test Files  5 passed (5)
      Tests  97 passed (97)
EXIT=0
```

Test-count arithmetic checks out: 69 → 97 = +28 (aliases +11, sendPayment +16 −1 tautology, summary +2). Worker's claims in `backlog/send-payment.md` are accurate.

## 3. Why I could not break B1 again

Scratch test results (32/32 passed):

| Attack | Expected | Actual |
|---|---|---|
| `resolveAlias(parsedBook, "constructor"/"__proto__"/"toString"/"hasOwnProperty"/"valueOf"/"isPrototypeOf"/" CONSTRUCTOR "/" __PROTO__ ")` | `undefined` | `undefined` |
| `resolveAlias({}, "constructor"/"toString"/…)` (plain-proto book) | `undefined` | `undefined` |
| `parseAliasBook(JSON.parse('{"__proto__":{…}}'))` | clear parse error | `Error: alias name "__proto__" is reserved and cannot be used` |
| `parseAliasBook('{"__proto__":{…}}')` | clear parse error | same |
| `sendPayment({…, recipient: <8 attack names>})` | `PaymentRefusal` `unknown_recipient` | all `PaymentRefusal` `unknown_recipient` (no raw `TypeError`) |
| `{…, asset: {}}` / `asset: true` / `recipient: []` | typed refusal | `unsupported_asset` / `unsupported_asset` / `unknown_recipient` |
| whole intent `null`/`undefined`/`[]`/`"send"`/`5` | `invalid_intent` | `invalid_intent` |

## 4. Mutation table (test-quality items §5 a-d)

Each mutation was applied to the source, the targeted test run, then reverted (`git checkout --`). All caught.

| Item | Test | Mutation applied | Caught? |
|---|---|---|---|
| (a) summary from decoded XDR | `sendPayment.test.ts:122-128` | override `summary.title` from the raw intent `amount` (`00010.5000000`) | **YES** — `expected 'Send 00010.5000000 USDC to ada' to be 'Send 10.5 USDC to ada'` |
| (b) arbitrary mode refused | `sendPayment.test.ts:224-229` | `mode !== "public"` → `mode === "confidential" \|\| mode === "private"` | **YES** — `"weird"` slipped through, no refusal thrown |
| (c1) non-payment first op | `summary.test.ts:40-53` | drop the `op.type !== "payment"` throw | **YES** — surfaced `Cannot read properties of undefined (reading 'isNative')` instead of `/not a payment/` |
| (c2) fee-bump envelope | `summary.test.ts:55-67` | drop the `tx instanceof Transaction` throw | **YES** — no throw at all (received `undefined`) |
| (d) tautology replaced by round-trip | `aliases.test.ts:117-125` | `resolveAlias` → `return undefined` always | **YES** — `expected undefined to be defined` |
| B1 extra: committed regression suite | `aliases.test.ts:98-102`, `sendPayment.test.ts:180-187` | `resolveAlias` → plain `book[key]` read | **YES** — plain-proto test + `constructor`/`__proto__` recipient tests fail with the old `destination is invalid` crash |

The tautological `ALIASES.ada.address === ADA` test is gone (no `ALIASES.ada.address` reference remains; import removed).

## 5. Blocking issues

none

## 6. Non-blocking

1. **Doc gap on `invalid_intent`** (`backlog/send-payment.md:91`): the row still says only `intent.kind !== "send"`, but the code now also emits it for `null`/`undefined`/non-object intents. Update the row to mention a malformed intent object.
2. **`mode_not_supported` doc row** (`backlog/send-payment.md:95`) says `mode` is `"confidential"` or `"private"`; the code refuses **any** non-`"public"` value (correct fail-closed behaviour). Reword to "any non-public mode".
3. **Non-Error throws are stringified as `undefined`** (`sendPayment.ts:178,195`): `(e as Error).message` on a thrown string/number yields `"…: undefined"`. Cosmetic; refusals are still typed.
4. **Round-trip test is vacuous for an emptied book** (`aliases.test.ts:117-125`): it iterates `Object.keys(book)`, so a book that parsed to `{}` would loop zero times. The sibling key assertion (`aliases.test.ts:110`) catches that, so the suite as a whole is safe; a fixed `["ada","bob","carol"]` list would make the test self-sufficient.
5. Carried over, already documented by the worker: `defaultPaymentDeps` passes no `checkTrustline` (`op_no_trust` at submit; demo must pre-create the trustline) and `payloadHash` is exposed via `payloadHashOf`/`buildPaymentSummary`, not on `ChainToolResult` (`backlog/send-payment.md:103-104,217-231`). No code change expected in this task.

---

**Bottom line for the coordinator:** merge. The delta does exactly what the prior review asked, the numbers are honest, the scope is clean, and the new tests demonstrably fail under mutation. Only cosmetic doc nits remain.

*(Review write-up only; no commit/push/add. Scratch test and `node_modules` symlink removed; `git status --short` shows only this file.)*
