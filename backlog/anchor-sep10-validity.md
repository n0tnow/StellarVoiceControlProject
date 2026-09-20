# ANCHOR-SDF — Stellar SDF test anchor as working scenario (2026-09-20)

**Cause.** `anchor:check --live` failed both anchors ("challenge stays valid for an unreasonably
long time"). Live data: both issue `minTime = now+1`, `maxTime = now+900` (finite). Our check used
`maxTime - now` (901 s) against an exact 900 s bound → off-by-one, not the anchor (case b).
**Fix.** `sep10.ts` bounds the challenge's OWN window `maxTime - minTime` (fallback `now` if
`minTime=0`); `MAX_CHALLENGE_WINDOW_SECONDS`=24 h (justified inline); `maxTime=0` still refused; all
other SEP-10 checks kept. +4 regression tests in `sep10.test.ts`.
**SDF scenario.** `scenarios.ts` adds `SDF_DEMO_CUSTOMER`/`demoCustomerFields` (Demo/User/
demo@polaris.invalid) and lists sep12/deposit/withdraw; `sep12.ts` auto-fills ONLY requested+known
fields else `KycRequiredError`; `session.ts` `customerFields`; `e2e.ts` passes SDF demo KYC + skips
the TR sandbox; `check.ts` final line. Docs: `docs/anchor-sdf-flow.md`, anchor `README.md`.
**Files.** `stellar/src/anchor/{sep10,sep12,session,e2e,scenarios,check,index}.ts` + 4 test files.
**Verified.** `npm run check` green; `npm test -w @polaris/stellar` green — 1037 tests (keeper 67,
anchor 204, payments 126, guard 133, approval 112, schedule 121, suggest 145, p2p 17, live 112);
`anchor:check --live` both anchors PASS SEP-1/6/10. Manual probe: SDF login + demo SEP-12 + deposit
completes ~11 s → 10 SRT on Horizon (tx `4f78a240…`); full detail in `docs/anchor-sdf-flow.md`.
**Blocked/handoff.** `anchor:e2e --home-domain testanchor.stellar.org` stops at SEP-38 (SDF quotes
USD/CAD, session defaults TRY). A full SDF deposit/withdraw with demo-only data is impossible: the
anchor's per-transaction identity fields (`id_type`,`id_number`,`birth_date`,address,id dates) are
refused (`KycRequiredError`); withdraw also defers `account_id` until bank KYC. Owner decision.

## ANCHOR-SDF2 — full bank<->anchor loop LIVE, both directions (2026-09-20)

**Done.** Scenario `sdf-test` now carries `fiat:USD`, `assetCode:SRT`, no SEP-38 delivery method;
`SDF_DEMO_CUSTOMER` extended with clearly-fake per-transaction identity + bank fields (TEST DATA,
SDF test anchor only). `sep12.ensureTransactionCustomer` does per-order `GET/PUT /customer` with
`transaction_id` (multi-round, bounded; unknown field still `KycRequiredError`). `pollTransaction`
gained `onCustomerInfoRequired` (bounded retries) and `incomplete` now polls instead of stopping.
Withdraw tolerates a deferred `account_id`, runs the order KYC, then polls the transaction for
`withdraw_anchor_account`+memo before paying exactly that. e2e is scenario-driven (USD/SRT).
**Verified live** (`anchor:e2e --home-domain testanchor.stellar.org`, twice): deposit 10 USD →
`incomplete -> pending_customer_info_update -> pending_anchor -> completed` → 10 SRT
(tx `a8e1d27c…`); withdraw 10 SRT → deferred account resolved → `pending_anchor -> completed`
(tx `14edf23f…`); ~45-47 s for both legs. `npm run check` green; `npm test -w @polaris/stellar`
green — 1044 tests (anchor 211). Docs: `docs/anchor-sdf-flow.md`, anchor `README.md`.
**Handoff.** TR mock unchanged (verified quote with/without delivery method); no human-only items.
