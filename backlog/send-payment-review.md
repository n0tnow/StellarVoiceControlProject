# Review: send-payment

- **Date:** 2026-09-19
- **Reviewer:** opencode-go/deepseek-v4.1-flash (L4, independent; did not write this code)
- **Reviewed:** branch `chain/send-payment` (worktree `chain/send-payment` == `review/send-payment`, HEAD `a48716b`, last 2 commits `7457267`+`a48716b`)
- **Method:** read every changed file + the spec (`brief-send-payment.md`, `docs/confidential-payments.md` §12 C3, `backlog/2026-09-19-slice-gap-analysis.md` §B.1/§G/§H); re-ran all gates; wrote a throwaway probe test (`stellar/src/payments/__tests__/zz-review.scratch.test.ts`, since deleted) to attack amount/recipient/asset inputs.

## Verdict: approve with corrections

The implementation is well-structured, honest in its report, and its numbers reproduce exactly. One real
correctness defect blocks: `resolveAlias` does a plain property read on a plain object, so the alias names
`constructor` / `__proto__` return inherited `Object.prototype` members, bypass the `!entry` check and reach
`Operation.payment` with `destination: undefined` — an **untyped generic `Error`**, not
`PaymentRefusal("unknown_recipient")`. A second, lower-severity gap: non-string `recipient`/`asset` throw raw
`TypeError`s. Fix the own-property lookup (and ideally the type guards) before merge; everything else can ship.

## 1. Numbers I re-ran (verbatim summary lines)

Environment: worktree root `node_modules -> /Users/bilalkaya/StellarVoiceControlProject/node_modules`
(removed afterwards). Note on honesty: that symlink's workspace links (`@polaris/interfaces`, `@polaris/stellar`)
resolve to the **main checkout**, not this worktree. `interfaces/` is NOT part of this diff, so the results are
valid for the reviewed code, but this caveat is stated explicitly.

```
$ caffeinate -i npm run check -w @polaris/stellar
> @polaris/stellar@0.1.0 check
> tsc -p tsconfig.json
EXIT=0                                            # no output

$ caffeinate -i npm run test:payments -w @polaris/stellar
 Test Files  5 passed (5)
      Tests  69 passed (69)
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
      Tests  69 passed (69)
EXIT=0
```

Worker's claims in `backlog/send-payment.md:18-19,110-122` (payments 69/69, keeper 67/67, anchor 111/111,
typecheck clean) are **accurate**. Files under test were the worktree's own `stellar/src/**` (`vitest` cwd was
`.worktrees/send-payment-review/stellar`).

## 2. Spec compliance table (req | result | evidence)

| Req | Result | Evidence |
|---|---|---|
| 1. API `createSendPayment(deps): ChainTool`; `configurePayments`; lazy default `sendPayment`; `defaultPaymentDeps` not run in tests; `index.ts` exports the configured default | PASS | `sendPayment.ts:106`, `index.ts:55-72`, `index.ts:86-97`; grep in `__tests__/` finds no `defaultPaymentDeps` call; `index.ts:46` re-exports `sendPayment` |
| 2. Input handling: `kind:"send"`, USDC/XLM only, amount 1-7 dp / ≤12 int digits, alias-only recipient, raw `G...` refused, mode fail-closed, `route` | PASS (caveat → §4) | `sendPayment.ts:110,125,133,135-148,114-123`; probes confirm raw `ADA` → `unknown_recipient` with "raw addresses are not accepted" |
| 3. Typed, machine-readable refusals (`PaymentRefusal` + 9 codes) | **FAIL (partial)** | Code list complete (`sendPayment.ts:20-29`), but `constructor`/`__proto__` and non-string fields escape as generic `Error`/`TypeError` — see §4 |
| 4. Build: `BASE_FEE`, 300 s timebounds w/ injectable clock, no memo, single `Operation.payment`, trustline precheck | PASS | `sendPayment.ts:178-187`, `150-166`; tests assert fee `"100"`, Δ=300 s, memo none, 1 op, XLM skips check |
| 5. Summary decoded from the produced XDR (round trip), `toHex(tx.hash())`, no `Buffer` | PASS | `summary.ts:57-83` decodes via `TransactionBuilder.fromXDR` and reads op fields; `payloadHash = toHex(tx.hash())` `summary.ts:69`; tests `summary.test.ts:28-37`, `sendPayment.test.ts:114-119` |
| 6. Alias book per §12 C3 (`parseAliasBook`, `StrKey`, network=testnet, name regex, collision warnings, Node-only loader) | PASS | `aliases.ts:43-100`, `loadAliases.ts:1-11`, `config/aliases.json`; committed-file test `aliases.test.ts:79-89` |
| 7. Tests coverage list + ≥25 tests | PASS | Full required list present (happy USDC/XLM, case/trim, unknown/raw known/raw unknown, 13 amounts, EURC, modes, guarded, trustline, not-configured, payloadHash, exact lines, source scan); 69 tests |
| 8. Quality gates run/reported | PASS | §1 |

