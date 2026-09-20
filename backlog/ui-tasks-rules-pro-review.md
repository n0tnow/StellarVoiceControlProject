# Review: ui-tasks-rules-pro (independent L4)

- **Verdict:** APPROVE WITH CHANGES — the redesign and the read-parallelisation are
  sound, but the module-level caches are **not scoped to the owner/network**, so an
  account switch can paint the previous account's schedules/rule and, worse, let a
  Save/Turn-off act on the new account with the old account's values. **Blocking
  issues 1 and 2 must be fixed (and tested) before merge.**
- Branch `feat/ui-tasks-rules-pro` @ `59ef253` (3 commits on `e226808`), reviewed
  by reading the full diff and the current files; every command re-run locally.
- I did not write this code, did not modify any source, and did not commit/push.

## Blocking issues

### 1. Module-level caches are not keyed by owner/network — cross-account leak and wrong-account write
- **Where:** `app/src/notch/data/useTasksData.ts:122,213-218,230-231` (`tasksCache`,
  seed, `tasksCache = load`) and `app/src/notch/rules/useRulesEditor.ts:56,123-130,141-150`
  (`rulesCache`, seed, `rulesCache = next`).
- **Why it is reachable:** the owner used by every read is the **active embedded
  wallet**, not a fixed env value: `app/src-tauri/src/stellar_config.rs:300`
  (`read_with_wallet(wallet.active_address())`) with the override at
  `stellar_config.rs:229-231`. The Wallet page can switch the active account at
  runtime: `app/src/notch/wallet/SessionWalletView.tsx:114`
  (`onSelectAccount={(address) => run(walletEngine.select(address))}`), wired from
  `WalletDashboard.tsx:223`. `loadTasks`/`loadSecurityState` read
  `getStellarConfig().ownerAddress` on every call
  (`useTasksData.ts:169`, `useRulesEditor.ts:93`, `guardStateLive.ts:110`), so a
  switch genuinely changes the data — but the cache still holds the old owner's
  snapshot.
- **Impact:** on returning to Tasks/Rules after switching accounts, the page paints
  the previous account's scheduled payments / spending rule for the whole
  revalidation window (seconds over RPC, unbounded on a slow network). If the
  revalidation fails, the cache is overwritten with the error (see #3) but the first
  frame already leaked the other account's data. On Rules, `security` (and therefore
  `form`) is seeded from the stale account and `disabled` is `false`
  (`RulesEditor.tsx:81`), so a user can press **Save** / **Turn off automatic
  payments** and `ruleIntent` runs with the old account's limits
  (`useRulesEditor.ts:163,174-175`, `rulesModel.ts:72-90`) against the **new**
  owner — a value-moving bug, not just a display glitch.
- **Additionally:** the Tasks revalidation effect depends only on `[timeZone, nonce]`
  (`useTasksData.ts:242`), so a mounted page does not even refetch when the owner
  changes.
- **Minimal fix:** give both caches a key (`${ownerAddress}|${networkPassphrase}`),
  store it with the snapshot, and only seed/serve when the key matches the current
  read. Simplest robust variant: extract a small `createSnapshotCache()` keyed by
  owner+network, and clear both module caches when the wallet session's active
  address changes (subscribe to `walletSessionStore`, e.g. on the `unlocked → locked`
  edge / active change). Include `ownerAddress` in the Tasks/Rules effect deps.

### 2. The high-risk cache/dedupe logic has no tests, and the commit/report overstate coverage
- **Where:** commit `e3bdfd0` "test(ui): cover tasks cache/view state and rules load
  probe"; `app/src/notch/data/useTasksData.test.ts:93-102` only exercises
  `tasksViewState` (a pure function); `app/src/notch/rules/rulesLoad.test.ts`
  covers `probeExecutor`/`editorSnapshotFrom` only.
- **Why it blocks:** the actual new logic — `fetchTasks`/`tasksInFlight`
  (`useTasksData.ts:148-153`) and `fetchEditorSnapshot`/`rulesInFlight`
  (`useRulesEditor.ts:115-120`), cache seeding, and mutation/owner invalidation — has
  **zero** direct tests. None of the tests would catch blocking issue #1 or the
  revalidation-overwrite in #3, so the change is merged on unverified risk.
- **Minimal fix:** extract the cache/dedupe into a tiny injectable module and unit
  test it with a fake loader: (a) two concurrent callers issue one read; (b) a cached
  snapshot paints before the promise resolves; (c) a different owner key does not
  serve the previous snapshot; (d) a mutation/refresh bypasses the in-flight promise.
  Correct the commit/report claim ("new tests (10)", "cover tasks cache") to match
  what is actually asserted.

## Non-blocking suggestions (fix or file as follow-ups)

