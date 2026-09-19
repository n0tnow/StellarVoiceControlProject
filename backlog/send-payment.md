# Report: send-payment

- **Date:** 2026-09-19
- **Worker/Agent:** opencode-go/deepseek-v4.1-flash (L2, W-send)
- **Branch/Worktree:** `chain/send-payment` / `.worktrees/send-payment`
- **PR:** none (not committed, per task; coordinator opens the PR)

## TL;DR

- Implemented the real `sendPayment` ChainTool: a validated `kind:"send"` `Intent`
  becomes an **unsigned** Stellar testnet payment XDR plus a summary **decoded from
  that XDR**. No signing, no submission, no network.
- Recipient is resolved **only** through the alias book; raw `G...` addresses are
  refused. Non-public modes and the guarded route are fail-closed.
- `createSendPayment(deps)` for tests/DI; `configurePayments(deps)` + default
  `sendPayment` for the app; `defaultPaymentDeps(env)` is the single place that
  wires real Horizon `loadAccount` (never executed in tests).
- **69/69** payments tests pass (offline vitest); typecheck clean; existing
  keeper (67) + anchor (111) tests unchanged and passing.
- Refusals are **thrown** (`PaymentRefusal`) because `ChainToolResult` has no
  refusal field; `payloadHash` is exposed via a separate helper for the same
  reason. Both are documented as hand-offs to the shell.

## Completed

New files:

| File | What it does |
|---|---|
| `stellar/src/payments/sendPayment.ts` | Core tool: input validation, alias resolution, `loadAccount`, trustline precheck, `TransactionBuilder` payment, summary. Defines `PaymentRefusal`, `PaymentDeps`, `PaymentIntent`, `AccountLike`, `createSendPayment(deps): ChainTool`. |
| `stellar/src/payments/aliases.ts` | Alias-book spec (§12 C3): `AliasBook`/`AliasEntry`, `parseAliasBook(input)`, `resolveAlias(book, name)`, `findAliasCollisions(book)`. Pure/browser-safe (only `StrKey`). |
| `stellar/src/payments/assets.ts` | `AssetRegistry`; USDC = pinned issuer from `anchor/config.ts` `KNOWN_ISSUERS`, XLM = native; `defaultAssetRegistry()`, `toSdkAsset()`. |
| `stellar/src/payments/summary.ts` | Decodes the produced XDR (`TransactionBuilder.fromXDR`) and builds `ChainToolResult["summary"]`; local `toHex(Uint8Array)`, `formatAmount`, `stroopsToXlm`; `payloadHashOf(xdr, passphrase)`, `buildPaymentSummary(...)`. No `Buffer`, no `node:`. |
| `stellar/src/payments/loadAliases.ts` | Node-only `loadAliasBook(path)` (`node:fs`), kept out of the pure modules. |
| `stellar/src/payments/index.ts` | Barrel + `configurePayments(deps)`, `getConfiguredPayments()`, default `sendPayment`, `defaultPaymentDeps(env)`. |
| `stellar/src/payments/__tests__/*` | Offline vitest suite (helpers + 5 files). |
| `stellar/config/aliases.json` | Testnet demo seed (`ada`, `bob`, `carol`) from the PUBLIC keys in `contracts/DEPLOYED.md`. No secrets. |
| `backlog/send-payment.md` | This report. |

Modified:

| File | Change |
|---|---|
| `stellar/src/index.ts` | Replaced only the `sendPayment` stub with `export { sendPayment } from "./payments/index.ts";`. `swap`/`guardPolicy`, `keeper`, `anchor` untouched. |
| `stellar/package.json` | Added `test:payments` and appended it to `test` (`keeper && anchor && payments`). Nothing else. |

Behaviour (per requirements):

- Accepts `kind:"send"` only; `asset` `"USDC"` (pinned issuer) or `"XLM"` (native).
- Amount: positive decimal string, 1–7 fraction digits, ≤12 integer digits, no
  sign/exponent/whitespace, and ≤ int64 stroops (`922337203685.4775807`).
