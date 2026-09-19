# Modifier-Only Hotkey (Control+Option hold/release) — Implementation Research
- **Date:** 2026-09-19
- **Author/Agent:** research worker (modifier-research)
- **Keywords:** macos, hotkey, modifier-only, flagsChanged, NSEvent, objc2, accessibility, axistrusted, voiceover, tauri, push-to-talk

## Summary

The default Polaris gesture — hold **Control+Option** to record, release **either** modifier to stop — cannot be expressed as a key-code shortcut (`tauri-plugin-global-shortcut` / Carbon `RegisterEventHotKey` needs a non-modifier key). The native path is `NSEvent`'s `flagsChanged` event monitors, exactly as the earlier notch-overlay report proposed. This report verifies that direction down to compile-checked Rust symbols and delivers everything the implementing worker needs: exact `objc2` 0.6 / `objc2-app-kit` 0.3 API names (verified with a throwaway probe crate that runs `cargo check` clean), thread and lifetime rules, permission handling, VoiceOver collision analysis with a concrete debounce recommendation, edge-case recovery, and a fallback recommendation (**keep** Control+Option+Space).

**Bottom line:** the approach is sound and low-risk. Cost is one small new dependency pair (`objc2-app-kit`, `block2`), one `AtomicU64`-style latch plus a hold-timer, an Accessibility-permission gate with graceful degradation, and a 1-second watchdog poll. No CGEvent tap is needed for this MVP.

## 0. Versions verified (do not assume — checked)

From `app/src-tauri/Cargo.lock` in this worktree:

| Crate | Locked version |
|---|---|
| `tauri` | 2.11.5 |
| `objc2` | 0.6.4 |
| `objc2-app-kit` | 0.3.2 |
| `objc2-foundation` | 0.3.2 |
| `block2` | 0.6.2 |

Feature flags (checked in the vendored `objc2-app-kit-0.3.2/Cargo.toml`): `default` enables `std`, `NSEvent`, **and** `block2`. So the implementing worker only needs:

```toml
[dependencies]
objc2-app-kit = "0.3"
block2 = "0.6"
```

with default features — no manual `features = [...]` wiring. (`NSEvent` methods that touch `NSGraphicsContext`/`NSWindow` need extra features; nothing in this report does.)

## 1. The objc2 binding (probe-verified)

A throwaway crate (`/tmp/objc2probe`, **not** committed) depending on the exact locked versions above was used to check every symbol below. The final probe runs `cargo check` **clean**. The authoritative source is the generated binding at `src/generated/NSEvent.rs` in `objc2-app-kit` 0.3.2 (lines ~1165–1188).

### 1.1 Registering the monitors

```rust
use std::ptr::NonNull;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventModifierFlags};

/// Owns both monitor tokens for the whole app lifetime.
pub struct FlagsMonitor {
    _global: Retained<AnyObject>,
    _local: Retained<AnyObject>,
}

pub fn install(on_transition: impl Fn(bool) + Send + Sync + 'static) -> Option<FlagsMonitor> {
    use std::sync::Arc;
    let cb: Arc<dyn Fn(bool) + Send + Sync> = Arc::new(on_transition);

    // --- Global monitor: events delivered to *other* apps. ---
    // Safe fn. Block receives the event by pointer; observe only.
    let weak = Arc::clone(&cb);
    let global_block = RcBlock::new(move |event: NonNull<NSEvent>| {
        let flags = unsafe { event.as_ref() }.modifierFlags();
        weak(pair_down(flags));
    });
    let global = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(
        NSEventMask::FlagsChanged,
        &global_block,
    )?;

    // --- Local monitor: events delivered to *our own* app. ---
    // UNSAFE fn (see 1.2). Block must return the event (possibly replaced).
    let weak = Arc::clone(&cb);
    let local_block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        let flags = unsafe { event.as_ref() }.modifierFlags();
        weak(pair_down(flags));
        // Pass the event through unmodified so the webview keeps working.
        event.as_ptr() as *mut NSEvent
    });
    // SAFETY: we return the same non-null event pointer we received.
    let local = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(
            NSEventMask::FlagsChanged,
            &local_block,
        )
    }?;

    Some(FlagsMonitor { _global: global, _local: local })
}

/// Effective pair state: true only when BOTH Control and Option are down.
fn pair_down(flags: NSEventModifierFlags) -> bool {
    let pair = NSEventModifierFlags::Control.union(NSEventModifierFlags::Option);
    flags.intersection(pair) == pair
}

pub fn remove(m: &FlagsMonitor) {
    // SAFETY: tokens are the live objects AppKit returned; removal is idempotent.
    unsafe { NSEvent::removeMonitor(&m._global) };
    unsafe { NSEvent::removeMonitor(&m._local) };
}
```

