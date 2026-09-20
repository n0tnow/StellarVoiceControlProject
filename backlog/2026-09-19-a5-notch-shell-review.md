# Review: A5 — Notch shell: named expansion states + hover-driven expansion

- **Date:** 2026-09-19
- **Reviewer:** Independent Reviewer (Task A5)
- **Branch:** `review/a5` (evaluating diff `e0292ba..HEAD`, identical to `feat/a5-notch-shell`)
- **Verdict:** **REJECT**

---

## Executive Summary

Task A5 attempts to replace the two-state notch overlay with a data-driven named-state system (`collapsed`, `compact`, `panel`), introduce global/local `mouseMoved` monitoring, and dynamically toggle click-through interactivity.

While the pure coordinate arithmetic and type definitions are clean, the runtime implementation contains **critical safety flaws that can cause the overlay window to permanently intercept user mouse clicks on other applications and blind the safety watchdog**. Furthermore, the fallback commit mechanism in the React reducer is fundamentally broken under `prefers-reduced-motion` and lost transition events, display topology polling can distort the window into a multi-thousand-pixel rectangle spanning across monitors, and AppKit thread-safety rules are repeatedly violated.

---

## Findings Ranked by Severity

### MAJOR-1: Stationary cursor blinds the 1.5s click-through watchdog
- **Location:** [`app/src-tauri/src/notch.rs:491`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L491), [`app/src-tauri/src/notch.rs:509-516`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L509-L516), [`app/src-tauri/src/notch/hover.rs:90-114`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L90-L114)
- **Failure Scenario:**
  1. User triggers expansion to `panel` (e.g., hover or programmatically). `shell_request_state("panel")` calls `runtime.set_active(2)`.
  2. At `notch.rs:491`, `set_active` explicitly sets `rt.outside_since = None`.
  3. The user stops moving the physical mouse (or flings the mouse off-screen/below the window before `set_active` finishes).
  4. Because the mouse is stationary, macOS generates no `mouseMoved` events.
  5. `observe_cursor` is never invoked, so `outside_since` remains `None`.
  6. The watchdog thread wakes up every 250 ms and calls `runtime.outside_for_longer_than(WATCHDOG_GRACE)`. Because `rt.outside_since` is `None`, `is_some_and(...)` evaluates to `false`.
  7. The watchdog **never fires**, even though the cursor is outside the shell and the native window is non-click-through (`interactive = true`). The overlay permanently eats user clicks intended for desktop apps underneath.
  8. *Root cause:* The watchdog passively inspects cached event state rather than actively polling `NSEvent::mouseLocation()` (which is thread-safe in AppKit) during its tick.

---

### MAJOR-2: Rapid state flapping causes out-of-order interactivity toggles and watchdog bypass
- **Location:** [`app/src-tauri/src/notch.rs:662-681`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L662-L681), [`app/src-tauri/src/notch.rs:711-718`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L711-L718)
- **Failure Scenario:**
  1. Fast cursor movement over the notch causes React to schedule `shell_request_state("panel")` followed immediately by `shell_request_state("collapsed")`.
  2. `shell_request_state` is an async command spawned onto Tokio worker threads.
  3. `request("panel")` executes `on_main`, setting `rt.active_index = 2` (`interactive = true`).
  4. `request("collapsed")` executes `on_main`, setting `rt.active_index = 0` (`interactive = false`).
  5. `request("collapsed")` calls `apply_interactivity(false)` (`set_ignore_cursor_events(true)`).
  6. `request("panel")` finishes its await and subsequently calls `apply_interactivity(state.interactive)` -> `apply_interactivity(true)` (`set_ignore_cursor_events(false)`).
  7. The OS window is now **NOT click-through**, but `runtime.interactive` is `false`!
  8. When the watchdog checks `runtime.outside_for_longer_than`, `rt.interactive` is `false`, so the watchdog believes the overlay is inert and **never restores click-through**. Clicks across the window frame are swallowed indefinitely.

---

