# Review Report Round 2: Step A6 — Re-review of fix commit 84d3eaa

- **Date:** 2026-09-19
- **Reviewer:** Independent second reviewer (did not write the code, did not write round 1)
- **Scope:** FOCUSED re-review only. For each round-1 BLOCKER/MAJOR (backlog/2026-09-19-a6-review.md), decide whether commit 84d3eaa actually closes it, is cosmetic, or introduces a new defect. Disposition claims verified against backlog/2026-09-19-a6-text-prompt.md ("Review round 1" section) and `git show 84d3eaa`.
- **Method:** Read AGENTS.md first; read both backlog reports; ran `git show 84d3eaa`; read the current files in full (ctrl_tap.rs, hotkey_flags.rs, prompt_window.rs, prompt.css, PromptPanel.tsx grep). No source files modified, nothing committed, nothing pushed.
- **Verdict:** **APPROVE**

---

## 1. Focus area (a): KeyDown observation in hotkey_flags.rs

### A1. Local monitor still passes the event through — VERIFIED / CLEAN (fix is real)
- **Location:** `app/src-tauri/src/hotkey_flags.rs:224-236`
- **What was checked:** the local block captures `let raw = event.as_ptr()` first, calls `notify_key_observers()` on `NSEventType::KeyDown`, and `return raw`. The modifier path likewise falls through to `raw` (line 235). The global block (`hotkey_flags.rs:207-210`) returns void on KeyDown, which is correct — a global monitor cannot modify events.
- **Failure scenario considered:** if the local block had returned null or a filtered event on the KeyDown path, every keystroke typed into the focusable prompt textarea (or any Polaris window) would be swallowed. That did not happen: the pointer returned is byte-identical to the one received, satisfying the documented pass-through contract (`hotkey_flags.rs:28-30`, `237-238`).
- **Conclusion:** R1.2's core mechanism (observe KeyDown, never swallow) is correctly implemented. Not cosmetic.

### A2. Ordering between key and modifier signals into CtrlTap — VERIFIED / CLEAN (with one conservative-timing note)
- **Location:** `app/src-tauri/src/hotkey_flags.rs:195-215,224-236`, `app/src-tauri/src/prompt_window.rs:198-237`, `app/src-tauri/src/ctrl_tap.rs:165-173`
- **What was checked:** both masks live on the same monitor pair (`OBSERVED_MASK`, `hotkey_flags.rs:155-156`). Each AppKit event is dispatched synchronously to one block invocation, which sends exactly one `TapInput` (`Modifiers` or `KeyPressed`) into a single `mpsc` channel from the same callback thread. Same-thread sequential sends preserve user order, and `start_tap_driver` applies them in receive order. The real `Ctrl+C` sequence (Ctrl-down → KeyDown → Ctrl-up) therefore always poisons between the two modifier edges.
- **Failure scenario considered:** interleaved or reordered delivery (KeyDown applied after the Ctrl-up) would let two quick `Ctrl+C` chords pair and pop the prompt over a terminal. The single-channel, same-thread design rules this out for the trusted-monitor case. Global vs. local double-delivery is not a factor: the two monitors are exclusive by AppKit design (own-app vs. other-app), and this pairing predates the fix.
- **Residual note (MINOR, non-blocking):** tap timing uses `Instant::now()` at channel *consumption* (`prompt_window.rs:223-224`), not the event timestamp. Under heavy load this can only push a within-gap tap *outside* the gap (a missed double-tap, never a false positive). Conservative direction; acceptable.
- **Scope note (MINOR, docs only):** without Accessibility trust the global monitor delivers nothing, so background `Ctrl+C` chords are still invisible and the false-positive fix only holds when trusted (or for in-app keys via the local monitor). The disposition's "FIXED" should be read with that pre-existing trust caveat. Not a code defect.

