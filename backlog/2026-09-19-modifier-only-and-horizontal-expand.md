# Report: modifier-only-and-horizontal-expand

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a0-push-to-talk-notch` @ `.worktrees/a0`
- **PR:** none (per task: no PR, no merge, no tag)
- **Spec followed:** `docs/reports/2026-09-19-modifier-only-hotkey.md` (Task 1) and the measured
  animation feedback (Task 2).
- **Scope:** two independent changes, one commit each. Task 1: a native Control+Option
  `flagsChanged` latch, the Accessibility gate, and the permission event — the
  `control+alt+space` shortcut is kept. Task 2: one CSS transition list. No geometry numbers, no
  shape/radii code, no capture engine, and no native window placement were touched.

---

## Task 1 — Modifier-only Control+Option hold is now the default gesture

### What changed

| File | Change |
|---|---|
| `app/src-tauri/src/gesture.rs` | **New.** Pure, timestamped latch: `ARM_DELAY`, `DRIVER_TICK`, `WATCHDOG_INTERVAL`, `ModifierSample`, `Trigger`, `Action`, `Latch`. 11 unit tests. |
| `app/src-tauri/src/hotkey_flags.rs` | **New.** `NSEvent` global+local `flagsChanged` monitor pair, the monitor-token lifetime handling, `AXIsProcessTrusted` / `AXIsProcessTrustedWithOptions`, and a masked-sample helper. Non-macOS stub. |
| `app/src-tauri/src/hotkey.rs` | Driver thread + `HotkeyRuntime` managed state + `setup` / `teardown` / `handle_shortcut` / `hotkey_permission` command. |
| `app/src-tauri/src/lib.rs` | Calls `hotkey::setup`, registers `hotkey_permission`, and moves to `build(..).run(|app, event| ..)` so `RunEvent::Exit` tears the monitors down. |
| `app/src-tauri/src/events.rs` | New `PolarisEvent::HotkeyPermission { trusted }` variant + wire-format test. |
| `interfaces/src/index.ts` | `hotkey_permission` added to the `PolarisEvent` union. |
| `app/src/lib/polaris.ts` | `getHotkeyPermission()` command wrapper + a `describeEvent` case. |
| `app/src/App.tsx` | Tracks trust, shows a one-time non-modal hint, and updates the gesture copy. |
| `app/src-tauri/Cargo.toml` + `Cargo.lock` | macOS-only direct deps `block2 = "0.6"`, `core-foundation = "0.10"` (both already in the lock as transitive deps). |

### How the required behaviour is implemented

1. **Both triggers, one latch.** `hotkey_flags` pushes `ModifierSample`s; the global-shortcut
   plugin pushes `Input::Shortcut`. Both land in the same `mpsc` channel; the driver thread owns
   the single `Latch` and calls `capture.start` / `capture.stop` (idempotent start, either release
   stops). The shortcut is registered unconditionally in `hotkey::setup`.
2. **300 ms arming delay** — `gesture::ARM_DELAY = 300 ms`, a named constant. A pair hold arms a
   deadline; only a still-held pair at the deadline starts a capture. A sub-300 ms tap never does
   (test `a_sub_delay_tap_never_starts_a_capture`).
3. **Command/Shift exclusion (and a stronger rule).** Any sample with Command or Shift held is
   ignored. In addition, a pair hold that overlaps Command/Shift is *poisoned*: it cannot re-arm
   until the pair is fully released. This goes one step past the report's "cancel" wording and is
   deliberate — a VoiceOver user who releases the chord's letter key while still holding
   Control+Option must not slide into a recording 300 ms later
   (test `command_or_shift_hold_is_ignored_and_poisons_the_pair`).
4. **Accessibility gate, no block/crash.** `AXIsProcessTrusted()` is read at startup. If
   untrusted, the standard system consent dialog is raised with
   `AXIsProcessTrustedWithOptions({ kAXTrustedCheckOptionPrompt: true })` and the app runs
   shortcut-only. The prompt's return value is never trusted; a 1 s watchdog polls
   `AXIsProcessTrusted()` and enables the gesture the moment trust flips
   (test/report `watchdog`). Nothing blocks or spins.
5. **Watchdog.** Every 1 s the latch is reconciled against `NSEvent::modifierFlags_class() &
   deviceIndependentFlagsMask`; a disagreement is replayed through the normal transition path, so
   a missed release stops the capture (test `watchdog_heals_a_stuck_modifier_latch`). On trust
   loss any modifier-initiated capture is force-stopped while a shortcut capture is left alone.
6. **Token lifetime.** `Retained::into_raw` keeps both monitor objects alive for the process
   lifetime; `hotkey::teardown` calls `NSEvent::removeMonitor` on both from the `RunEvent::Exit`
   callback (main thread).

### Deliberate choices / deviations

- **`current_sample()` is read on the driver thread.** The report's watchdog pseudocode runs on
  the main thread. `objc2-app-kit` 0.3 marks `NSEvent` as any-thread (its `modifierFlags` class
  method takes no `MainThreadMarker`), so the driver polls it directly and avoids a main-thread
  hop and a per-tick round trip. Flagged as a deviation: if the user ever sees the watchdog
  "heal" a healthy hold, this is the first line to revisit.
- **Registration happens directly in `setup`.** Tauri's `setup` runs on the main thread (the notch
  code already relies on this), so no `run_on_main_thread` hop is needed for installation.
- **Startup prompt instead of a click-to-prompt.** The notch overlay is click-through and never
  takes focus, so there is no clickable "Enable" affordance. The only user-visible action
  available is app launch, so the prompt is raised there. macOS shows it once per signature; later
  calls are no-ops. This is the one user-facing first-run step (see below).
- **"Re-check on focus" is the 1 s poll.** The overlay is `focusable: false`, so it never receives
  focus. The watchdog poll re-checks trust at least once a second, which is strictly more
  responsive than a focus event would be.

---

## Task 2 — The expansion now reads as horizontal only

`app/src/index.css` `.notch` previously transitioned `width`, `height`, `border-radius` and
`--ear` together. The height transition (`32 -> 66 pt` over the same spring curve) was the visible
vertical growth the user objected to. It is now removed:

```css
transition:
  width 300ms cubic-bezier(0.22, 1, 0.36, 1),
  border-radius 300ms cubic-bezier(0.22, 1, 0.36, 1),
  --ear 300ms cubic-bezier(0.22, 1, 0.36, 1);
