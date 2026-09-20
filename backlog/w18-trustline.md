# W18 — "Add asset" (trustline) so faucet USDC / anchor SRT can actually be received

## What was done
- **`stellar/src/payments/trustline.ts`** (new): unsigned `changeTrust` builder. Pinned catalog (USDC `GBBD47IF…`, SRT `GCDNJUBQ…`), injected `loadAccount`, sequence/fee + 300 s upper bound (minTime 0) like `sendPayment`, summary decoded from the XDR (`Add USDC to your wallet`), typed `TrustlineRefusal`. Exported from `payments/index.ts` and `stellar/src/index.ts`.
- **`app/src/lib/walletAssets.ts`**: `TRUSTLINE_ASSETS`, `hasTrustline`, `trustlineRows`, `USDC_FAUCET_URL/HINT` (pure, unit-tested). **`app/src/lib/trustline.ts`** (new): `buildAddTrustline` (real Horizon) and `runAddTrustline` → the existing `runTx` pipeline (approval card → Touch ID → `wallet_sign` → submit). No new signing path, no auto-approve.
- **Wallet** (`notch/wallet/AddAsset.tsx` + wired in `WalletDashboard.tsx`): "Add asset" text button under the balance hero → USDC/SRT rows with `Add` / disabled `Added`; success re-reads balances so the chip appears; once USDC is added the faucet hint + "Open faucet" + "Copy address" show.
- **`notch/trade/P2pTrade.tsx`**: the missing-trustline sentence now offers an "Add <asset>" action through the same flow.
- **`app/src-tauri/src/external.rs`**: allow-listed `https://faucet.circle.com/` (+ tests).

## Verified
- `npm run check` (all workspaces) clean. `npm test -w @polaris/app` **416/0** (8 walletAssets, incl. new). `vitest src/payments` **135 passed**, incl. 9 new trustline tests (SAC equality `CBIE…DAMA`, time bounds, refusals).
- `cargo test external` **3/3**; `cargo clippy -- -D warnings` clean.
- History/balances: `history.ts` already lists both directions (`mapWalletTransactions`), `chainToHistoryRow` → "Received X USDC"; `deriveAssetRows` already shows every trustline. No fix needed.

## Remaining / human
- Live Touch ID + real faucet delivery are **not verified** (needs a human on a real Mac). No transaction submitted.
- **Pre-existing red (not W18):** `stellar/src/payments/typedRecipient.test.ts` is a `node:test` file under the vitest `test:payments` glob → `vitest` reports "No test suite found" (added by W17 `d2532e6`). Left untouched to keep scope; suite is otherwise 135/0.
- Nits: `app/src/lib/app.ts` docstring still says "only testnet explorer URLs" (now also the faucet) — outside W18 scope.