Scope hygiene: PASS. `git diff HEAD~2 --name-only` lists only `backlog/send-payment.md`,
`stellar/config/aliases.json`, `stellar/package.json`, `stellar/src/index.ts`, `stellar/src/payments/**`.
`stellar/src/index.ts` diff replaces only the `sendPayment` stub; `stellar/package.json` only adds
`test:payments` and appends it to `test`; no anchor/keeper/interfaces/agent/app/contracts changes.
No secret keys: `git diff HEAD~2 | grep -E '^\+.*S[A-Z2-7]{55}'` → none.

## 3. Break attempts table (input | expected | actual | result)

Probed through `createSendPayment(makeDeps())` (real `Account`, fixed clock, no network). "THROWN" = a
non-`PaymentRefusal` error escaping to the caller.

| Input | Expected | Actual | Result |
|---|---|---|---|
| amount `"0.0000000"` | `invalid_amount` | `invalid_amount` (>0) | PASS |
| amount `"00010"` | valid / canonical | accepted; XDR→summary shows `10` | NOTE (leading zeros allowed) |
| amount `"1."`, `".5"`, `"10."` | `invalid_amount` | `invalid_amount` | PASS |
| amount `"1,5"` | `invalid_amount` | `invalid_amount` | PASS |
| amount `"१०"` (non-ASCII digits) | `invalid_amount` | `invalid_amount` (`\d` is ASCII-only) | PASS |
| amount `"10\n"` | `invalid_amount` | `invalid_amount` (`$` does not match before final `\n` in JS) | PASS |
| amount `"9999999999999.1"` (13 int digits) | `invalid_amount` | `invalid_amount` | PASS |
| amount `"0.0000001"` | accepted | accepted, op amount `"0.0000001"` | PASS |
| amount `"−10"` (U+2212) | `invalid_amount` | `invalid_amount` | PASS |
| amount `922337203685.4775807` | accepted | accepted (int64 max) | PASS |
| recipient `"constructor"` | `unknown_recipient` | **THROWN** `Error: destination is invalid` | **FAIL** |
| recipient `"__proto__"` | `unknown_recipient` | **THROWN** `Error: destination is invalid` | **FAIL** |
| recipient `"toString"`/`"hasOwnProperty"`/`"valueOf"` | `unknown_recipient` | `unknown_recipient` (lowercased key misses camelCase proto prop) | PASS |
| `resolveAlias(book,"constructor")` | undefined | returns `Object` constructor (typeof `function`, truthy, `.address` undefined) | **FAIL** |
| recipient = known alias's raw `G...` | `unknown_recipient` | `unknown_recipient`, message "raw addresses are not accepted" | PASS |
| recipient `"ADA"` / `"  ada  "` | resolves | resolves to ada | PASS |
| asset `"usdc"`, `"USDC "` | USDC | USDC | PASS |
| asset `"USDC:G..."`, `"native"` | `unsupported_asset` | `unsupported_asset` | PASS |
| amount `10` (number) | `invalid_amount` | `invalid_amount` | PASS |
| recipient `5` (number) | typed refusal | **THROWN** `TypeError: ...trim is not a function` | FAIL (low) |
| asset `null` | typed refusal | **THROWN** `TypeError: Cannot read properties of null` | FAIL (low) |
| mode `"weird"` | `mode_not_supported` | `mode_not_supported` | PASS |
| mode `undefined` vs `"public"` | identical | identical | PASS |