### A3. Poison logic cannot wedge the detector — VERIFIED / CLEAN
- **Location:** `app/src-tauri/src/ctrl_tap.rs:97-104,129-143,165-173`
- **What was checked:** `on_key_press` early-returns when `control_down == false` (ordinary typing never poisons), otherwise sets `contaminated` and clears `press_started / first_tap_release / awaiting_second` without touching `control_down`. Every poison path self-clears: the Ctrl-up path unconditionally resets `contaminated = false` (`ctrl_tap.rs:131-132`) and drops the seed (`first_tap_release = None` on the contaminated/short-tap-fail branch, lines 140-143); the no-edge path clears on full release (lines 100-102).
- **Failure scenarios walked:**
  1. `Ctrl+C` chord → poison set → Ctrl-up reads `contaminated=true`, `press_started=None` → returns false, clears. Next press starts clean. No wedge.
  2. Key repeat while Ctrl held → repeated `on_key_press` is idempotent. No wedge.
  3. Typing between two bare taps with Control up → early return, pair still fires (covered by test `a_key_press_with_control_up_is_ordinary_typing_and_does_not_invalidate`).
  4. Missed-event lockup (release sample lost, `control_down` stuck true) is a pre-existing risk of any edge detector, not introduced here.
- **Conclusion:** R1.2 (round-1 finding 1.1) is genuinely closed, not cosmetic, and introduces no wedge defect.

---

## 2. Focus area (b): catch_unwind around Arc<dyn Fn> observers

### B1. Containment boundary is correct — VERIFIED / CLEAN (fix is real)
- **Location:** `app/src-tauri/src/hotkey_flags.rs:92-136`
- **What was checked:** `notify_sample_observers` / `notify_key_observers` now clone the `Arc` vec under the lock, drop the guard, then run each body inside `std::panic::catch_unwind(std::panic::AssertUnwindSafe(...))` via the shared `notify_all` helper. The `AssertUnwindSafe` wrapper is the standard and correct pattern at an FFI boundary: the alternative (a panic unwinding through the `RcBlock` into AppKit) is undefined behaviour / process abort, strictly worse than the theoretical risk of resuming with observer-local state mid-mutation. Registry poisoning is structurally impossible on the callback path now (the lock is never held across a call), and the `into_inner()` recovery branches are harmless dead-code defense.
- **Failure scenario considered:** a panicking observer (e.g. a future contributor's `unwrap` in a forwarded closure) previously aborted the whole app via the ObjC boundary and poisoned `SAMPLE_OBSERVERS`. Now the panic is contained per-observer and later observers still run (proven by `notify_all_contains_a_panicking_observer`, `hotkey_flags.rs:370-385`). `CtrlTap` itself never runs under `catch_unwind` — it lives on the tap thread outside the FFI frame — so detector state cannot be left half-mutated by a caught panic. The `Send + Sync` bound added to the observer types (`hotkey_flags.rs:49,56,70,84`) is required and correct for cross-thread dispatch.
- **Conclusion:** R1.5 (round-1 finding 2.2) is genuinely closed. The `!UnwindSafe` concern is acknowledged and correctly outweighed at this boundary; no new defect.

### B2. Lock-release snapshot is correct — VERIFIED / CLEAN (fix is real)
- **Location:** `app/src-tauri/src/hotkey_flags.rs:58-63,103-120`
- **What was checked:** snapshot-then-dispatch eliminates the re-entrant deadlock (observer calling `add_sample_observer` inside a dispatch no longer blocks on a held guard) and stops a slow observer from stalling AppKit dispatch under lock.
- **Conclusion:** R1.4 (round-1 finding 2.1) is genuinely closed.

---

## 3. Focus area (c): the new tests are genuine, not vacuous

Each test below was traced against both the fixed and the hypothetical still-buggy behaviour. All would fail pre-fix (or not compile where the API did not exist), i.e. none is tautological.

### C1. `a_long_control_hold_is_not_a_tap` — FIXED, genuine
- **Location:** `app/src-tauri/src/ctrl_tap.rs:236-260`
- **Check:** follow-up tap is now placed at `hold_release + 100 ms`, inside `TAP_GAP` (400 ms). If the rejected hold had seeded `first_tap_release`, that tap would pair and `assert!(!fired)` would fail. The third tap then proves rearm (fires). The old 1.0 s placement is gone. Not vacuous.

### C2. Contamination rearm assertions — FIXED, genuine
- **Location:** `app/src-tauri/src/ctrl_tap.rs:275-283` (Option path), `app/src-tauri/src/ctrl_tap.rs:299-314` (Command/Shift loop)
- **Check:** both place the probe tap at `release + 60 ms` (inside gap). A seeding bug would fire and fail the assertion; the partner tap then proves the machine rearmed rather than wedged. The second half (contamination *between* taps, lines 285-295) is retained and extended the same way. Not vacuous.

### C3. `a_long_second_tap_does_not_fire`, `a_foreign_modifier_during_the_second_press_breaks_the_pair` — genuine (new coverage for round-1 finding 1.3)
- **Location:** `app/src-tauri/src/ctrl_tap.rs:317-344`
- **Check:** both seed a valid first tap, then violate the second tap (over-hold / mid-press Shift). Without the hold/contamination checks the release would return true and the assertions would fail. Genuine.

### C4. `a_key_pressed_while_control_is_down_invalidates_the_sequence` — genuine
- **Location:** `app/src-tauri/src/ctrl_tap.rs:347-372`
- **Check:** models two `Ctrl+C` chords with `on_key_press` between down and up. Without the poison, the second chord's release would complete the pair and the final assertion would fail. (The first chord's own release-returns-false assertion alone would be weak; the second chord carries the proof.) The method did not exist pre-fix, so the test cannot pass against the old API at all. Not vacuous.