### MAJOR-3: Cancelled state transitions in `useShellState` leave the native window stranded
- **Location:** [`app/src/notch/useShellState.ts:155-171`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L155-L171)
- **Failure Scenario:**
  1. The reducer resolves `target = "panel"`. The effect runs `requestShellState("panel")`.
  2. Before the IPC call resolves, the hover/voice condition drops, resolving `target = "collapsed"`.
  3. The effect cleanup sets `cancelled = true`.
  4. When `requestShellState("panel")` resolves in the webview, `if (!cancelled)` evaluates to `false`; `setApplied("panel")` is skipped.
  5. In React, `target` is `"collapsed"` and `applied` is `"collapsed"`. Because `target === applied`, no subsequent effect or commit is ever triggered.
  6. However, Rust already resized the window to the panel size and applied `set_ignore_cursor_events(false)`.
  7. If the cursor is stationary inside the cutout, the watchdog never fires. The native overlay remains non-click-through and oversized while React believes it is collapsed.

---

### MAJOR-4: Fallback commit timer is cancelled when `target === applied`, breaking `prefers-reduced-motion`
- **Location:** [`app/src/notch/useShellState.ts:176-181`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L176-L181)
- **Failure Scenario:**
  1. The author designed Effect 2 as a guarantee: *"transitionend is the fast path; this timer is the guarantee (reduced motion has no transition event at all, and a lost event must never leave the OS window oversized)."*
  2. However, Effect 2 guards with `if (target === applied) return;` and depends on `[target, applied]`.
  3. When `target` changes to `"panel"` while `applied` is `"collapsed"`, a timer is scheduled.
  4. As soon as `requestShellState` finishes (typically < 10 ms), `setApplied("panel")` is called.
  5. The effect cleanup immediately runs `clearTimeout(timer)`, **cancelling the scheduled timer**.
  6. On the re-render with `applied = "panel"`, `target === applied` is `true`. The effect **returns immediately without scheduling any timer**.
  7. When `prefers-reduced-motion: reduce` is enabled, CSS transitions are disabled (`transition: none`), meaning no `transitionend` event ever fires.
  8. `shell_commit_state` is **never called**. The OS window remains stuck at `grow_union` dimensions forever.

---

### MAJOR-5: Display topology polling distorts window frame across multiple monitors via `grow_union`
- **Location:** [`app/src-tauri/src/notch.rs:648-653`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L648-L653), [`app/src-tauri/src/notch.rs:369-380`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L369-L380)
- **Failure Scenario:**
  1. `App.tsx` polls `notch_geometry` every 2000 ms via `setInterval`.
  2. In `notch_geometry`:
     ```rust
     let current = window::frame(&frame_handle)?;
     window::set_frame(&frame_handle, grow_union(current, target))?;
     ```
  3. If an external display is plugged in, unplugged, or display arrangement changes, the notched display origin may shift (e.g. from `x = 0` to `x = 1920`).
  4. `current` has `x = 342, width = 827`. `target` has `x = 2262, width = 827`.
  5. `grow_union` computes:
     - `left = 342`
     - `right = 2262 + 827 = 3089`
     - `width = 3089 - 342 = 2747 pt`
  6. The native window is resized to a **2,747 pt wide monster rectangle spanning multiple physical screens**.
  7. Because periodic polling does not trigger any CSS transition or state change in React, `shell_commit_state` is never called. The window remains distorted across screens until manual intervention.

---

