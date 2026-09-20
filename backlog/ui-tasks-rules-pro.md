# Report: ui-tasks-rules-pro

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/ui-tasks-rules-pro` / `.worktrees/ui-tasks-rules`
- **PR:** none (not committed / not pushed — per task)

## TL;DR

**Root cause.** The Tasks and Rules pages are unmounted whenever another page is
selected (`NotchPanel.tsx` renders only the active page), so every visit
remounted the page and re-ran the whole read from scratch. The read itself was a
long **serial** chain of Tauri IPC + Soroban RPC round trips, with no cache and
no skeleton:

- `useTasksData` awaited `getStellarConfig()` and then `loadUpcoming()`, which
  called `defaultScheduleDeps()` → `getStellarConfig()` **again**, then a chain
  read — all serial, on every mount (`useTasksData.ts:161-183`,
  `schedulesLive.ts:44`).
- `useRulesEditor` awaited, one after another: `getStellarConfig` →
  `contacts_list` → `executor_status` (feature probe) → `executor_status`
  **again** (funding) → `loadSecurityState`, which itself serialises
  `get_rule` → `get_executor` → `spent_today` → `get_allowance` → N ×
  `get_alias` (`useRulesEditor.ts:73-128`, `guardStateLive.ts:122-135`).
- While the read ran the body was a bare text line, so the page looked blank and
  the data "appeared late"; a refresh flashed `setLoading(true)` and collapsed
  the list again (`TasksPage.tsx:141-144`, `RulesEditor.tsx:66`).

No polling, no live `backdrop-filter`/blur, and no big synchronous work was
found. One additional one-time cost: the Stellar SDK ships as a lazy
`client-*.js` chunk (744 kB / 147 kB gzip) that is fetched on the **first**
chain read (see build evidence); later opens are served from the module cache.

**Fix (behavior-preserving).**
1. Both page hooks now keep a module-level snapshot and dedupe concurrent reads
   (stale-while-revalidate): the previous rows/rule paint on the first frame and
   the chain is revalidated quietly in the background. Reopening a page is
   instant after the first successful read.
2. Rules reads are parallelised (`contacts` ∥ `executor probe` ∥
   `loadSecurityState`) and the executor is probed with **one** `executor_status`
   call instead of two.
3. The body is never blank: a skeleton on first load, an explicit empty state,
   and an error state with Retry; a background refresh no longer collapses the
   list.
4. Task rows are memoized and the IANA time zone is resolved once.

**Files touched.** `app/src/notch/data/useTasksData.ts`,
`app/src/notch/data/useTasksData.test.ts`, `app/src/notch/pages/TasksPage.tsx`,
`app/src/notch/pages/RulesPage.tsx`,
`app/src/notch/pages/tasks-rules.css` (new),
`app/src/notch/rules/RulesEditor.tsx`,
`app/src/notch/rules/useRulesEditor.ts`,
`app/src/notch/rules/rulesLoad.ts` (new),
`app/src/notch/rules/rulesLoad.test.ts` (new),
`app/src/notch/tasks/NewScheduleForm.tsx`.

**Verified.** `npm run check` (all workspaces, tsc), `npm test -w @polaris/app`
(485/485), `npm test -w @polaris/stellar` (112/112), `npm run build -w
@polaris/app` (green). No lint is configured in the repo.

**Not verified.** Real WKWebView rendering (no visual-test harness exists in the
repo), live Tauri IPC / Soroban RPC / Touch ID, and the perceived first-open
latency on a real Mac. These need a human on the desktop app.

**Remaining.** Live human check of both pages; optional follow-up: warm the lazy
Stellar SDK chunk on idle, and de-duplicate the `stellar_config` read (shared
`schedulesLive.ts` was intentionally left untouched — see Scope).

---

## Part 1 — Performance

### 1.1 Root cause (with evidence)

| # | Cause | Evidence (pre-change) |
|---|---|---|
| C1 | **Page unmounts on nav → full reload each visit, no cache.** `NotchPanel` renders only `PAGE_BODY[page]`; selecting another page unmounts the old one and drops all hook state. | `app/src/notch/NotchPanel.tsx:71,113` |
| C2 | **Tasks read was serial and read the config twice.** `loadTasks` awaited `getStellarConfig()`, then `loadUpcoming()` → `defaultScheduleDeps()` → `getStellarConfig()` again, then the chain read. | `app/src/notch/data/useTasksData.ts:161-183`; `app/src/lib/schedulesLive.ts:44` |
| C3 | **Rules read was serial with a duplicated executor probe.** `getStellarConfig` → `contacts_list` → `executor_status` → `executor_status` → `loadSecurityState`, each awaited in turn. | `app/src/notch/rules/useRulesEditor.ts:87-99` |
| C4 | **`loadSecurityState` serialises its own RPC reads** (`get_rule`, `get_executor`, `spent_today`, `get_allowance`, then N × `get_alias`). Shared with the Security panel, so not changed here. | `app/src/lib/guardStateLive.ts:122-135` |
| C5 | **No skeleton; refresh collapsed the list.** `loading` started `true` on every effect and the body was one muted text line. | `app/src/notch/data/useTasksData.ts:171,180-188`; `app/src/notch/pages/TasksPage.tsx:141-144`; `app/src/notch/rules/RulesEditor.tsx:66` |
| C6 | **One-time lazy SDK chunk on first chain read.** Stellar SDK is a lazy `client-*.js` chunk (744.13 kB / 147.61 kB gzip) fetched by the dynamic import in the data hooks. | `npm run build -w @polaris/app` output |

There is **no** polling (`useRulesData.ts:86` "No polling"; `useTasksData` loads
on mount/refresh only), no live blur/backdrop-filter, and no heavy synchronous
work on these paths. `NotchPanel` statically imports all six pages, so the page
modules themselves are already in the main bundle — lazy-loading the page bundle
was not the cause (main chunk ≈ 265 kB; SDK is already split out).

### 1.2 Fix

- **Stale-while-revalidate cache + in-flight dedupe** in both hooks
  (`tasksCache`/`tasksInFlight`, `rulesCache`/`rulesInFlight`). The last
  successful read seeds `useState`, so the first frame shows real content; the
  effect always revalidates in the background.
- **Parallel reads** in Rules (`Promise.all([loadContacts(), probeExecutor(),
  loadSecurityState()])`) and a **single** `executor_status` probe
  (`probeExecutor`, `rulesLoad.ts`).
- **Never blank**: `tasksViewState` picks `rows | skeleton | error | empty`;
  Rules renders a skeleton, an empty rule row ("No spending rule yet"), or the
  error card with Retry.
- **Cheap re-renders**: `MemoTaskRow` (`React.memo`), `useMemo(deviceTimeZone)`,
  and no `setLoading(true)` flash on refresh (a separate `refreshing` flag).

### 1.3 Build evidence

```
# before (baseline)
dist/assets/main-D6UBOmZf.js    260.90 kB │ gzip: 76.58 kB
dist/assets/client-DQMbBIrg.js  744.13 kB │ gzip: 147.61 kB   (lazy, Stellar SDK)