- `recipient` is an alias name (trimmed, case-insensitive). Unknown alias **and any
  raw `G...` string** (even a known alias's own address) are refused.
- `mode` absent/`"public"` OK; `"confidential"`/`"private"` → `mode_not_supported`
  with the exact message `Privacy modes are not available yet; the payment was NOT sent`.
- `route` default `"direct"`; `"guarded"` → `guarded_route_not_available`.
- Build: `TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase, timebounds })`
  with 300 s time bounds from an injectable clock, no memo, one `Operation.payment`.
- If `checkTrustline` is supplied and returns false for a non-native asset →
  `recipient_no_trustline` (not called for XLM).
- Summary is a round trip: build XDR, decode it, read destination/asset/amount/fee
  from the decoded operation. Title `Send 10 USDC to ada`; lines
  `Pay 10 USDC (issuer GBBD…LA5)`, `To ada (<full G>)`,
  `Network: Test SDF Network ; September 2015`, `Fee: 0.00001 XLM`;
  `explorerUrl` = `<explorerBase>/tx/<payloadHash>`.

## API & refusal codes

Public surface (`stellar/src/payments/index.ts`):

| Export | Purpose |
|---|---|
| `createSendPayment(deps): ChainTool` | DI factory; returns the shared `ChainTool` shape. |
| `configurePayments(deps)` | Installs the process-wide default tool. |
| `sendPayment` | The configured default; throws `PaymentRefusal("not_configured")` before config. |
| `defaultPaymentDeps(env)` | Wires real Horizon `loadAccount` (not executed in tests). |
| `parseAliasBook`, `resolveAlias`, `findAliasCollisions`, `loadAliasBook` | Alias book. |
| `defaultAssetRegistry`, `TESTNET_USDC_ISSUER` | Pinned asset registry. |
| `payloadHashOf`, `buildPaymentSummary`, `toHex`, `formatAmount`, `stroopsToXlm` | Summary/hash helpers. |
| `PaymentRefusal`, `PaymentIntent`, `PaymentChainTool`, `PaymentDeps`, … | Types. |

`PaymentDeps`: `ownerAddress`, `aliases`, `loadAccount(address)`,
`networkPassphrase`, optional `horizonUrl`, `explorerBase`, required `assets`,
optional `checkTrustline(address, asset)`, `route`, `now`, `timeboundSeconds`.

`PaymentRefusal.code` values:

| Code | When |
|---|---|
| `not_configured` | Default `sendPayment` called before `configurePayments`. |
| `invalid_intent` | `intent.kind !== "send"`. |
| `invalid_amount` | Missing/non-string, bad shape, ≤0, or > int64 stroops. |
| `unsupported_asset` | Asset code not in the registry (e.g. `EURC`) or a non-string `asset`. |
| `unknown_recipient` | Missing/non-string/unknown alias, or any raw `G...` address. |
| `mode_not_supported` | `mode` is `"confidential"` or `"private"` (fail-closed). |
| `guarded_route_not_available` | `route: "guarded"`. |
| `recipient_no_trustline` | `checkTrustline` returned false for a non-native asset. |
| `trustline_check_failed` | The trustline precheck READ itself failed (only when `checkTrustline` is supplied). |
| `account_not_found` | `loadAccount` (owner account) rejected. |

The shared `ChainToolResult` has no refusal field, so refusals are **thrown**. The
shell should branch on `.code`, never on `.message`, and turn them into events.
Likewise `payloadHash` cannot ride on `ChainToolResult` (no extra fields), so it is
returned by `payloadHashOf(xdr, passphrase)` and by `buildPaymentSummary(...).payloadHash`.

## Test results (real, offline)

Command and verbatim last summary lines:

```
$ npm run test:payments -w @polaris/stellar
Test Files  5 passed (5)
     Tests  97 passed (97)
```

Full suite (`npm test -w @polaris/stellar`, keeper `node:test` → anchor → payments):

```
$ npm test -w @polaris/stellar
# keeper (node:test):  tests 67, pass 67, fail 0
# anchor (vitest):     Test Files  5 passed (5), Tests 111 passed (111)
# payments (vitest):   Test Files  5 passed (5), Tests  97 passed (97)
```

> The pre-fix numbers were payments 69/69; the review fixes added 28 tests and
> re-ran every gate (see "Review fixes" below).

Typecheck (`npm run check -w @polaris/stellar`, `tsc -p tsconfig.json`): exit 0, no output.

Coverage highlights: USDC + XLM happy paths decoded back (destination/asset/amount/
fee/time bounds); alias case-insensitivity and trimming; unknown alias; raw `G...`
(known and unknown) refused; 13 invalid amounts including `0`, `-1`, `1e3`,
`1.2345678` (8 dp), whitespace, empty, overflow; one-stroop and int64-max accepted;
`EURC` refused; `confidential`/`private`/`guarded` refused; missing trustline;
XLM skips the trustline check; `loadAccount` failure → `account_not_found`;
`not_configured`; summary lines exact; `payloadHash` equals `tx.hash()`;
`parseAliasBook` validation + collision warnings + the committed JSON; and a
source scan proving `aliases.ts`/`assets.ts`/`summary.ts`/`sendPayment.ts` contain no
`Buffer` and no `node:` import.

All fixtures are fake/injected: a real `Account` from `@stellar/stellar-sdk` with a
fixed clock. No Horizon, no friendbot, no network.

## How to try it (offline Node snippet, fake deps)

```ts
// run from stellar/:  node --experimental-strip-types /tmp/try.ts
import { Account } from "@stellar/stellar-sdk";
import { configurePayments, defaultAssetRegistry, sendPayment, payloadHashOf } from "./src/payments/index.ts";
const aliases = { ada: { address: "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO", network: "testnet" as const } };
configurePayments({ ownerAddress: "GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E", aliases,
  loadAccount: async (a) => new Account(a, "1000"), networkPassphrase: "Test SDF Network ; September 2015", assets: defaultAssetRegistry() });
const { unsignedXdr, summary } = await sendPayment({ kind: "send", asset: "USDC", amount: "10", recipient: "ada" });
console.log(summary.title, summary.lines, payloadHashOf(unsignedXdr, "Test SDF Network ; September 2015"));
```

## Unfinished (handed off)

- **Guarded route** (`route:"guarded"`) is refused and deliberately unimplemented;
  it needs the `polaris_guard` owner-side TS client (`pay_executor`) — the next chain
  task in the slice plan (S9). `direct` is the only route.
- **`defaultPaymentDeps` is untested against live Horizon.** It is only wired; the
  proof that a real `loadAccount` works needs the headless e2e script
  (`Intent → XDR → sign → submit`, slice S7/S8). Do not treat it as verified.
- **`mode`/`privacy` field is reserved-only.** It is accepted structurally via
  `PaymentIntent`, but `interfaces/` is not edited; the seam change is Owner A's.
- **`Buffer` note for `describeXdr`:** the anchor `describeXdr` still uses the Node
  `Buffer` global (`stellar/src/anchor/describe.ts`). The payment summary therefore
  does **not** reuse it; a hex helper (`toHex`) is used instead. If the webview ever
  imports the anchor describe path, it still needs the polyfill/migration tracked in
  slice §G.2/H.3.
- **Alias book is read-only and off-chain.** Precedence vs the on-chain `get_alias`
  (guarded mode) is specified in §12 C3 but not implemented here (no guarded mode yet).
- **No signing/payloadHash event.** The shell must call `payloadHashOf` and emit
  `approval_request` itself; this tool only builds the unsigned XDR + summary.

## Blockers

- None for this task. No network, no keys, no live services used.

## Review notes

- Start at `stellar/src/payments/sendPayment.ts` (validation order: kind → mode →
  route → asset → amount → recipient → trustline → loadAccount → build). Confirm
  that **no raw address can reach `Operation.payment`** and that the amount is
  decoded from the XDR, not trusted from the intent.
- `stellar/src/payments/summary.ts` — verify the `payloadHash` is `toHex(tx.hash())`
  and that nothing uses `Buffer`/`node:`.
- `stellar/src/payments/aliases.ts` — confirm `parseAliasBook` validates the
  G-address checksum (`StrKey.isValidEd25519PublicKey`) and `testnet` network.
- `stellar/src/index.ts` — verify only the `sendPayment` line changed and the other
  stubs/exports are intact.
- `stellar/package.json` — only the `test`/`test:payments` scripts changed.
- `stellar/config/aliases.json` — confirm addresses match the PUBLIC keys in
  `contracts/DEPLOYED.md` and contain no secrets.
- Re-run: `npm run check -w @polaris/stellar`, `npm run test:payments -w @polaris/stellar`,
  `npm test -w @polaris/stellar`.
- The reviewer who wrote no code here should ideally check the intentional
  `op.amount` canonicalisation (`"10"` in → `"10.0000000"` in XDR → `"10"` in the
  summary) is acceptable, since the card text must read naturally.

## Suggested next step

- **S9 / guard client**: add `stellar/src/guard/**` (owner-side `set_rule`, `set_alias`,
  SAC `approve`, `pay_executor`) and implement `route:"guarded"` in `sendPayment`
  (resolve the alias on-chain when the local file and `get_alias` disagree — §12 C3),
  returning `guarded_route_not_available` today.
- Then the **headless e2e** (S7/S8): `Intent → XDR → dev-key sign → submitSignedTx`
  against testnet, asserting an over-limit payment is rejected with guard `#105`.

---

## Review fixes

Applied the corrections from `backlog/send-payment-review.md`. Scope touched:
`stellar/src/payments/**` (code + tests) and this file only.

### B1 (blocking) — `resolveAlias` leaked `Object.prototype` members

- `resolveAlias` now lowercases+trims the key and reads it only when
  `Object.prototype.hasOwnProperty.call(book, key)`, returning `undefined`
  otherwise (`aliases.ts`).
- `parseAliasBook` now builds the book with `Object.create(null)` and refuses the
  reserved names `__proto__`, `constructor`, `prototype` with the explicit error
  `alias name "<name>" is reserved and cannot be used`.
- Regression tests: `resolveAlias(book, "constructor"|"__proto__"|"toString"|
  "hasOwnProperty"|"valueOf")` all return `undefined` (also on a plain-proto book);
  `sendPayment` with those recipients rejects with `PaymentRefusal`
  `unknown_recipient` instead of throwing a raw `TypeError`, for every one of the
  five names.

### Suggestion 1 — non-string `asset` / `recipient` threw raw `TypeError`s

- Non-string `intent.asset` → `PaymentRefusal("unsupported_asset")`.
- Non-string `intent.recipient` / `intent.alias` → `PaymentRefusal("unknown_recipient")`.
- A whole `null` / `undefined` intent → `PaymentRefusal("invalid_intent")` instead
  of dereferencing `intent.kind`.
- Tests cover `asset: null`, `asset: 5`, `recipient: 5`, `recipient: null`,
  `recipient: undefined`, and whole-intent `null` / `undefined`.

### Suggestion 3 — trustline-precheck read failure mislabelled

- New refusal code `trustline_check_failed` (added to the `PaymentRefusal` union
  and the table above). The `checkTrustline` catch now throws it; `account_not_found`
  is reserved for `loadAccount` failures only.
- Tests: a throwing `checkTrustline` → `trustline_check_failed`; an owner
  `loadAccount` failure with a passing trustline precheck stays `account_not_found`.

### Test-quality gaps (review §6)

- **Summary is decoded, not copied:** non-canonical input `"00010.5000000"` is
  accepted and the XDR/summary are canonical (`op.amount === "10.5000000"`, title
  `Send 10.5 USDC to ada`); a summary built from the intent text could not produce this.
- **Arbitrary mode:** `mode: "weird"` is refused with `mode_not_supported`
  (fail-closed, not just the two named modes).
- **Negative summary decoder:** a two-operation tx whose first op is not a payment
  throws `/not a payment/`; a fee-bump envelope throws `/fee-bump envelopes are not supported/`.
- **Removed the tautological test** (`ALIASES.ada.address === ADA`); replaced by a
  round-trip test that the committed `stellar/config/aliases.json` parses and every
  alias's address round-trips through `resolveAlias` and is a valid ed25519 strkey.

### Non-blocking hand-off (documented)

- **`defaultPaymentDeps` passes no `checkTrustline`.** A live USDC payment to a
  recipient without a USDC trustline therefore passes the precheck and fails later
  at submit with `op_no_trust`; the demo setup must pre-create the trustline (slice
  risk #7). Only injected `PaymentDeps` can enable the precheck today.
- **`payloadHash` is not on `ChainToolResult`.** It is exposed via
  `payloadHashOf(xdr, passphrase)` and `buildPaymentSummary(...).payloadHash`; the
  shell must call one of them to build `approval_request` before wiring the tool.

### Gates after the fixes (verbatim)

```
$ caffeinate -i npm run check -w @polaris/stellar
> tsc -p tsconfig.json
EXIT=0                                            # no output

$ caffeinate -i npm run test:payments -w @polaris/stellar
 Test Files  5 passed (5)
      Tests  97 passed (97)
EXIT=0

$ caffeinate -i npm test -w @polaris/stellar      # keeper -> anchor -> payments
# keeper (node:test):  tests 67, pass 67, fail 0
# anchor (vitest):     Test Files  5 passed (5), Tests 111 passed (111)
# payments (vitest):   Test Files  5 passed (5), Tests  97 passed (97)
EXIT=0
```