### MAJOR-6: Unsound AppKit threading and unchecked raw pointer dereferencing
- **Location:** [`app/src-tauri/src/notch.rs:711-718`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L711-L718), [`app/src-tauri/src/notch.rs:610-615`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L610-L615), [`app/src-tauri/src/notch/window.rs:83, 103, 127`](file:///Users/fatih/SturiVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/window.rs#L83)
- **Failure Scenario:**
  1. `apply_interactivity` calls `window.set_ignore_cursor_events(!interactive)` directly on Tokio worker threads.
  2. `force_click_through` calls `window.set_ignore_cursor_events(true)` directly on the background watchdog thread (`polaris-hover-watchdog`).
  3. In `window.rs`, `apply_style`, `frame`, and `set_frame` do not verify `MainThreadMarker` (unlike `measure`).
  4. `let native = unsafe { &*raw.cast::<NSWindow>() };` assumes `raw` is non-null. If Tauri fails to retrieve the window or if it has been destroyed, dereferencing `raw` is undefined behavior (segfault).

---

### MAJOR-7: Monitor leaks on window close and leaked `AnyObject` retain counts in objc2
- **Location:** [`app/src-tauri/src/lib.rs:103-107`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/lib.rs#L103-L107), [`app/src-tauri/src/notch/hover.rs:182-187, 190-201`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L182-L201)
- **Failure Scenario:**
  1. In `lib.rs`:
     ```rust
     tauri::RunEvent::WindowEvent {
         event: tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed,
         ..
     } => notch::force_click_through(app_handle),
     ```
     `hover::teardown` is **not** called on window destruction. The global and local `mouseMoved` monitors remain active in AppKit, continuing to invoke `observe` on every cursor movement across macOS for a destroyed window.
  2. In `hover.rs`, `Retained::into_raw(global)` increments/transfers the retain count. In `platform::remove`, `NSEvent::removeMonitor` is called, but the retained pointers are never balanced with `Retained::from_raw(...)`, leaking the monitor tokens. Furthermore, `HoverMonitor` does not implement `Drop`.

---

### MINOR-1: Ready and Error dwell timers lock out hover expansion for up to 6 seconds
- **Location:** [`app/src/App.tsx:190-203, 275-281`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/App.tsx#L190-L203), [`app/src/notch/useShellState.ts:46-56`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L46-L56)
- **Failure Scenario:**
  After recording finishes, `App.tsx` remains in `ready` for `READY_DWELL_MS` (6,000 ms), during which `voiceState` is `"compact"`. Because `voice` has strict precedence over `hover` in `resolveShellState`, hovering the notch during these 6 seconds is completely ignored. If the user leaves their mouse over the notch, the panel suddenly pops open when the 6-second timer expires.

---

### MINOR-2: Triple `transitionend` events fire on every state transition
- **Location:** [`app/src/index.css:107-111`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/index.css#L107-L111), [`app/src/notch/useShellState.ts:183-190`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L183-L190)
- **Failure Scenario:**
  `.notch` transitions three CSS properties simultaneously on `event.currentTarget`: `width`, `height`, and `border-radius`. Each transition completion emits a distinct `transitionend` event. `onTransitionEnd` filters out child elements (`event.target !== event.currentTarget`), but fires 3 separate IPC `commitShellState` invocations for every transition.

---

### MINOR-3: Extensibility claim ("one table row + one CSS block") is false
- **Location:** [`app/src-tauri/src/notch.rs:139, 384-406`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L139), [`interfaces/src/index.ts:160-198`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/interfaces/src/index.ts#L160-L198), [`app/src/notch/useShellState.ts:33`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L33)
- **Failure Scenario:**
  Adding a new named state actually requires:
  1. Modifying the fixed array signature `SHELL_STATES: [ShellStateSpec; 3]` in `notch.rs`.
  2. Rewriting compile-time asserts in `notch.rs:384-406` (which hardcode indices 0, 1, 2 and assert `!SHELL_STATES[1].interactive && SHELL_STATES[2].interactive`).
  3. Modifying the TypeScript union `export type ShellStateName = "collapsed" | "compact" | "panel"`.
  4. Updating `FALLBACK_SHELL_GEOMETRY` in `interfaces/src/index.ts`.
  5. Updating unit tests asserting single-interactive-state and array length.

---

### MINOR-4: Unit test suite only verifies trivial arithmetic
- **Location:** [`app/src-tauri/src/notch.rs:758-963`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L758-L963)
- **Failure Scenario:**
  All 13 tests in `notch.rs` cover pure mathematical helper functions (`ShellDim::resolve`, `radii_for`, `grow_union`, `window_origin_x`). Not a single test verifies:
  - Watchdog execution on a background thread with stationary cursor or mouse drag.
  - Asynchronous IPC race conditions between `shell_request_state` and `shell_commit_state`.
  - Display topology transitions.
  - React reducer state transitions (`useShellState.ts` has zero automated tests).

---

### MINOR-5: Missing mouse drag masks in NSEvent monitors
- **Location:** [`app/src-tauri/src/notch/hover.rs:151, 170`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L151)
- **Failure Scenario:**
  Monitors only listen for `NSEventMask::MouseMoved`. On macOS, dragging with any mouse button pressed emits `NSEventMaskLeftMouseDragged` / `RightMouseDragged`, not `MouseMoved`. If a user clicks inside the panel and drags outside, no hover-exit event is received.

---

## What Was Verified as Correct

1. **Pure Geometry Derivation:** `ShellDim::resolve`, `radii_for`, and `shell_rect` pure mathematical implementations correctly compute AppKit points from display metrics.
2. **Display Centering Formula:** Centering based on `auxiliaryTopLeftArea` and `auxiliaryTopRightArea` properly identifies the hardware notch center on notched displays.
3. **Type Compilation:** `npx tsc -p app/tsconfig.json` and `npx tsc -p interfaces/tsconfig.json` compile with zero errors; TypeScript interfaces match Rust serde camelCase outputs.
4. **Unit Tests Passing:** `cargo test --manifest-path app/src-tauri/Cargo.toml` runs 104 tests cleanly without failures.
5. **Mutex Poison Recovery:** `ShellRuntime::lock()` correctly handles `PoisonError::into_inner` to prevent deadlocks following an unwound thread.

---

## Conclusion & Recommendation

The branch `feat/a5-notch-shell` must be **REJECTED**. The click-through safety net is the foundational contract of the notch overlay; as implemented, multiple real-world scenarios cause the overlay to permanently hijack desktop mouse events without recovery from the watchdog.

Before merging, the following fixes are mandatory:
1. Active cursor polling via `NSEvent::mouseLocation()` inside the watchdog loop.
2. Synchronous main-thread execution of `apply_interactivity` bound directly to the runtime lock to eliminate Tokio race conditions.
3. Overhaul of `useShellState.ts` to guarantee fallback commits on reduced-motion and cancelled transitions.
4. Bounding display geometry polls to prevent multi-monitor `grow_union` explosion.
5. Proper teardown of `NSEvent` monitors on window close and balance of objc2 retained pointers.

---

## Round 2 re-review

- **Date:** 2026-09-19
- **Reviewer:** Independent Reviewer (Task A5)
- **Branch:** `review/a5` (evaluating fix diff `816332f..HEAD`, identical to `feat/a5-notch-shell`)
- **Verdict:** **APPROVE**

### Round 2 Summary

The author has addressed all concerns raised in Round 1 with rigorous, high-quality engineering. The core vulnerability—the click-through safety net failing and permanently hijacking desktop input—has been thoroughly eliminated:

1. The watchdog no longer relies on passive event streaming; it actively polls cursor coordinates via `NSEvent::mouseLocation()` on every tick, guaranteeing recovery even for a completely stationary mouse outside the shell.
2. Native click-through toggles are serialized onto AppKit's main thread and consolidated behind a single guarded writer (`sync_native_interactivity`), eliminating Tokio async race conditions.
3. `useShellState.ts` now uses a generation counter and an unconditional completion `settle` counter, guaranteeing that `shell_commit_state` is dispatched under `prefers-reduced-motion`, lost responses, and rapid A->B->A flap sequences.
4. Multi-monitor display topology changes now snap to the target frame rather than calculating an unbounded `grow_union` across monitors.
5. AppKit pointer safety and event monitor teardown have been rectified with proper `MainThreadMarker` checks, null guards, `Retained` ownership, and run-loop teardown on window destruction.

An audit for newly introduced defects (deadlocks, lock contention across threads, `Drop` off-thread, polling overhead, and reducer feedback loops) turned up no regressions. All automated suites (`cargo clippy`, `cargo test`, `node --test`, TypeScript `tsc`, and Vite production build) are fully green.

---

### Detailed Findings Audit (Diff `816332f..HEAD`)

#### MAJOR-1: Stationary cursor blinds the 1.5s click-through watchdog
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch/hover.rs:133-146`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L133-L146), [`app/src-tauri/src/notch/hover.rs:236-241`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L236-L241), [`app/src-tauri/src/notch.rs:589-608`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L589-L608), [`app/src-tauri/src/notch.rs:1110-1144`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1110-L1144)
- **Trace Analysis:**
  The background watchdog thread (`polaris-hover-watchdog`) wakes every 250 ms (`WATCHDOG_TICK`). On each tick, it actively invokes `platform::cursor_location()` (`NSEvent::mouseLocation()`), obtaining real AppKit screen coordinates regardless of whether physical cursor movement generated an OS event. It passes these coordinates into `runtime.watchdog_decision(x, y, now, WATCHDOG_GRACE)`.
  Inside `watchdog_decision`, if the cursor is outside the active shell rectangle, `rt.track_outside(false, now)` initializes `outside_since = Some(now)` on the first sample and preserves the timestamp on subsequent samples. Once `since.elapsed() >= WATCHDOG_GRACE` (1.5 s), `watchdog_decision` returns `true`. The watchdog triggers `force_click_through(&app)` and sets `forcing = true` to suppress duplicate log messages while the main-thread collapse executes. Crucially, `watchdog_decision` leaves `last_inside` untouched, ensuring that background sampling never suppresses legitimate hover transition edges. Covered by unit test `watchdog_polls_a_stationary_cursor_instead_of_waiting_for_a_move`.

---

#### MAJOR-2: Rapid state flapping causes out-of-order interactivity toggles and watchdog bypass
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch.rs:776-784`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L776-L784), [`app/src-tauri/src/notch.rs:822-844`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L822-L844), [`app/src-tauri/src/notch.rs:852-868`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L852-L868), [`app/src-tauri/src/notch.rs:1207-1227`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1207-L1227)
- **Trace Analysis:**
  There is now exactly one function that drives the native `ignoresMouseEvents` state: `sync_native_interactivity`. It directly reads `runtime.is_interactive()`, writes `window::set_ignore_cursor_events(app, !interactive)`, and logs the write via `runtime.note_native_interactive(interactive)`.
  Both `shell_request_state` and `shell_commit_state` dispatch their entire operation onto the AppKit main thread via `on_main`. In `shell_request_state`, the runtime state mutation (`set_active`), the frame expansion (`window::set_frame`), and the native interactivity synchronization (`sync_native_interactivity`) occur synchronously within the same main-thread task. Because commands are sequenced on the main run loop, a late-resolving async request cannot re-enable click-eating out of order. Furthermore, `shell_commit_state` uses `runtime.resolve_commit(&request)`, which rejects stale commit requests if the active state has changed. Covered by unit tests `commit_is_ignored_until_the_matching_state_is_active` and `native_interactivity_log_matches_the_guarded_state`.

---

#### MAJOR-3 & MAJOR-4: Cancelled requests or `prefers-reduced-motion` stranding the window
- **Status:** **FIXED**
- **Evidence:** [`app/src/notch/useShellState.ts:51-64`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L51-L64), [`app/src/notch/useShellState.ts:133-143`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L133-L143), [`app/src/notch/useShellState.ts:154-171`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L154-L171), [`app/src/notch/useShellState.ts:178-182`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L178-L182)
- **Trace Analysis:**
  The request and commit lifecycle in `useShellState.ts` was redesigned around a monotonic `generation` ref and a `settle` counter:
  - **Rapid A -> B -> A Flap:** When `target` transitions from `"collapsed"` (A) to `"panel"` (B), `useEffect([target])` increments `generation.current` (1) and dispatches `requestShellState("panel")`. If the target rapidly flips back to `"collapsed"` (A) before response 1 resolves, effect cleanup marks response 1 inactive (`active = false`), and the new effect increments `generation.current` (2) and dispatches `requestShellState("collapsed")`. Even if response 1 resolves before or after response 2, `id !== generation.current` drops response 1. When request 2 completes, `setApplied("collapsed")` and `setSettle((c) => c + 1)` execute in `.finally()`. Because `settle` changed, `useEffect([applied, settle, reducedMotion, commit])` triggers even though `applied` was already `"collapsed"`, scheduling `commitShellState("collapsed")`.
  - **Lost Response / IPC Rejection:** In `useEffect([target])`, `.finally()` is used rather than `.then()`. If `requestShellState` rejects, `.finally()` still advances `applied` and bumps `settle`, ensuring the commit path is scheduled.
  - **`prefers-reduced-motion`:** `usePrefersReducedMotion()` dynamically listens to `(prefers-reduced-motion: reduce)`. When active, `delay` in Effect 2 is set to `0 ms` (`setTimeout(..., 0)`), dispatching `commitShellState(appliedRef.current)` on the next event-loop turn without depending on CSS `transitionend` events.

---

#### MAJOR-5: Display topology polling distorts window frame across monitors
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch.rs:420-431`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L420-L431), [`app/src-tauri/src/notch.rs:504-515`](file:///Users/fauri/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L504-L515), [`app/src-tauri/src/notch.rs:806-813`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L806-L813), [`app/src-tauri/src/notch.rs:1188-1205`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1188-L1205)
- **Trace Analysis:**
  `ShellRuntime::update_display` compares display origin coordinates and screen dimensions against previous metrics, flagging `display_changed = true` if the display moved or resized. In `notch_geometry`, frame calculation delegates to `reconcile_window_frame(current, update.target, update.display_changed)`. When a display topology change occurs, `reconcile_window_frame` bypasses `grow_union` entirely and snaps immediately to `update.target`. Unit test `display_topology_change_snaps_instead_of_spanning_monitors` validates that a monitor jump from x=0 to x=1920 snaps cleanly rather than expanding into a >2000 pt multi-display frame.

---

#### MAJOR-6: AppKit threading and raw pointer dereferencing
- **Status:** **PARTIALLY INVALID (Round 1 sub-claim) / FIXED (pointer safety)**
- **Evidence:** [`app/src-tauri/src/notch/window.rs:26-45`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/window.rs#L26-L45), [`app/src-tauri/src/notch/window.rs:103, 117, 135, 151`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/window.rs#L103)
- **Evaluation:**
  - **Thread-Safety Sub-claim:** The author is correct on the facts. In Tauri v2, `WebviewWindow::set_ignore_cursor_events` delegates to `tauri_runtime_wry::send_user_message` (`tauri-runtime-wry/src/lib.rs:2458`), which enqueues the operation onto the event loop when invoked off the main thread; Tao's macOS backend then marshals `set_ignore_mouse_events` to the main queue (`tao/src/platform_impl/macos/util/async.rs:252`). Invoking `set_ignore_cursor_events` from a worker thread does not issue raw AppKit calls off-thread.
  - **Raw Pointer Safety Sub-claim:** Valid and fixed. Previously, `apply_style`, `frame`, and `set_frame` unsafely cast raw pointers without verifying `MainThreadMarker` or checking for null. The author introduced the centralized `ns_window(app)` helper: it asserts `MainThreadMarker::new()`, null-checks the pointer (`if raw.is_null()`), and uses `Retained::retain(...)` to safely extend object lifetime during the call. All AppKit operations now route through this helper.

---

#### MAJOR-7: Monitor leaks on window close and leaked `AnyObject` retain counts
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/lib.rs:103-107`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/lib.rs#L103-L107), [`app/src-tauri/src/notch/hover.rs:87-102`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L87-L102), [`app/src-tauri/src/notch/hover.rs:172-194`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L172-L194)
- **Trace Analysis:**
  `lib.rs` now executes `notch::teardown(app_handle)` on both `WindowEvent::CloseRequested` and `WindowEvent::Destroyed`. `HoverMonitor` holds `global: Retained<AnyObject>` and `local: Retained<AnyObject>` directly rather than relinquishing them via `into_raw`. `HoverMonitor` implements `Drop`, invoking `NSEvent::removeMonitor(&self.global)` and `NSEvent::removeMonitor(&self.local)`. When `hover::teardown` takes the monitor from `HoverRuntime.monitor`, it is dropped on the AppKit main thread (from the run-loop callback), properly unregistering the monitors and releasing retain counts.

---

#### MINOR-1: Ready and Error dwell timers lock out hover expansion
- **Status:** **FIXED**
- **Evidence:** [`app/src/App.tsx:235-242`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/App.tsx#L235-L242), [`app/src/notch/shellState.ts:55-63`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.ts#L55-L63), [`app/src/notch/shellState.test.ts:25-32`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.test.ts#L25-L32)
- **Evaluation:**
  `App.tsx` now derives `voiceAttention`, which is `true` during active attention states (`recording`, `transcribing`, permission hint, connection error, undismissible error) and `false` during passive dwell (`ready`, dismissible error). `resolveShellState` only prioritizes `voice` over `hover` when `voiceAttention` is true. During passive dwell, hovering immediately triggers panel expansion.

---

#### MINOR-2: Triple `transitionend` events fire on every state transition
- **Status:** **FIXED**
- **Evidence:** [`app/src/notch/useShellState.ts:184-195`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L184-L195)
- **Evaluation:**
  `onTransitionEnd` filters events with `if (event.propertyName !== "width") return;`, ensuring only a single commit IPC call is issued per animation cycle.

---

#### MINOR-3: Extensibility claim ("one table row + one CSS block")
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch.rs:154-182`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L154-L182), [`app/src-tauri/src/notch.rs:187-221`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L187-L221), [`interfaces/src/index.ts:161`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/interfaces/src/index.ts#L161), [`app/src/notch/shellState.ts:16`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.ts#L16)
- **Evaluation:**
  `SHELL_STATES` is now a slice `&[ShellStateSpec]` without hardcoded compile-time array lengths. `validate_shell_states()` verifies table invariants at startup and test time dynamically. `COLLAPSED_STATE` is looked up by name rather than index 0. On the frontend, `ShellStateName` is typed as `string`, and `FALLBACK_SHELL_GEOMETRY.states` is an empty array that awaits the initial geometry query. Adding a state now legitimately requires only one Rust row (and optional CSS styling).

---

#### MINOR-4: Unit test suite gaps
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch.rs:1085-1227`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1085-L1227), [`app/src/notch/shellState.test.ts:1-78`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.test.ts#L1-L78), [`scripts/check.sh:20-21, 29-30`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/scripts/check.sh#L20-L21)
- **Evaluation:**
  Added 6 new Rust unit tests in `notch.rs` covering stationary watchdog polling, edge preservation, commit resolution ordering, display topology snapping, and native interactivity logging. Added 7 TypeScript unit tests covering the state reducer, dwell precedence, and unrecognized state pass-through. Added `cargo clippy --all-targets -- -D warnings` and `npm test -w @polaris/app` to `scripts/check.sh`.

---

#### MINOR-5: Missing mouse drag masks in NSEvent monitors
- **Status:** **FIXED**
- **Evidence:** [`app/src-tauri/src/notch/hover.rs:37-41`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L37-L41), [`app/src-tauri/src/notch/hover.rs:205, 224`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/hover.rs#L205)
- **Evaluation:**
  `HOVER_EVENT_MASK` combines `MouseMoved`, `LeftMouseDragged`, `RightMouseDragged`, and `OtherMouseDragged`, ensuring drags out of the panel generate cursor exit samples.

---

### New Defect Audit

1. **Deadlock on Main-Thread Hop (`on_main`):**
   `on_main` schedules work via `app.run_on_main_thread` and receives the result through an `mpsc::sync_channel(1)` awaited on `spawn_blocking`. It is exclusively called from Tauri async command handlers running on worker threads (`notch_geometry`, `shell_request_state`, `shell_commit_state`). Synchronous startup code in `setup` uses `platform()`, which executes directly on the main thread without hopping. No deadlock paths exist.
2. **Watchdog Lock Contention / AppKit Re-entrancy:**
   In `spawn_watchdog`, `platform::cursor_location()` calls `NSEvent::mouseLocation()` outside of any mutex lock. `watchdog_decision` locks the inner mutex solely for in-memory rect checks and drops it before returning. `force_click_through` dispatches asynchronously via `run_on_main_thread` without holding the mutex. No locks are held during AppKit calls.
3. **`Drop` Execution Context:**
   `HoverMonitor` is held in `HoverRuntime.monitor: Mutex<Option<HoverMonitor>>`. It is extracted and dropped in `hover::teardown`, which runs on the main thread from Tauri's window lifecycle handler (`WindowEvent::CloseRequested` / `Destroyed`).
4. **Busy Polling Overhead:**
   Watchdog ticks sleep for 250 ms (4 Hz). Each tick performs a single memory lookup via `NSEvent::mouseLocation()` and basic point-in-rect floating point comparisons. CPU usage is immeasurable (<0.01%).
5. **Reducer Infinite Loops:**
   In `useShellState.ts`, `useEffect([target])` updates `applied` and `settle` in `.finally()`. `target` is derived strictly from `voice`, `hoverActive`, and `hotkey`, and does not depend on `applied` or `settle`. The commit effect invokes `commitShellState` without mutating React state. The pipeline is strictly acyclic.

---

### Verification Run Results

- **Rust Clippy:** `cargo clippy --manifest-path app/src-tauri/Cargo.toml --all-targets -- -D warnings` — **0 warnings**
- **Rust Unit Tests:** `cargo test --manifest-path app/src-tauri/Cargo.toml` — **109 passed, 0 failed** (all 18 `notch` tests passing)
- **TypeScript Shell Reducer Tests:** `npm test -w @polaris/app` (`node --test "src/**/*.test.ts"`) — **7 passed, 0 failed**
- **TypeScript Typecheck:** `npm run check -w @polaris/app` and `npm run check -w @polaris/interfaces` — **Clean, 0 errors**
- **Production Shell Build:** `npm run build -w @polaris/app` — **Vite build succeeded**

---

### Final Verdict

**APPROVE**

The implementation is verified to be safe, reliable, and compliant with all architectural invariants. The overlay will not eat desktop clicks or strand the native window. Ready to merge into `main`.

