# Report: guard-client — owner/executor TS client for `polaris_guard` + `guarded` route of `sendPayment`

- **Date:** 2026-09-19
- **Worker/Agent:** W-guard (opencode-go/deepseek-v4.1-flash, L2)
- **Branch/Worktree:** `chain/guard-client` / `.worktrees/guard-client` (based on `chain/send-payment`)
- **PR:** none (per task: no commit/push/tag)
- **Slice step:** S9 of `backlog/2026-09-19-slice-gap-analysis.md` §G.3

## TL;DR

- Added `stellar/src/guard/**`: a **contract-id parametrised** owner/executor client for the
  deployed `polaris_guard` v0.1 ABI (D9 — no hard-coded contract id), a SAC `approve`/`allowance`
  helper, a pure routing policy, and typed error mapping that reuses `keeper/errors.ts`.
- Added `route: "guarded"` to `sendPayment`: it fetches the owner's rule + executor through the
  injected client, applies the routing policy, builds `pay_executor` / `pay_owner`, and returns a
  summary decoded from the produced XDR. `direct` is byte-for-byte unchanged.
- All new tests are offline (fake RPC). No network calls were made.
- **Gates green:** `check` clean; `test:guard` 133/133; full `test` = keeper 67 + anchor 111 +
  payments 113 + guard 133 = **424 tests, 0 failures**. (Review-fix round: see §"Review fixes".)

## Completed

### New files — `stellar/src/guard/`
| File | Purpose |
|---|---|
| `types.ts` | `Rule` / `Schedule` mirrors of the contract structs, `GuardCall`, `GuardClient`, `GuardRpcLike` |
| `errors.ts` | `GuardClientError { name, kind, code, message }`; reuses `keeper/errors.ts` tables (`GUARD_ERRORS`, `TOKEN_ERRORS`), plus name-only `GUARD_ERROR_NAMES` / `TOKEN_ERROR_NAMES` |
| `amount.ts` | `toRawUnits` / `fromRawUnits` (7-decimal), `I128_MAX` |
| `route.ts` | `chooseGuardedRoute` — pure policy, no I/O |
| `describe.ts` | `decodeInvocation` (contract id + fn + args from XDR), `buildGuardCallSummary`, `buildGuardedPaymentSummary`, `toHex`, `stroopsToXlm`, `shortKey` |
| `invoke.ts` | shared `getAccount → build → simulate → assemble` (unsigned) and read simulation; surfaces mapped errors |
| `client.ts` | `createGuardClient({ contractId, rpc, networkPassphrase, source, ... })` — all 17 ABI methods |
| `allowance.ts` | `buildApproveAllowance` (SEP-41 `approve`), `getAllowance`, `allowanceExpiryLedger` (~30 days) |
| `index.ts` | barrel for the `guard` namespace |
| `__tests__/` | `helpers.ts`, `amount.test.ts`, `errors.test.ts`, `route.test.ts`, `allowance.test.ts`, `client.test.ts`, `source-scan.test.ts` |

### Modified
- `stellar/src/payments/sendPayment.ts` — `route: "guarded"` branch, new `PaymentDeps.guard` /
  `guardAssetContracts`, new `PaymentRefusalCode`s, optional `PaymentRefusal.guardErrorName`.
- `stellar/src/payments/__tests__/sendPayment.guarded.test.ts` — new guarded-route tests.
- `stellar/src/index.ts` — `export * as guard from "./guard/index.ts";`.
- `stellar/package.json` — `test:guard` and appended to `test`.
- `backlog/guard-client.md` — this report.

## API table (`createGuardClient`)

`rpc` is an injected `GuardRpcLike = Pick<rpc.Server, "getAccount" | "simulateTransaction" | "getLatestLedger">`.
`source` is the account used to simulate read-only calls. Every write returns
`{ unsignedXdr, summary, payloadHash }` (unsigned, assembled, never signed/sent).