Security/invariant checks by reading:
- **Summary cannot disagree with the XDR** for destination/amount/asset/fee: `summary.ts:57-83` reads
  `op.destination`, `op.asset`, `op.amount`, `tx.fee` from the decoded envelope; only the alias label comes
  from input (intended).
- **`payloadHash`** is `toHex(tx.hash())` and matches `payloadHashOf` (test `sendPayment.test.ts:114-119`).
- **Browser-safety:** `grep -n "Buffer\|node:"` over `aliases.ts/assets.ts/summary.ts/sendPayment.ts` returns
  only prose comments; `assets.ts` imports `anchor/config.ts`, which is pure (no Node globals). `loadAliases.ts`
  (the only `node:fs`) is a separate module and correctly omitted from the pure set.
- **Source-scan test can fail:** `/\bBuffer\b/` matches `Buffer.from(...)` (verified with `node -e`), and
  `/["']node:/` matches `import ... "node:fs"`. It is a real guard, not a tautology.
- **`aliases.json`:** all three addresses are public demo identities from `contracts/DEPLOYED.md:35-38`
  (ada = payee `w1-bob` `GARX…WCO`; bob = executor `w1-exec` `GB3H…LX5`; carol = issuer `w1-iss`
  `GB7Y…2EE`); no `S…` secrets anywhere in the diff.
- **Refusals are fail-closed** for privacy modes: any non-`"public"` mode refuses with the exact required
  message (`sendPayment.ts:114-117`); no downgrade path exists.
- **`loadAccount` failure → `account_not_found`** (`sendPayment.ts:168-176`) and the error text carries no
  secret (owner address is public).
- **Default deps** (`index.ts:86-97`) wire real Horizon `loadAccount` and no secret; they pass no
  `checkTrustline` (see §5).

## 4. Blocking issues (exact fix each)

**B1 — `resolveAlias` returns inherited `Object.prototype` members → untyped crash instead of refusal.**
`aliases.ts:82-85`:

```ts
export function resolveAlias(book: AliasBook, name: string): AliasEntry | undefined {
  if (typeof name !== "string") return undefined;
  return book[name.trim().toLowerCase()];   // <- inherited props leak through
}
```

`sendPayment.ts:142-148` trusts the result (`if (!entry)`), so `recipient:"constructor"` (and `"__proto__"`)
passes the check with `entry.address === undefined` and the failure surfaces at
`Operation.payment` as `Error: destination is invalid`, not `PaymentRefusal("unknown_recipient")`. This
violates requirement 3 and the explicit spec check in the task. It cannot move funds (destination is
`undefined`), but it is a genuine bypass of the alias-only invariant.

Fix (one of, preferably both):

```ts
export function resolveAlias(book: AliasBook, name: string): AliasEntry | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(book, key) ? book[key] : undefined;
}
```
and/or build the book with a null prototype in `parseAliasBook` (`const book: AliasBook = Object.create(null)`).
Add a regression test asserting `resolveAlias(book, "constructor") === undefined`,
`resolveAlias(book, "__proto__") === undefined`, and that `runPayment(..., recipient:"constructor")`
rejects with `unknown_recipient`.

No other blocking issues.

## 5. Non-blocking suggestions

