# Report: anchor-live-check (TR mock anchor SEP-6, live)

- **Date:** 2026-09-20 (all times UTC; evidence window 2026-09-19 22:12–22:20Z)
- **Worker/Agent:** W-anchor (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/anchor-check` @ `.worktrees/anchor-check`
- **Scope touched:** `stellar/src/anchor/sep6.ts`, `stellar/src/anchor/__tests__/sep6-sep38-sep12.test.ts`, `stellar/src/anchor/README.md`, this report.
- **Anchors contacted:** `tr-mock-anchor.fly.dev` (default), `horizon-testnet.stellar.org` (read-only evidence). SEP-6 only; no SEP-24.

## Verdict (5 lines)

1. **Reproduced: YES.** A fresh 50 TRY deposit (`sep_uwg7nu53jr5inqpc1926`) moved to `pending_anchor` and never completed; the client timed out with `E2E FAILED: order sep_uwg7nu53jr5inqpc1926 is still "pending_anchor" after 180s`. Verdict: **anchor-side (a/d)** — the anchor's deposit payout pipeline stopped completing orders.
2. Not (b) our client: the identical code path completed deposits in ~2 s on 2026-09-19 and the anchor accepted every step (SEP-1, SEP-10, SEP-38, SEP-12, `/deposit`, `simulate-bank-transfer`).
3. Not (c) our usage: trustline present before deposit, amount 50 TRY (accepted), correct `asset_code`/`type`, issuer `GBBD47…` unchanged.
4. Not obviously (d) a short transient: the treasury's last outgoing USDC payment is `2026-09-19T20:59:32Z`; none followed for the next ~80 min, while the anchor stayed up and kept receiving withdrawals.
5. **Fixed on our side: the graceful path only** — on poll timeout the client now narrates `sep6.timeout` and reports the anchor's sanitised last `message` + `more_info_url` in `PollTimeoutError`. The underlying anchor stall is not ours to fix.

## Timeline (exact requests, trimmed, no secrets)

New throwaway in-memory account (public key only): `GAHUQAPZU6OQMDG2LOCFLOC7KS6GACBOPVRIDNIOTWP6VEBTXNZJDCIE`.

| UTC | Layer | Request | Result |
|---|---|---|---|
| 22:12 | SEP-1 | `GET https://tr-mock-anchor.fly.dev/.well-known/stellar.toml` | `200`; `VERSION="2.7.0"`, `SIGNING_KEY=GDXYO6FJ…E73M`, `WEB_AUTH_ENDPOINT=/auth`, `TRANSFER_SERVER=/sep6`, `KYC_SERVER=/sep12`, `ANCHOR_QUOTE_SERVER=/sep38`, issuer `GBBD47IF…LFA5` |
| 22:12 | SEP-6 info | `GET /sep6/info` | `200`; deposit/withdraw/…-exchange `USDC` enabled, `authentication_required:true`, `fee_percent:0.5`; **no `min_amount`/`max_amount`** |
| 22:12 | SEP-38 | `GET /sep38/info`; `GET /sep38/price?sell_asset=iso4217:TRY&buy_asset=stellar:USDC:GBBD47…&sell_amount=50` | `200`; `{"total_price":"49.0290051","price":"48.785078","sell_amount":"50.00","buy_amount":"1.0198045","fee":{"total":"0.25","asset":"iso4217:TRY"}}` |
| 22:12 | SEP-10 | `GET /auth?account=GAHU…DCIE` | `200`; 615-byte challenge transaction (contains `web_auth_domain` op) |
| 22:12 | SEP-12/6 unauth | `GET /sep12/customer`, `GET /sep6/deposit`, `GET /sep6/withdraw` (no bearer) | all `403` `{"type":"authentication_required","error":"missing or invalid SEP-10 token"}` |
| 22:12 | Health | `GET /health` | `200`; `treasury.usdc_balance 29139.6701437`, `low_balance:false`, `limits {min_onramp_try:null,max_onramp_try:null,min_offramp_usdc:null}` |
| 22:12:37 | Preflight | Friendbot create-account for `GAHU…DCIE` | on-chain `create_account`, horizon tx `c91cad81…37a57` |
| 22:12:43 | Preflight | USDC `changeTrust` | ok |
| 22:12:44 | SEP-10/12 | challenge sign + token; customer auto-approved | ok |
| 22:12:45 | SEP-6 | `/sep6/deposit` 50 TRY -> order `sep_uwg7nu53jr5inqpc1926`, external `TRMA-NLSP-2AK5`, `amount_out 1.0198045 USDC`, fee 0.25 TRY | ok |
| 22:12:45 | Sandbox | `POST /sep6/tx/sep_uwg7nu53jr5inqpc1926/simulate-bank-transfer {"amount":"50"}` | ok; order -> `pending_anchor` |
| 22:12:45 | Order | public `more_info_url`: `GET /sep6/tx/sep_uwg7nu53jr5inqpc1926` | `status pending_anchor`, `status_eta 5`, `message "TRY received; paying USDC on Stellar."`, `started_at 22:12:45.100Z`, `updated_at 22:12:45.355Z` |
| 22:12:45–22:15:45 | Poll | `GET /sep6/transaction?id=…` every 2 s | unchanged `pending_anchor`; `E2E FAILED … still "pending_anchor" after 180s` |
| 22:16:47–22:18:22 | Re-poll | manual reads of the public order page + `/health` | still `pending_anchor`, `updated_at` unchanged; `/health` time `22:18:22Z` |
| 22:12 | Horizon | `GET /accounts/GCLC…W7T3Z6/payments?order=desc` | newest **outgoing** treasury payment `20:59:32Z`; incoming withdrawals e.g. 1 USDC at `22:12:02Z` |
| 22:12 | Horizon | `GET /accounts/GAHU…DCIE/payments` | only the Friendbot `create_account`; **no USDC payout** |

### Exact failing output (client, trimmed)

```
Anchor: tr-mock-anchor.fly.dev  Account: GAHUQAPZU6OQMDG2LOCFLOC7KS6GACBOPVRIDNIOTWP6VEBTXNZJDCIE
...
  [sep6.deposit] SEP-6: asked the anchor to turn 50 TRY into USDC ... order sep_uwg7nu53jr5inqpc1926 ...
  [sandbox.bank] Sandbox: pretended to be the bank and told the test anchor that 50 TRY arrived for order sep_uwg7nu53jr5inqpc1926 ...
  [sep6.status.pending_anchor] SEP-6 order sep_uwg7nu53jr5inqpc1926: The anchor is processing the order. ...
E2E FAILED: order sep_uwg7nu53jr5inqpc1926 is still "pending_anchor" after 180s
EXIT=1
```

Failing step: SEP-6 deposit polling (`pollTransaction`), after the sandbox bank trigger. The order is stuck at `pending_anchor` = "TRY received; paying USDC on Stellar", i.e. the anchor never submits the USDC payout.

## Comparison: 2026-09-19 (working) vs 2026-09-20 (this check)

| Item | 2026-09-19 (UTC) | 2026-09-20 (UTC) | Change |
|---|---|---|---|
| SEP-1 endpoints / signing key `GDXY…E73M` | same | same | none |
| Asset issuer `GBBD47…LFA5`, treasury `GCLC…W7T3Z6` | same | same | none |
| SEP-38 `50 TRY -> USDC` | `1.0198045` (fee 0.25 TRY) | `1.0198045` (fee 0.25 TRY) | none |
| SEP-10 challenge / SEP-12 auto-approve | works | works | none |
| SEP-6 deposit order + simulate-bank-transfer | accepted | accepted | none |
| **Deposit completion** | `pending_anchor -> completed` in ~2 s | **stuck `pending_anchor` > 180 s** | **BROKEN** |
| Treasury outgoing payouts on Horizon | frequent (multiple/min) | **last at 20:59:32Z, none after** | **stopped** |
| `/sep6/info` min/max | printed `0.5 / 300` | **fields absent** | changed |
| `/health` limits | (not recorded) | `min/max: null` | null |
| Withdraw minimum | 1 USDC (400 text), `/info` said 0.5 | not re-tested (account had 0 USDC; see risks) | n/a |

## Diagnosis and classification

**Class (a)/(d), anchor-side.** The anchor accepts orders and receives fiat (simulated) but its payout worker/Stellar submission stopped completing deposits. Evidence:

1. Treasury had **zero outgoing USDC payments after 20:59:32Z**, while inbound withdrawal payments continued (e.g. 1 USDC at 22:12:02Z) — payouts specifically halted.
2. Our order's `message` explicitly says `"TRY received; paying USDC on Stellar."` with `status_eta 5` and `updated_at` frozen; it never entered `pending_stellar`.
3. Infrastructure was healthy: `/health ok:true`, Horizon `200`, treasury ~29 139 USDC (`low_balance:false`), SEP-10/38/12 all fine.
4. The client used the exact documented flow; the same code succeeded on 2026-09-19. No code path changed on our side before this run.

Nothing in the failures points at (b) our client or (c) our usage (trustline was added before deposit; amount, asset, issuer and `type` all correct).

## Fix (our side, minimal) + regression test

`stellar/src/anchor/sep6.ts` — `pollTransaction` timeout branch now:

- records an explain event `sep6.timeout` that says the order is stuck and that a non-moving `pending_anchor` is usually anchor-side (safe next step: check later, don't pay again);
- includes the anchor's **sanitised** last `message` in the `PollTimeoutError` message (e.g. `… still "pending_anchor" after 180s; the anchor last said: "TRY received; paying USDC on Stellar."`), with embedded double quotes escaped so the quoting cannot be broken; and
- includes the `more_info_url` only when it is **https-only, credentials rejected, length-capped (≤300), and host-restricted to the anchor's own host after this fix** — i.e. its host must exactly equal the anchor's home domain (or a host declared in that anchor's stellar.toml `TRANSFER_SERVER`/`WEB_AUTH_ENDPOINT`). An off-host link is omitted and reported as `(link withheld: not on the anchor's host)`; a link is never fetched automatically. The composed error is capped at a fixed maximum (`MAX_POLL_TIMEOUT_MESSAGE`); if the link does not fit, it is kept only in the `sep6.timeout` explain record's `link` field.

Anchor text still never enters `what`/`why`: it is passed as `anchorSaid` only.

`stellar/src/anchor/__tests__/sep6-sep38-sep12.test.ts` — new offline regression test (mocked HTTP, no network) `narrates and reports the anchor's last message + more_info_url when a deposit is stuck (live 2026-09-20 regression)`: serves a `pending_anchor` transaction with a `message`/`more_info_url`, forces a timeout, and asserts the error message contains both, that the last explain record is `sep6.timeout` with `anchorSaid`, and that the narration excludes the anchor text. This reproduces the live failure shape with a mock.

`stellar/src/anchor/README.md` — added a "2026-09-20 live re-check" subsection documenting the stall, the evidence, and the new graceful reporting.

## SEP-24 audit (TR path)

No SEP-24 usage. `grep -rniE "sep[-_ ]?24|interactive|/sep24" stellar/src/anchor/` finds only the standard SEP-12/6 error string `non_interactive_customer_info_needed` (an error `type`, not SEP-24) and the README's explanatory section "Why SEP-24 is deliberately not used in Turkey". No interactive endpoint is read, configured or demoed; `stellar.toml` does not expose one and the client never requests one.

## Gates (all run with `caffeinate -i`, from `stellar/`)

```
npm run check -w @polaris/stellar        # tsc -p tsconfig.json -> EXIT 0
npm run test:anchor -w @polaris/stellar  # Test Files 5 passed (5), Tests 112 passed (112)
npm test -w @polaris/stellar             # EXIT 0
  test:keeper   : pass 67, fail 0
  test:anchor   : 112 passed (112)
  test:payments : 121 passed (121)
  test:guard    : 133 passed (133)
  test:approval : 112 passed (112)
  test:schedule : 121 passed (121)
  test:suggest  : 145 passed (145)
  test:live     : 112 passed (112)
```

## Remaining risks / open items

- **Anchor payout stall is unresolved** (not ours). The deposit path cannot reach `completed` until the anchor's payout worker recovers; the new error surfaces this clearly instead of a bare timeout.
- **Withdrawal was not re-tested live:** the task allows one withdrawal of 1 USDC, but the failed deposit left the throwaway account with 0 USDC, so there was nothing to cash out. Horizon still shows inbound withdrawal payments (1 USDC at 22:12:02Z), so the user→treasury leg appears alive; the anchor's TRY-payout leg is simulated and not observable on-chain. No loop against the shared treasury was performed.
- `/sep6/info` no longer reports `min_amount`/`max_amount` and `/health` reports `null` limits. The client treats them as optional (verified: order creation still works), but limits are now effectively unenforced by the anchor.
- Total shared-treasury use this session: **one** 50 TRY deposit order that did **not** pay out, so no treasury USDC was spent by us.

## Recommended demo guidance for the TR anchor (safe amounts/steps)

- **Before a demo, check `/health`:** if `low_balance:false` but the treasury's last outgoing payment on Horizon is more than a few minutes old, assume deposits are stalled. Prefer **discovery/quote/login** (fully read-only) or a demonstrated **withdraw** (USDC -> TRY) over a live deposit until payouts resume — but note that "withdraw instead" is **NOT live-verified**: only the user->treasury leg works (inbound USDC payments are visible on Horizon), while the anchor's TRY payout leg is off-chain/simulated and withdrawal **completion was not re-tested**, so a withdraw is not guaranteed to reach `completed` either.
- **Safe, always-available steps:** SEP-1 discovery, SEP-10 login, SEP-38 quote (`GET /price` works unauthenticated), SEP-12 auto-approval, `/sep6/info`, and building a withdrawal order (treasury account + id memo).
- **Deposit amount:** keep it at the proven minimum, **50 TRY** (50 TRY -> ~1.0198045 USDC, fee 0.25 TRY). Never loop; one deposit per demo.
- **Withdraw:** minimum is **1 USDC** (the anchor returns `400 "Minimum off-ramp is 1.0000000 USDC"` below it, regardless of `/info`); one withdrawal of ~1 USDC is enough. This minimum is live-observed, but withdrawal **completion is NOT live-verified** (see the caveat above): the user->treasury leg works, the TRY payout leg is simulated.
- **Fallback:** for a non-TR comparison only, `testanchor.stellar.org` (SRT/USDC) works for discovery/login/info, but it demands real SEP-12 fields and must **not** be presented as the Turkish path.
- If a deposit must be shown while the anchor is stalled, run it, let the client time out, and use the new message to explain that the order is stuck on the anchor's side — do not ask the user to pay again.

## Acceptance

`git status --short` shows only the allowed paths (plus the temporary `node_modules` symlink, removed at the end); no secrets in the report or diff (`grep -E "S[A-Z2-7]{55}"` over report + diff is empty).
