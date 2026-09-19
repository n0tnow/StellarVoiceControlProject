# Report: a0-push-to-talk-notch

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a0-push-to-talk-notch` @ `.worktrees/a0` (based on `origin/main` a559403)
- **PR:** none (per task: no PR, no merge, no tag)

## Completed

Step A0 of the Owner A track: a running macOS notch overlay driven entirely by the typed
event stream, a global push-to-talk hotkey, and microphone capture to a WAV. The old
skeleton dashboard was replaced by the notch shell (the design reference's
`notch-design.md` says "Replace the A0 dashboard"), so the "log pane" from the skeleton
is no longer the visible harness; the overlay's state *is* the harness.

| Area | What landed |
|---|---|
| `interfaces/src/index.ts` | `CaptureState`, `CaptureRecording`, `CaptureStatus`, `NotchGeometry`; new `PolarisEvent` variants `capture_status` and `audio_captured`; `isPolarisEvent` doc updated (it is tag-agnostic, so it already admits the new variants). |
| `app/src-tauri/src/types.rs` | Rust mirror of `CaptureState` / `CaptureRecording` / `CaptureStatus` (`snake_case` state, `camelCase` fields). |
| `app/src-tauri/src/events.rs` | `PolarisEvent::CaptureStatus { status }` and `PolarisEvent::AudioCaptured { path, duration_ms }`, `kind()` updated, JSON-shape tests pinned. |
| `app/src-tauri/src/capture.rs` | `cpal` input capture on a dedicated thread, normalized to 16-bit PCM and written with `hound`; `idle/recording/ready/error` state machine; `stop` waits briefly for finalization and emits `ready`; failures become the `error` state. |
| `app/src-tauri/src/hotkey.rs` | `control+option+space` registered via `tauri-plugin-global-shortcut`; Pressed → `hotkey down` + capture start, Released → `hotkey up` + capture stop (no send/submit). |
| `app/src-tauri/src/notch.rs` | Main-thread AppKit overlay: window level 25, all-Spaces/fullscreen-auxiliary collection behaviour, geometry from `safeAreaInsets` / `auxiliaryTopLeftArea` / `auxiliaryTopRightArea`, centered-pill fallback, `notch_geometry` command. |
| `app/src-tauri/src/commands.rs` | `app_info` kept; `capture_start` / `capture_stop` / `capture_status` added; **`dev_self_test` deleted**. |
| `app/src-tauri/tauri.conf.json` + `Info.plist` | Transparent, undecorated, shadowless, always-on-top, non-focusable, click-through, all-Spaces, taskbar-skipping window starting hidden; `macOSPrivateApi: true`; `NSMicrophoneUsageDescription`. |
| `app/src/App.tsx`, `index.css`, `lib/polaris.ts` | Notch component: collapsed pill ↔ expanded shell with concave shoulders, left status label, magenta indicator, error row, `ready` dwell; transparent html/body; `prefers-reduced-motion` respected. |

Design decisions worth review:

1. **The notch overlay replaces the dashboard.** `App.tsx` is now the overlay. The skeleton's
   `EventLog.tsx` / shadcn `Button` / `lib/utils.ts` / `components.json` are **kept but not
   rendered** by A0 — they are the reviewed M2 harness + design-system scaffold that A1/A2
   (transcripts) and A5 (approval card) will use. Flagged here so review can decide to trim.
2. **`ready` is sticky on the wire; the overlay collapses after a 6 s dwell.** A0 has no
   consumer for the WAV, so the backend keeps `state: ready` + `recording` (A1 needs the path);
   the 6 s dwell is presentation-only and never discards the recording.
3. **Hotkey is `control+option+space`**, a key-code shortcut. The modifier-only Ctrl+Option
   gesture is the deliberate follow-up named in the task; it needs a native `flagsChanged`
   observer + Accessibility prompt.
4. **The task said `audio_captured` "already exists on main" — it does not.** `grep` over
   `main` finds only the `hotkey` variant; `audio_captured` was added in this PR.
5. **Recordings location:** `~/Library/Application Support/dev.polaris.desktop/recordings/`
   (created at startup), so WAVs never land in the repo.

## Verification (real command output)

### 1. `cd app/src-tauri && caffeinate -i cargo build` — succeeds

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.43s
```

### 2. `cd app/src-tauri && caffeinate -i cargo test` — passes (10 tests)

```
test capture::tests::generated_paths_are_unique_and_under_the_recordings_dir ... ok
test capture::tests::idle_capture_reports_idle_and_stop_is_a_noop ... ok
test capture::tests::snapshot_maps_every_state_to_the_wire_shape ... ok
test events::tests::event_tags_and_fields_match_the_ts_union ... ok
test events::tests::capture_events_match_the_ts_union ... ok
test commands::tests::app_info_serializes_camel_case ... ok
test types::tests::intent_serializes_to_the_ts_shape ... ok
test types::tests::capture_status_matches_the_ts_shape ... ok
test types::tests::summary_uses_camel_case ... ok
test events::tests::approval_request_round_trips ... ok
test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s
```