Exact upstream signatures for reference (so the implementer can diff, not guess):

```rust
pub fn addGlobalMonitorForEventsMatchingMask_handler(
    mask: NSEventMask,
    block: &block2::DynBlock<dyn Fn(NonNull<NSEvent>)>,
) -> Option<Retained<AnyObject>>;

pub unsafe fn addLocalMonitorForEventsMatchingMask_handler(
    mask: NSEventMask,
    block: &block2::DynBlock<dyn Fn(NonNull<NSEvent>) -> *mut NSEvent>,
) -> Option<Retained<AnyObject>>;

pub unsafe fn removeMonitor(event_monitor: &AnyObject);
```

Notes for the implementer:

- `NSEventMask::FlagsChanged` is `1 << 12` (`NSEventType::FlagsChanged.0 == 12`). Subscribe to **only** this mask — never `KeyDown`/`KeyUp`: a flags-only monitor observes modifier transitions without ever seeing key content, which is the minimum-privilege posture and the easiest permission story to defend to users.
- The global block takes `&block2::DynBlock<...>`; construct it with `block2::RcBlock::new(closure)` and pass `&block`. `RcBlock` is reference-counted and may outlive the registering stack frame, which is what you want — but see 1.3 on the token.
- The local block's return type is `*mut NSEvent`: return the incoming pointer to pass the event through. Returning null would **swallow** the event for our own app (don't do that here).
- `NSEvent::type()` exists (method name is `r#type()` in Rust since `type` is a keyword) and returns `NSEventType`; `NSEventType::FlagsChanged` exists. With a flags-only mask every event *should* be `FlagsChanged`, but defensively filter on `event.r#type() == NSEventType::FlagsChanged` anyway.
- Real-world precedent in Rust: the `fluor` crate installs a global mouse monitor with exactly this `RcBlock::new` + `addGlobalMonitorForEventsMatchingMask_handler` + `Retained<AnyObject>` token pattern, and a public gist/answer shows a global hotkey handler combining `NSEventMask::KeyDown | NSEventMask::FlagsChanged` with `NSEventModifierFlags::{Command, Option, Control, ...}` masking (see Sources). The pattern is proven outside Tauri; inside Tauri it just needs main-thread registration (section 2).

### 1.2 Why the local monitor is `unsafe` (and the global one isn't)

`addLocalMonitor...` hands you an event you may mutate, replace, or drop, so `objc2` marks it `unsafe`: the safety contract is that the returned pointer must be a valid `NSEvent` (or null to swallow). Returning the untouched incoming pointer — as the snippet does — trivially satisfies this; document the `SAFETY:` comment exactly as shown. The global monitor is observe-only, hence a safe fn.

### 1.3 Token lifetime — dropping unregisters

`addGlobalMonitor...` returns `Option<Retained<AnyObject>>` (`nil` → `None` on failure). AppKit keeps delivering events only while that monitor object is alive. Practical rules:

1. Store both tokens in a struct owned for the whole app lifetime (Tauri managed state, e.g. `app.manage(MonitorState { _monitor: Mutex<Option<FlagsMonitor>> })`, or a `static OnceLock<FlagsMonitor>`). **A token dropped on the floor after `setup()` returns silently kills the gesture** — this is the most likely implementation bug; the `fluor` precedent keeps the token as a raw pointer inside a long-lived struct for the same reason.
2. Call `NSEvent::removeMonitor` explicitly at shutdown/teardown (best practice; removal is idempotent).
3. `RcBlock`s are copied by AppKit at registration; the Rust `RcBlock` values themselves may be dropped after the calls return. Only the *tokens* must be retained.

## 2. Thread and lifetime rules

- **Registration should happen on the main thread.** These are AppKit APIs. Tauri exposes exactly the right tool, verified present in the vendored `tauri` 2.11.5 source (`src/app.rs:495` and identical impls on `Window`/`WebviewWindow`):
  ```rust
  pub fn run_on_main_thread<F: FnOnce() + Send + 'static>(&self, f: F) -> crate::Result<()>
  ```
  Pattern: in `tauri::Builder::setup`, clone an `AppHandle`, call `handle.run_on_main_thread(move || { install(...) })`. Note the closure must be `FnOnce() + Send + 'static` — bridge results back over a `std::sync::mpsc` channel or `tauri::async_runtime::spawn`-friendly mutex, not by capturing non-`Send` state.
- **Neither monitor method takes `MainThreadMarker`** (verified in the generated source — no `mtm` parameter), so `objc2` won't *force* main-thread registration at the type level. Register on the main thread anyway: AppKit event infrastructure assumes it, and Tauri's main thread is where the `NSApplication` run loop lives.
- **Callback thread (UNCERTAINTY — flagged, not verified):** Apple's reference page for `addGlobalMonitorForEvents(matching:handler:)` does not state the delivery thread in the text I could retrieve. The universally observed behavior is that monitor blocks run on the **main thread**. The implementer must not rely on memory here: log/assert the thread id (`std::thread::current().id` vs. known main-thread id) in the first debug build, and in any case do *minimal* work in the block — compute `pair_down`, push a timestamped `bool` into a lock-free queue / `mpsc` channel, and let the recorder state machine (with the hold-timer from section 5) run outside the callback.
- **Where to create/store:** create once in `setup()`; store tokens in Tauri managed state so they live until app exit. Never create per-window or per-recording — registration is process-global.

## 3. Reading the modifier state

### 3.1 Constants (verified in generated source)

```text
NSEventModifierFlags::CapsLock = 1 << 16
NSEventModifierFlags::Shift    = 1 << 17
NSEventModifierFlags::Control  = 1 << 18   // the "Control" key
NSEventModifierFlags::Option   = 1 << 19   // the "Option/Alt" key (AppKit name is Option, NOT Alternate)
NSEventModifierFlags::Command  = 1 << 20
NSEventModifierFlags::NumericPad = 1 << 21
NSEventModifierFlags::Help     = 1 << 22
NSEventModifierFlags::Function = 1 << 23
NSEventModifierFlags::DeviceIndependentFlagsMask = 0xffff0000
```

AppKit naming trap, stated explicitly: **Control = "control", Option = "alternate/option"**. In the modern `NSEventModifierFlags` API the constant is `Option` (`NSEventModifierFlagOption`); the older Carbon/alias name for the same bit is `NSAlternateKeyMask`. There is no `Alternate` constant in `objc2-app-kit` 0.3 — anyone writing `NSEventModifierFlags::Alternate` will get a compile error; the correct symbol is `::Option`.

### 3.2 The `deviceIndependentFlagsMask` caveat

`modifierFlags` returns device-dependent bits in the low 16 bits (vendor/keyboard-specific). Apple's long-standing guidance is to mask with `deviceIndependentFlagsMask` (`0xffff0000`) before interpreting. In practice the pairwise test in 1.1 is unaffected (Control/Option live in the high word), but:

- the **watchdog poll** (section 6) should compare `NSEvent::modifierFlags_class() & DeviceIndependentFlagsMask` — the class method `modifierFlags_class` (ObjC `+modifierFlags`, the current global state) was probe-verified to exist;
- never persist or compare raw `bits()` values across machines without masking.

