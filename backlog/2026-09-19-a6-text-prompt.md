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