### 3. `caffeinate -i npm run build` (repo root) — frontend builds

```
> @polaris/app@0.1.0 build
> vite build

vite v8.3.0 building client environment for production...
✓ 21 modules transformed.
dist/index.html                   0.43 kB │ gzip:  0.28 kB
dist/assets/index-CGFMn3Bd.css   17.08 kB │ gzip:  4.34 kB
dist/assets/index-BEZfEYrD.js   223.45 kB │ gzip: 70.13 kB
✓ built in 167ms
```

Type-checking is a separate workspace script; `caffeinate -i npm run typecheck` is green for
all four workspaces (`interfaces`, `agent`, `stellar`, `app`), `tsc` emitting no diagnostics.

### 4. `cd app/src-tauri && caffeinate -i cargo clippy --all-targets` — one **pre-existing** warning

```
warning: large size difference between variants
  --> src/events.rs:37:1
   |
37 | /   pub enum PolarisEvent {
...
62 | |         intent: Intent,
   | |______________________- the largest variant contains at least 272 bytes
```

This warning is about the pre-existing `ApprovalRequest` variant (272 bytes) and fires on
`main` too. Evidence: a detached worktree at `main` (`a559403`) run through the same command
produces the identical warning at the same line:

```
warning: large size difference between variants
  --> src/events.rs:37:1
warning: `polaris-app` (lib test) generated 1 warning (1 duplicate)
warning: `polaris-app` (lib) generated 1 warning
```

No warning is introduced by A0. (I did introduce four `assertions_on_constants` warnings in a
notch unit test; those were converted to a `const _: () = { … }` compile-time assertion and
are gone.)

### 5. objc2 version check — one objc2 major, matching Tauri

`cargo tree -i objc2` shows a single `objc2 v0.6.4`, shared by `tauri 2.11.5`,
`tauri-plugin-global-shortcut 2.3.2`, `cpal 0.18.2` (via `coreaudio-rs`) and this crate;
`objc2-app-kit v0.3.2` and `objc2-foundation v0.3.2` likewise have one version each. Cargo did
not resolve a second, incompatible objc2.

### 6. Real launch (`cargo run`) — the shell starts and configures the overlay

```
polaris: notch geometry NotchGeometry { idle_width: 199.0, idle_height: 36.0, expanded_width: 680.0, expanded_height: 66.0 }
polaris: notch overlay ready — hold Control+Option+Space to record; listen on `polaris-event`, network=testnet
```

This is a real measurement from the built-in notched display (idle pill 199 × 36 pt, expanded
680 × 66 pt), produced by the AppKit path; the process stayed up until it was killed. The
global shortcut registered without error.

## Unfinished (handed off) / unverified

- **End-to-end microphone capture is NOT verified by a human.** I did not hold the hotkey, so
  the cpal path, the TCC microphone prompt, and the resulting WAV were not exercised. The code
  path is unit-tested only around its state machine; the audio I/O callbacks are untested.
- **The overlay is not visually verified.** No screenshot/eyeball check of the shoulder curves,
  centring, or indicator; only the numerically measured geometry and a clean launch.
- **Display topology changes** are picked up by a 2 s UI poll of `notch_geometry` (which
  repositions the native window). A native `NSApplicationDidChangeScreenParameters` observer
  would be more precise; deliberately deferred.
- If a capture worker thread ever panicked, the state could remain `recording` (no
  catch-unwind). Rare and not user-triggerable in normal use; noted as a hardening item.
- A1 consumes the `ready` artifact: subscribe to `audio_captured` / read `CaptureStatus.recording.path`.

## Blockers

- None. Node 22, Rust 1.97, Tauri crates 2.11.5, `cpal` 0.18.2, `hound` 3.5.1,
  `tauri-plugin-global-shortcut` 2.3.2 and objc2 0.6.4 are all present.

## Review Notes

- `isPolarisEvent` was left tag-agnostic (`typeof type === "string"`) and documented; it already
  narrows to the extended union. A strict allow-list was considered and rejected as a
  forward-compatibility trap.
- `PolarisEvent` carries the pre-existing `large_enum_variant` clippy warning (boxing
  `ApprovalRequest` would fix it, but it changes the seam and is out of A0 scope).
- The skeleton's `EventLog.tsx` / `Button` / `utils.ts` / `components.json` are retained but not
  rendered (see Completed §1) — a reviewer may prefer they be trimmed until A1/A5 need them.
- `.notch-reference/` is scratch and was never `git add`ed (confirmed with `git status`).

## Suggested Next Step

A1 (STT): on `audio_captured`, run `whisper.cpp` over `CaptureStatus.recording.path` and emit a
`transcript` event; add a compact transcript view to the expanded notch.
