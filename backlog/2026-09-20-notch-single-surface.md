# Plan: fold the A6 typed-prompt window into the notch panel (single surface)

- **Date:** 2026-09-20
- **Owner decision date:** 2026-09-20
- **Worker/Agent:** — (unassigned; planning only)
- **Branch/Worktree:** future work on `main`, only after both `feat/a5-notch-shell` and `feat/a6-text-prompt` have merged
- **PR:** none
- **Status:** ⚠️ **PLANNED TASK — NO CODE WRITTEN YET.** This report is a plan for a future worker. Nothing described below has been implemented.

## 1. Why — the one-surface rule

The project owner's rule, decided 2026-09-20: **the whole UI runs through the notch itself.**
There is exactly one interactive surface — the notch shell. No second window, no
satellite popover, no auxiliary panel floating "near" the notch.

PR #15 (branch `feat/a6-text-prompt`) introduces a **separate** typed-prompt window
anchored near the notch. That was a reasonable way to ship text input fast, but it
violates the one-surface rule as a permanent state. So once both branches are on
`main`, the typed-prompt surface must be **folded into the notch shell's `panel`
state** instead of living in its own window.

Consequences of the rule for this task:

- The notch `panel` becomes the only host for the prompt input (plus its mute /
  attach / send / close controls and any future menus).
- The separate prompt window goes away (or, explicitly decided otherwise — see
  open question 4 — is kept temporarily as a fallback behind a flag, never as the
  default).
- No new top-level window may be added for future surfaces either; new surfaces
  are new rows in the shell-state table and/or new body content in the panel.

## 2. What exists on each side today

### 2a. A5 side — the notch shell (`feat/a5-notch-shell`)

Source of truth: `backlog/2026-09-19-a5-notch-shell.md`.

- **Data-driven named-state table** in `app/src-tauri/src/notch.rs`:
  `ShellDim` (`Cutout` | `CutoutPlus { per_side, max_screen_ratio }` | `Fixed(pt)`)
  resolved purely per state, plus `ShellStateSpec { name, width, height, shape,
  interactive }` rows in the `SHELL_STATES` table. Current rows:
  | name | width | height | shape | interactive |
  |---|---|---|---|---|
  | `collapsed` | cutout | cutout | Pill | no |
  | `compact` | cutout + 2×110 | cutout | Shell | no |
  | `panel` | clamp(cutout + 2×300, ≤ screen×0.55) | 420 | Shell | **yes** |
- **Window lifecycle API** (Tauri commands, grow-before-animate):
  - `shell_request_state(name)` — grows the OS window to
    `grow_union(current, target)`, applies interactivity, returns the state geometry.
  - `shell_commit_state(name)` — called on CSS `transitionend` (plus a timer
    fallback); shrinks to exactly that state's frame. Commits for superseded
    states are ignored.
- **React reducer** in `app/src/notch/useShellState.ts`: one reducer over
  `{ voice, hover, hotkey }` sources with documented precedence
  **voice > hover > hotkey** (first non-`collapsed` proposal wins). Hover dwell
  250 ms enter / 400 ms leave grace; `SHELL_MOTION_MS = 470` mirrors
  `--shell-motion`.
- **Panel placeholder:** `app/src/notch/ShellSurface.tsx` renders a
  `.notch-panel` body ("menus land here"); `app/src/notch/shellBridge.ts` carries
  the `notch_geometry` / `shell_request_state` / `shell_commit_state` /
  `notch_hover` IPC.
- **Focus posture by design:** the notch overlay window is `focusable: false` /
  `focus: false` so push-to-talk never steals focus from the app underneath.
  Native hover detection (`app/src-tauri/src/notch/hover.rs`, global + local
  `mouseMoved` monitors) plus a 1.5 s click-through watchdog keep the overlay
  click-transparent whenever it is not deliberately interactive.

### 2b. A6 side — the separate typed-prompt window (`feat/a6-text-prompt`, PR #15)

As described in the PR (this plan does not re-audit the A6 branch; the future
worker must confirm the exact shapes on `main` after both merges):

- `app/prompt.html` — entry page for the second window.
- `app/src/prompt/PromptPanel.tsx` — the typed-prompt UI (text field plus its
  mute / attach / send / close controls per the Owner A UX vision, note
  2026-09-19 §6).
- `app/src-tauri/src/prompt_window.rs` — Rust side: creation/positioning of the
  prompt window anchored near the notch, show/hide wiring.
- A **second Tauri window** declared in `app/src-tauri/tauri.conf.json`
  (alongside the notch overlay window), with its own show/hide and
  near-notch anchoring logic.
- **Double-Control-tap trigger** — double-pressing Control opens the typed
  prompt (the "text input mode" from the Owner A UX vision).

## 3. Open questions the future worker must resolve

1. **Keyboard focus.** The notch overlay is `focusable: false` / `focus: false`
   by design so push-to-talk never steals focus — but a text field needs
   keyboard focus to receive typing. Options include (a) making the window
   focusable only while a prompt-bearing panel state is active and restoring
   non-focusable on commit back to a non-interactive state; (b) a dedicated
   prompt state row whose lifecycle owns the focusable flag; (c) keeping the
   overlay never-focusable and routing keystrokes some other way (not
   recommended — must be justified if chosen). Whichever is chosen, the
   push-to-talk path must provably never steal focus: the fix must cover
   request/commit ordering, the watchdog forced-collapse path, and window
   teardown. New tests must pin the focusable flag per state.
