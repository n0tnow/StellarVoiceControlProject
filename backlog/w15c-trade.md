# W15c — Trade page (anchor deposit/withdraw + P2P) inside the notch

**Status:** done, awaiting review. Branch `feat/w15c-trade` (uncommitted).

## What
Replaced the `TradePage` stub with a three-segment page (Deposit · Withdraw · P2P, default Deposit).
Deposit/Withdraw reuse BANK-SIM (`bankDeposit`/`bankWithdraw` from `lib/bankAnchor.ts`): one amount
field (default `10`), one primary button, and the seven engine steps folded into three rows
(Bank debited → Anchor received → Wallet credited; reversed for withdraw). Value movement stays in
the existing pipeline (SEP-10 wallet-only; withdrawal payment via Touch ID). P2P reuses `lib/p2p*.ts`
exactly (offers list + Accept; text "Sell" form → `create_offer`). Locked wallet → shared `LoginGate`.

## Files
- `app/src/notch/pages/TradePage.tsx` (stub replaced): segments + gate + body switch.
- `app/src/notch/trade/tradeModel.ts` + `tradeModel.test.ts` (pure: phases, balance line, validation).
- `app/src/notch/trade/useAnchorTrade.ts`, `AnchorTrade.tsx`, `P2pTrade.tsx`.

## Decisions
- Default amount `10` per the brief; the demo bank's 50 floor (`validateBankAmount`) is not applied,
  so one tap completes a loop. The anchor's advertised max is still enforced.
- Default `sdf-test`/SDF scenario via `getBankAnchorConfig`; no pickers. `panels/**` untouched.

## Verification
- `npm run check -w @polaris/app`: clean.
- `npm test -w @polaris/app`: **444 pass / 0 fail** (10 new in `tradeModel.test.ts`).
- `npm run build -w @polaris/app`: green. No Rust touched.

## Human-verify (not possible by automation)
- Live SDF deposit/withdraw (real Touch ID + network); P2P accept/create against the deployed
  escrow; real notch window rendering/scroll.

## Blocked / handoff
- None. Nothing outside scope was edited.