### 3.3 Latch logic (debounce by state, not by count)

`flagsChanged` fires once per modifier transition, with coalescing quirks (rapid press/release can merge; left/right modifiers of the same kind produce separate events). So: **never count events**. Keep `pair_down: bool` (or the last masked flags word) and emit transitions only on *change of the effective pair state*:

```text
on flagsChanged(flags):
    now = controlDown(flags) && optionDown(flags)
    if now != pair_down: pair_down = now; notify(now, timestamp)
```

Starting on the first event where both are true and stopping when either goes false gives exactly the required hold/release semantics, immune to duplicate or merged events.

## 4. Accessibility permission

### 4.1 Yes — a `flagsChanged` global monitor requires Accessibility trust

Apple's reference for `addGlobalMonitorForEvents(matching:handler:)` states it directly (Discussion section):

> "Key-related events may only be monitored if accessibility is enabled or if your application is trusted for accessibility access (see `AXIsProcessTrusted`)."

`NSFlagsChanged` appears in the same page's list of monitorable event types, so the requirement covers our flags-only monitor. The **local** monitor (events delivered to our own app) needs no permission — which is why the gesture will appear to "half work" (fires only while our own window is focused) when trust is missing. The implementer should use that asymmetry deliberately: local-only activity with a dead global monitor is the *signal* to show the permission prompt, not a bug to chase.

### 4.2 Check, prompt, and degrade

```rust
// Standard pattern: direct extern declarations against ApplicationServices.
// (No first-party objc2 wrapper is used here; this is the minimal stable ABI.)
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const std::ffi::c_void) -> bool;
}

pub fn is_trusted() -> bool {
    // SAFETY: AXIsProcessTrusted takes no arguments and is always safe to call.
    unsafe { AXIsProcessTrusted() }
}
```

- **Silent check** (every launch, before installing the global monitor): `AXIsProcessTrusted()`.
- **Prompt** (only from a user-visible action, e.g. clicking "Enable system-wide hotkey" or first attempting the gesture): `AXIsProcessTrustedWithOptions` with `{ kAXTrustedCheckOptionPrompt: kCFBooleanTrue }`. Per the header docs, prompting is asynchronous and does not affect the return value — **poll** `AXIsProcessTrusted()` afterwards (e.g. on window focus / a 2 s timer for ~30 s) rather than trusting the prompt call's return.
- Recommended UX when untrusted: (1) keep the app fully working with the fallback shortcut (section 7); (2) show a persistent, non-modal notch/panel hint "Hold-to-talk needs Accessibility access — [Open Settings]" deep-linking to `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`; (3) never block startup, never crash, never spin. Re-check trust on app focus and enable the global monitor the moment it flips true.
- **UNCERTAINTY (minor):** I did not verify whether `addGlobalMonitor...` returns `nil` or a dead-but-non-nil token when untrusted. The implementer must treat `is_trusted() == false` as the source of truth, not the `Option` from registration.

### 4.3 Info.plist / entitlements

**No Info.plist usage-description key is needed** for Accessibility monitoring (unlike camera/microphone, which do need `NSMicrophoneUsageDescription` etc.). Accessibility consent is a TCC (Transparency, Consent, Control) record managed in System Settings → Privacy & Security → Accessibility; the app binary's code signature identifies it. Two corollaries: during development the *actual binary* (not the IDE) needs the TCC entry, so test from a signed bundle; and keep the app **unsandboxed** (Developer-ID distribution, as planned) — sandboxed apps have a documented history of the `AXIsProcessTrustedWithOptions` prompt silently not appearing.

## 5. False-trigger risk (Control+Option collisions)

### 5.1 The big one: VoiceOver

Apple Support documents that **the default VoiceOver modifier (VO keys) is Control+Option held together** (alternatively Caps Lock). A VoiceOver user therefore holds exactly our gesture *constantly* while navigating, including VO+key chords. This is not a theoretical collision — it is the single largest false-trigger source, and it affects users who most need voice input to work well.

