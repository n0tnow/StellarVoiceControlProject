# SDF test anchor (`testanchor.stellar.org`) — verified flow

Verified live 2026-09-20, **both directions**, with in-memory throwaway testnet keys (no owner
key, no secret printed). Endpoints: `/auth`, `/sep6`, `/sep12`, `/sep38`; signing key `GCHL…33PR`.
It also publishes `TRANSFER_SERVER_SEP0024`, which this project never uses.

- **SEP-10 login**: `GET /auth?account=G…&home_domain=…` returns a challenge with `minTime = now+1`,
  `maxTime = now+900`. Succeeds with a Friendbot-funded throwaway account; returns a JWT (never printed).
- **SEP-6 info**: deposit/withdraw enabled for `SRT`, `USDC`, `native`, `min=1`, `max=10`.
  Deposit `type`/`funding_method`: `SRT` accepts `bank_account`; `USDC`/`native` need `SEPA`/`SWIFT`
  (400 otherwise). Withdraw accepts `bank_account`. This is why the SDF scenario defaults to **SRT**.
- **SEP-38**: quotes `iso4217:USD`/`iso4217:CAD` with `context=sep6`, NOT TRY (`buy_asset not found`).
  Delivery method must be omitted or `WIRE`; `bank_account` → `Unsupported sell delivery method`.
  Live: `10 USD → 62.069 SRT` (fee 1 USD), `10 SRT → 1.3043 USD` (fee 1 SRT).
- **SEP-12 account KYC**: `GET /customer` → `NEEDS_INFO` requiring `first_name`, `last_name`,
  `email_address`. A `PUT` with those three returns 202; the next GET is `ACCEPTED`.
- **SEP-12 per-transaction KYC**: an order first reports `incomplete`, then
  `pending_customer_info_update`; `GET /customer?transaction_id=…` requires `address`, `birth_date`,
  `id_type` (`drivers_license|passport|national_id`), `id_country_code`, `id_issue_date`,
  `id_expiration_date`, `id_number` (withdraw also `bank_account_number`, `bank_account_type`,
  `bank_number`, `bank_branch_number`). We submit `PUT /customer` with `transaction_id` and resume
  polling; the anchor may ask in several rounds. These are synthetic values (`SDF_DEMO_CUSTOMER`,
  TEST DATA — testnet SDF test anchor only, see `scenarios.ts`), never real user data.
- **Deposit** (`npm run anchor:e2e -w @polaris/stellar -- --home-domain testanchor.stellar.org`):
  `10 USD` → order → `incomplete` → `pending_customer_info_update` → (KYC) → `pending_anchor` →
  `completed`; `amount_in 10 iso4217:USD`, `amount_out 10 stellar:SRT:…`; ~10 SRT arrives. Tx
  `a8e1d27c3977e81276b7a963af96bc34eeda578615e25c6316cea47dfbb8778d`
  (https://stellar.expert/explorer/testnet/tx/a8e1d27c3977e81276b7a963af96bc34eeda578615e25c6316cea47dfbb8778d).
- **Withdraw**: `GET /sep6/withdraw` returns only `{id}` (the payout account is DEFERRED). After the
  order's SEP-12 KYC the transaction exposes `withdraw_anchor_account` + id `memo`; we pay exactly
  that. `10 SRT` → `pending_anchor` → `completed`; `amount_out 10 iso4217:USD`. Payment tx
  `14edf23fc718d7fcf1c2c563c0b949611e20be6943307c52e3be4bd166a15a2c`
  (https://stellar.expert/explorer/testnet/tx/14edf23fc718d7fcf1c2c563c0b949611e20be6943307c52e3be4bd166a15a2c).
- **Timing**: the full deposit+withdraw e2e takes ~45-47 s end to end on testnet (Friendbot +
  trustline + two KYC rounds + polling); each leg's final status appears within a few seconds.

## Anchor selection (fallback)

The shell picks ONE anchor before any money moves: it preflights the approved
scenarios in order (SDF test anchor first, then `tr-mock-anchor.fly.dev`) with a
~6 s SEP-1 discovery + SEP-6 `/info` supported-asset check and uses the first
healthy one. The chosen scenario supplies the asset pair (SDF: USD/SRT; TR:
TRY/USDC), the fiat label, the wallet balances and the trustline — never mixed.
If neither answers, the UI shows one plain line ("No anchor is reachable right
now — try again in a minute") with per-anchor reasons behind "Details", and
nothing is debited. The second anchor is only ever an up-front choice, never a
retry after value moved.

**Gotchas**: fund the account first (Friendbot) or requests 404; add the asset trustline before the
deposit completes or it stalls in `pending_trust`. Issuers: SRT
`GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B`, USDC
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`. The withdrawal payout account can take
a moment to appear after KYC, so the client polls the order before paying.
