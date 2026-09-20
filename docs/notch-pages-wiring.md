# Wiring the notch pages to real data

The four notch panel pages (`app/src/notch/pages/**`) render `app/src/lib/mockData.ts`
only. Each page is presentational; wiring a page to real data means replacing its
mock array with a loader, not rewriting the markup. The page-routing seam stays as
is: `setNotchPage("history" | "tasks" | "rules" | "wallet")` from
`app/src/notch/notchPage.ts` (see `useNotchPage`) already accepts a voice intent.

| Page | File | Real source (already implemented) |
|---|---|---|
| History | `notch/pages/HistoryPage.tsx` | `lib/history.ts`: `fetchOwnerPayments` + `mapHistoryRecords` (→ `WalletTransaction`), plus the turn's transcript/response text. Map to `HistoryEntry`. |
| Tasks | `notch/pages/TasksPage.tsx` | `lib/schedulesLive.ts`: `loadUpcoming`; `lib/schedules.ts`: `toScheduleRows`, `keeperStatus` (mirror the `SchedulesPanel`). |
| Rules | `notch/pages/RulesPage.tsx` | `lib/guardStateLive.ts`: `loadSecurityState`; `lib/guardState.ts`: `stateLines`, `profileModeOf`, `ruleFromFields` (mirror `SecurityPanel`). |
| Wallet | `notch/pages/WalletPage.tsx` | `lib/stellarConfig.ts`: `getStellarConfig` (owner/network, `stellar_config`); `lib/history.ts`: `fetchOwnerAccount`/`fetchOwnerPayments`; `lib/address.ts`: `shortAddress`. |

Tasks page (NW3): `notch/data/useTasksData.ts` adapts `loadUpcoming` →
`toScheduleRows` → `TaskRow` (amount/recipient, local + UTC next run,
recurrence, runs left, status) and reuses `keeperStatus` for the keeper hint. It
is demo (mock) only outside Tauri or without an owner address; a real read
failure shows the error + Retry. Cancel is the single value-moving action and
goes through `cancelChainTool` + `useTxRun`/`txPipeline`; demo rows (no numeric
id) are not cancellable. The empty state points at the voice example because
schedule creation stays a voice action. Covered by the existing `schedules`
Debug check (same data source).

Notes:

- The existing panels are the reference implementations; reuse their loaders and
  models rather than calling Horizon directly from a notch page.
- Read-only first: Wallet/Rules/Tasks pages should render the loaded state. Any
  value-moving action must go through the shared seam (`executeApprovedIntent` /
  `runTx`), never a page-local call.
- No secrets, testnet only. Owner address and aliases come from `stellar_config`,
  never from the bundle.

## NW1 — Wallet page (done)

`WalletPage.tsx` now calls `useWalletData` (`app/src/notch/data/useWalletData.ts`), which loads
`stellar_config` plus `fetchOwnerAccount`/`fetchOwnerPayments`, merges the alias book with
`buildAliasEntries`/`mapWalletTransactions`, and subscribes to `tx_submitted` for a session "Latest
transaction". A pure `deriveWalletPageView` picks the state (loading / unconfigured / offline /
unfunded + Friendbot / ready) so the page renders only real data or an honest error; there is
deliberately no mock fallback. Reads are read-only, load on mount and refresh on demand (no polling).
## Rules page (NW2)

`notch/pages/RulesPage.tsx` now renders `notch/data/useRulesData.ts`. The hook
does one read on mount (re-run by the error state's Retry, no polling) and the
pure `mapRulesView(load)` turns `loadSecurityState()` into the page's view model:
the same `stateLines` read-back the Security panel shows (profile, executor,
limits, recipients, allowance, spent-today) plus a `Saved contacts` line from the
alias book. States: `unconfigured` ("Guard not configured"), `not_set_up` (rule
`null`), `error` + Retry (`unreachable`); a real read failure never falls back to
mock. Outside Tauri, or when `stellar_config` has no owner, the page shows the
labelled mock demo. The page is read-only — its only action is "Edit rules in
Security", which reveals the inline rules editor.
## History (NW4)
`HistoryPage` now reads `useHistoryData`, which merges the local turn log
(`lib/turnLog.ts`, a 50-entry `localStorage` ring buffer fed from `App.tsx`) with
the owner's recent Horizon payments (`fetchOwnerPayments` → `mapWalletTransactions`
→ `historyModel.ts` mappers), newest first and de-duplicated by tx hash. The page
is refreshed on open and via a Refresh action; "Clear local history" empties the
turn log. The mock timeline is used **only** when not running in Tauri or when
`stellar_config` has no owner address; a failed real read shows its error with a
Retry. The turn log stores no XDR and no secret material.

