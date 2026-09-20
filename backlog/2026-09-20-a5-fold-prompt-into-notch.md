# Report: A5-fold — fold the typed prompt into the notch shell (single surface)

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a5-notch-shell` / `.worktrees/a5-notch-shell`
- **PR:** none (per the task: commit + push only; the coordinator opens the PR)
- **Spec:** `TASK-A5-FOLD.md` (deleted before the final commit, as required)

## 1. What changed

The A6 typed prompt is no longer a second window. It is a **named state of the
one notch shell**, so the whole UI runs through the notch (owner rule).

- **New state row** in `notch::SHELL_STATES`: `prompt`
  (width = compact width, min height = cutout + 44 pt, max = cutout + 200 pt,
  `ShellShape::Shell`, `interactive: true`, `focusable: true`). It is the first
  row that is both interactive *and* focusable.
- **`focusable` per state** with its own single writer (`sync_native_focusability`)
  mirroring `sync_native_interactivity`, plus focus return to the previously
  frontmost app and watchdog forcing.
- **Content-driven height**: the state declares `min`/`max` (`ShellHeightRange`),
  the webview reports its measured body, and the new `shell_resize_content`
  command clamps and resizes (grow-before-animate; commit shrinks back).
- **Trigger rewire**: `ctrl_tap.rs` is unchanged; its driver now lives in
  `notch/tap.rs` and emits `notch_hotkey { prompt }` instead of toggling a window.
- **Reducer precedence** changed: a latched `hotkey` (the prompt) now outranks
  attention voice and hover (see §4).
- **Deleted**: `app/prompt.html`, `app/src/prompt/main.tsx`, `prompt.css`,
  `app/src-tauri/src/prompt_window.rs`, `app/src-tauri/src/prompt_commands.rs`,
  the second window in `tauri.conf.json`, the second Vite entry, and the
  `"prompt"` capability grant. `PromptPanel.tsx` moved to `app/src/notch/` and was
  re-skinned in the notch's own CSS language (no sheet chrome, backdrop, shadow or
  own card radius; everything scoped under `.notch-prompt` so it cannot bleed into
  the resting pill).

## 2. Focus design (and why it is safe)

Tauri 2.11.5 exposes `WebviewWindow::set_focusable`, so the overlay itself can
host the prompt — no second window.

- **Exactly one writer.** `sync_native_focusability` (in `notch.rs`) is the only
  place that writes the native focusable flag, and it derives it from
  `runtime.focusable`, which `set_active` / `mark_forced_collapse` own. The
  counterpart invariant `native_focusable == Some(focusable)` is pinned by a test.
  Focus is taken only on the transition *into* a focusable state, in the same
  serialized main-thread section as the state change (`shell_request_state` /
  `shell_commit_state`).
- **Watchdog forces both flags off.** `force_click_through` now runs
  `mark_forced_collapse` → `sync_native_interactivity` → `sync_native_focusability`
  → frame collapse, all in one main-thread task, and emits the `notch_hotkey`
  clear proposal when a prompt was torn down. The cursor poll is unchanged
  (active `NSEvent::mouseLocation` sampling).
- **Collapse / hide / error / teardown all restore the non-focusable default**
  through the same two writers; `RunEvent::Exit` and window
  `CloseRequested`/`Destroyed` run `notch::teardown`.
- **Focus return is implemented** (A6 never did it). `notch/focus.rs` remembers
  the frontmost app's pid before the prompt takes focus and reactivates it with
  `NSRunningApplication::activateWithOptions` (no deprecated
  `ActivateIgnoringOtherApps`) when the window goes non-focusable. Verified by
  inspection; the human step is below.

### Watchdog refinement (called out explicitly)

The prompt is opened by a **keyboard** gesture, so the cursor is usually nowhere
near the notch. An unmodified cursor-away watchdog would collapse the prompt
~1.5 s after it opened. The watchdog now also requires the window to be **not
focused** before it forces a collapse (`outside_for_longer_than`). This is
documented as a refinement rather than a weakening, with this argument:

- A focused window is not "stranded": the user is in it, and `ignore_cursor_events
  = false` only intercepts clicks **inside the window's own small rect** — clicks
  anywhere else already reach the app underneath.
- The moment the window loses focus (user clicks another app), the Tauri
  `Focused(false)` event re-arms the watchdog, so a frozen webview that never
  processes the blur is still recovered.
- Net: no interactive/focusable state can be left permanently eating clicks or
  holding focus. Pinned by
  `watchdog_does_not_collapse_a_focused_prompt` (focused → no force; blur → force).

If the coordinator judges this too lenient, the alternative is to keep the
unconditional force and accept that the prompt self-collapses while typing; the
code change is one condition in `outside_for_longer_than`.

## 3. Content-height design

- `ShellStateSpec` gains `content_height: Option<ShellHeightRange>`; the
  `prompt` row sets `min = CutoutOffset(44)`, `max = CutoutOffset(244)`, and its
  nominal `height` is the min. `ShellStateGeometry` serializes
  `focusable`/`minHeight`/`maxHeight` for the seam.
- `RuntimeState` stores a clamped `content_height` override. `target_frame`
  applies it to the active state only, so the **commit** path shrinks to the
  measured frame.
- `shell_resize_content(height)` clamps to the active state's `[min, max]`, stores
  the value, and grows the window with `grow_union` (grow-before-animate). The
  guaranteed commit runs again because the hook bumps its `settle` counter after
  the resize — a content resize therefore cannot strand the window oversized.
- The body reports its **natural** height; the area below the strip scrolls
  (`overflow-y: auto` on `.notch-prompt`) once the shell reaches its max, so a long
  answer never grows past "obviously a grown notch". `ShellSurface` adds the
  cutout height to the measured body before reporting the whole-shell height.
- Fixed states ignore a content report (`set_content_height` returns the table
  height) and are unaffected.

Settled proportions on the measured 14" reference (179×32 cutout): **399 wide,
76 pt min, 276 pt max**, i.e. the compact width plus one 44 pt text row, growing
up to 200 pt of body after which it scrolls.

## 4. Precedence decisions

Written down in `shellState.ts` and tested:

1. **`hotkey` (the latched prompt) — highest.** A prompt is an explicitly invoked
   mode with explicit dismissal paths. Losing hover must **not** collapse it, and
   a push-to-talk recording must **not** replace it. Justification for "recording
   wins the status strip, the prompt body stays": the top strip is state-
   independent (the `visual` class still shows the listening animation and the
   label), so the user still sees "Listening"; tearing away a half-typed prompt to
   show a larger strip would lose input for no visibility gain.
2. **attention voice** (recording/transcribing/permission/error) — something the
   user must see.
3. **hover** — pointer rests on the shell (opens `panel`).
4. **ambient voice** — the ready/error dwell label.
5. otherwise `collapsed`.

Because a quiet hotkey source proposes `"collapsed"`, this only changes behaviour
while a mode is latched. The round-1 test "hotkey proposals are consulted last"
was replaced by "a latched prompt mode outranks hover and attention voice" plus
"a quiet hotkey source leaves the existing precedence intact".

Dismissal paths all become **state transitions to `collapsed`**, never window
hides: Escape (in `PromptPanel`), outside-click/blur (window `blur` listener in
`useShellState`), the ✕ button, a second double-Control tap (Rust emits
`prompt:false`), and the Rust watchdog's forced collapse (same emit).

## 5. The one-row claim — what was more than a row

Honest accounting (the task asked to say so rather than hide it): the `prompt`
mode needed, beyond one `SHELL_STATES` row and one CSS block,

- a `focusable` field + its single writer and focus-return helper,
- a `content_height` range + the `shell_resize_content` command and the
  measure/clamp/settle round-trip in the hook,
- the reducer's top-priority hotkey source and the `notch_hotkey` seam, and
- the tap driver moved out of the deleted `prompt_window.rs`.

All of it is generic (any future content-driven or focusable state reuses it),
but it is more than one row, and the "one table row" claim should be read with
this caveat.

## 6. §2.6 — the dev-mode TCC crash (BLOCKED, do not claim fixed)

The spec's diagnosis does not hold on this machine (macOS 27.0, build 26A428),
and the prescribed fix cannot work. Evidence:

1. **The dev binary already carries the plist.** Tauri's `generate_context!`
   (`tauri-codegen` 2.6.3) embeds the same `src-tauri/Info.plist` when
   `dev && !running_tests`. `otool -s __TEXT __info_plist
   app/src-tauri/target/debug/polaris-app` shows the `__TEXT,__info_plist`
   section, and the running code can read
   `NSBundle.mainBundle.infoDictionary["NSSpeechRecognitionUsageDescription"]`.
2. **Adding `embed_info_plist!` in `main.rs` only duplicates the symbol** (linker
   `duplicate symbol '__EMBED_INFO_PLIST'`), and the raw plist wins over Tauri's
   augmented one (drops `CFBundleName`/version). It is therefore **not shipped**.
3. **The real cause is TCC's responsible-process model.** `tauri dev` launches
   the binary from the terminal; TCC consults the **terminal app**, which declares
   no speech usage key, and aborts before any prompt. An isolated probe
   reproducing the exact `SFSpeechRecognizer.requestAuthorization` call:
   - bare binary, unsigned → SIGABRT (new `.ips`, namespace TCC);
   - bare binary, ad-hoc signed → SIGABRT;
   - unsigned `.app` bundle opened directly → SIGABRT;
   - **code-signed `.app` launched by LaunchServices (`open`) → no SIGABRT.**

   (`Terminal.app`'s `Info.plist` declares neither `NSSpeechRecognitionUsageDescription`
   nor `NSMicrophoneUsageDescription`; `Zed`/`Ghostty` do.)

**Consequence:** `tauri dev` cannot satisfy TCC for speech on this OS without
either (a) launching the app as a signed bundle via LaunchServices
(`tauri build --debug` then `open …/Polaris.app`, or a custom `--runner`), or
(b) granting the terminal app the usage key. Both are outside this task's file
scope and workflow. The typed-prompt feature does not touch speech, so it builds,
launches and is testable without it; the **voice** path in dev remains blocked.

Per the task's "if you get stuck, stop and file the report describing exactly
where", this is the exact location. No code was written for this section because
the only in-repo change available was a redundant, warning-producing duplicate.

## 7. Test evidence

`caffeinate -i bash scripts/check.sh` (exit 0):

```
== JS: typecheck all workspaces
== JS: workspace tests (keeper node:test + anchor vitest)
# tests 67
# pass 67
# fail 0
== JS: app tests (notch shell reducer, node:test)
# tests 8
# pass 8
# fail 0
== JS: production build of the shell (vite)
✓ 51 modules transformed.
✓ built in 194ms
== JS: agent skeleton smoke test
== Rust: cargo clippy (Tauri shell; warnings are errors)
== Rust: cargo test (Tauri shell; the notch state-table tests live here)
test result: ok. 129 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.01s
== all checks passed
```

Rust went from the 124 baseline to **129** (+5). New/changed tests:

- Rust: `prompt_state_is_interactive_focusable_and_content_driven`,
  `content_height_clamps_between_min_and_max`,
  `a_content_resize_grows_the_target_frame_and_commits_to_it`,
  `forced_collapse_clears_a_prompt_and_reports_that_it_did`,
  `watchdog_does_not_collapse_a_focused_prompt`,
  `native_focusable_log_matches_the_guarded_state`; the table/round-trip, sizing,
  forced-collapse and serialization tests were updated for the new row and the
  `ForcedCollapse` return.
- TS: reducer "a latched prompt mode outranks hover and attention voice" and
  "a quiet hotkey source leaves the existing precedence intact" replace the old
  "hotkey last" test.

**Startup smoke test:** `tauri dev` launched clean; the log shows all four states
resolved (`prompt` 399×76, min 76, max 276), `notch overlay ready`, and the
inventory monitors live — no panic, no React error (an early hooks-order bug in
`ShellSurface` was caught here and fixed in `8eff3e2`).

## 8. Manual verification steps (human, real keyboard)

1. `npm run dev` (repo root) or `npm run tauri:dev -w @polaris/app`. The resting
   pill sits flush with the cutout.
2. **Tap Control twice** (each tap < 350 ms, gap < 400 ms). Expected: the notch
   grows *slightly* sideways (to the compact width) and *slightly* downward to
   one text row, the caret is in the field, and the strip reads "Ask Polaris".
   No floating sheet, no drop shadow.
3. **Type** "Send 5 USDC to ada" and press Enter. Expected: "Thinking…", then the
   answer appears under the input; the notch **grows taller** as it arrives, up
   to about cutout + 200 pt, after which the answer area **scrolls**.
4. **Escape**. Expected: the prompt collapses back to the resting pill **and the
   app you were in before gets keyboard focus back** (type immediately into it to
   confirm).
5. Reopen (double-Control), then **click another app**. Expected: the prompt
   collapses (outside-click/blur) and the click lands in the other app.
6. Reopen, then **hold Control+Option** (push-to-talk). Expected: the strip shows
   the "Listening" animation but the **prompt body stays** (recording wins the
   strip, not the state). Release; transcription continues as usual.
7. **Hover the notch** while no prompt is open. Expected: the 420 pt `panel`
   placeholder opens as before; move away and it collapses.
8. **Click a desktop icon through the overlay area while collapsed.** Expected:
   the click passes through (no eaten clicks).
9. **Reduce motion on.** Expected: states jump with no tween (the fallback commit
   still fires), including the content grow.
10. **TCC (voice path, known blocker):** hold Control+Option and speak. On this
    macOS 27 machine the bare `tauri dev` binary is expected to SIGABRT on the
    first speech authorization (see §6). To exercise it, run a signed bundle
    instead (`tauri build --debug` + `open`), or grant the terminal the usage key.

## 9. Left over / handed off

- **§2.6 TCC:** blocked as described; the coordinator decides between a signed-
  bundle dev runner (out of scope here) and documenting the workaround.
- **Manual GUI/human verification** of §8 steps 2–9 (the agent has no keyboard or
  cursor control).
- The `panel` body is still the placeholder; real menus land later, and the
  `prompt` state is its own much smaller row, not the panel.

## 10. Files changed

Rust: `app/src-tauri/Cargo.toml` (objc2-app-kit features), `src/notch.rs`,
`src/notch/focus.rs` (new), `src/notch/tap.rs` (new), `src/notch/window.rs`,
`src/events.rs`, `src/lib.rs`; deleted `src/prompt_window.rs`,
`src/prompt_commands.rs`.

Frontend: `interfaces/src/index.ts`, `app/src/notch/PromptPanel.tsx` (moved from
`app/src/prompt/`), `ShellSurface.tsx`, `shellBridge.ts`, `shellState.ts`,
`shellState.test.ts`, `useShellState.ts`, `app/src/index.css`, `app/vite.config.ts`,
`app/src-tauri/tauri.conf.json`, `app/src-tauri/capabilities/default.json`; deleted
`app/prompt.html`, `app/src/prompt/main.tsx`, `app/src/prompt/prompt.css`.

Docs: this report, `backlog.md`, `notes.md`.

## Commit trail

`4356264` feat(notch): content-driven prompt state + focus safety ·
`11c923f` feat(prompt): fold the prompt, delete the second window ·
`8eff3e2` fix(shell): hooks order for the content-height callback ·
plus the docs commit.