Other overlaps: some IDE/launcher shortcuts and CJK input-source chords pass through Control+Option transiently; Karabiner-style remappers often synthesize the pair.

### 5.2 Mitigations (all three, in combination)

1. **Minimum hold duration before arming — recommended 300 ms.** Rationale: transient pass-through of the pair inside someone else's shortcut chord lasts tens of milliseconds (typical inter-key timing < 150 ms even for slow typists); an intentional push-to-talk hold is comfortably ≥ 300 ms. 300 ms sits below the ~400 ms threshold where PTT starts feeling laggy, and matches common PTT products (200–500 ms arming delays). Concretely: on pair-down, start a 300 ms timer; begin capture only if the pair is *still* down when it fires; discard holds shorter than this as taps/chords. Make the value a constant (`ARM_DELAY_MS = 300`) so it can be tuned or exposed in Settings later.
2. **Cancel on any other activity.** While armed-or-recording, cancel/discard on: any `keyDown`/`keyUp` from the global monitor is *not* subscribed (flags-only mask), so instead cancel when (a) Command or Shift becomes held alongside the pair (`flags & (Command|Shift) != 0` → ignore the gesture entirely — real PTT holds never include them), or (b) any local key event arrives in our own window mid-hold. VoiceOver chords (VO+letter) always involve a third keypress in the front app; combined with the 300 ms gate this rejects the vast majority of VO traffic. Full separation from an *active* VoiceOver session (VO user holding the pair with no third key yet) is impossible at the event level — accept this and rely on mitigation 3.
3. **Escape hatches, not cleverness.** Ship a visible toggle ("Hold-to-talk gesture: on/off") plus the fallback shortcut (section 7), and consider auto-suggesting the fallback when we observe > N discarded sub-300 ms pair presses per minute (a signature of shortcut-chord traffic, e.g. a VoiceOver session). Do not try to detect VoiceOver process state — fragile and unnecessary.

Net assessment: with the 300 ms gate + Command/Shift exclusion + any-key cancellation, accidental *recordings* become rare (they require a deliberate-feeling 300 ms+ bare hold); accidental *arming attempts* may still occur for VoiceOver users, which is why the gesture must be disable-able and the fallback first-class.

## 6. Edge cases and recovery

| # | Case | Behavior | Handling |
|---|---|---|---|
| 1 | Modifier released while app not frontmost | Global monitor still fires (it observes other apps) — release is caught normally. | No action; this is the happy path the global monitor exists for. |
| 2 | Screen lock / sleep mid-hold | No `flagsChanged` release is delivered; latch would stick "recording". | Subscribe to `NSWorkspace` sleep/will-sleep + distributed `com.apple.screenIsLocked` notifications → **force-stop and discard** the in-progress capture. Also force-stop on `applicationWillResignActive`→screensaver. Never auto-send a truncated capture. |
| 3 | Space / fullscreen-app switch mid-hold | Modifiers usually survive the switch; if the user releases over a fullscreen app the global monitor still sees it. | No special handling; watchdog (below) covers the pathological case. Keep overlay behavior unchanged (existing A0 decision). |
| 4 | Missed event → stuck latch (recording forever) | Coalesced/dropped events, monitor re-registration races. | **Watchdog:** every 1 s, compare `NSEvent::modifierFlags_class() & DeviceIndependentFlagsMask` against the latch; on mismatch, snap the latch to ground truth and stop recording if the pair is broken. This is cheap (one class call per second) and closes every stuck-state hole at once. |
| 5 | Secure-input fields (password prompts) | macOS may suppress global key-event delivery while Secure Input is on. **Unverified for `flagsChanged` specifically** — assume releases can go missing there. | Watchdog (case 4) is the backstop; additionally force-stop on front-app change to a Secure-Input context if cheaply detectable, else do nothing. Flagged for the implementer to test with a password dialog. |
| 6 | Left vs right modifiers, rapid re-press | Separate `flagsChanged` events per side; key repeat never applies to modifiers. | State-based latch (3.3) is inherently immune. Do not track sides separately. |
| 7 | Accessibility revoked mid-session | Global monitor goes silent; latch freezes. | Re-check `AXIsProcessTrusted()` on app focus and in the watchdog tick; on revocation, tear down to fallback mode (section 7) and re-show the permission hint. |
| 8 | Monitor registration returns `None` | AppKit refused (early boot, TCC database locked, etc.). | Log, fall back to shortcut-only mode, retry on next focus/launch. Never crash. |

