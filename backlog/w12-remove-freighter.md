# W12 — remove the Freighter bridge completely

**Goal:** the embedded wallet (`wallet_sign`, `wallet_sign_challenge`) is the only signer; the browser bridge (Freighter / Stellar Wallets Kit) is deleted.

## Done
- **Rust:** deleted `bridge/{server.rs,launch.rs,commands.rs}` and the commands `bridge_sign`/`bridge_selftest`/`bridge_health`/`bridge_sign_challenge`/`anchor_signing_health` + their `lib.rs` registration and launcher state; removed `tiny_http` and `subtle`. Kept `bridge/verify.rs`, `bridge/strkey.rs` (nested under the unchanged `bridge::` path) and moved the wire result struct `BridgeOutcome` to a new `bridge/outcome.rs` (the wallet commands still return it). Dropped the test-only helpers only the deleted bridge tests used (`OWNER_KEY`, `sign_with`, `sign_fixture`). `POLARIS_SIGNER`/`resolve_signer` removed; `signer` is always `embedded`.
- **TS/web:** deleted `app/bridge.html`, `app/src/bridge/**`, `scripts/bridge-fixture.mjs`(+test), the `bridge:fixture` script, `docs/freighter-bridge.md`, `debug/checks/bridge.ts` and its helpers, `@creit.tech/stellar-wallets-kit` (+ lockfile pruned: −6328 lines), the second Vite entry, `resolveSigner`/`POLARIS_SIGNER`/`bridge_sign` branches, `bridge_health` in the Settings panel, `POLARIS_BRIDGE_BROWSER`. `wallet_sign_challenge` is the only challenge command; `signing.ts` always calls `wallet_sign`.
- **Docs:** `docs/wallet-track.md` §1 records build→review→removal; `ui-panels/interfaces/README/pitch/demo-script/spp-demo` de-Freightered. Historical `backlog/*` untouched.

## Decisions
- `WalletOnly` approval mode + `begin_wallet_only`/`authorize_wallet_only` were kept (defense-in-depth primitive), annotated `#[allow(dead_code)]`; they were only exercised by a deleted test.
- `BridgeOutcome` keeps the bridge-era type name intentionally (avoid cross-package churn); only its module path moved.
- The Session-style flowchart comments ("Touch ID → Freighter") now read "wallet signing".

## Verification (real output)
- `grep -rni freighter app agent stellar interfaces scripts docs/*.md README.md` → only `docs/wallet-track.md` (historical/decision note). `git grep bridge_sign` → only `backlog/` + `sprints.md` (historical). `POLARIS_BRIDGE_BROWSER` → none.
- `npm run check` clean; `npm test -w @polaris/app` **396/0**, `-w @polaris/agent` **213/0**, `-w @polaris/stellar` **112/0**; `npm run build -w @polaris/app` OK.
- `cargo test` **348 passed / 0 failed / 5 ignored**; `cargo clippy --all-targets -- -D warnings` clean.
- Bundle: before (HEAD build) had `dist/bridge.html` + `bridge-BsAFps49.js` (121.8 kB, contains `StellarWalletsKit`/`FreighterModule`); after there is **no bridge entry and no wallets-kit chunk** (`grep -rli stellar-wallets-kit app/dist` → none).
- Unchanged: fail-closed approver, seq-0-only challenge signing, `take_authorized` the only XDR exit.

## Remaining / human-verify
- Live embedded-wallet payment, Touch ID, and a real SEP-10 challenge need a human on a Mac (not verified here).
- A later task may rename the `bridge` module (kept for in-flight branches).
