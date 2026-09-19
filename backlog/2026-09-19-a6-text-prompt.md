# Report: A6 — text-prompt popup (double-Control tap)

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a6-text-prompt` (based on `feat/a4-speak-intent`), `.worktrees/a6-text-prompt`
- **PR:** none (per the task: the coordinator opens it after review)

## Objective

Add a **typed** entry path next to push-to-talk: a double-tap of **Control** opens a
focusable panel that hangs under the notch and expands downward. Submitting the text runs the
same agent/intent pipeline the voice path uses; a speaker switch decides whether the reply is
also spoken through the existing TTS path.

## Completed

### 1. Pure double-Control state machine — `app/src-tauri/src/ctrl_tap.rs`

No AppKit, no channel, no window: `CtrlTap::on_modifiers(sample, now) -> bool` returns `true`
exactly once, on the release that completes a double tap. Same discipline as `gesture.rs`, so
every rule is unit-testable without a keyboard.

Timing constants (one place each, documented in the module):

| Constant | Value | Why |
|---|---|---|
| `MAX_TAP_HOLD` | 350 ms | Just above a deliberate tap and above `gesture::ARM_DELAY` (300 ms), so one press can never be both a push-to-talk hold and a tap. |
| `TAP_GAP` | 400 ms | Usual double-click window (macOS ships ~500 ms); 400 ms is snappier but still forgiving for a modifier tap. |

Rules implemented:

1. A tap is Control down→up held at most `MAX_TAP_HOLD`.
2. The second tap must **start** within `TAP_GAP` of the first tap's release; a later press
   starts a fresh sequence instead.
3. Any foreign modifier (Option/Command/Shift) held at any point — including *between* the two
   taps — invalidates the sequence and must be fully released before a new one starts. This is
   what keeps Control+Option (VoiceOver's modifier, and Polaris's own push-to-talk) from ever
   counting as a tap.
4. A detected double tap resets the machine; a new one needs two fresh taps.

**Fn (Globe)** is intentionally **not** handled: `ModifierSample` does not carry it and adding a
field would mean editing `gesture.rs`, which is outside this step's file scope. See Known gaps.

### 2. Feeding the detector — `app/src-tauri/src/hotkey_flags.rs` (additive)

The AppKit monitor pair is process-global and the token returned by `add*Monitor…` *is* the
subscription, so a second monitor would be wasteful and fragile. Instead the module now exposes
`add_sample_observer(closure)`: the one existing `flagsChanged` monitor fans every masked sample
out to the push-to-talk driver (unchanged) **and** to any registered extra observers. The A6
detector registers one and forwards into its own thread, so the AppKit callback stays a cheap
channel send. The Control+Option gesture semantics in `gesture.rs` are untouched.

### 3. Prompt window — `app/src-tauri/src/prompt_window.rs`

- Second Tauri window, label `prompt`: `transparent`, `decorations: false`, `shadow: false`,
  `alwaysOnTop`, `skipTaskbar`, `visibleOnAllWorkspaces`, **`focusable: true`** (unlike `main`,
  which must accept keyboard input for the text field), `visible: false` at startup.
- Positioned on the notched screen (fallback: primary), centred, `y = top - height` in AppKit
  coordinates so the top edge is flush with the screen top; window level 25 (`NSStatusWindowLevel`)
  and the same collection behaviour as the overlay, so it renders above the menu bar.
- Height is content-driven: the panel measures itself and calls `prompt_resize`; Rust clamps to
  `[56, 720]` pt and keeps the top edge pinned. The CSS animates the sheet from 0 to that height,
  so the visible result is an expansion out of the notch.
- Toggling: a double tap **opens** (show + set_focus + emit `open`) or, when already visible,
  emits `close`. Closing is panel-driven so the collapse-upward animation is not cut off; the
  panel calls `prompt_hide` when its transition ends.
- Own event channel `polaris-prompt` (`{ "action": "open" | "close" }`) — `PolarisEvent` in
  `events.rs` was deliberately not extended.

### 4. Commands — `app/src-tauri/src/prompt_commands.rs`

`prompt_resize(height)` and `prompt_hide()`. That is the whole panel↔native seam.

### 5. Frontend — `app/prompt.html`, `app/src/prompt/*`

Its own Vite entry and React root (`main.tsx`), no shared state with `App.tsx`. `PromptPanel`
reuses `@/lib/agent` (`runAgentTurn`) and `@/lib/speech` (`speakTurnResult`) — the pipeline is not
duplicated. A `ResizeObserver` on the natural-height inner element reports the measured height to
Rust exactly once per change. The speaker switch persists in `localStorage`
(`polaris.prompt.speaker`, only `"off"` is the opt-out value; read failures fall back to **on**).
Enter submits, Shift+Enter inserts a newline, `Esc`/`✕` close with the reverse animation. The
answer is rendered first, then — only if the switch is on — spoken; a slow TTS backend never
delays the visible result, and OFF synthesizes nothing at all.

### 6. Wiring

`lib.rs` gets three `mod` lines, two registered commands, and one `prompt_window::setup(app)?`
call. `tauri.conf.json` gets the second window entry; `capabilities/default.json` adds `"prompt"`;
`vite.config.ts` gets the two-entry `rollupOptions.input`.

## Acceptance criteria — command output

```
### npm run typecheck
> @polaris/app@0.1.0 check
> tsc -p tsconfig.json
(no errors; interfaces, agent, stellar and app all clean)

### npm --prefix app run build
vite v8.3.0 building client environment for production...
✓ 50 modules transformed.
dist/index.html                    0.51 kB │ gzip:  0.30 kB
dist/prompt.html                   0.59 kB │ gzip:  0.31 kB
dist/assets/prompt-Bb8Ovyen.css    2.97 kB │ gzip:  1.02 kB
dist/assets/src-DHqd7kOS.css      19.48 kB │ gzip:  4.82 kB
dist/assets/prompt-BJpc6tpK.js     4.07 kB │ gzip:  1.65 kB
dist/assets/main-DmYJoU8K.js       5.12 kB │ gzip:  2.07 kB
dist/assets/src-DnkZxg85.js      232.55 kB │ gzip: 73.70 kB
✓ built in 260ms

### cargo test
test result: ok. 103 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out
(the 2 ignored are the pre-existing opt-in live Fish tests)

### cargo clippy --all-targets -- -D warnings
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.75s
```

`ctrl_tap.rs` tests cover exactly the required cases: happy-path double tap,
too-slow second tap, long-hold rejection, Option/Command contamination, and
no-retrigger-until-a-full-cycle (plus a three-tap regression).

### Startup smoke test

`npm run tauri dev` was launched and killed after ~55 s. It started with no panic:

```
polaris: STT backend on-device (tr-TR); audio never leaves this Mac
polaris: TTS backend Fish Audio (s2.1-pro-free — voice 933563129e564b19a115bedd57b7406a) ...
polaris: notch geometry NotchGeometry { idle_width: 179.0, idle_height: 32.0, ... }
polaris: notch overlay ready — hold Control+Option (or Control+Option+Space) to record; ...
```

No `prompt window unavailable` / `could not place the prompt window` errors were printed, so the
new window accepted its config and was positioned. The interactive behaviour (double tap, typing,
speaking) still needs the human with a real keyboard.

## Files touched

Created:

- `app/src-tauri/src/ctrl_tap.rs`
- `app/src-tauri/src/prompt_window.rs`
- `app/src-tauri/src/prompt_commands.rs`
- `app/prompt.html`
- `app/src/prompt/main.tsx`, `app/src/prompt/PromptPanel.tsx`, `app/src/prompt/prompt.css`
- `backlog/2026-09-19-a6-text-prompt.md` (this file)

Edited (minimal, additive):

- `app/src-tauri/src/lib.rs` — mods + command registration + one `setup` call
- `app/src-tauri/src/hotkey_flags.rs` — `add_sample_observer` fan-out + two call sites
- `app/src-tauri/src/tauri.conf.json` — second window entry
- `app/src-tauri/capabilities/default.json` — `"prompt"` window label
- `app/vite.config.ts` — multi-page `rollupOptions.input`
- `backlog.md`, `notes.md`

No file outside the task's ownership list was modified.

## Known gaps / follow-ups

1. **Fn (Globe) is not part of the contamination check.** `ModifierSample` carries only
   Control/Option/Command/Shift; adding `fn` would mean editing `gesture.rs`, outside this
   scope. Low risk (Fn alone does not produce `flagsChanged` with the other bits here) but a
   real gap against the letter of the spec.
2. **Close is panel-driven.** If the prompt webview is wedged, a generated `close` would not
   hide the window. The panel's `prompt_hide` call is best-effort; a Rust-side fallback timeout
   was deliberately left out to keep the code small. Consider adding one if this ever bites.
3. **Transparent area during the animation.** The native window is exactly the sheet's height
   once open, but for the ~240 ms open/close animation the remainder is transparent yet still
   inside the (focusable) window, so it can capture a click. Short-lived and low impact; a
   `set_ignore_cursor_events` toggle could remove it if it is ever noticeable.
4. **Merge with the a5 notch shell.** `feat/a5-notch-shell` restructures `App.tsx`,
   `components/*` and `notch.rs`. A6 deliberately shares none of those: the prompt window is a
   *separate* Tauri window with its own entry and root, and it duplicates only the window-level
   positioning (level 25 + collection behaviour) that `notch.rs` keeps private. On merge, the
   likely follow-ups are (a) hoist the `NSStatusWindowLevel` constant and the collection-behaviour
   set behind a small shared helper if a5 exposes one, and (b) re-check the prompt width if the
   a5 shell changes the overlay's own width assumptions. No textual conflict is expected in
   `lib.rs` beyond the adjacent `mod`/handler lines.
5. **Global trigger needs Accessibility trust.** `flagsChanged` samples only arrive when the
   global monitor is trusted; without it the double tap works only while a Polaris window is
   focused. This matches the existing Control+Option behaviour and is not separately gated.
6. **Production `speak`/agent path is unchanged.** The panel reuses the same Vite `/agent-api`
   proxy as the overlay, so the pre-existing "proxy only exists in dev" caveat carries over.

## Suggested next step

Human verification with a real keyboard: double-tap Control, type, submit with the speaker switch
both on and off; confirm the sheet grows from the notch and collapses on Esc/✕, and that the
toggle survives a restart. Then review + merge, coordinating with `feat/a5-notch-shell`.

---

## Review round 1 — response to `backlog/2026-09-19-a6-review.md`

- **Date:** 2026-09-19
- **Reviewer verdict:** REQUEST CHANGES (1 BLOCKER, several MAJOR)
- **Disposition below:** every BLOCKER/MAJOR addressed; MINOR/NIT items either fixed or explicitly
  deferred. Reviewer line numbers were verified against the real code first — one finding (4.3's
  claim that `setText("")` should have been there) was a genuine gap, and one claim was re-scoped
  because the report misread the intended behaviour (noted inline).

### BLOCKER

**R1.1 — `.is-open` had no CSS rule, so the sheet never animated (4.1). — FIXED.**
Verified: `prompt.css` defined `.prompt-sheet { height: var(--sheet-height, 0px) }` and no
`.is-open` selector; `PromptPanel` toggled the class for nothing. The closed state now sets
`height: 0`, `.prompt-sheet.is-open { height: var(--sheet-height, 0px) }`, so open animates
0 → measured and close animates measured → 0. `COLLAPSE_MS` (240 ms) still matches the CSS
`--prompt-motion`, so `prompt_hide` fires after the collapse completes. The same edit carries the
notch-aware corner radius (see R1.7).

### MAJOR

**R1.2 — false-positive double-tap from rapid Control chords (`Ctrl+C`, tmux `Ctrl+B`) (1.1). —
FIXED (this was the most important finding).**
Verified: the detector only consumed `flagsChanged`; a non-modifier key press never reached it, so
two quick `Ctrl+C` presses looked exactly like two bare Control taps.
Fix, end to end:
- `hotkey_flags.rs` now observes `NSEventMask::FlagsChanged | NSEventMask::KeyDown` on the same
  global+local monitor pair (`OBSERVED_MASK`) and adds `add_key_observer`. The monitor callbacks
  branch on `event.r#type()`: a `KeyDown` calls `notify_key_observers()` and, for the local
  monitor, returns the event pointer unchanged (key-downs are observed, never swallowed).
- `CtrlTap` gains `on_key_press()`: a key pressed **while Control is down** poisons the attempt the
  same way a foreign modifier does (clears `press_started`, `first_tap_release`,
  `awaiting_second`; sets `contaminated`), and the poison clears once Control is released. A key
  pressed with Control up (ordinary typing between taps) does **not** poison.
- `prompt_window::start_tap_driver` forwards both signals as one ordered `TapInput` stream into
  the tap thread, applying `on_key_press` in user order.
- Tests: `a_key_pressed_while_control_is_down_invalidates_the_sequence` (the reported scenario,
  two chords inside `TAP_GAP`) and
  `a_key_press_with_control_up_is_ordinary_typing_and_does_not_invalidate`.

**R1.3 — tautological `a_long_control_hold_is_not_a_tap` (1.2). — FIXED.**
Verified the report's reasoning: the old assertion placed the follow-up tap at `t0 + 1s`, far past
`TAP_GAP`, so it proved nothing. The test now sends a tap at `hold_release + 100 ms` (inside
`TAP_GAP`), asserts it does **not** fire, then a third tap that **does** fire — proving the
rejected hold left `first_tap_release` empty and the machine rearmed. The same
"inside-`TAP_GAP`" pattern was added to the contamination test (report finding 1.3.1).

**R1.4 — `SAMPLE_OBSERVERS` mutex held across observer callbacks (2.1). — FIXED.**
Verified the old loop called `observer(sample)` while holding the guard. Observers are now stored
as `Arc<dyn Fn … >`; `notify_*` clones the registry list under the lock, releases it, then runs
the callbacks. Re-entrant `add_sample_observer` no longer deadlocks — covered by
`a_sample_observer_can_register_another_observer`, which would hang before the fix.

**R1.5 — observer panic unwinds across the Objective-C boundary (2.2). — FIXED.**
Every observer body now runs inside `std::panic::catch_unwind`. The containment is factored into a
private `notify_all<T, F>` so it is testable against a local list without touching the global
registry; `notify_all_contains_a_panicking_observer` proves a panic in one observer is contained
and later observers still run.

**R1.6 — `emit(Open)` raced `run_on_main_thread` (3.2). — FIXED.**
Verified: `show()` emitted outside the main-thread closure, before `place`/`show`/`set_focus`.
`emit(Open)` now happens inside the closure, after `set_focus`. `setup` and `resize` were also
checked: both already sequence their `place` through `run_on_main_thread`, so no other racy emit
remains.

**R1.7 — notch-less screens covered the menu bar with a square-topped sheet (3.1). — FIXED.**
Verified `safeAreaInsets().top == 0` on notch-less displays and the fallback path. `place()` now
derives `notched` from `safeAreaInsets().top > 0`; when there is no notch the top edge is pinned
to `screen.visibleFrame()`'s top (below the menu bar, Spotlight-like) instead of the screen top.
The value is published to the panel on the `open` event (`PromptEvent.notched`, omitted on close),
and `PromptPanel` adds `is-notched`, so the CSS squares the top corners only when the sheet really
sits under a cutout. Tested by `an_open_event_carries_the_notch_flag`.

**R1.8 — answer taller than `MAX_WINDOW_HEIGHT` was clipped with no scroll (4.2 / 1.6). — FIXED.**
`.prompt-answer` now has `max-height: 480px; overflow-y: auto` (plus thin scrollbar and
`overscroll-behavior: contain`). The 480 px budget is deliberately under the 720 pt native cap so
the bar, input and padding always fit.

**R1.9 — height not clamped to the screen (3.3). — FIXED.**
Verified `height.clamp(MIN, MAX)` ignored the display. `place()` now clamps against
`(top - frame.origin.y - 40).max(MIN_WINDOW_HEIGHT)`, so a short or vertically scaled display
cannot push the window off the bottom.

**R1.10 — non-macOS stub used unclamped `PROMPT_WIDTH` (3.4). — FIXED.**
Verified: the stub clamped `width` locally then passed `PROMPT_WIDTH` to `LogicalSize`. It now
passes the clamped `width`.

### MINOR / NIT (addressed beyond the required BLOCKER/MAJOR set)

**R1.11 — test coverage gaps (1.3). — FIXED.** Added
`command_and_shift_also_contaminate_the_sequence`, `a_long_second_tap_does_not_fire`,
`a_foreign_modifier_during_the_second_press_breaks_the_pair`, and the two key-press tests.

**R1.12 — input/answer not cleared on reopen (4.3). — FIXED.** `openPanel()` now clears `text`
and `result` unless a turn is still in flight, so a reopened panel starts clean. `submit()` still
leaves the submitted text in place while the answer is on screen (intentional: the user can re-run
or edit it).

**R1.13 — permanent observer allocation without unregistration (2.3). — DEFERRED (documented).**
`add_sample_observer`/`add_key_observer` are process-lifetime by design; the prompt driver
registers exactly once from `setup`. An unregister token was not added because it would be unused
and would complicate the ordering guarantees. The doc comments now state the lifetime contract
explicitly.

### Review items verified as already correct (unchanged)

- **1.4 gesture collision:** re-verified. `CtrlTap` still poisons on Option/Command/Shift and
  `gesture.rs` is untouched; a double-Control sequence never asserts `pair_down()`.
- **3.5 runtime errors/unwraps:** still zero `unwrap`/`expect` outside `#[cfg(test)]`; clippy
  `-D warnings` is clean.
- **4.4 XSS / localStorage:** unchanged and still clean (JSX text nodes, `try/catch` storage).

### Gates after round 1

```
npm run typecheck            → clean (interfaces, agent, stellar, app)
npm --prefix app run build   → ✓ built (prompt.css 3.23 kB, prompt.js 4.30 kB)
cargo test                   → 111 passed; 0 failed; 2 ignored
cargo clippy --all-targets -- -D warnings → clean
```

`cargo test` grew from 103 to 111: +5 `ctrl_tap` cases, +2 `notify_all`/re-entrancy cases,
+1 `prompt_window` notch-serialization case.

## Files touched in round 1

- `app/src-tauri/src/ctrl_tap.rs` — `on_key_press`, rule 4 doc, fixed tautological test, new tests
- `app/src-tauri/src/hotkey_flags.rs` — key-down observers, lock-release snapshot, `catch_unwind`,
  tests
- `app/src-tauri/src/prompt_window.rs` — ordered key stream, in-closure `emit(Open)`, notch /
  menu-bar placement, height clamp, stub width, notch event flag + test
- `app/src/prompt/PromptPanel.tsx` — notch flag, stale-content reset
- `app/src/prompt/prompt.css` — `.is-open` animation, notch corner radius, answer scroll
- `backlog/2026-09-19-a6-text-prompt.md` — this section
- `backlog/2026-09-19-a6-review.md` — the reviewer's report, committed for the record
