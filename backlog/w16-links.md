# Report: W16 — every explorer link opens in the default browser
- **Date:** 2026-09-20 · **Worker:** opencode worker (deepseek-v4.1-flash) · **Branch:** `feat/w16-links` · **PR:** none yet
- `ExplorerLink` gained an `iconOnly` variant (`page-icon-button` + aria-label), reusing the allow-listed `open_external` seam; the text variant is unchanged.
- Replaced dead `<a target="_blank">` explorer links (the Tauri webview never navigates) with `ExplorerLink`: Wallet dashboard address row, `WalletReadView` account/latest-tx/activity, `AccountList` rows.
- Added `ExplorerLink` where a tx hash had no working link: History drawer (selectable hash + copy kept), `AnchorTrade` completed result, P2P created/accepted notice, Rules auto-pay result (`resultHash`), Tasks create/cancel result, approval overlay "Sent ✓".
- The overlay hash comes from the existing `tx_submitted` event (`usePendingApproval.txHash`), reset per request/dismiss and shown only on the `sent` stage. Removed the dead `.history-link` CSS. No other external destination added (Friendbot untouched).
- **Tests:** `npm run check` clean; `npm test -w @polaris/app` **412 pass / 0 fail**; no new pure helpers → no new tests; Rust untouched.
- **Human-verify:** each click opens Safari (real `open_external`); the overlay link appears when the hash lands within its 2 s dwell.
- **Blocked / handoff:** none; only `app/src/notch/**` was touched.