### C5. `a_key_press_with_control_up_is_ordinary_typing_and_does_not_invalidate` — genuine anti-overcorrection guard
- **Location:** `app/src-tauri/src/ctrl_tap.rs:375-385`
- **Check:** a naive "any key poisons" implementation would fail this test (the middle `on_key_press` with Control up would kill the pending first tap and the partner would not fire). It pins the `if !control_down return` guard. Not vacuous.

### C6. `notify_all_contains_a_panicking_observer` — genuine
- **Location:** `app/src-tauri/src/hotkey_flags.rs:370-385`
- **Check:** pre-fix direct dispatch would propagate the panic out of the test (failure/abort); post-fix it is contained and the second observer still runs. Genuine, correctly isolated against a local vec rather than the global registry.

### C7. `a_sample_observer_can_register_another_observer` — genuine, with one MINOR hygiene note
- **Location:** `app/src-tauri/src/hotkey_flags.rs:390-409`
- **Check:** pre-fix this deadlocks (non-reentrant `Mutex` held across the callback, re-locked from inside). Post-fix it returns. Genuine.
- **Severity MINOR — test hygiene, non-blocking:** the test leaks its observers into the process-global registry (no unregister by design) and serializes only via a local `TEST_LOCK`. Each future `notify_sample_observers` call will execute the leaked closures (each registering one more). No current test asserts on global-registry size, so nothing breaks today, but a follow-up that counts notifications or measures dispatch cost could be polluted. Suggested non-blocking follow-up: run the re-entrancy proof against a local vec (like the panic test does) instead of the global registry.

### C8. `an_open_event_carries_the_notch_flag` — genuine serialization pin
- **Location:** `app/src-tauri/src/prompt_window.rs:356-367`
- **Check:** pins `notched` present on open and omitted (not null) on close via `skip_serializing_if`. Trivial but not vacuous.

---

## 4. Remaining round-1 BLOCKER/MAJOR dispositions (all verified closed)

### R1.1 BLOCKER — `.is-open` had no CSS rule — FIXED, genuine
- **Location:** `app/src/prompt/prompt.css:25-47`, `app/src/prompt/PromptPanel.tsx:224,229`, `PromptPanel.tsx:45` (`COLLAPSE_MS = 240`)
- **Check:** closed state is now `height: 0`, open state `.prompt-sheet.is-open { height: var(--sheet-height, 0px) }`, with `--sheet-height` still driven from the measured inner height. Open animates 0 → measured, close animates measured → 0, and `COLLAPSE_MS` (240 ms) matches `--prompt-motion` (240 ms) so `prompt_hide` fires after the collapse. The animation now has something to animate. Closed correctly.

### R1.6 MAJOR — `emit(Open)` raced `run_on_main_thread` — FIXED, genuine
- **Location:** `app/src-tauri/src/prompt_window.rs:124-145,173-182`
- **Check:** `emit(Open)` moved inside the main-thread closure after `place`/`show`/`set_focus`. The webview can no longer animate/focus its textarea before the native window exists.
- **Residual MINOR (non-blocking, pre-existing style):** `show()` still logs-and-continues on `place`/`show`/`set_focus` failure and emits `Open` anyway, so a failed placement would still animate a hidden window. Same log-and-continue philosophy as before the fix; not a regression, not worth blocking on.

