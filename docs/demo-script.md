# Polaris — Live Demo Script (≈4 min)

> **Testnet only.** Every step is implemented in this repo; `[verify live]` marks what
> still needs a human on a real Mac (mic, STT, Touch ID, real windows, live anchor).
> The **notch is the only surface**: the menu-bar tray is gone and there are no
> popup windows; every screen (History, Tasks, Rules, Wallet, Trade, Settings) is a
> page inside the notch. Addresses: owner **acc1**
> `GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A`, recipient **acc2**
> `GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV`.
> Notch UI: `docs/notch-ui.md`. Wallet design: `docs/wallet-track.md`.

## Pre-flight (5 min before)
- [ ] `make setup` — npm install + `.env` from `.env.example` + icons.
- [ ] `.env` filled: `OPENCODE_API_KEY`, `GROQ_API_KEY`, `FISH_AUDIO_API_KEY`,
  `GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`,
  `POLARIS_P2P_CONTRACT_ID=CBMXLTXS76S72SIPLVMCQOSS6SN2CR4V3Q73GZPRA4GRIBEM7RE5OLJW`.
  The shell finds the repo-root `.env`; a Finder-launched bundle falls back to
  `~/Library/Application Support/Polaris/.env`.
- [ ] `make build` then `make run` (or `make dev` for HMR).
- [ ] Keeper running: `export KEEPER_SECRET=$(stellar keys show keeper)` then
  `caffeinate -i npm run keeper -w @polaris/stellar` (rehearse once with `--dry-run`).
- [ ] `⋯ → Debug…`: `app`, `network`, `voice`, `approval`, `wallet`, `anchor`, `bank`
  green. `[verify live: value checks need the Mac]`

## Scene 1 — Create the wallet (0:00–0:40)
- Wallet gate auto-opens. **Create** → a 24-word phrase is shown **once**; store it in
  the macOS Keychain. (Or **Import** an `S…`/phrase.) `[verify live: Keychain + Touch ID]`
- **Fund** with Friendbot; the dashboard shows network, key + QR, balances.

## Scene 2 — Recipient + voice payment (0:40–1:50)
- Wallet → recipients: add **acc2**
  `GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV` as a "rumuz".
- **Say:** hold **Control+Option**, say **“Send 10 XLM to acc2.”**, release.
- Notch: `Listening → Thinking`, then the spoken read-back **“Sending 10 XLM to
  acc2. Do you confirm?”** `[verify live: mic + STT]`
- Approval card opens from the decoded XDR (From acc1 / To acc2 / 10 XLM, Deny
  focused). **Touch ID** → the embedded wallet signs in-app; no browser. Speaks
  **“Sent 10 XLM to acc2.”** with an explorer link.
- **Fallback:** mic/STT fail → `npm run e2e:build-xdr` prints a real acc1→acc2 XDR;
  network fail → show the recorded explorer tx.

## Scene 3 — Rules by voice → autonomous payment (1:50–3:00)
- **Say:** **“Don’t ask me for payments under 10 XLM.”** One batch card lists
  `approve → set_rule → set_executor` (D13) and **one** Touch ID arms auto-pay.
  `[verify live: Touch ID]`
- **Say:** **“Send 1 XLM to acc2.”** No card: the executor key settles it on-chain via
  `pay_executor` (recorded as `auto` in History). `[verify live]`
- **Say:** **“Send 15 XLM to acc2.”** Above the limit → on-chain `#105`, falls back to
  the owner approval card + Touch ID. `[verify live]`
- **Fallback:** `npm run e2e:autopay` replays the same guard behaviour headless
  (unattended 1 XLM SUCCESS, 15 XLM `#105`).

## Scene 4 — Bank ⇄ anchor (3:00–3:40)
- **Say:** **“Deposit 10 dollars.”** The simulated bank debits its IBAN, the SDF test
  anchor (`testanchor.stellar.org`) quotes and pays out SRT/SRT→USD; the panel shows the
  bank ledger + anchor steps. `[verify live: anchor payout needs the network]`
- **Say:** **“Withdraw 10 SRT.”** Same loop in reverse (credit-once), both directions.
- **Fallback:** `npm run anchor:check -w @polaris/stellar -- --live --home-domain
  testanchor.stellar.org --payout-check`; verified flow in `docs/anchor-sdf-flow.md`.

## Scene 5 — P2P offer + History + close (3:40–4:15)
- P2P panel: create an offer (seller locks a token, asks TRY). The contract ID is
  `CBMXLTXS76…`. `[verify live: panel + Touch ID]`
- History: timeline with filters, search, detail drawer, paging across payments,
  auto-pay and anchor/P2P rows.
- **Close:** “The model proposes; you dispose.” Touch ID gates every value-moving step,
  the embedded wallet signs in-app, and `polaris_guard` bounds what runs unattended.
  Testnet only.
