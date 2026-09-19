# A15 — the notch overlay floats over fullscreen apps (accessory activation policy)

- **Task:** `TASK-A15.md`
- **Branch:** `fix/a15-fullscreen-overlay` (based on `main` @ `34d1267`)
- **Worker:** opencode worker (`opencode-go/deepseek-v4.1-flash`)
- **Date:** 2026-09-20
- **Status:** pushed, no PR, no merge, no tag

## 1. What the owner reported, and what A14 left behind

The owner needs the notch overlay visible while **another** app is fullscreen
(video, Safari, Xcode). After A14 it was still not. A14 had verified, off the
live `NSWindow`:

```
notch window flags { level: 101, collection_behavior: 337,
                     full_screen_auxiliary: true, can_join_all_spaces: true,
                     focusable: false }
```

level = `NSPopUpMenuWindowLevel` and behaviour =
`CanJoinAllSpaces | Stationary | IgnoresCycle | FullScreenAuxiliary`. The flags
were exactly what A14 intended, and the overlay still vanished. **Flags were
necessary but not sufficient** — the fix was aimed at the wrong layer.

## 2. Reproduction and diagnosis (done before any change)

Two independent, non-visual checks were run against the unmodified `main`
binary, because this worker cannot see the screen.

**a) The activation policy of a running Polaris.** `lsappinfo` (the
WindowServer's own registry, not a guess from config) reported a Polaris
process of the regular kind:

```
"Polaris" ASN:0x0-0xa99a99:
    bundleID="dev.polaris.desktop"
    type="Foreground" flavor=3 ...
```

`type="Foreground"` is the WindowServer's name for a regular-policy app.

**b) Why it is regular.** `tao` (Tauri's windowing layer) hardcodes the policy
to `ActivationPolicy::Regular` at app-delegate construction
(`tao-0.35.3/src/platform_impl/macos/app_delegate.rs:106`), and Tauri's
`set_activation_policy` is the only thing that changes it. Nothing in
`tauri.conf.json` or `app/src-tauri/src/*.rs` called it; there is no
`LSUIElement` key in `Info.plist`. Grep confirms zero matches, matching the
coordinator's own check.

**c) The mechanism.** Apple's documented behaviour and the developers who have
shipped this (`stackoverflow.com/q/33845596`, Apple Developer Forums thread
826308, and a Tauri-specific write-up) agree: macOS does **not** layer a
regular app's windows into *another* app's fullscreen Space, whatever the window
level or collection behaviour. `FullScreenAuxiliary` mainly governs floating
over *your own* fullscreen window; it is not the mechanism for another app's
Space. The documented answer is the accessory (agent) activation policy —
`NSApplicationActivationPolicyAccessory`, i.e. `LSUIElement = 1`.

**Conclusion (hypothesis confirmed):** the overlay was configured correctly and
still could not appear, because Polaris was a **regular** app. The strong
hypothesis in the task was correct.

## 3. The fix

### Where it is applied — and why not in `setup`

```rust
// app/src-tauri/src/lib.rs, in run():
let mut app = tauri::Builder::default()
    ...
    .build(tauri::generate_context!())
    .expect("error while building Polaris");

apply_activation_policy(&mut app);   // <-- before the run loop opens any window

app.run(|app_handle, event| { ... });
```

with

```rust
#[cfg(target_os = "macos")]
fn apply_activation_policy(app: &mut tauri::App) {
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);
}
```

The placement is deliberate and is the part a naive fix gets wrong:

- Tauri builds the `tauri.conf.json` window (**before** the `setup` closure
  runs — `tauri-2.11.5/src/app.rs:2521-2534`). Setting the policy inside `setup`,
  as the Tauri docs' example suggests, happens after the `NSWindow` exists,
  which is too late for the WindowServer to bind its Space behaviour.
