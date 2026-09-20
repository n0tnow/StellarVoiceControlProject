# SDF test anchor (`testanchor.stellar.org`) — verified flow

Verified live 2026-09-20 with in-memory throwaway testnet keys (no owner key, no secret printed).
Endpoints: `/auth`, `/sep6`, `/sep12`, `/sep38`; signing key `GCHL…33PR`. It also publishes
`TRANSFER_SERVER_SEP0024`, which this project never uses.

- **SEP-10 login**: `GET /auth?account=G…&home_domain=…` returns a challenge with
  `minTime = now + 1`, `maxTime = now + 900` (900 s window). Login succeeds with a throwaway
  or newly-Friendbot-funded account and returns a JWT (never printed).
- **SEP-6 info**: deposit and withdraw enabled for `SRT`, `USDC`, `native`, `min=1`, `max=10`,
  no `fee_percent`. Deposit `type` must be `SEPA`/`SWIFT` for USDC/native (400 otherwise); `SRT`
  accepts `bank_account`. Withdraw accepts `bank_account`.
- **SEP-38**: quotes `iso4217:USD`/`iso4217:CAD` with `context=sep6`, NOT TRY. The repo session
  defaults to TRY, so `anchor:e2e` against SDF stops at the quote (`sell_asset not found`).
- **SEP-12 account KYC**: `GET /customer` → `NEEDS_INFO` requiring exactly `first_name`,
  `last_name`, `email_address` (~45 other fields optional). A `PUT` with those three returns 202,
  the next GET is `ACCEPTED`. `SDF_DEMO_CUSTOMER` (`Demo`/`User`/`demo@polaris.invalid`) is
  auto-filled.
- **SEP-12 per-transaction KYC**: a deposit/withdraw moves to `pending_customer_info_update`;
  `GET /customer?transaction_id=…` then requires `address`, `birth_date`, `id_type`
  (`drivers_license|passport|national_id`), `id_country_code`, `id_issue_date`,
  `id_expiration_date`, `id_number` (withdraw also `bank_account_number`, `bank_account_type`,
  `bank_number`, `bank_branch_number`). These are real identity data — refused with
  `KycRequiredError`, never fabricated.
- **Deposit** (manual probe, identity fields supplied): `GET /sep6/deposit?asset_code=SRT&account=G…&amount=10&type=bank_account`
  → `{id}`; the anchor simulates the off-chain leg itself (no sandbox call). Statuses:
  `pending_customer_info_update` → `pending_anchor` ("Funds received from user") → `completed` in ~11 s.
  `amount_in` is `10 iso4217:USD`; `amount_out` is `10 stellar:SRT:…`. 10 SRT arrived on Horizon;
  deposit tx `4f78a240e69d56e18b29d566b9e59d7a38df82ae7b46d081105b4c40beeb9fe7`
  (https://stellar.expert/explorer/testnet/tx/4f78a240e69d56e18b29d566b9e59d7a38df82ae7b46d081105b4c40beeb9fe7).
- **Withdraw**: `GET /sep6/withdraw?asset_code=SRT&account=G…&amount=10&type=bank_account`
  returns only `{id}`; the anchor defers `account_id`/memo until bank KYC is complete, so the repo's
  immediate-`account_id` expectation cannot pay it. Not completed here.

**Gotchas**: fund the account first (Friendbot) or requests 404; add the asset trustline before the
deposit completes or it stalls in `pending_trust`. Issuers: SRT
`GCDNJUBQSX7AJWLJACMJ7I4BC3Z47BQUTMHEICZLE6MU4KQBRYG5JY6B`, USDC
`GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`.