| Method | Contract fn | Signer (tx source) | Returns |
|---|---|---|---|
| `setRule(owner, rule)` | `set_rule(owner, rule)` | owner | `GuardCall` |
| `getRule(owner)` | `get_rule(owner)` | — (read) | `Rule \| null` |
| `setExecutor(owner, executor)` | `set_executor(owner, executor)` | owner | `GuardCall` |
| `revokeExecutor(owner)` | `revoke_executor(owner)` | owner | `GuardCall` |
| `getExecutor(owner)` | `get_executor(owner)` | — | `string \| null` |
| `setAlias(owner, alias, address)` | `set_alias(owner, alias, address)` | owner | `GuardCall` |
| `removeAlias(owner, alias)` | `remove_alias(owner, alias)` | owner | `GuardCall` |
| `getAlias(owner, alias)` | `get_alias(owner, alias)` | — | `string \| null` |
| `isKnownRecipient(owner, to)` | `is_known_recipient(owner, to)` | — | `boolean` |
| `payOwner(owner, to, asset, amount)` | `pay_owner(owner, to, asset, amount)` | owner | `GuardCall` |
| `payExecutor(executor, owner, to, asset, amount)` | `pay_executor(executor, owner, to, asset, amount)` | executor | `GuardCall` |
| `spentToday(owner)` | `spent_today(owner)` | — | `bigint` |
| `createSchedule(owner, to, asset, amount, firstRunAt, intervalSecs, runs)` | `create_schedule(...)` | owner | `GuardCall` |
| `cancelSchedule(owner, id)` | `cancel_schedule(owner, id)` | owner | `GuardCall` |
| `getSchedule(id)` | `get_schedule(id)` | — | `Schedule \| null` |
| `listSchedules(owner)` | `list_schedules(owner)` | — | `Schedule[]` |
| `nextScheduleId()` | `next_schedule_id()` | — | `number` |

Allowance helper (`assetContractId` supplied by the caller; `spender` = guard contract id):

| Function | Contract fn | Signer | Returns |
|---|---|---|---|
| `buildApproveAllowance(rpc, { assetContractId, from, spender, amount, ... })` | `approve(from, spender, amount, live_until_ledger)` | `from` | `GuardCall & { currentLedger, liveUntilLedger }` |
| `getAllowance(rpc, { assetContractId, from, spender, ... })` | `allowance(from, spender)` | — | `bigint` |

`live_until_ledger = latestLedger + days * 17_280` (default 30 days).

## Routing policy — `chooseGuardedRoute` (pure)