# after
dist/assets/main-C1-Cg5QW.js    264.70 kB │ gzip: 77.54 kB
dist/assets/client-DQMbBIrg.js  744.13 kB │ gzip: 147.61 kB
dist/assets/main-D2Q6eXPS.css     6.28 kB │ gzip:  1.60 kB   (new page styles)
```

The lazy `client` chunk is unchanged and still fetched only on the first chain
read; the new caching means that cost is paid once per session, not per page
visit.

---

## Part 2 — Redesign

Design rules followed: the notch panel is the only surface (no popups/new
windows, no external links, no mock data for a configured owner, panel always
closable); professional and simple; **at most two visible inputs per view**, with
advanced options behind a text button; existing tokens/components/spacing/
typography reused (`.page-stack`, `.page-list`, `.task-row`, `.rule-card`,
`.rule-add`, `.page-icon-button`, `.page-toggle`, `.task-new*`, `.rule-*`,
`--color-notch-*`). New shared chrome lives in
`app/src/notch/pages/tasks-rules.css` (`.nr-*`), scoped by `.nr-page`.

### 2.1 Tasks page

**Before.** A muted "Upcoming payments" line, an inline "New schedule" dashed
button, then rows with a trash icon; the form showed four inputs at once
(To / Amount / Every / First run); loading was the text "Loading upcoming
payments…"; no status indicator.

**After.**
- **Header**: "Scheduled payments" + a live subtitle ("N scheduled payment(s)" /
  "No scheduled payments yet" / "Demo preview") and a Refresh icon button.
- **List rows**: a status dot (green active / amber delayed / grey finished)
  before the title, the amount → recipient, `recurrence · runs left · status`,
  and a "Next …" line. The only action is **Cancel** (as before), in a stable
  action slot so rows align.
- **New schedule**: only **To** and **Amount** are visible; **Every** and
  **First run** moved behind an "Advanced" text button. Validation, defaults and
  the approval pipeline are unchanged.
- **States**: 3 shimmer skeleton rows on first load, a centred empty line, an
  error notice with Retry, and a demo notice. Rows are memoized.
- Focus-visible outline and reduced-motion handling are provided by the shared
  stylesheet.

### 2.2 Rules page

**Before.** A plain "Reading spending rules…" line, a long summary paragraph, a
card with the threshold field + per-payment/per-day/contacts controls all mixed
together, and an Advanced button that revealed the read-back.

**After.**
- **Header**: "Spending rules" + a state subtitle ("Reading the chain…" /
  "Automatic spending is on" / "Every payment asks first" / "No rule yet" /
  error/unconfigured) and a Refresh icon button.
- **Rule row (list)**: the single on-chain rule shown as a list row with a
  status dot, a short title ("Automatic payments" / "Always ask") and the
  existing human-readable `ruleSummary` sentence. The chain model is one rule per
  asset, so the list holds one honest row rather than fabricated entries.
- **Primary control**: one visible input — "Ask me only above" + **Save** (same
  `guard_policy` batch flow, same one Touch ID).
- **Advanced** (text button): per-payment / per-day limits, the
  "Saved contacts only" toggle, the asset note and the full on-chain read-back.
- **Disable**: the existing "Turn off automatic payments" action is kept. There
  is **no** "Remove" because the guard/executor has no delete intent; adding one
  would change rule/guard logic, which is out of scope. Disabling already
  returns the rule to "Always ask".
- **States**: 2 shimmer skeleton rows while reading, an error card with Retry,
  an unconfigured card, and an empty ("No rule yet") summary. No mock rule is
  shown for a configured owner.

### 2.3 Scope / non-goals

- Rule evaluation, approval policy, guard/executor, Rust, the notch shell and
  the other pages were **not** touched.
- `app/src/lib/guardStateLive.ts` and `app/src/lib/schedulesLive.ts` are shared
  with the Security panel / voice tools, so their serial internal reads (C4) and
  the duplicate `stellar_config` read (C2) were left as-is to avoid overlapping
  `.worktrees/rules-check`. The page-level hooks compensate with caching and
  parallelism.
- `app/src/notch/data/useRulesData.ts` is dead code (only its own test imports
  it); it was left untouched to keep the change minimal.

---

## Verification

No lint is configured (no eslint/prettier/biome config, no `lint` script). The
relevant commands and their real results:

```
$ caffeinate -i npm run check
> npm run check --workspaces --if-present
@polaris/interfaces  tsc -p tsconfig.json   ✓
@polaris/agent       tsc -p tsconfig.json   ✓
@polaris/stellar     tsc -p tsconfig.json   ✓
@polaris/app         tsc -p tsconfig.json   ✓