- `App::set_activation_policy` (the `App` variant, not `AppHandle`'s) takes the
  `runtime.set_activation_policy` path. At that point the app has not been run
  yet, so this goes through tao's activation-policy **state** and is applied in
  `applicationDidFinishLaunching` — before any window is created. That is the
  correct sequence: policy → window → flags.
- The whole crate is macOS-guarded: the non-macOS `apply_activation_policy` is a
  no-op, so a non-macOS build still compiles (acceptance rule 4).

### What was intentionally left alone

- Window level (`101`) and collection behaviour (`337`) are unchanged — they
  still matter for keeping the overlay on top once the Space is joined.
- The overlay window is still click-through
  (`set_ignore_cursor_events(true)`), still cannot become key (`focusable: false`
  in `tauri.conf.json`), still `show()`s only after configuration. Nothing in
  this change makes the overlay steal focus or activate Polaris.
- Hotkey path untouched: the global shortcut and the `flagsChanged` monitor pair
  do not depend on the activation policy (the Accessibility gate is a separate
  concern). Product change: Polaris no longer shows a Dock icon or app menu bar,
  and becomes harder to Quit from the UI (no menu bar). The overlay is the app's
  only window, so nothing else loses a surface.

## 4. Diagnostics updated

`notch_window_flags` now exposes the policy, read off the **running** app rather
than from config, and the startup line logs it:

```
polaris: notch window flags NotchWindowFlags { level: 101, collection_behavior: 337,
  full_screen_auxiliary: true, can_join_all_spaces: true, focusable: false,
  activation_policy: Accessory }
```

Details:

- New `NotchActivationPolicy` enum (`Regular` / `Accessory` / `Prohibited` /
  `Unknown` / `Unsupported`) and a new `activation_policy` field on
  `NotchWindowFlags`, camelCase like the rest of the crate.
- Read via `NSRunningApplication::currentApplication().activationPolicy()`
  (thread-safe, no main-thread marker needed) inside `configure`, so a single
  pass produces "what the window *and* the app actually are".
- `setup` prints a `WARNING` if the policy is not `Accessory`, so a future
  regression is loud at launch instead of silently visual.
- Non-macOS reports `Unsupported` (the diagnostics command still answers).
- Added the `NSRunningApplication` feature to the pinned `objc2-app-kit` 0.3
  dependency (`NSApplicationActivationPolicy` is exported under that feature;
  version unchanged, so no duplicate objc2 generation is linked).

### New tests (cargo 121/5 → 123/5)

- `the_activation_policy_maps_from_appkit` — the three documented AppKit
  policies map to their names, and an unknown raw value maps to `Unknown`
  rather than being misreported as a real policy.
- `activation_policy_serializes_as_camel_case` — pins the payload spelling
  (`"accessory"`, `"regular"`).

## 5. Verification from the running process

Baseline (unmodified `main`, same worktree tree):

```
polaris: notch window flags NotchWindowFlags { level: 101, collection_behavior: 337,
  full_screen_auxiliary: true, can_join_all_spaces: true, focusable: false }
lsappinfo info <pid>  ->  type="Foreground"
```

After the change, running `app/src-tauri/target/debug/polaris-app`:

```
polaris: notch window flags NotchWindowFlags { level: 101, collection_behavior: 337,
  full_screen_auxiliary: true, can_join_all_spaces: true, focusable: false,
  activation_policy: Accessory }
lsappinfo find pid=<pid> ; lsappinfo info <asn>
    bundle path=".../a15/app/src-tauri/target/debug/polaris-app"
    pid = <pid> ... type="UIElement" ...
```

`type="UIElement"` is the WindowServer's own label for an accessory-policy
process (it replaced `type="Foreground"`). This is independent of our own log
line: the WindowServer agrees the app is now an agent. Geometry is unchanged
from A14 (`179x32` pill, `399x32` shell), so the normal desktop behaves exactly
as before — the policy only adds the layering the overlay was missing.

## 6. What the owner must confirm visually (not claimed here)

**I did not see the overlay.** This worker cannot observe the screen. The
process-level evidence proves the app is now an accessory app with the right
window flags, but the pixel-level claim — *the pill stays visible on the active
Space while another app is fullscreen, without stealing focus* — is the owner's
to confirm:

1. Launch Polaris (`npm run dev` in `app/`), leave it running.
2. Put another app fullscreen (Safari video, QuickTime, Xcode).
3. Confirm the notch pill is visible on that fullscreen Space, and that typing
   still goes to the fullscreen app (Polaris never activates).
4. Press and hold Control+Option to confirm the session still expands in place.

If it still fails, the next thing to check is the activation-policy line in the
startup log — if it does not read `Accessory`, the policy was not applied.

## 7. Cost (product change, as the task asked to state explicitly)

- **Lost:** Dock icon, app menu bar. Polaris is now an `LSUIElement` app.
- **Gained:** windows may layer over other apps' fullscreen Spaces — the
  requested behaviour.
- **Compensating for the lost menu bar:** none yet. There is no menu-bar status
  item (the conventional replacement for overlay utilities). The global hotkey
  and the overlay are the entire surface. Quitting is via `kill`/Activity
  Monitor until a status item or a hotkey-to-quit exists. Flagged as follow-up,
  not as part of this task.

## 8. Acceptance

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm test -w @polaris/app` | 19 passed |
| `npm test -w @polaris/agent` | 109 passed |
| `caffeinate -i cargo test` | **123 passed / 5 ignored** (was 121 / 5) |
| `caffeinate -i cargo clippy --all-targets` | clean |

## Files touched

- `app/src-tauri/src/lib.rs` — `apply_activation_policy` before `run()`
- `app/src-tauri/src/notch.rs` — `NotchActivationPolicy`, `activation_policy`
  field, policy readback, startup warning, two tests, corrected A14 comments
- `app/src-tauri/Cargo.toml` — `NSRunningApplication` feature on `objc2-app-kit`

## Remaining work

- **Owner visual check over a real fullscreen app** — the only unverified claim.
- No menu-bar status item / quit affordance now that the menu bar is gone
  (follow-up, not in task scope).
