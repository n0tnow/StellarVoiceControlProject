# Anchor client (SEP-6 on/off-ramp)

Anchor-agnostic client for moving between a local currency (TRY) and an on-chain
asset (USDC) through any anchor that speaks the standard **programmatic** SEPs.
The only inputs are the anchor's **home domain** (default `tr-mock-anchor.fly.dev`)
and the **asset code** (default `USDC`). Everything else is discovered.

Testnet only. No key handling: signing is injected through the `Signer` interface.

## What each SEP does in this code

| SEP | Role | Our code | What happens, in plain words |
|---|---|---|---|
| SEP-1 | `stellar.toml` discovery | `sep1.ts` | Read `https://<home domain>/.well-known/stellar.toml` and learn the auth, transfer, KYC and quote endpoints plus the anchor's signing key and the asset issuer. Nothing is hard-coded. |
| SEP-10 | Web authentication | `sep10.ts` | Fetch a challenge (a transaction that can never be submitted), validate it, have the injected signer sign it, trade it for a JWT. Proves we own the key without a password. |
| SEP-12 | Customer / KYC | `sep12.ts` | Register as a customer. The mock auto-approves after an empty PUT. If a real anchor wants fields, we throw `KycRequiredError` with the field names instead of inventing personal data. |
| SEP-38 | Price quotes | `sep38.ts` | `GET /price` gives an indicative rate (works without auth): "50 TRY buys about 1.0198 USDC". |
| SEP-6 | Deposit / withdraw | `sep6.ts` | `GET /deposit`, `GET /withdraw`, `GET /transaction`, plus a polling state machine over the SEP-6 statuses. |

Around them: `preflight.ts` (Friendbot + USDC trustline), `horizon.ts` (account reads, submit),
`session.ts` (the object the agent drives), `flows.ts` (whole deposit/withdraw journeys),
`explain.ts` (the narration log), `chainTools.ts` (the `ChainTool` wiring).

Only standard endpoints are used. The one exception is `sandbox.ts`
(`simulate-bank-transfer`), a mock-only helper that plays "the bank"; it is opt-in
(`sandboxBank: true`) and would simply not be called against a real anchor.

## Flows

```
Deposit (TRY -> USDC)                           Withdraw (USDC -> TRY)
1  SEP-1   discover endpoints                   1  SEP-1   discover endpoints
2  preflight: funded? USDC trustline?           2  SEP-38  quote
3  SEP-38  quote                                3  SEP-10  login, SEP-12 KYC
4  SEP-10  login, SEP-12 KYC                    4  SEP-6   /withdraw -> anchor account + memo
5  SEP-6   /deposit -> bank instructions        5  WE pay USDC to that account with that memo
6  (bank transfer; sandbox: simulate)           6  poll -> completed (anchor pays TRY)
7  poll -> completed, USDC arrives
8  Horizon: read the resulting balance
```

## Usage

```ts
import { anchor } from "@polaris/stellar";

const session = new anchor.AnchorSession({ signer });            // signer: anchor.Signer (Touch ID in the app)
session.explain.subscribe((r) => speak(`${r.what} ${r.why}`));   // narrate every step

const quote = await session.quoteDeposit("500");                 // { data, explain[] }
await session.prepareAccount();                                  // friendbot + trustline via signer
const dep = await session.startDeposit("500");                   // login + KYC run implicitly
const done = await session.waitForTransaction(dep.data.id);      // repairs pending_trust on its own
```

Every step method returns `{ data, explain }`, where `explain` is a list of
`{ step, what, why, at }` records for that step, e.g.

> `sep10.sign` — *SEP-10: proved we own GB3E...V275 by signing the challenge — no password involved and no funds moved.*
> Why: *A signature can only be made by the holder of the private key, so the anchor now knows this is really you.*

Whole journeys: `anchor.runDepositFlow(session, { amountFiat, sandboxBank })` and
`anchor.runWithdrawFlow(session, { amountAsset })`.