## HISTORY-UI — pro History timeline

`HistoryPage` now renders `notch/history/`: pure `model.ts` (rich rows, kind/status/
route/approval, 7-decimal `bigint` signed amounts), `group.ts` (filter chips
All/Sent/Received/Auto/P2P/Anchor/Voice with counts, search, sticky day groups,
relative/exact time), `csv.ts` (visible-row CSV copy) and best-effort
`p2pHistory.ts`/`anchorHistory.ts` (open offers of the active wallet; session anchor
explain rows). Rows expand into a detail drawer; `useHistoryData` adds Horizon cursor
pagination (20/page, 200 cap), Refresh/Load more and an offline notice. Demo/mock is
unchanged (no Tauri or no owner). `turnLog` gained optional metadata fields.

## W10b — Wallet login + recipients (notch)

`WalletPage.tsx` now drives the Rust wallet engine (feature-detected; "not in this build" falls back
to the read-only env-owner view). No wallet → Create / Import: create shows the 24-word phrase once
behind an "I saved it" gate; import previews the derived address before storing and clears the field
on submit/cancel. A wallet is active → `AccountList` (select/rename/remove, copy/explorer) over the
NW1 `WalletReadView` (balances, Friendbot when unfunded, alias book). Recipients ("rumuz") live in
the same column: nickname + `G...` address, nickname `[a-z][a-z0-9_-]{0,31}` (reserved words
rejected), address checked by StrKey checksum. Rust `contacts.rs` persists `contacts.json` (atomic,
max 200) and `stellar_config` merges contacts under env aliases, so the agent refreshes its alias
table each turn and "send 5 XLM to ali" resolves. A value-moving intent with no active wallet is
refused with one sentence and the Wallet page, with no chain call. New Debug check: `contacts`.

## W13b — professional wallet experience (login gate → dashboard)

The Wallet page now follows the Rust session (`wallet_session` / `wallet_session_changed`,
feature-detected by `WalletPage`): `none` → Create/Import, `locked` → `UnlockScreen` (wallet picker
+ Touch ID), `unlocked` → `WalletDashboard`. `lib/walletSession.ts` holds the pure engine/store and
selectors (`walletScreenFor`, `shouldGateForSession`, `shouldAutoOpenWallet`, `didSessionLock`);
`walletSessionLive.ts` binds Tauri, `notch/wallet/useWalletSession.ts` exposes them to React through
one `useSyncExternalStore` subscription. `ShellSurface` opens the panel on Wallet **once** at launch
when the session is not unlocked and collapses it on the unlocked → locked (logout / auto-lock)
edge; the panel is always closable (Close, Escape, hover-away). While gated, History/Tasks/Rules
render `LoginGate` — no chain reads. A value-moving intent while locked answers "Please
unlock your wallet first." (`decideWalletGateForSession`), opens Wallet and makes no chain call.

The dashboard reads via `useWalletData` (extended: trustlines/issuer/sequence/subentries from
`lib/walletAssets.ts`, plus 10 activity rows) and shows the Testnet badge (passphrase tooltip),
Funded chip, full public key with copy/explorer, a lazily-loaded dependency-free QR (`lib/qr.ts`)
for Receive, ordered assets with the `(2 + subentries) × 0.5 XLM` native reserve, collapsed account
details, recent activity, account switching, Send, Log out (`wallet_lock`) and the auto-lock setting.
Send builds the same `Intent` and runs the same `executeApprovedIntent` pipeline as voice. Debug
check `walletSession` reports the session non-destructively.