Watchdog pseudocode (runs on a 1 s timer, main thread):

```rust
let live = NSEvent::modifierFlags_class()
    .intersection(NSEventModifierFlags::DeviceIndependentFlagsMask);
let pair = NSEventModifierFlags::Control.union(NSEventModifierFlags::Option);
let now = live.intersection(pair) == pair;
if now != latch.pair_down { latch.pair_down = now; notify(now); } // heals stuck latch
if !is_trusted() { enter_fallback_mode(); }
```

## 7. Fallback — keep the key-code shortcut (recommendation: YES, unequivocally)

**Keep Control+Option+Space registered via `tauri-plugin-global-shortcut` as a permanent secondary trigger**, for four independent reasons:

1. **Permission-denied path.** Without Accessibility trust the modifier-only gesture is dead by design (section 4). The shortcut works with zero permissions and is the entire UX until the user grants trust.
2. **VoiceOver users.** For the population most likely to collide with the bare pair (section 5), a three-key shortcut that never collides with VO chords is the accessible alternative — removing it would actively harm the users most sensitive to the collision.
3. **Reliability floor.** Carbon `RegisterEventHotKey` delivery is synchronous and battle-tested; the flags monitor is observation-async and subject to coalescing. During any monitor outage (section 6), the shortcut keeps PTT alive.
4. **Zero marginal cost.** Step A0 already builds it; keeping the registration is a few lines and one documented shortcut.

 both triggers should feed the **same** recorder state machine (start idempotent while recording; either release path stops). Document Control+Option+Space in the UI as the always-available alternative, not as a deprecated legacy.

## 8. Suggested implementation order for the worker

1. Add `objc2-app-kit = "0.3"` + `block2 = "0.6"`; port the section-1 snippet into a `hotkey_flags.rs` module (no Tauri wiring yet) — reuse `/tmp/objc2probe` as the compile oracle if needed (recreate; it was intentionally not committed).
2. Wire `install`/`remove` behind `run_on_main_thread` in `setup()`; store tokens in managed state; forward transitions over `mpsc` into the existing A0 recorder events (`hotkey down/up`).
3. Add the 300 ms arm timer + Command/Shift exclusion + state latch (sections 3.3, 5).
4. Add the AX gate + Settings deep-link UI (section 4); keep the A0 shortcut as fallback (section 7).
5. Add watchdog + sleep/lock force-stop (section 6); test matrix: unit (latch transitions), manual (VoiceOver on/off, password dialog, sleep, Space switch, permission revoked).

## Sources