### R1.7 MAJOR — notch-less screens covered the menu bar — FIXED, genuine
- **Location:** `app/src-tauri/src/prompt_window.rs:262-308`, `app/src/prompt/PromptPanel.tsx:70,144-146,229`, `app/src/prompt/prompt.css:49-58`
- **Check:** `place()` derives `notched` from `safeAreaInsets().top > 0`, pins the top edge to `visibleFrame` top (below the menu bar, Spotlight-like) when notch-less, publishes via `NOTCHED` on the open event, and the panel switches `is-notched` so only true cutout placement gets square top corners. The fallback-screen path is preserved. Closed.
- **NIT (non-blocking):** panel defaults `notched=true` while the Rust static defaults `false` until first placement, so a first-ever open on a notch-less display could flash square corners for one frame before the event arrives. Cosmetic at most.

### R1.8 MAJOR — answers taller than MAX_WINDOW_HEIGHT clipped — FIXED, genuine
- **Location:** `app/src/prompt/prompt.css` (`.prompt-answer`: `max-height: 480px; overflow-y: auto`, thin scrollbar, `overscroll-behavior: contain`)
- **Check:** content beyond the 720 pt native cap now scrolls inside the sheet instead of clipping outside the window frame. The 480 px budget leaves room for bar/input/padding. Closed.

### R1.9 MAJOR — height not clamped to the screen — FIXED, genuine
- **Location:** `app/src-tauri/src/prompt_window.rs:284-290`
- **Check:** `place()` clamps against `(top - frame.origin.y - 40).max(MIN_WINDOW_HEIGHT)`, so short/scaled displays cannot push the window off the bottom. `resize()`'s pre-clamp to 720 remains as defense in depth. Closed.

### R1.10 MAJOR (NIT-scale) — non-macOS stub used unclamped PROMPT_WIDTH — FIXED, genuine
- **Location:** `app/src-tauri/src/prompt_window.rs:311-333` (now threads `width` into `LogicalSize::new(width, height)`)
- **Check:** one-line fix, exactly as recommended. The stub still passes unclamped height, but the stub is not shipped and the finding was NIT; acceptable.

### Round-1 MINOR/NIT (R1.11 test gaps, R1.12 stale input, R1.13 lifetime docs) — handled
- New Command/Shift, long-second-tap, mid-press contamination, and both key-press tests close the 1.3 gaps (`ctrl_tap.rs:299-385`). `openPanel()` clears `text`/`result` when no turn is in flight (`PromptPanel.tsx:111-117`) — `submit()` intentionally keeps text for re-run/edit, which is a reasonable scoping of round-1 finding 4.3, not evasion. Observer lifetime is now documented as process-lifetime on both registration functions (`hotkey_flags.rs:65-90`); declining the unregister token is justified and does not affect the ordering guarantee. All acceptable.

---

## 5. New-defect sweep (did the fix break anything?)

No new BLOCKER or MAJOR found. Non-blocking observations only:

1. **MINOR (test hygiene):** C7 leak noted above — re-entrancy test registers into the global registry permanently. No functional impact today.
2. **MINOR (error path):** `show()` emits `Open` even when `place`/`show`/`set_focus` fail (logs to stderr, continues). Pre-existing philosophy; worst case is animating a hidden window, same as before.
3. **MINOR (observability cost):** the global monitor now wakes on every system keystroke (presence only, never key content — privacy-preserving by design). Cost is one `Arc`-vec clone plus a channel send per keystroke; negligible but nonzero. Accepted tradeoff for the chord fix.
4. **NIT:** first-open corner flash on notch-less displays (panel default vs. static default mismatch). Cosmetic.

---

## Verdict

### **APPROVE**

Every round-1 BLOCKER and MAJOR is genuinely closed by 84d3eaa — verified line by line, not taken on the disposition's word. The three focus areas hold: (a) the local monitor returns the event untouched so keystrokes are never swallowed, key/modifier ordering into `CtrlTap` is guaranteed by the single same-thread channel, and the poison path always self-clears so the detector cannot wedge; (b) `catch_unwind` + `AssertUnwindSafe` at the ObjC boundary is the correct tradeoff and the lock is released before dispatch; (c) all new tests fail against the pre-fix behaviour and none is vacuous. Residuals are one MINOR test-hygiene note and three negligible notes above — none blocks merge.
