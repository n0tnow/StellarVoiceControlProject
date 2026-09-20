# Report: onboarding-native

- **Date:** 2026-09-20
- **Worker/Agent:** opencode-go/deepseek-v4.1-flash (worker)
- **Branch/Worktree:** `feat/onboarding-native` at `.worktrees/onboarding-native`
- **PR:** none (coordinator opens it)

## Completed

The native half of the first-run onboarding flow. A second, centered,
focusable window plus the Rust commands it needs. The React UI is owned by a
parallel worker; this worker ships only a dark placeholder page so the window
can be seen to work.

### Window

- Label `onboarding`, URL `onboarding.html`, 900x640, `.center()` on the primary
  display, `decorations(false)`, `transparent(true)`, `shadow(true)`,
  `resizable(false)`, `focusable(true)`, `always_on_top(true)`, built
  `visible(false)` then shown (the `panels.rs` pattern). It is a real,
  focusable window — it does **not** call `set_ignore_cursor_events`, so unlike
  the notch overlay it is not click-through.
- Created on demand, reused across opens (one instance per label). Close hides
  it instead of destroying it; `lib.rs` then calls `notch::resign_active` when
  no panel and no onboarding window remains visible.
- Opened at startup from `setup()` when the marker is not completed
  (`onboarding::open_if_needed`).

### Command + event contract (exactly as shipped)

Rust signatures; `invoke("name", args)` from TS. All argument/payload names are
the ones below (payload fields are already single words, so camelCase == as
written).

```rust
onboarding_state()                    -> OnboardingState   // { completed: bool, version: u32 }
onboarding_open()                     -> Result<(), String>
onboarding_close()                    -> Result<(), String>
onboarding_complete()                 -> Result<(), String>
onboarding_reset()                    -> Result<(), String>
onboarding_permissions()              -> Permissions       // { microphone, accessibility }
onboarding_request_microphone()       -> PermissionStatus  // async; shows the TCC prompt, returns after the answer
onboarding_request_accessibility()    -> PermissionStatus  // AXIsProcessTrustedWithOptions(prompt=true)
onboarding_open_settings(pane: SettingsPane) -> Result<(), String>
```

- `PermissionStatus`: lowercase wire values `"granted" | "denied" | "undetermined"`.
- `SettingsPane`: deserialized from `"microphone" | "accessibility"`.
- `OnboardingState.version` returns `ONBOARDING_VERSION` (the version the running
  app expects), not the stored marker's version; `completed` already encodes the
  `stored_version >= ONBOARDING_VERSION` comparison.
- Event name (public const `onboarding::ONBOARDING_PERMISSIONS_EVENT_NAME`):
  `onboarding_permissions`, payload `{"microphone":"…","accessibility":"…"}`.
  Emitted **only on change**, by a 1-second poll that runs **only while the
  window is visible** and stops when it hides (generation counter; no permanent
  timer).

### Persistence

`onboarding.json` (`{"version":1}`) in `app.path().app_config_dir()`. Missing or
unreadable marker reads as "not completed"; write/remove failures are returned
as `Err(String)` and logged, never `unwrap()`. `ONBOARDING_VERSION = 1`; bumping
it re-runs onboarding for users who finished an older design (documented on the
const).

### Permissions

- Microphone: `objc2-av-foundation` →
  `AVCaptureDevice.authorizationStatusForMediaType:` /
  `requestAccessForMediaType:completionHandler:`. Map
  `0→undetermined`, `1|2→denied`, `3→granted`, unknown→`denied`. The request
  waits on an `mpsc` channel fed by the completion block (120 s bound), then
  re-reads the authoritative status.
- Accessibility: reuses `hotkey_flags::is_trusted()` (`AXIsProcessTrusted`) and
  `hotkey_flags::prompt_for_trust()` (`AXIsProcessTrustedWithOptions` with
  `kAXTrustedCheckOptionPrompt=true`). Never `undetermined` (documented).
- System Settings deep links opened with the macOS `open` command.

### Files

- Created: `app/src-tauri/src/onboarding.rs`, `app/onboarding.html`,
  `app/src/onboarding/main.tsx` (placeholder), `app/src-tauri/capabilities/onboarding.json`.
- Edited: `app/src-tauri/src/lib.rs`, `app/vite.config.ts`,
  `app/src-tauri/Cargo.toml` (+ `Cargo.lock`).