`ChainTool` contract: `depositTry(intent)` returns the first thing the user must
approve, with a summary decoded from the XDR: the USDC trustline if still needed,
otherwise the SEP-10 challenge. After the shell signs it: `submitSignedTx(xdr)` for a
trustline, or `session.finishLogin(signedXdr)` for the challenge; then continue with
`session.startDeposit(...)`. For cash-out, `withdrawTry(intent)` creates the SEP-6
order and returns the **unsigned on-chain payment** plus an approval card that names
the destination, the memo and the asset **code and issuer**; after signing,
`submitSignedTx(signedXdr, unsignedXdr)` submits it (the expected XDR enables a
hash check; a sequence-0 login challenge is refused with a pointer to
`finishLogin`), then poll. Configure once with `configureAnchor({ signer })`.

> `withdrawTry` is typed with a local `AnchorIntent` that adds the `"withdraw"`
> kind (PR #8 adds it to `@polaris/interfaces`; the TODO there will disappear on
> merge). Likewise `toAnchorStepEvent()` in `explain.ts` emits exactly
> `{ type: "anchor_step", step, what, why }`, the shape PR #8 adds to `PolarisEvent`.

## Safety hardening (round-2 review)

Everything an anchor sends is untrusted. The client enforces this at the boundary:

* **Home domain / URLs:** only a plain FQDN is accepted; http, IP literals,
  `localhost`, ports, credentials, paths and internal TLDs are refused before any
  request. Every endpoint in `stellar.toml` must be **https on the anchor's own
  domain (or a subdomain)**; the only escape hatch is the test/ops-only
  `allowInsecure` / `allowedEndpointHosts` policy. Requests use
  `redirect: "error"` and a timeout that also covers reading the body; the toml is
  capped at 100 KB and JSON bodies at 1 MB, streamed or declared.
* **Untrusted text:** every anchor-authored string (`how`, `instructions`,
  status `message`, quote amounts, text-memo echoes, TOML parser messages, error
  bodies...) is sanitised (controls, newlines, zero-width and bidi characters
  removed, hard-capped at `MAX_ANCHOR_TEXT = 200` unless a tighter format applies)
  and carried in explain records as `anchorSaid` — **never** in `what`/`why`, and
  `narrate()` excludes it, so prompt injection cannot ride the TTS/LLM narration.
  SEP-38 quote amounts/fee assets are additionally format-validated (bounded
  decimal / asset-id patterns) before they can appear anywhere.
* **Test-only signer:** `EnvSigner` is deliberately not in the main barrel;
  tests and the e2e script import it from `@polaris/stellar/anchor/testing` (or
  the relative `testing.ts`), so it cannot ship in the app bundle.
* **Login credential:** the SEP-10 JWT stays inside the session. `login()` and
  `finishLogin()` return `{ account, expiresAt }` (`SessionInfo`), never the token.
* **Withdrawal payment:** the destination must be a plain `G...` account (muxed
  `M...` is refused) and the memo is validated against Stellar's exact rules
  (id = uint64 as a string; large JSON ids are quoted before parsing so they stay
  exact; text ≤ 28 UTF-8 bytes; hash = 32-byte hex/base64). `payWithdrawal()` pays
  **only** the response this session received from `startWithdraw()` — a caller
  cannot substitute a target — and the signed envelope is checked against the
  unsigned one before submission. `prepareWithdrawal()` is the unsigned preview
  for the approval card.
* **Paused orders:** `pending_customer_info_update` /
  `pending_transaction_info_update` stop the poll immediately (no 180 s spin) and
  surface the missing field names (`TransactionInfoRequiredError`), asking SEP-12
  `GET /customer?transaction_id=` when a KYC server exists.
* **Code loading:** no TypeScript parameter properties/enums anywhere; the package
  is `erasableSyntaxOnly` and loads under plain `node` (`node
  --input-type=module -e "await import('./stellar/src/anchor/index.ts')"`), which
  is why the e2e script runs with `node`, not `tsx`.

## The pending_trust gotcha

A Stellar account can only receive an asset after it has a **trustline** for it, and
it must exist (be funded with XLM) first. If it has not, the anchor accepts the
deposit, receives the bank transfer, and then parks the order in `pending_trust`
forever. The SDF workshop demo hit exactly this. We handle it twice:

1. **Preflight** (`prepareAccount` / `preflight`): Friendbot funds a new testnet account,
   then a `changeTrust` for USDC is signed through the injected signer. Idempotent:
   nothing is done, signed or paid when the account is already ready.
2. **Repair while polling** (`waitForTransaction`): if the anchor reports `pending_trust`
   anyway, the session adds the trustline once and keeps polling. Verified live: the
   mock completed the stuck order right after the trustline appeared.