```

**Why snap rather than an 80 ms tween.** A `<= 80 ms` height tween was the offered alternative,
but at a 34 px delta it is still a visible vertical pop on the first frames. Removing the height
transition entirely means the only animated axis is the width, so the perceived motion is purely
left/right. `.notch-stage` is `align-items: flex-start`, so the shell stays top-anchored and the
top edge never drifts; when the height snaps it grows downward. The geometry (`expanded_width`
680, `expanded_height` 66, all radii) is unchanged, `@property --ear` still animates in lockstep
with the width, and `prefers-reduced-motion` still disables the remaining transitions.

Note: the task brief mentioned a "460 ms" curve; the code on this branch actually used `300ms`.
The duration was left at `300ms` — only the height transition was removed.

Verified against the built bundle (no height transition survives minification):

```css
.notch{...;width:var(--idle-width);height:var(--idle-height);...
transition:width .3s cubic-bezier(.22,1,.36,1),border-radius .3s cubic-bezier(.22,1,.36,1),--ear .3s cubic-bezier(.22,1,.36,1);position:relative}
```

---

## Verification (real command output)

### `cd app/src-tauri && caffeinate -i cargo build` — success

```
   Compiling polaris-app v0.1.0 (/Users/fatih/StellarVoiceControlProject/.worktrees/a0/app/src-tauri)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 2.61s
```

This is the first build that links the `ApplicationServices` extern block — `AXIsProcessTrusted`
and `AXIsProcessTrustedWithOptions` resolve at link time, which closes the research report's
uncertainty #4.

### `cd app/src-tauri && caffeinate -i cargo test` — 25 passed (14 pre-existing + 11 new)

```
running 25 tests
test gesture::tests::both_down_arms_after_the_delay_and_starts ... ok
test gesture::tests::releasing_either_modifier_stops ... ok
test gesture::tests::command_or_shift_hold_is_ignored_and_poisons_the_pair ... ok
test gesture::tests::command_pressed_mid_hold_cancels_and_stops ... ok
test gesture::tests::a_sub_delay_tap_never_starts_a_capture ... ok
test gesture::tests::shortcut_is_immediate_idempotent_and_release_stops ... ok
test gesture::tests::watchdog_heals_a_stuck_modifier_latch ... ok
test gesture::tests::watchdog_catches_a_missed_press ... ok
test gesture::tests::reset_modifiers_stops_the_gesture_capture_only ... ok
test hotkey::tests::fallback_shortcut_is_control_option_space ... ok
test events::tests::hotkey_permission_matches_the_ts_union ... ok
... (14 pre-existing) ...
test result: ok. 25 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The latch tests cover exactly the required matrix: both-down arms; either-up stops; Command/Shift
held is ignored; a sub-300 ms tap never starts; and the watchdog heals a stuck latch.