1. **Failed revalidation destroys valid cached data.** `useTasksData.ts:230-238` and
   `useRulesEditor.ts:141-150` unconditionally write the new snapshot. A transient
   RPC failure replaces a populated list / a valid rule with the error state
   (`tasksViewState` returns `error` because `count === 0`,
   `useTasksData.ts:141-144`). For a stale-while-revalidate cache, keep the last good
   snapshot and show a non-destructive "refresh failed" hint instead of collapsing
   the body. (The report's claim "a background refresh never collapses the list"
   only holds for the skeleton, not for this error path.)
2. **In-flight dedupe can serve a pre-mutation snapshot.** After a submitted
   mutation, `refresh()`/`setNonce` (`useTasksData.ts:257,287`,
   `useRulesEditor.ts:167`) calls `fetch*`; if a read is still in flight,
   `fetch*` returns that older promise and then stamps it into the cache
   (`useTasksData.ts:230-231`, `useRulesEditor.ts:142`), briefly showing
   pre-mutation data. Low probability, but a mutation epoch/generation token (or
   clearing `*InFlight` on mutation) removes it.
3. **`MemoTaskRow` does not actually memoize.** `TasksPage.tsx:217` passes a fresh
   `onCancel={(target) => void onCancel(target)}` on every render, so
   `React.memo` (`TasksPage.tsx:102`) always sees a changed prop and re-renders every
   row. The report's "rows are memoized" claim is not delivered. Use a stable
   `useCallback` handler (or pass `scheduleId` and a stable handler).
4. **Rules form can be clobbered by a background refresh.** With a cached snapshot
   the inputs are immediately editable (`disabled = busy || security === null`,
   `RulesEditor.tsx:81`) while the mount effect revalidates and calls
   `setForm(next.form)` (`useRulesEditor.ts:147`); a fast edit right after reopening
   the page is silently discarded. Only seed `form` on first load or when the form is
   not dirty.
5. **Rules refresh affordance is inconsistent.** The Rules refresh button
   (`RulesEditor.tsx:104-113`) never shows the pending state and stays enabled during
   a background revalidation, unlike Tasks (`TasksPage.tsx:154-163`). Reuse the
   `refreshing` pattern (or add one) for parity.
6. **"≤2 visible inputs" is only true before Advanced opens.** With Advanced expanded
   Tasks shows 4 inputs (To/Amount/Every/First run,
   `NewScheduleForm.tsx:65-125`) and Rules shows 3 (threshold/per-payment/per-day,
   `RulesEditor.tsx:139-180`). If the rule is strict about *simultaneously visible*
   inputs, this needs a second look; the default (collapsed) view does satisfy it.
7. **Report/verification number inaccuracies.** `npm test -w @polaris/stellar` runs
   8 Vitest suites (219+137+133+112+121+145+25+112 = 1004 tests) **plus** the
   `node:test` keeper suite (67 tests) = **1071**, not "112/112" (112 is only the
   `test:live` suite). `npm run check` (4 workspaces) and `npm run build -w
   @polaris/app` are genuinely green; app tests are genuinely 485/485.

## Checklist results

### 1. Re-run everything yourself — **PASS**
Re-run on this worktree after `npm install`:
- `npm run check` → all four workspaces (`interfaces`, `agent`, `stellar`, `app`)
  exit 0.
- `npm test -w @polaris/app` → `tests 485 / pass 485 / fail 0`, exit 0.
- `npm test -w @polaris/stellar` → exit 0; keeper 67, plus 8 Vitest suites totalling
  1004 (219/137/133/112/121/145/25/112), all pass.
- `npm run build -w @polaris/app` → `✓ built in 505ms`, exit 0; `main-*.js` 264.70 kB
  (gzip 77.54), lazy `client-*.js` 744.13 kB (gzip 147.61) unchanged, new
  `main-*.css` 6.28 kB (gzip 1.60).
The report's exact counts for `check`/app/build are accurate; its stellar figure
understates the full command (see suggestion 7).

### 2. Cache correctness — **FAIL (blocking #1; risks 1–2, 4)**
Detailed under blocking issue 1. Answering the specific questions: stale data
**can** leak after an account/owner switch (reachable today); it is not invalidated
by key, only by the follow-up revalidation; a failed revalidation does **not** leave
stale "armed" data (it replaces the snapshot with an error) but it does destroy good
data; and the in-flight dedupe raced with a mutation can briefly serve pre-mutation
state. Logout/lock itself is safe because the pages are gated (`TasksPage.tsx:115-116`,
`RulesPage.tsx:17-18`), but the cache survives the lock and is re-served on unlock.

### 3. Behaviour preserved — **PASS (with one risk)**
- Save rule / Turn off: same `executeApprovedIntent(ruleIntent(...))` path
  (`useRulesEditor.ts:157-176`), one batch approval + one Touch ID unchanged; disable
  still collapses to `always_ask` via `normalizeForm`/`ruleIntent`
  (`rulesModel.ts:45-90`).
