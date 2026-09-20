# Polaris — Live Demo Script (3–4 min)

> **Testnet only.** Every step below is implemented in this repo; `[verify live]`
> marks what still needs a human on a real Mac (mic, Touch ID, real
> windows). Public addresses: owner **acc1**
> `GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A`, recipient **acc2**
> `GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV`.
> Panels/tray: `docs/ui-panels.md`. Signing path: `docs/ui-panels.md` §9.

## Pre-flight (do 5 min before)
- [ ] `make setup` — installs deps, creates `.env` from `.env.example`, generates icons.
- [ ] `.env` filled: `OPENCODE_API_KEY`, `GROQ_API_KEY`, `FISH_AUDIO_API_KEY`,
  `POLARIS_OWNER_ADDRESS=<acc1>`, `POLARIS_ALIASES=acc2=GB25QEDA…`,
  `GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`.
- [ ] acc1 funded (testnet XLM; PGUSD trustline + balance for the guard scene).
- [ ] Wallet ready: `tray → Wallet…` create or import an account (the seed stays
  in the macOS Keychain; the embedded wallet is the only signer).
- [ ] Keeper running: `export KEEPER_SECRET=$(stellar keys show keeper)` then
  `caffeinate -i npm run keeper -w @polaris/stellar` (rehearse once with `--dry-run`).
- [ ] `make dev` starts the shell; the menu-bar tray icon appears, no Dock icon.
- [ ] `tray → Debug…`: `app`, `network`, `voice`, `approval`, `wallet` are green.
- [ ] Anchor dry run: `npm run anchor:check -w @polaris/stellar -- --live --payout-check`.

## Scene 1 — Voice payment, owner-approved (0:00–1:20)
- **Say:** hold **Control+Option**, say **“Send 10 XLM to acc2.”**, release.
- **On screen:** notch pill expands `Listening → Thinking`; on release it stays open
  and speaks **“Sending 10 XLM to acc2. Do you confirm?”** `[verify live: mic + STT]`
- **Open:** the Approval window opens by itself (`#/approval`): decoded XDR summary,
  From acc1 / To acc2 / 10 XLM, focus on **Deny**.
- **Do:** Touch ID. The embedded wallet signs in-app; no browser opens.
- **On screen:** notch speaks **“Sent 10 XLM to acc2.”** and the `tx_submitted` link
  (stellar.expert testnet) appears.
- **Fallbacks:** mic fail → Debug panel `network`/`wallet` checks, or
  `npm run e2e:build-xdr` prints a real unsigned acc1→acc2 XDR; wallet fail →
  `tray → Wallet…` re-check the active account; network fail → show the
  recorded transaction.

## Scene 2 — On-chain guard rules (1:20–2:00)
- **Open:** `tray → Security & rules…` — limits, allowance, executor and alias book read
  live from the deployed `polaris_guard` (demo asset **PGUSD**, SAC `CC2V2R6J…`, `contracts/DEPLOYED.md`).
- **Say:** **“Don’t ask me for payments under 25 PGUSD.”** Read-back, then **one** card lists
  `approve → set_rule → set_executor` (D13), **one** Touch ID. `[verify live]`
- **Say:** **“Send 40 PGUSD to acc2”** (above the limit): rejected on-chain, falls back to the
  `pay_owner` card path. `[verify live]`
- **Fallback:** `contracts/scripts/demo.sh` replays the same guard behaviour headless
  (payment, `#105` NeedsOwnerApproval, owner re-send).

## Scene 3 — Scheduled payment + keeper (2:00–2:40)
- **Open:** `tray → Schedules…`; create a one-shot **“Send 5 PGUSD to acc2 in 1 minute”**
  `[verify live]`. The card shows local **and** UTC time.
- **Watch:** ~15–25 s after due, the keeper submits `execute_schedule`; the keeper log shows
  `executed` and the explorer link.
- **Fallback:** `npm run keeper:once -w @polaris/stellar` for one deterministic tick.

## Scene 4 — Panels tour (2:40–3:30)
- **Anchor…**: SEP-1 discovery → SEP-10 login → SEP-38 quote → SEP-6. `[verify live]`
- **P2P…**: Soroban escrow create/accept/confirm (`POLARIS_P2P_CONTRACT_ID` currently unset).
- **Privacy…**: SPP private payments, **read-only** (status/contracts/evidence); value-moving
  forms are disabled pending a wallet `signAuthEntry`.
- **Wallet…**: balances, alias book, last 10 payments from Horizon.

## Scene 5 — Close (3:30–3:45)
- **Say:** “The model proposes; you dispose.” Every value-moving step is gated by Touch ID and
  signed by the embedded wallet, and bounded by on-chain rules. **Testnet only**; the app never
  holds a key.