$ caffeinate -i npm test -w @polaris/app
ℹ tests 485
ℹ pass 485
ℹ fail 0

$ caffeinate -i npm test -w @polaris/stellar
Test Files  12 passed (12)
Tests       112 passed (112)

$ caffeinate -i npm run build -w @polaris/app
✓ built in 219ms
```

New tests (10):
`useTasksData.test.ts` — `tasksViewState` (rows win over loading/error;
skeleton vs error vs empty).
`rulesLoad.test.ts` — `probeExecutor` (one call reports support+funding;
missing command → unsupported; other error rethrown) and `editorSnapshotFrom`
(all five states, no mock for a real owner, form seeded from chain state).

### Not verified

- **Visual result in WKWebView / the real notch**: the repo has no visual-test
  harness (no Playwright/Storybook/Cypress; only `scripts/check.sh` and the
  `e2e:*` Node scripts, none of which render the panel). Visual verification was
  therefore **not possible** here.
- **Live Tauri IPC, Soroban RPC, Touch ID, Keychain**: not exercised; the
  data-loading logic is unit-tested with pure mappers/fakes.
- **Perceived first-open latency on a real Mac**: reasoned from the code + build
  output, not measured on-device.

## Review Notes

- The redesign keeps every existing action and data flow; no intent, guard or
  executor logic changed.
- Caching introduces one behavior to be aware of: a re-open can briefly show the
  previous snapshot before the background refresh lands (by design; the refresh
  icon spins while `refreshing`).
- The "Remove rule" wording in the brief was interpreted as the existing disable
  path, because no delete intent exists and adding one is out of scope.

## Suggested Next Step

- A human runs the desktop app and opens Tasks/Rules (configured owner + unlocked
  wallet) to confirm the look and the first-open latency, then a reviewer checks
  this branch and a PR is opened.
