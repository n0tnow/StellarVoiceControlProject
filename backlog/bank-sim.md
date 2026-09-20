# BANK-SIM — simulated bank + automated on/off-ramp loop

**What/why.** Simulate the customer's bank and automate **bank → anchor → wallet**
(deposit) and **wallet → anchor → bank** (withdraw). The anchor is real (SDF test
anchor by default, per the owner's latest decision); only the bank is ours.
**Files.** `app/src-tauri/src/bank.rs` (+`lib.rs`): ledger `bank.json` under the
app data dir (atomic, no secrets, integer minor units), TR mod-97 IBAN, commands
`bank_account/history/debit/credit/settle/refund/reset/set_currency/anchor_config/
health`, event `bank_changed`. `app/src/lib/{bank.ts,bankFlow.ts (pure automation +
`localStorage` persistence),bankAnchor.ts (session adapter, scenario/limits, voice
intent)}`. UI `panels/anchor/{BankSection.tsx,useBank.ts}` + `AnchorPanel.tsx`;
`chain.ts` routes deposit/withdraw to `runBankIntent` and configures the anchor
with `POLARIS_ANCHOR_HOME_DOMAIN` (default SDF); Debug `checks/bank.ts`.
**Decisions.** Extra helpers (`settle/refund/set_currency/anchor_config`) were
needed for the loop + env read; all task-named commands exist. Ledger keeps the
`amountTry` wire name; `currency` follows the anchor's quoted fiat. A failed or
stalled deposit refunds the reservation; a withdrawal credits the payout once.
Cancellable before money moves; restart reconciles in-flight work.
**Verification.** `cargo test` **328 passed / 0 failed / 5 ignored** (+9 bank
tests). `cargo clippy --all-targets -- -D warnings` clean. `npm run check` clean;
`npm test -w @polaris/app` **372/372** (+10 `bankFlow.test.ts`); `npm test -w
@polaris/agent` **190/190**; `npm run build -w @polaris/app` OK.
**Human / live.** Real Touch ID + embedded wallet (SEP-10 via
`wallet_sign_challenge`, trustline, withdrawal payment via `txPipeline` →
`wallet_sign`), a live SDF deposit/withdraw, and the panel on a real Mac.
**Blocked / handoff.** `docs/anchor-sdf-flow.md` was not on `origin` yet; flows
were built against the abstract `AnchorSession` and follow the anchor's real
`/info` limits + quoted fiat automatically. `demo-local` not detected yet.

**MERGE-BANK (2026-09-20).** Merged `feat/bank-sim-automation` into
`integration/wallet-login`. `lib.rs` resolved by hand (both command lists + setup
blocks once); `chain.ts` deposit/withdraw route to `runBankIntent` behind the
wallet session gate + Touch ID pipeline; challenge via `wallet_sign_challenge`,
no Freighter refs in new paths. Verified: check clean, app 431/0, agent 213/0,
stellar 970/0, build OK, cargo 386/0/5-ignored, clippy `-D warnings` clean.