2. **Panel geometry — reuse `panel` or add a taller row?** The current `panel`
   row is 420 pt tall and hosts a placeholder. The prompt UI (input + buttons +
   any suggestion/completion area) may or may not fit that budget. The worker
   must measure the A6 prompt content against the panel and decide: reuse the
   existing `panel` row (preferred if it fits — no table change) or add a new
   row (e.g. a prompt-height state) per the one-row-adding-a-state pattern from
   the A5 report §"Adding a future state". Either way the table invariants hold:
   ordered smallest→largest, only interactive rows interactive, `collapsed` the
   forced-collapse target, widest/tallest fits the initial window
   (`tauri.conf.json` window size grows only if the new tallest state requires
   it, with the compile-time assert updated accordingly).
3. **What happens to the double-Control-tap trigger?** The trigger itself stays
   (it is the specified gesture for text input mode), but its *target* changes:
   instead of showing the separate prompt window it must propose the
   prompt-bearing notch state through the existing reducer (almost certainly as
   a new `hotkey`-source proposal — the reducer's `hotkey` source is currently
   a stub proposing `collapsed`). The worker must define the exact reducer
   wiring (proposal name, precedence interaction with an in-flight voice
   recording, dismiss path: Escape / send / focus loss / cursor-away) and keep
   the Control+Option hold path untouched.
4. **Delete the second window or keep it as a fallback?** Default answer: delete
   — `app/prompt.html`, `app/src/prompt/`, `app/src-tauri/src/prompt_window.rs`
   and the second window entry in `tauri.conf.json` are removed, with the prompt
   component moved under `app/src/notch/` (or wherever the shell body lives at
   that time). If the worker finds a genuine reason to keep the old window
   (e.g. staged rollout), it must be opt-in behind an explicit flag/env var,
   default off, with a dated removal note — never a silent second default
   surface. The plan's acceptance criteria assume deletion.

## 4. Proposed step-by-step plan

Assumes both `feat/a5-notch-shell` and `feat/a6-text-prompt` are merged to
`main`. The worker starts from fresh `main`.

1. **Rebase and survey.** Pull `main`, confirm both A5 (state table, reducer,
   placeholder panel) and A6 (prompt window files listed in §2b) are present.
   Record the actual A6 file list and trigger wiring; correct §2b above if it
   drifted.
2. **Decide geometry (open question 2).** Measure the prompt UI against the
   420 pt panel. Either reuse `panel` or add one table row (one-row pattern;
   radii derive automatically). Update `tauri.conf.json` initial window size
   only if the tallest state grew.
3. **Move the prompt component into the shell.** Relocate the prompt UI from
   `app/src/prompt/PromptPanel.tsx` into the notch body tree (rendered inside
   the panel/prompt state branch of `ShellSurface.tsx`), keeping its behaviour
   identical. No visual redesign in this task — aiming for parity, not polish.
4. **Rewire the trigger (open question 3).** Point the double-Control-tap
   handler at the reducer's `hotkey` source so it proposes the prompt-bearing
   state; implement the dismiss paths (send / Escape / close button /
   cursor-away via the existing hover + watchdog machinery).
5. **Solve focus (open question 1).** Implement per-state focusable management
   tied to the request/commit lifecycle, covering forced-collapse and teardown.
   Pin with Rust tests (flag per state transition incl. watchdog path) and,
   if the reducer owns visibility, reducer tests for the prompt proposal.
6. **Delete the second window (open question 4).** Remove `app/prompt.html`,
   the old prompt entry, `prompt_window.rs` (including command registration in
   `lib.rs`), and the second window from `tauri.conf.json`. Prove no dangling
   references (typecheck, clippy, grep for the old window label).
7. **Update the seam docs.** `docs/interfaces.md` if the geometry/flags surface
   changed; the A5 report's "Left over" item (real menus) now includes the
   prompt as the panel's first real body content.
8. **Verify per §5, write the backlog report, open the PR** (review per
   constitution; no direct push to `main`).

## 5. Acceptance criteria (explicit)

- [ ] There is exactly **one** Tauri window: the notch overlay. No second
  window entry in `tauri.conf.json`; `app/prompt.html`,
  `app/src-tauri/src/prompt_window.rs` (or their post-merge equivalents) are
  gone; no code references the old prompt window label.
- [ ] Double-Control-tap opens the prompt **inside the notch shell** (panel or
  a new named prompt state), with the text field focused and typing working.
- [ ] Push-to-talk (Control+Option hold / ⌃⌥Space) provably never steals focus:
  in `collapsed`/`compact` the window is non-focusable; focus is held only
  while the prompt-bearing interactive state is active and is released on
  commit back, watchdog forced-collapse, and teardown.
- [ ] Dismiss paths all collapse the shell and restore click-through: send,
  Escape, close button, cursor-away (watchdog ≤ ~1.5 s).
- [ ] `bash scripts/check.sh` (clippy + cargo test + typecheck + app tests +
  build) is green, including new tests for: the focusable flag per state
  transition, the reducer's prompt proposal/precedence, and (if a row was
  added) the state-table invariants covering the new row.
- [ ] Manual GUI check on a real display: tap Control twice → prompt opens in
  the notch, typing works, Escape closes; hold Control+Option → compact voice
  expansion unchanged; clicks pass through the overlay area when collapsed.
- [ ] Backlog report filed under `backlog/` and indexed in `backlog.md`; the
  A5 "real menus" handoff notes the panel now hosts the prompt.

## Suggested next step

Schedule this task after PR #15 and the A5 shell PR are both merged to `main`.
Assign to one worker (shell + prompt touch the same window lifecycle — do not
parallelise across the seam), in a fresh worktree off `main`, as a single PR
with a reviewer per the constitution. No work before the two merges: the exact
A6 shapes must be read off `main`, not off the pre-merge branches.
