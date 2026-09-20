# W14 — "Connect your existing wallet" as the primary first-run path

## What / why
"Create new" led and "Import" was a plain secondary action, so the embedded
wallet read like a fake wallet. The real-wallet path (Freighter/Lobstr/xBull
`S…` key → Keychain → Touch ID → in-app signing) is now primary. No Rust/voice.

## Files touched
- `app/src/lib/walletFlows.ts`: new `CONNECT_COPY` (single source, testable).
- `ConnectScreen.tsx`: title "Connect your wallet"; primary **"Connect existing
  wallet"** (→ import, secret mode default), secondary **"Create new wallet"**;
  new body copy; `StoreNotice` kept.
- `ImportWallet.tsx`: heading "Connect existing wallet"; preview "Connect this
  account?"; confirm **"Connect and store in Keychain"**; a11y "Connect type";
  masked field / no logging / cleared on submit-cancel-failure unchanged.
- `walletFlows.test.ts`: default-secret + "never says Import" tests.
- `docs/wallet-track.md`: one paragraph on the connect-first UX.

## Dead-end check (item 3)
`session::import` calls `connect()` (session.rs:243), so import leaves the
session **unlocked**; `reload()` then routes to the dashboard with the new
account — no extra unlock, no return to Connect. Security unchanged.

## Verification
`npm run check` clean; `npm test -w @polaris/app` **434/0**;
`app/src/lib/walletFlows.test.ts` 9/0.

## Human-verify
Real Touch ID/Keychain + notch ranking not verified. No blockers.