On mainnet the zero-XLM user needs sponsored reserves / fee bumps instead of Friendbot
(see docs/architecture.md section 4.3).

## Verified behaviour of the TR mock anchor (2026-09-19, live)

* SEP-38 `GET /price` works **without** auth and uses `sell_asset` / `buy_asset`
  (`iso4217:TRY`, `stellar:USDC:<issuer>`). 100 TRY -> 2.0396090 USDC, 50 bps spread.
* Deposit `amount` is in **TRY**. `/sep6/deposit` reports `min_amount 50 / max_amount 3000`
  (TRY), but `/sep6/info` prints `0.5 / 300`; treat `/info` as unreliable and use the
  deposit response.
* Withdraw `amount` is in **USDC**, and the real minimum is **1 USDC**
  (`400 "Minimum off-ramp is 1.0000000 USDC"`) although `/sep6/info` says 0.5.
* Withdraw response: `account_id` (the anchor's treasury account), `memo_type: "id"`,
  `memo`, `id`, and a rate locked for 30 minutes in `extra_info.message`. There is **no**
  `withdraw_anchor_account` field until you read the transaction. Paying that account
  with that memo moves the order `pending_user_transfer_start -> completed` in about
  5-6 seconds ("TRY paid to TR02... via FAST (simulated)").
* Deposit statuses seen: `pending_user_transfer_start -> (simulate) pending_anchor -> completed`
  (about 2 seconds), or `pending_trust -> completed` after the trustline is added.
* SEP-12: `GET /customer` says `NEEDS_INFO`; any `PUT /customer` (even with no fields)
  flips it to `ACCEPTED`.
* SEP-10 challenges carry a `web_auth_domain` operation; our validation requires it.

`testanchor.stellar.org` (SDF) also works as a second home domain for SEP-1/10/6
discovery and info (assets SRT/USDC/native, amounts 1-10) but demands SEP-12 fields
(`first_name`, `last_name`, `email_address`), which surface as `KycRequiredError`.

## Mock vs mainnet

| | TR mock anchor (testnet) | Real Turkish anchor (mainnet) |
|---|---|---|
| Route | TRY -> USDC in one atomic step | TRY -> TRYB -> USDC (two legs) |
| Access | Home domain only, no key | No static API key; OAuth and IP allow-listing |
| KYC | Auto-approved, no data | Real KYC / identity data |
| Bank leg | Simulated (`simulate-bank-transfer`) | Real bank transfer (FAST / EFT) |
| Zero-XLM user | Friendbot funds the account | Sponsored reserves / fee bumps needed |

The client stays portable because it only uses standard SEP endpoints; the two-leg
route and the auth model will need extra steps on top of it.

## Why SEP-24 is deliberately not used in Turkey

Polaris is a voice-controlled wallet, so the wallet must own the whole flow. The
hosted/interactive deposit style (SEP-24) sends the user to a page the anchor runs
inside a pop-up; in Turkey that hosted, interactive model is prohibited under MASAK
rules, while the programmatic SEP-6 model is legal (source: SDF anchor workshop).
So this client implements SEP-6 only, with SEP-1, 10, 12 and 38 as its supporting
standards. Nothing here reads, configures or demos the hosted flow, and cross-border
(SEP-31) and contract-account auth (SEP-45) are out of scope too.

## Testing

```bash
npm test -w @polaris/stellar                       # unit tests, mocked HTTP, no network
npm run check -w @polaris/stellar                  # typecheck (also part of `make check`)

# live testnet run: preflight -> quote -> deposit -> simulate bank -> completed -> balance -> withdraw
npm run anchor:e2e -w @polaris/stellar -- --amount-try 50 --withdraw-usdc 1
# POLARIS_TEST_SECRET=S... reuses one throwaway wallet; unset = a fresh in-memory key
```

Keep test deposits small (50-100 TRY): the mock's treasury is shared.

## Not done here

* No real signer: `EnvSigner` (`POLARIS_TEST_SECRET`) is test-only; the Touch ID signer plugs into `Signer`.
* Firm SEP-38 quotes (`POST /quote`) and `deposit-exchange` / `withdraw-exchange` are not used; indicative quotes only.
* SEP-6 `fee` endpoint, claimable-balance deposits, refunds handling beyond reporting the status.
