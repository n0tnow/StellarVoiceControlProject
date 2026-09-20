# The notch UI

The notch panel is the **only** surface. There are no popup windows, no tray icon
and no "⋯" menu: every screen is a page inside the notch, selected by the in-panel
nav or a voice navigation request (`app/src/lib/navigation.ts`).

- Entry: `app/src/notch/NotchPanel.tsx`, mounted from `ShellSurface.tsx`; the page
  ids live in `app/src/notch/notchPage.ts` (`history` | `tasks` | `rules` |
  `wallet` | `trade` | `settings`, default `history`).
- The panel body is one scrolling column (~600×300 pt usable). Nothing may need
  horizontal scroll.

## Pages

| Page | What it does |
|---|---|
| **History** | Activity timeline: day-grouped rows, filter chips, search, "Copy CSV", and an in-place detail drawer (hash, fee, memo, voice transcript). |
| **Tasks** | On-chain scheduled payments. Cancel and "New schedule" go through the shared tx pipeline. |
| **Rules** | The on-chain guard rule, editable: limits, contacts, Always-ask. A change is a batch approval (one Touch ID). |
| **Wallet** | Create / import / unlock (Touch ID step-up) / dashboard: balances, accounts, recipients, send. |
| **Trade** | Deposit · Withdraw (automated bank↔anchor loop) and P2P open escrow offers. |
| **Settings** | Session and auto-lock, network/status, privacy, Diagnostics, and Quit. |

## Approval is inline

Every value-moving action goes through `app/src/lib/txPipeline.ts` — never a
page-local call. When a transaction needs approval, `usePendingApproval` pins the
notch `panel` state and renders the approval card **over the page body**
(`app/src/notch/approval/`): summary + Approve/Deny, then Touch ID. A deny or a
failure is shown in place; a submitted tx shows its result briefly, then collapses.
No window ever opens.

## Diagnostics

The Settings page's Diagnostics section (`notch/settings/DiagnosticsSection.tsx`)
is the only place FeatureChecks run. "Run all checks" calls `runAll` from
`app/src/debug/runner.ts` and lists one line per check (status + detail). Checks
are read-only unless a check is explicitly named; nothing auto-runs at startup.