| Condition | Outcome |
|---|---|
| `amountRaw <= 0` | refuse `InvalidAmount` (#101) |
| asset not in `rule.allowed_assets` | refuse `AssetNotAllowed` (#106) |
| `amountRaw > rule.per_tx_limit` | refuse `OverPerTxLimit` (#103) |
| executor registered, `amountRaw <= auto_approve_limit`, asset allowed, and (`known_recipients_only` → recipient known) | `pay_executor` (agent signs, no card) |
| otherwise (no executor, over auto-approve, or unknown recipient under `known_recipients_only`) | `pay_owner` (owner signs after the card) |

Hard caps are refused **before** anything is built; `daily_limit` is deliberately left to the
contract (this function has no spend counter), and `pay_owner` remains the owner-approved path.

## Refusal / error tables

`sendPayment` guarded route (`PaymentRefusal.code`, plus `guardErrorName`):

| Code | Trigger | `guardErrorName` |
|---|---|---|
| `guarded_route_not_available` | `route: "guarded"` without `deps.guard` | — |
| `guard_rule_missing` | `get_rule` → `None`, or guard `NotConfigured` | `NotConfigured` |
| `guard_limit_exceeded` | `OverPerTxLimit` / `OverDailyLimit` | mapped name |
| `guard_asset_not_allowed` | `AssetNotAllowed` | `AssetNotAllowed` |
| `unsupported_asset` | XLM without a supplied SAC id, or unknown code | — |
| `guard_client_error` | any other mapped guard/simulation failure | mapped name |
| `unknown_recipient` / `invalid_amount` / `recipient_no_trustline` / … | unchanged direct-path refusals | — |

Guard client errors (`GuardClientError`) are built from `keeper/errors.ts`:

| Range | Source | Examples |
|---|---|---|
| `100–116` | guard policy | `NotConfigured` 100, `OverPerTxLimit` 103, `NeedsOwnerApproval` 105, `AssetNotAllowed` 106, `InsufficientAllowance` 116 |
| `2–15` | SAC/token/host | `SacAllowanceError` 9, `SacBalanceError` 10, `SacTrustlineMissing` 13 |

Drift guards (tests): `GUARD_ERROR_NAMES` ≡ `keeper/errors.ts#GUARD_ERRORS` ≡ the
`#[contracterror]` enum parsed from `contracts/polaris_guard/src/lib.rs` at test runtime.

## Test results (real numbers, offline)

```
npm run check -w @polaris/stellar     # tsc, clean
npm run test:guard -w @polaris/stellar
  Test Files  7 passed (7)   Tests  133 passed (133)
npm test -w @polaris/stellar
  test:keeper   tests 67  pass 67  fail 0
  test:anchor   Test Files 5 passed   Tests 111 passed
  test:payments Test Files 6 passed   Tests 113 passed   (includes 16 new guarded tests)
  test:guard    Test Files 7 passed   Tests 133 passed
```

New tests: **149** for the review-fix state — 133 in `src/guard` (113 from the original slice + 20
golden-ABI) and 16 in `src/payments/__tests__/sendPayment.guarded.test.ts`. (The pre-review report
undercounted the guarded file as 13; the correct 16 makes the original slice **129** new tests.)
They decode every produced XDR and assert contract id, function name, argument order/types/values,
signer (tx source), fee/network, plus read decoding, allowance math, routing branches, error mapping
and the two drift guards. A source scan asserts no guard source contains the deployed id
`CDRLSFJ5…` or any `C…` strkey literal.

## How to try it (offline, fake RPC)

```ts
import { Account, Networks, SorobanDataBuilder, xdr } from "@stellar/stellar-sdk";
import { guard } from "@polaris/stellar";

const rpc = {
  getAccount: async (a: string) => new Account(a, "100"),
  simulateTransaction: async () => ({
    _parsed: true, id: "1", latestLedger: 1, events: [],
    transactionData: new SorobanDataBuilder().setResourceFee(5000),
    minResourceFee: "5000", result: { auth: [], retval: xdr.ScVal.scvVoid() },
  }),
  getLatestLedger: async () => ({ sequence: 1000 }),
};

const client = guard.createGuardClient({
  contractId: process.env.GUARD_CONTRACT_ID!,   // never hard-coded
  rpc, networkPassphrase: Networks.TESTNET, source: owner,
});

const { unsignedXdr, summary, payloadHash } = await client.payExecutor(
  executor, owner, recipient, assetSac, guard.toRawUnits("10.5"),
);
// -> sign unsignedXdr as `executor`, then submit. Nothing was sent here.
```

## Unfinished (handed off)

- **Live testnet run of the headless slice** (the actual S9 acceptance: `Intent → XDR → sign →
  submit`, and a >`auto_approve_limit` payment refused `#105`). This task is explicitly offline; the
  next task is the headless e2e script (see Suggested next step).
- **Live RPC assembly untested.** The fake RPC returns a synthetic `transactionData`; the real
  `rpc.Server.simulateTransaction` + `assembleTransaction` path (footprint, auth, resource fee,
  archived-entry restore) is exercised only structurally, not against testnet. `client.ts`/`invoke.ts`
  reuse the keeper's exact flow, but the keeper's restore-preamble handling is not duplicated here
  (guard writes are not expected to hit archived entries in the demo).
- **`defaultPaymentDeps` does not wire `guard`** — the app bootstrap must construct the guard client
  from `GUARD_CONTRACT_ID` and pass `guard` + `guardAssetContracts` (USDC SAC id) into
  `configurePayments`.
- **SAC ids are caller-supplied.** `guardAssetContracts` currently has to be populated by the app;
  resolving the SAC id from the classic asset (issuer+code) is a follow-up.
- **Daily-limit precheck** is not done client-side (no spend counter in the pure router); the contract
  enforces it at submission time.

## Blockers

- None for this task. The live e2e needs a funded testnet owner/executor, the deployed guard id, the
  USDC SAC id, and the SAC allowance set — all available per `contracts/DEPLOYED.md`.

## Review Notes

- Start with `stellar/src/guard/client.ts` (arg builders) and `stellar/src/payments/sendPayment.ts`
  (`guardedPayment`). The XDR assertions in `__tests__/client.test.ts` and
  `sendPayment.guarded.test.ts` are the contract-ABI evidence.
- `guard/errors.ts` deliberately re-exports the keeper's tables instead of duplicating names; the
  drift tests are the guard against divergence.
- `guard/route.ts` is pure: no clock, no RPC, no randomness — table-driven tests cover every branch.
- Contract id is only ever an option/parameter; `__tests__/source-scan.test.ts` enforces it.
- `direct` route code path was not refactored; only a guarded branch was inserted before it.

## Suggested Next Step

- Headless e2e script (e.g. `stellar/src/guard/e2e.ts` + `npm run guard:e2e`): construct the real
  `rpc.Server`, `getLatestLedger` → `buildApproveAllowance` → sign with a testnet key →
  `buildUnsignedInvoke` for `set_rule`/`set_executor` → submit; then `sendPayment({route:"guarded"})`
  for a small (expect `pay_executor` settle) and a large amount (expect `#105` →
  `pay_owner` after owner signature). Record the tx hashes in this report.

## Review fixes (2026-09-19, W-guard)

The independent review `backlog/guard-client-review.md` returned **reject** on one blocking ABI bug
(`setRule` mis-encoding). This round fixes it and adds the missing ABI evidence. No commit/push (per
task).

### B1 (blocking) — `setRule` mis-encoded the `Rule` struct

- `client.ts` now encodes the struct through `ruleToScVal` with explicit spec types: `scvSymbol`
  keys, `scvI128` limits, `allowed_assets` as a `Vec<scvAddress>` (each asset wrapped in an
  `Address`), and `scvBool` for `known_recipients_only`. The untyped `nativeToScVal(rule)` produced
  `scvString` keys, `scvU64` limits and `scvString` addresses, which the host rejects on `set_rule`.
- Audited every other encode site (alias `String` args, `u32`/`u64` schedule fields, all address
  args, allowance args): no further untyped struct/map/array encodings; all are explicit.
- `client.test.ts` now asserts the decoded `set_rule` map directly — every key `scvSymbol`, all
  three limits `scvI128`, `allowed_assets` elements `scvAddress` (the review's exact check, which
  failed against the submitted code).

### Golden ABI test from the real compiled contract

- New committed fixture `__tests__/fixtures/polaris_guard.spec.json`: base64 XDR of each
  `ScSpecEntry`, extracted **offline** from the compiled wasm at
  `contracts/target/wasm32v1-none/release/polaris_guard.wasm` (sha256 `c4f65e65…98e6`, recorded as
  `wasmSha256` and re-checked at test load). The wasm itself is not committed; no network step.
- New `__tests__/abi-golden.test.ts` loads the fixture into `contract.Spec`, then for all 17 wrapped
  methods builds representative arguments and requires the client's produced invocation args to be
  **byte-for-byte equal** (base64 XDR) to `spec.funcArgsToScVals(fn, {...})`, and the arity to match.
- Drift guard: `spec.funcs()` must equal the 17 wrapped functions plus the explicit `NOT_WRAPPED`
  list (`execute_schedule`, `list_due`, keeper-only), so a new contract function fails the test until
  it is wrapped or explicitly listed as not wrapped.
- Struct round-trips: the canonical `Rule` / `Schedule` ScVals (spec-encoded) decode to the same
  `Rule`/`Schedule` objects through both `spec.scValToNative` and the client's raw `scValToNative`
  read path. The test fixtures `ruleScVal`/`scheduleScVal` were corrected to emit fields in the
  contract's alphabetical derive order (byte-identical to the spec encoding).

### Proof the golden test can fail (mutation)

Reverting `setRule` to the untyped `nativeToScVal(rule)` makes `abi-golden.test.ts` fail on
`set_rule` with a per-argument diff (spec `scvSymbol`/`scvI128`/`scvAddress` vs client
`scvString`/`scvU64`/`scvString`); the other 19 golden tests stayed green. Restored immediately;
`check` clean.

### Non-blocking notes

- The offline fake RPC accepts **any** simulation payload, so it cannot validate the ABI: **only**
  `abi-golden.test.ts` and the later live testnet run guard the encoding. Recorded explicitly here
  because the review's break attempts showed the `scvMap`-only assertion and fake RPC let B1 through.
- Applied the cheap (documentation-only) review notes: `toRawUnits` docstring now states the
  12-integer-digit cap, and `allowanceExpiryLedger` flags the untyped `u32` overflow risk for absurd
  `days`.
- Deliberately not addressed this round (outside the blocking scope): value-level assertions in
  `client.test.ts`, `buildApproveAllowance` spender cross-check, typed errors in the summary
  builders, and the live RPC assembly/testnet verification (still UNVERIFIED, as before).