- Create schedule: `buildSimpleSchedule` validation, defaults and the `useTxRun`
  pipeline are untouched (`NewScheduleForm.tsx:48-61`, `TasksPage.tsx:136-139`); the
  folded fields keep their state, so the preview and defaults still work.
- Cancel schedule: unchanged (`TasksPage.tsx:129-134`, `useTasksData.ts:246-272`).
- Every prior limit remains reachable: per-payment, per-day and saved-contacts-only
  are all under Advanced (`RulesEditor.tsx:151-180`); the on-chain read-back lines
  are still rendered (`RulesEditor.tsx:209-218`).
- Only caveat: the Rules form can be overwritten by a background refresh
  (suggestion 4), which can silently discard a just-typed value.

### 4. Owner design rules — **PASS (one caveat)**
No popups/new windows/modals; no external link introduced (`ExplorerLink` is a
button calling the existing allow-listed `open_external`, pre-existing in both pages);
no mock data for a configured owner (`editorSnapshotFrom` maps real reads only, and
`tasksSource` keeps demo strictly outside Tauri — `rulesLoad.ts:118-120`,
`useTasksData.ts:92-97,161-183`); the panel stays closable via the existing
`NotchPanel` close control (`NotchPanel.tsx:102-110`); existing tokens/primitives are
reused (`tasks-rules.css` only adds `.nr-*`; `text-notch-muted` matches the existing
pattern in `P2pTrade.tsx:225`). Caveat: the ≤2-visible-inputs rule holds only while
Advanced is collapsed (suggestion 6).

### 5. Parallel reads safety — **PASS**
`Promise.all([loadContacts(), probeExecutor(...), loadSecurityState()])`
(`useRulesEditor.ts:103-107`) is safe: `loadSecurityState` catches internally and
returns `unreachable` (`guardStateLive.ts:122-138`), `loadContacts` catches and
returns `[]` (`useRulesEditor.ts:65-73`), and `probeExecutor`'s real rejection is
caught by the surrounding `try/catch` (`rulesLoad.ts:1144-1152`,
`useRulesEditor.ts:109-111`) — no unhandled rejection, no partial state (the snapshot
is applied atomically in one `.then`, `useRulesEditor.ts:141-151`). State-after-unmount
is guarded by `cancelled` (`useRulesEditor.ts:139,152-154`,
`useTasksData.ts:225,232,239-241`). No timers added; the only listener
(`NewScheduleForm.tsx:42-46`) is removed in cleanup.

### 6. Quality — **RISK**
- Accessibility: good — icon buttons carry `aria-label`s
  (`TasksPage.tsx:157,177`, `RulesEditor.tsx:107`), the status dot is `aria-hidden`
  with a text status beside it (`TasksPage.tsx:67-73`), `focus-visible` and
  `prefers-reduced-motion` are handled (`tasks-rules.css:125-138`), and the error
  message uses `role="status"` (`RulesEditor.tsx:227`). The Advanced toggles use
  `aria-expanded` but no `aria-controls` (minor).
- Dead code / scope: no scope creep — only the two pages, their hooks, the new CSS,
  tests and docs changed. `useRulesData.ts` remains dead code as stated (only its own
  test imports it).
- Tests: the gap in blocking issue 2 is the main quality problem; the added
  pure-function assertions are meaningful but do not prove the caching/state logic
  the commit message claims.
- `React.memo` ineffectiveness (suggestion 3) is a real dead optimisation.

### 7. Visual check — **NOT POSSIBLE**
There is no browser/DOM harness in the repo or its `node_modules` (no
Playwright/Puppeteer/Storybook/Cypress/jsdom/happy-dom), so I could not render the
pages in demo mode and did not start a browser. The Vite build compiles and the CSS
tokens resolve, but no WKWebView/visual verification was performed — this matches the
author's own "not verified" note. A human must still open Tasks/Rules in the desktop
app (configured owner + unlocked wallet) to confirm layout and first-open latency.

## Status summary

The refactor is well structured and delivers the claimed read-parallelisation, single
`executor_status` probe, skeleton/empty/error states and a clean layout; `check`,
app tests, stellar tests and the app build are all genuinely green. The redesign keeps
every action, including all three prior limit controls and the one-Touch-ID approval
path. However, the new module-level caches are global rather than owner-scoped, and
the account-switch path is reachable in the shipped UI, so stale data from a previous
owner can be shown and — on Rules — acted on. That, plus the absence of any test for
the caching logic, makes this **APPROVE WITH CHANGES**: scope both caches to
`ownerAddress + networkPassphrase` (and reset on active-account change/lock), add
direct tests for the cache/dedupe/mutation behaviour, then a human visual check before
merge. Nothing was fixed by me; no files were changed except this report.
