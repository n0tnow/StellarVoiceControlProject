# Report: notch-pages

- **Date:** 2026-09-20
- **Worker/Agent:** senior frontend worker (Claude Opus)
- **Branch/Worktree:** `feat/notch-pages` / `.worktrees/notch-pages`
- **PR:** none (coordinator opens it, per task instruction)

## Completed

The notch's `panel` state (hover-expand, 420 pt tall, already in the Rust
`SHELL_STATES` table) went from a "menus land here" placeholder to a four-page
surface on mock data.

### Pages (`app/src/notch/pages/`)

| Page | File | Contents |
|---|---|---|
| History | `HistoryPage.tsx` | One row per past voice turn: status icon (success/pending/failed), Turkish transcript snippet, agent answer, time. Rows with a chain action expand in place (chevron) to show the action summary + truncated tx hash. |
| Scheduled Tasks | `TasksPage.tsx` | Rows with human schedule text ("Every Monday at 09:00"), description, next-run time, an enable/disable switch and a delete button — all local state. A dashed "new task" input row prepends a mock task (no real scheduling). Terminology mirrors the guard scheduler (`next_run_at`, recurrence). |
| Rules / Policies | `RulesPage.tsx` | Rule cards in the `polaris_guard` vocabulary: condition → action → approval profile (`none` / `Touch ID` / `always ask`, from `backlog/approval-policy.md`). Enable/disable switch per card; a dashed "Add rule" mock affordance. |
| Wallet | `WalletPage.tsx` | XLM + USDC balance cards, truncated public key with copy-to-clipboard, a month-to-date spend-vs-budget progress bar (budget = the monthly rule budget), and a mini recent-transactions list with in/out direction icons. |

### The routing seam (for the voice-wiring follow-up)

- `app/src/notch/notchPage.ts` — pure module: `NotchPage` ("history" |
  "tasks" | "rules" | "wallet"), `NOTCH_PAGES`, `isNotchPage`, and
  `coerceNotchPage` (unknown strings fall back to the default page instead of
  stranding the panel on a mis-heard command). Unit-tested in
  `notchPage.test.ts` (5 tests, node --test, the project's existing pattern).
- `app/src/notch/useNotchPage.ts` — the hook: `{ page, setNotchPage, close }`.
  **The voice seam is one call:** `setNotchPage("history")` from a
  "geçmişi aç" intent. `close` is the shell's `dismiss`, so nav-close, Escape
  and hover-leave all share one collapse path.
- `app/src/notch/NotchPanel.tsx` — nav (lucide icons + labels) + page router.
  Escape closes the panel.
- `ShellSurface.tsx` owns the controller (survives panel mount cycles) and
  renders `<NotchPanel>` into the existing `.notch-panel` body.

### Design decisions

- **No Rust changes.** The existing `panel` state (cutout + 2×300 pt wide,
  420 pt tall, interactive) already fits a nav + scrollable page column; the
  task allowed touching `notch.rs` only if strictly required — it was not.
  Spring/animation behaviour is untouched; the panel crossfade rule
  (`.notch.shell-panel .notch-panel`) is unchanged.
- **Panel body stays always-mounted** (unlike the prompt): page state and the
  active page survive a close/reopen within the session, and the existing
  opacity crossfade keeps working — no deferred-unmount dance needed.
- **Mock data** (`app/src/lib/mockData.ts`) uses plausible Stellar shapes:
  real-format `G…` public key, 64-hex tx hashes, epoch-second timestamps.
  Transcripts are Turkish (the product is Turkish-first); all UI labels are
  English per the project rule.
- CSS reuses the notch tokens (`--color-notch-*`, `--shell-motion`,
  `--shell-ease`) and the existing `.polaris-scroll` utility; page styles are
  scoped class blocks appended to `index.css` per the existing pattern.

## How to run / verify

```bash
cd .worktrees/notch-pages/app
npm run check   # tsc — passes
npm run test    # node --test, 37 tests pass (5 new for the routing seam)
npm run build   # vite build — passes
npm run tauri:dev  # then hover the notch: panel expands; nav switches pages
```

## Unfinished (handed off)

- **Voice wiring**: the intent layer must call `setNotchPage(<page>)` (and,
  while collapsed, propose the `panel` shell state — e.g. via the hotkey
  source or a new proposal). The page side is done; nothing in the pages
  needs to change.
- **Real data wiring**: replace `MOCK_*` arrays with the turn log (history),
  the guard's `list_schedules` (tasks), `get_rule` (rules) and Horizon
  balances/transactions (wallet). Shapes already mirror those APIs.
- **Rule creation flow**: "Add rule" is a mock affordance; the real flow is
  voice-drafted and confirmed on an approval card before `set_rule`.
- Persistence: task/rule toggles are in-memory only.

## Blockers

- None.

## Review Notes

- New files: `app/src/lib/mockData.ts`, `app/src/notch/notchPage.ts`,
  `notchPage.test.ts`, `useNotchPage.ts`, `NotchPanel.tsx`,
  `pages/{HistoryPage,TasksPage,RulesPage,WalletPage}.tsx`.
- Modified: `app/src/notch/ShellSurface.tsx` (import + controller + panel
  body), `app/src/index.css` (placeholder block replaced by panel/page
  styles; nothing else touched).
- Untouched per scope: `app/src-tauri/`, `agent/`, `stellar/`, `contracts/`,
  `interfaces/`.

## Suggested Next Step

Voice-wiring task: map Turkish intents ("geçmişi aç", "görevleri aç",
"kuralları aç", "cüzdanı aç") to `setNotchPage(...)` + a `panel` state
proposal; then the real-data wiring per page.