1. **Non-string `intent.recipient` / `intent.asset` throw raw `TypeError`s** (`sendPayment.ts:135,125`).
   `amount` already rejects non-strings cleanly; make the other two match (e.g. `typeof intent.asset !==
   "string"` → `unsupported_asset` / `invalid_intent`, `typeof recipient !== "string"` →
   `unknown_recipient`). The shared type says `string`, but the seam inputs are agent-supplied.
2. **`defaultPaymentDeps` passes no `checkTrustline`.** A live USDC payment to a recipient without a USDC
   trustline passes the precheck and fails later at submit (`op_no_trust`). Slice risk #7 already covers the
   demo setup; consider wiring a Horizon trustline lookup or documenting it in the report's hand-off.
3. **A trustline-precheck failure is reported as `account_not_found`** (`sendPayment.ts:154-159`). There is no
   dedicated code, but "account not found" is misleading for a trustline read error; consider a distinct code
   or a clearer message.
4. **Source-scan strength:** `source-scan.test.ts` scans only the 4 files' own text, so a transitive Node
   import (e.g. a future helper) or a backtick `import(\`node:fs\`)` slips through. It also strips only
   whole-line `//` comments. Low risk today; a dependency-level check would be stronger.
5. **`aliases.json` alias→role naming** (`ada` = the demo *payee*, `bob` = the *executor*, `carol` = the
   *issuer*) is valid and public, but the fixture names don't match the DEPLOYED.md role names; note it to
   avoid confusion in the demo runbook.
6. **Leading-zero amounts** (`"00010"`) are accepted and canonicalised in the XDR/summary. If canonical
   input is required, normalise or refuse; the 12-*digit* (not value) cap also means a 13-digit spelling of
   a small number is refused. Purely cosmetic.
7. **`payloadHash` is not returned by the tool** (only via `payloadHashOf` / `buildPaymentSummary`), as
   documented. Ensure the shell actually calls it for `approval_request` before wiring the tool.

## 6. Mutation/test-quality notes

For the five most important behaviours, a plausible mutation and whether the suite catches it:

| # | Behaviour | Plausible mutation | Caught? |
|---|---|---|---|
| 1 | Alias-only recipient / unknown refused | Drop the `!entry` guard, or keep `resolveAlias` as-is | Raw known/unknown `G...` are caught (`sendPayment.test.ts:155-164`); the prototype-key bypass is **NOT** caught (no test) |
| 2 | Summary decoded from XDR | Build the summary from the intent text instead of `buildPaymentSummary(xdr)` | **NOT reliably caught** for destination/asset/amount: `summary.test.ts:28-37` compares `buildPaymentSummary(xdr)` to `res.summary`, but for canonical input `"10"` both spellings coincide. A non-canonical amount (e.g. `"00010"`) would expose it; none is tested |
| 3 | Fail-closed modes | Change `mode !== "public"` to `mode === "confidential" \|\| mode === "private"` | `confidential`/`private` caught; an arbitrary mode like `"weird"` is **not** tested (probe confirms it is refused today) |
| 4 | int64 overflow | Change `stroops > MAX_STROOPS` to `>=` | Caught by the exact-max accept test (`sendPayment.test.ts:137-140`) and the 12-digit reject |
| 5 | XLM skips trustline check | Always call `checkTrustline` | Caught (`sendPayment.test.ts:208-212`) |

Weak/tautological tests: `sendPayment.test.ts:231-234` asserts the fixture equals itself (`ALIASES.ada.address
=== ADA`) — near-zero value. `summary.test.ts` has no negative test (fee-bump / non-payment rejection). Test
count (69) and coverage breadth are otherwise strong and the happy-path assertions genuinely decode the XDR.

No tests assert mocks/tautologies otherwise; `loadAccount`/`checkTrustline` spies are used against real SDK
objects, not stub-only assertions.

---

**Bottom line for the coordinator:** numbers are honest and all gates pass; merge after B1 (own-property
lookup + regression test). Suggestions 1 and 3 are cheap and worth folding in with B1; the rest can be
backlogged. I changed nothing except this report (scratch test and `node_modules` symlink removed; review
write-up only, no commit).