## Deviations from the task spec (and why)

1. **Fallible commands return `Result<(), String>` instead of a bare `()`**
   (`onboarding_open/close/complete/reset/open_settings`). The spec requires a
   write failure to be "returned as an error string", which a `()` command
   cannot do. On the JS side this is unchanged: `invoke` resolves to `undefined`
   (success) or rejects (failure) — i.e. `Promise<void>`.
2. **Added `app/src-tauri/capabilities/onboarding.json`** (not in the EDIT
   list). Strictly required: a window only gets IPC/event permissions from a
   capability matching its label. Without it the onboarding webview could not
   listen to `onboarding_permissions`. Mirrors `capabilities/panels.json`
   (`core:default` + `core:window:allow-close`).
3. **Added `objc2-av-foundation`** as a macOS-only target dependency with
   `default-features = false` and the minimal feature set
   (`std, AVCaptureDevice, AVMediaFormat, block2`). The spec allowed "the
   smallest dependency that does it"; the typed crate (same objc2 0.6.x
   generation) is safer than a hand-written msgSend shim, and the default
   features were trimmed so image-io/media-toolbox are not built.
4. **`onboarding_request_microphone` is `async` + `spawn_blocking`** (the same
   shape as `approval_authorize`) so the TCC wait never blocks the Tauri main
   thread. The JS contract is unchanged.
5. **`OnboardingState.version` semantics**: returns `ONBOARDING_VERSION` (current
   contract version). Flagged here so the UI worker can confirm the intent.

## Verification

- `caffeinate -i ./scripts/check.sh` → **all checks passed** (exit 0).
- `cd app/src-tauri && caffeinate -i cargo test` → **328 passed / 0 failed /
  5 ignored**; the new `onboarding` suite is **8/8**.
- `caffeinate -i cargo clippy --all-targets -- -D warnings` → clean.
- `cd app && npx tsc -p tsconfig.json` → clean (after `npm ci` in the worktree;
  the worktree had no `node_modules`).
- `npm run build -w @polaris/app` → `app/dist/onboarding.html` emitted with its
  own chunk.

## Unfinished (handed off)

- The onboarding React UI (parallel worker) — only the dark placeholder exists.
- A menu/tray entry that calls `onboarding_reset` to re-run onboarding (the
  command exists; nothing invokes it yet).
- Human verification on a real Mac: window centering/size/appearance, the TCC
  microphone prompt, the Accessibility prompt, the two System Settings deep
  links, and the permission poll reacting to a switch flipped in System
  Settings.

## Blockers

- None for merge. Runtime macOS behaviour cannot be verified from this
  headless/CLI worker.

## Review Notes

- Focus areas: the startup `open_if_needed` call runs inside `setup()` (before
  `run()`); the poll's generation-based stop; the `Result<(), String>` vs `()`
  decision; the new capability file.
- `on_window_event` in `lib.rs` was refactored into a shared
  `resign_after_interactive_close` so panels and onboarding follow one rule.

## Suggested Next Step

- Merge the React onboarding UI on top of this contract, then run the live Mac
  checklist above.

## Review fixes applied

Applied against `backlog/onboarding-native-review.md` (verdict: APPROVE WITH
NITS; all three nits fixed).

- **Finding 1 — startup `?` could brick first launch.** `lib.rs` `setup()` now
  logs and continues on an `open_if_needed` error instead of propagating it, so
  a transient window-server failure on a fresh install no longer prevents
  Polaris from starting. `open_if_needed` stays fallible for the command path.
- **Finding 2 — no label-collision tolerance on concurrent opens.**
  `onboarding::open()` now mirrors `panels::open_spec`: the create result is
  matched, and `WindowLabelAlreadyExists`/`WebviewLabelAlreadyExists` fall
  through to a shared `show_and_focus(app)` helper instead of returning a
  spurious error. Added `onboarding::tests::concurrent_create_label_collisions_are_recognized`
  for the newly testable `is_label_collision` predicate (the race itself still
  needs a live app to exercise).
- **Finding 3 — poll stopped before the hide succeeds.** `hide_window()` now
  hides first and calls `stop_permission_poll()` only after a successful hide,
  so a failed hide cannot strand a visible window with a dead permission poll.
  The no-window path still stops the poll, keeping the command idempotent. The
  ordering itself is not unit-testable without a real `AppHandle`/window, so it
  is verified by reading; `cargo test` covers the rest of the module.