### `cd app/src-tauri && caffeinate -i cargo clippy --all-targets` — only the pre-existing warning

```
warning: `polaris-app` (lib) generated 1 warning
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 1.17s
```

The single warning is `clippy::large_enum_variant` on `PolarisEvent` (present before this work).

### `caffeinate -i npm run typecheck` (repo root) — green

All four workspaces (`interfaces`, `agent`, `stellar`, `app`) run `tsc` with no diagnostics.

### `caffeinate -i npm run build` (repo root) — green

```
dist/index.html                   0.43 kB │ gzip:  0.27 kB
dist/assets/index-DnTD6wu_.css   17.40 kB │ gzip:  4.41 kB
dist/assets/index-k3dR7VTV.js   224.20 kB │ gzip: 70.39 kB
✓ built in 155ms
```

---

## What the user MUST do / check on the real machine

**Accessibility permission changes first run — prominently:**

1. On first launch (and after any TCC reset), macOS will show the standard
   *"Polaris would like to control this computer using accessibility features"* dialog, or the app
   will open System Settings. **Polaris must be enabled in System Settings → Privacy & Security →
   Accessibility** before the Control+Option hold works system-wide. Until then only
   `Control+Option+Space` records. The TCC entry is for the **app binary**, not the terminal/IDE
   that launched it.
2. In the terminal, the first modifier press prints a one-shot line
   `polaris: flagsChanged delivered on ThreadId(..) (registered on ThreadId(..), match=..)`. Please
   paste that line back: it settles the report's flagged callback-thread uncertainty.
3. Visual/animation check (cannot be done from this environment):
   - Idle pill still disappears into the hardware cutout.
   - Holding Control+Option: the shell should widen **left and right only**; the top edge stays
     flush and there should be no visible vertical inflation.
   - Releasing **either** Control or Option stops and lands on `ready`.
   - `Control+Option+Space` still starts/stops (fallback).
   - Tapping Control+Option quickly (< 300 ms) must NOT start a recording.
4. VoiceOver-on check: with VoiceOver active, navigating with VO+keys should not leave the app
   recording after the chord. This is the highest-risk collision; the 300 ms gate + Command/Shift
   poison should cover the common chords, but it is a manual test.

## What I could NOT verify (honest limitations)

- **The gesture itself, the animation, and the Accessibility flow were never run.** This
  environment builds and unit-tests only; there is no interactive window server, no TCC grant, and
  no microphone. Everything runtime is delegated to the user checks above.
- **Callback delivery thread** — not observed. The diagnostic print is in place but only fires on a
  real modifier press.
- **Secure Input** (password dialogs) — unverified, as the report flagged. The watchdog is the
  backstop; a manual password-dialog test is requested.
- **Sleep/lock mid-hold** — the watchdog heals within ~1 s after wake, but the report's stronger
  `NSWorkspace` sleep/lock force-stop (and screensaver) is **not implemented**. The result is a
  silent tail on the WAV, never a send. Filed as handoff below.
- **`addGlobalMonitor…` token when untrusted** — I gate on `AXIsProcessTrusted()`, not on the
  registration `Option`, as the report requires; whether AppKit returns `None` while untrusted was
  not observed (no untrusted interactive run).
- **VoiceOver users can still trigger a bare 300 ms+ pair hold** with no third key. This is the
  report's acknowledged event-level limit. The report's recommended on/off toggle and
  "auto-suggest the shortcut" heuristic are **not implemented** (there is no settings surface in
  the current notch-only shell). Filed as handoff.

## Unfinished (handed off)

- VoiceOver/normal-use toggle for the modifier gesture (needs a settings surface).
- `NSWorkspace` sleep / screen-lock / screensaver force-stop for an in-flight gesture capture.
- Optional: a clickable permission affordance (currently the overlay is click-through, so the
  system dialog + one-time in-shell hint are the only signals).

## Suggested Next Step

1. User runs the app, grants Accessibility, and reports the delivery-thread line + the four
   runtime checks above.
2. If the animation still reads vertically, the next lever is the `--ear`/`border-radius` timing
   (delay them ~80 ms) — not the width curve.
3. Add the VoiceOver toggle and the sleep/lock force-stop once a settings surface exists (A1+).
