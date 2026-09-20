# W17b — P2P "Create offer" HostError #13: preflight + plain errors

Live Trade → P2P → Sell 100 USDC failed with `HostError: Error(Contract, #13)`. Escrow codes start
at 200, so #13 is the token SAC's `TrustlineMissingError` (no USDC trustline). Confirmed live:
simulating `create_offer` (seller `GAXZBZ3T…`, USDC SAC `CBIELTK6…`) on `CBMXLTXS76…` returns #13.

## Changes
- `stellar/src/p2p/errors.ts` (+`index.ts`): `p2pErrorMessage(error,{asset})` maps SAC #1..15
  (#13 trustline, #10 balance) and escrow 200..211 to plain sentences; raw `HostError` never shown.
- `app/src/lib/p2p.ts`: fail-closed seller preflight (`preflightOffer`/`checkOfferBalance` over an
  injected Horizon read), `heldP2pAssets`, `p2pAssetCodeByToken`, `P2pContext.horizonUrl`; the voice
  `p2p_offer` tool preflights before building.
- `app/src/lib/p2pView.ts`: pure `rawFromDecimal`/`heldP2pAssets`/`checkHeldBalance` + `P2pPreflight`.
- `app/src/notch/trade/P2pTrade.tsx`: held-asset picker (default first held / XLM), "Amount (<ASSET>)",
  rows labelled by their real token, preflight blocks the approval card, friendly errors.

## Verified
- `npm run check` stellar + app clean; `test:p2p` stellar 3 files **25/0**; app **415/0** (+3 new).
- Live testnet simulation confirmed the #13 diagnosis (nothing signed or submitted).

## Human-verify
Real notch, a wallet with/without a USDC trustline, Touch ID + on-chain submit.

## Blocked / handoff
No `change_trust` "Add <ASSET> trustline" action (needs a classic-op builder, > ~40 lines). The
`tradeModel.validateOfferInputs` message still hardcodes "USDC" (file out of W17b scope); P2pTrade
rewrites the label to the selected asset.