### Apple documentation (primary)
- `NSEvent.addGlobalMonitorForEvents(matching:handler:)` — global observation, Accessibility requirement for key-related events, "handler not called for events sent to your own application" (hence the local monitor): https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents(matching:handler:) (retrieved as Markdown 2026-09-19; Discussion section quoted verbatim in 4.1)
- `NSEvent.EventTypeMask` / `NSFlagsChanged` in the monitorable-types list (same page, Special Considerations)
- `kAXTrustedCheckOptionPrompt` constant: https://developer.apple.com/documentation/applicationservices/kaxtrustedcheckoptionprompt?changes_2=&language=objc
- `AXUIElement.h` header text for `AXIsProcessTrustedWithOptions` semantics (prompt is async, doesn't affect return value) — via SDK mirror and https://gertrude.app/blog/macos-request-accessibility-control
- VoiceOver modifier defaults to Control+Option: https://support.apple.com/guide/voiceover/control-your-mac-with-keyboard-commands-vo2681/mac and https://support.apple.com/guide/voiceover/general-commands-cpvokys01/mac ("By default, you can press Control and Option together or just press Caps Lock")

### objc2 / docs.rs (primary, version-pinned)
- `NSEvent` struct, `addGlobalMonitorForEventsMatchingMask_handler` (safe) / `addLocalMonitorForEventsMatchingMask_handler` (`unsafe`) / `removeMonitor` signatures — https://docs.rs/objc2-app-kit/0.3.2/objc2_app_kit/struct.NSEvent.html and generated source `src/generated/NSEvent.rs:1165–1188` in the vendored crate
- `NSEventMask::FlagsChanged` (`1 << NSEventType::FlagsChanged.0`, type value 12) — https://docs.rs/objc2-app-kit/0.3.2/objc2_app_kit/struct.NSEventMask.html and generated source lines 43–44, 222–223
- `NSEventModifierFlags::{Control = 1<<18, Option = 1<<19, DeviceIndependentFlagsMask = 0xffff0000}` — https://docs.rs/objc2-app-kit/0.3.2/objc2_app_kit/struct.NSEventModifierFlags.html and generated source lines 383–406
- Crate features (`default` ⊇ `NSEvent`, `block2`, `std`) — vendored `objc2-app-kit-0.3.2/Cargo.toml`
- `block2::RcBlock` / `DynBlock` — https://docs.rs/block2/0.6.2/

### Real open-source Rust code doing the same thing
- `fluor` 0.0.3 `src/host/macos_hittest.rs` — global `NSEvent` mouse monitor via `RcBlock::new` + `addGlobalMonitorForEventsMatchingMask_handler`, token kept as long-lived raw pointer: https://docs.rs/crate/fluor/latest/source/src/host/macos_hittest.rs
- StackOverflow 2026-04-22, "How to consume a keyboard event for a global hotkey in macos" — `RcBlock`-based global handler with `NSEventMask::KeyDown | NSEventMask::FlagsChanged` and `NSEventModifierFlags` masking, plus `ensure_accessibility_permission()` gating: https://stackoverflow.com/questions/79929981/how-to-consume-a-keyboard-event-for-a-global-hotkey-in-macos
- `Augani/kael` commit `9f5c54f` — `cocoa` → `objc2-app-kit` migration notes incl. `NSAlternateKeyMask → NSEventModifierFlags::Option` rename table and `event.r#type()` / `modifierFlags()` method mapping: https://github.com/Augani/kael/commit/9f5c54f1363e2e23b1e0e6dead0444c2c9816c07

### Tauri
- `AppHandle::run_on_main_thread` (`FnOnce() + Send + 'static -> Result<()>`) — verified in vendored `tauri-2.11.5/src/app.rs:495` (also `window/mod.rs`, `webview/*`); public docs at https://v2.tauri.app/ and https://docs.rs/tauri/2.11.5/
- `tauri-plugin-global-shortcut` (Carbon `RegisterEventHotKey` Pressed/Released backend for the fallback) — https://v2.tauri.app/plugin/global-shortcut/

### Prior repo research (context, not re-cited as authority)
- `docs/reports/2026-09-19-notch-overlay-research.md` (branch `origin/codex/notch-research`), section "Hotkey and permissions" — direction confirmed and hardened by this report.

## Known uncertainties (for the implementing worker, not hidden)

1. **Callback delivery thread** — Apple reference text retrieved does not state it; assumed main thread. Assert at runtime in debug builds.
2. **Token value when untrusted** — unknown whether registration returns `None` or a silent dead monitor. Gate on `AXIsProcessTrusted()`, not on the `Option`.
3. **`flagsChanged` under Secure Input** — presumed possibly suppressed; covered by watchdog, verify manually with a password dialog.
4. **AX extern declarations** — the two-function `#[link(name = "ApplicationServices")]` block is the standard minimal pattern but was *not* compile-checked in the probe (AppKit-only probe). Check it in the implementing branch.