Verification after fixes: `cargo clippy --all-targets -- -D warnings` clean;
`cargo test` 329 passed / 0 failed / 5 ignored (was 328; +1 new test).

## Rehearsal mode

- **Date:** 2026-09-20
- **Worker/Agent:** opencode-go/deepseek-v4.1-flash (worker)
- **Branch/Worktree:** `feat/onboarding-native` at `.worktrees/onboarding-native`
- **PR:** none (coordinator opens it; #34 already tracks this branch)

### The decision

The product owner's rule: **the first run is entirely a rehearsal — no real
operation happens during onboarding.** The onboarding lessons make the user
physically perform the push-to-talk hold and the double-Control tap so the
gestures are learned, but a native global hotkey cannot tell "lesson" input from
"real" input. Left alone, a rehearsal keystroke would run the real pipeline:
`hotkey::apply` would `capture.start(app)` (write a real WAV to disk, open a
timing trace, feed STT/agent/TTS) and `notch/tap.rs` would emit `notch_hotkey`
so the real prompt opened behind the onboarding window.

### What was built

- `onboarding::is_rehearsing(app: &AppHandle) -> bool` — the single predicate.
  It answers from the onboarding window's **real visibility**
  (`get_webview_window(WINDOW_LABEL)` + `is_visible()`), is cheap and
  non-panicking, and on a visibility error returns `false` ("not rehearsing"):
  a window-server hiccup fails toward normal behaviour, never toward a dead
  hotkey.
- `hotkey::apply` — while rehearsing, `Start` and `Stop` are both dropped before
  any `events::emit`, `capture.start`/`capture.stop`, or
  `timing::begin_turn`/`timing::mark`. The decision is factored into a pure
  `surviving_actions(actions, rehearsing) -> Vec<Action>` so it is unit-tested
  without an `AppHandle`.
- `notch/tap.rs` — while rehearsing the detector keeps consuming samples but
  skips the `notch_hotkey` emit, so the notch never proposes its prompt behind
  the onboarding window.

### Not done (and why)

- The monitors themselves (`hotkey_flags.rs`, `ctrl_tap`) are **not** disabled.
  The gesture machinery stays running and warm; only the consequences are
  suppressed. Tearing the monitors down and rebuilding them around onboarding is
  how this project previously broke notch hover.
- No UI-supplied "step 3 visible" flag is trusted. The Rust safety gate reads
  the window's real visibility, never the webview.
- `capture.rs`, `stt*`, `agent.rs`, `tts*` are untouched.

### The non-obvious coupling (why total silence, not partial)

The onboarding UI does **not** depend on the native events. On branch
`feat/onboarding-ui`, `app/src/onboarding/useShortcutProbe.ts` subscribes to the
Tauri events **and** to plain DOM `keydown`/`keyup` on the focused onboarding
window as redundant sources. The DOM path alone gates both lessons, and the
onboarding window is the key window while it is up. Suppressing the native side
therefore costs the lesson nothing and is the only way to guarantee no side
effect. If that UI is ever "simplified" onto the native events alone, this gate
must be revisited — called out in the `is_rehearsing` doc comment so the next
reader sees it.

### Verification

- `cargo clippy --all-targets -- -D warnings` → clean.
- `cargo test` → **331 passed / 0 failed / 5 ignored** (was 329; +2 new tests:
  `hotkey::tests::rehearsal_drops_every_action`,
  `hotkey::tests::normal_mode_keeps_every_action`).
- Not run: `cargo fmt` — running it revealed the crate has pre-existing,
  repo-wide rustfmt drift, so formatting the whole tree was out of scope for
  this change and was reverted. Only the three touched files were modified.

### Unsure / for review

- `is_rehearsing` is called on `apply`, including the watchdog/tick paths, so a
  visibility lookup happens on any tick that carries actions. The empty-action
  early return keeps it off idle ticks, but this has not been profiled on a real
  run; the task accepted "cheap" as a requirement and `is_visible()` is a
  window-state read, not a syscall-heavy probe.
- The rehearsal gate is inactive once onboarding is hidden; a user who hides
  onboarding mid-lesson (rather than finishing) returns to the real pipeline
  immediately. That matches "while the window is up" in the task and matches the
  visibility the lessons themselves use.
