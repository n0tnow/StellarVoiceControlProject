# Review: A5-fold — Fold the typed prompt into the notch shell (single surface)

- **Date:** 2026-09-20
- **Reviewer:** Independent Reviewer (Task A5 / A5-fold)
- **Branch:** `review/a5` (evaluating diff `6cc2056..HEAD`, identical to `feat/a5-notch-shell`)
- **Verdict:** **APPROVE WITH FIXES**

---

## Executive Summary

The follow-up work on `feat/a5-notch-shell` (`6cc2056..HEAD`) collapses the separate A6 typed-prompt Tauri window (`prompt.html`, `prompt_window.rs`, `prompt_commands.rs`) into the single notch overlay as a new content-driven `prompt` shell state.

The core architecture of the fold is exceptionally clean:
1. The single-writer invariant for window interactivity (`sync_native_interactivity`) has been cleanly extended to native keyboard focusability (`sync_native_focusability`).
2. The content-driven height lifecycle correctly implements grow-before-animate and guaranteed-commit shrinking, bounded by display metrics and table-declared `[min_height, max_height]`.
3. The double-Control tap detector now emits state proposals (`notch_hotkey`) to the unified reducer rather than directly manipulating windows.
4. The deletion of the secondary Tauri window, capabilities, commands, and Vite multi-page configuration is thorough and free of orphaned artifacts or dead CSS.

However, unconditional **APPROVE** cannot be granted at this step because two concrete UX/focus regressions exist in real-world desktop usage:
- **MAJOR-1:** Dismissing the prompt by clicking away into another application causes Polaris to blindly activate the *previously* active application, stealing focus away from the application the user just clicked.
- **MAJOR-2:** Dismissing the prompt via Escape or the ✕ Close button while the mouse cursor rests over the prompt surface causes the shell to immediately expand into the 420 pt interactive `panel` rather than collapsing.

Once these two flaws and two minor edge cases are resolved, the implementation meets all criteria for production merge.

---

## Audit Findings in Priority Order

### 1. Safety Regressions Against Round-2 Invariants

#### Invariant Verification: Single Writers & Watchdog Guarantees
- **Native `ignoresMouseEvents` single writer:** Verified. `sync_native_interactivity` ([`app/src-tauri/src/notch.rs:1016-1025`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1016-L1025)) remains the sole caller of `window::set_ignore_cursor_events`. It derives its boolean directly from `runtime.is_interactive()`.
- **Native `focusable` single writer:** Verified. `sync_native_focusability` ([`app/src-tauri/src/notch.rs:1037-1055`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1037-L1055)) is the sole caller of `window::set_focusable`. It reads `runtime.is_focusable()`, updates the native flag on AppKit's main thread, and logs the write in `runtime.note_native_focusable(focusable)`.
- **Watchdog forcing both flags:** Verified. In `force_click_through` ([`app/src-tauri/src/notch.rs:975-1014`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L975-L1014)), `mark_forced_collapse` resets both `rt.interactive = false` and `rt.focusable = false`. Both `sync_native_interactivity` and `sync_native_focusability` are invoked in the same serialized main-thread task *before* the frame collapse, ensuring click-through and non-focusability are re-asserted even if frame animation fails.
- **Watchdog focused-window refinement:** Verified safe. In `outside_for_longer_than` ([`app/src-tauri/src/notch.rs:771-778`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L771-L778)), `!rt.focused` prevents collapsing a prompt the user is actively typing into while the cursor sits still. The moment the user clicks outside or switches windows, AppKit emits `Focused(false)` via `WindowEvent::Focused` ([`app/src-tauri/src/lib.rs:114-117`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/lib.rs#L114-L117)), re-arming the watchdog immediately. A frozen or crashed webview that fails to process `blur` in JavaScript is still recovered by the native watchdog after `WATCHDOG_GRACE` (1.5 s).
- **Teardown & Flapping:** Both `RunEvent::Exit` and `WindowEvent::CloseRequested`/`Destroyed` route to `notch::teardown` ([`app/src-tauri/src/lib.rs:103-110`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/lib.rs#L103-L110)). Rapid double-Control tapping is debounced in `ctrl_tap.rs` and serialized through the `generation` counter in `useShellState.ts:243-255`.

---

#### MAJOR-1: Blind focus restoration steals focus away from newly activated applications on outside-click dismiss
- **Location:** [`app/src-tauri/src/notch/focus.rs:45-64`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/focus.rs#L45-L64), [`app/src-tauri/src/notch.rs:1049-1051`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L1049-L1051), [`app/src/notch/useShellState.ts:178-184`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L178-L184)
- **Failure Scenario:**
  1. User is working in App A (e.g. VS Code, PID 100).
  2. User double-taps Control to open the Polaris prompt. `sync_native_focusability` runs `focus::remember_frontmost()`, which stores PID 100 in `PREVIOUS_PID`.
  3. User decides to switch tasks and clicks directly on a window belonging to App B (e.g. Chrome, PID 200).
  4. macOS handles the click by bringing App B to the front and resigning key focus from Polaris.
  5. The Polaris webview receives `window.blur` ([`useShellState.ts:178-184`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L178-L184)) and schedules `setHotkeyState("collapsed")`.
  6. Rust receives `shell_request_state("collapsed")`. In `sync_native_focusability`:
     ```rust
     else if !focusable && previously == Some(true) {
         focus::restore_frontmost();
     }
     ```
  7. `focus::restore_frontmost()` takes PID 100 from `PREVIOUS_PID` and invokes:
     ```rust
     app.activateWithOptions(NSApplicationActivationOptions::empty());
     ```
  8. **App A (PID 100) is forcefully reactivated to the front, instantly stealing focus away from App B (PID 200).**
  9. The user clicked Chrome, but Chrome was immediately submerged by VS Code because Polaris blindly restored the old application on collapse.
- **Required Fix:**
  In `focus::restore_frontmost()`, only call `app.activateWithOptions(...)` if the application currently frontmost according to `NSWorkspace::sharedWorkspace().frontmostApplication()` is Polaris itself (`pid == std::process::id() as i32`). If the user already focused an external application (or if no application is frontmost), simply clear `PREVIOUS_PID` without issuing an activation request.

---

### 2. Content-Driven Height

- **Resize Loop Audit:** Can a loop occur where content measures -> window resizes -> content re-measures?
  - Evaluated: **No.** In [`app/src/notch/PromptPanel.tsx:78-86`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/PromptPanel.tsx#L78-L86), `ResizeObserver` observes `.notch-prompt-body`. In [`app/src/index.css:372-378`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/index.css#L372-L378), `.notch-prompt-body` has `flex: none` and natural height driven solely by its inner elements (title bar, input, answer), while its scrollable container `.notch-prompt` has `overflow-y: auto`. The body's height does not depend on the parent window's height. When the content exceeds `max_height`, `.notch-prompt` scrolls while `.notch-prompt-body` stabilizes, preventing measurement oscillation.
- **Height Clamping:** Verified. In `notch.rs:693-707`, `set_content_height` clamps to `[state.min_height, state.max_height]`. Both bounds are resolved through `ShellDim::resolve`, which clamps to `screen_height * ratio` ([`notch.rs:131`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch.rs#L131)).
- **Stranded Oversized Window Audit:** Verified. `shell_resize_content` applies `grow_union(current, target)` so the native window expands immediately without clipping animation. The hook in `useShellState.ts:224` bumps `settle`, triggering the guaranteed commit timer (`useShellState.ts:266-270`), which dispatches `shell_commit_state("prompt")` to snap the window to the exact clamped target frame once motion completes.

---

#### MINOR-1: Content-driven height transitions bypass the `transitionend` fast path
- **Location:** [`app/src/notch/useShellState.ts:272-283`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L272-L283)
- **Failure Scenario:**
  1. Review round 2 introduced `if (event.propertyName !== "width") return;` in `onTransitionEnd` to prevent triple commit dispatches when `.notch` transitions `width`, `height`, and `border-radius` simultaneously.
  2. However, when `applyContentHeight` runs during a content resize while in `prompt`, the shell width is constant; **only `height` transitions** via `--shell-height`.
  3. When the CSS height tween finishes, `onTransitionEnd` receives an event with `propertyName === "height"`.
  4. Because `propertyName !== "width"`, the event is dropped.
  5. The fast-path commit is never executed for content resizes; the window only shrinks via the fallback `setTimeout(..., SHELL_MOTION_MS + 60)` timer.
  6. While the fallback timer prevents permanent stranding, the fast path is effectively dead for all prompt growth and shrink transitions.
- **Required Fix:**
  Update the property check in `onTransitionEnd` to allow either `width` OR `height` when `applied === "prompt"`:
  ```ts
  const isTargetProperty =
    appliedRef.current === "prompt"
      ? event.propertyName === "height" || event.propertyName === "width"
      : event.propertyName === "width";
  if (!isTargetProperty) return;
  ```

---

#### MINOR-2: `NaN` content height bypasses `rounded <= 0` guard and causes IPC serialization rejection
- **Location:** [`app/src/notch/useShellState.ts:218-221`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L218-L221)
- **Failure Scenario:**
  1. If `PromptPanel` measures an unattached DOM node or a layout edge case producing `NaN`, `handleContentHeight` passes `NaN` to `applyContentHeight`.
  2. `const rounded = Math.round(shellHeight)` produces `NaN`.
  3. In JavaScript, `NaN <= 0` evaluates to `false`.
  4. `applyContentHeight` does not return; it invokes `resizeShellContent(NaN)`.
  5. `JSON.stringify({ height: NaN })` serializes to `{"height": null}`.
  6. Tauri's command deserializer expects `f64` (not `Option<f64>`) and rejects the call with `invalid type: null, expected f64`, logging an unhandled promise rejection in the webview console.
- **Required Fix:**
  Guard with `Number.isFinite`:
  ```ts
  const rounded = Math.round(shellHeight);
  if (!Number.isFinite(rounded) || rounded <= 0) return;
  ```

---

### 3. Reducer: Prompt vs Hover vs Voice Precedence

- **Precedence Audit:** In [`app/src/notch/shellState.ts:59-71`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.ts#L59-L71), precedence is strictly ordered:
  `hotkey (latched prompt) > attention voice > hover > ambient voice dwell > collapsed`.
- **Prompt closed by hover loss:** Verified protected. Because `hotkeyState` is a persistent latch in `useShellState.ts` (`useState("collapsed")`), moving the cursor away from the notch drops `hover` to `"collapsed"` but leaves `hotkey: "prompt"` untouched. The prompt remains open.
- **Voice silently destroying typed text:** Verified protected. When push-to-talk is triggered, `voiceState` becomes `"compact"`. In `resolveShellState`, `hotkey: "prompt"` outranks `voice: "compact"`. In `ShellSurface.tsx:116`, `applied === "prompt"` remains `true`, keeping `PromptPanel` mounted. The typed text in `useState("")` is retained. The status strip visually displays "Listening" via the `visual` prop (`ShellSurface.tsx:69, 87`) without destroying user input.
- **Listener Leaks & Stale Closures:** Verified clean. `listenNotchHover`, `listenNotchHotkey`, and `window.blur` effects properly clean up unlisten handlers and remove event listeners. Monotonic `generation.current` and `settle` counter avoid stale async state transitions.

---

#### MAJOR-2: Prompt dismissal via Escape or Close button (✕) while hovering morphs into 420 pt interactive `panel` instead of collapsing
- **Location:** [`app/src/notch/shellState.ts:63-70`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/shellState.ts#L63-L70), [`app/src/notch/useShellState.ts:186-189, 210-212`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L186-L189), [`app/src/notch/PromptPanel.tsx:133-138, 163-171`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/PromptPanel.tsx#L163-L171)
- **Failure Scenario:**
  1. User opens the prompt with double-Control.
  2. The user moves the mouse into the prompt to click the text area, toggle the speaker switch, or read an answer.
  3. Because the mouse cursor is located within the prompt frame, `observe_cursor` in Rust detects `inside_at(x, y) == true` and emits `notch_hover { inside: true }`.
  4. In `useShellState.ts:120-125`, `enterTimer` elapses after `HOVER_ENTER_DWELL_MS` (250 ms) and sets `hoverActive = true`. While the prompt is active, `hotkey: "prompt"` outranks hover, so `target` remains `"prompt"`.
  5. The user decides to close the prompt and clicks the **✕ Close button** (`PromptPanel.tsx:166`) or presses **Escape**.
  6. `onDismiss()` calls `dismiss()` in `useShellState.ts:210`:
     ```ts
     const dismiss = useCallback((): void => {
       setHotkeyState("collapsed");
     }, []);
     ```
  7. `hotkeyState` switches from `"prompt"` to `"collapsed"`.
  8. React re-evaluates `target = resolveShellState(...)`:
     - `hotkey`: `"collapsed"`
     - `voice`: `"collapsed"`
     - `hover`: `"panel"` (because `hoverActive` is **still `true`**!)
  9. `resolveShellState` resolves `target = "panel"`.
  10. **Instead of collapsing, the notch immediately expands into the massive 420 pt tall, 779 pt wide interactive `panel` placeholder!**
  11. The user explicitly clicked Close (or pressed Escape) to dismiss the notch, but it morphed into a giant interactive panel that captures mouse clicks over desktop windows.
- **Required Fix:**
  In `useShellState.ts`, `dismiss()` must cancel pending enter timers and explicitly reset `hoverActive`:
  ```ts
  const dismiss = useCallback((): void => {
    clearTimeout(enterTimer.current);
    hoverActiveRef.current = false;
    setHoverActive(false);
    setHotkeyState("collapsed");
  }, []);
  ```
  Additionally, when `inside: false` arrives or when `hotkeyState !== "collapsed"`, hover dwell should be suppressed so that hovering inside an explicitly opened prompt does not silently prime an underlying panel expansion.

---

### 4. The Deleted Window

- **Dangling References:** None. Grepping the repository confirms zero remaining source references to `prompt.html`, `prompt_window.rs`, `prompt_commands.rs`, or `prompt.css`.
- **Tauri Configuration & Capabilities:** Verified clean.
  - `app/src-tauri/tauri.conf.json:20-33`: Only the single `"main"` window is declared.
  - `app/src-tauri/capabilities/default.json:5`: Scoped strictly to `windows: ["main"]`.
  - `app/src-tauri/src/lib.rs:40-50`: Commands list cleanly registers `notch_geometry`, `shell_request_state`, `shell_commit_state`, `shell_resize_content`, and `hotkey_permission`. `prompt_resize` and `prompt_hide` are completely removed.
- **Vite Multi-Page Build:** Verified clean. `app/vite.config.ts:75-84` deleted the `rollupOptions.input` multi-entry object; Vite now builds a single bundle for `index.html` (verified via `npm run build -w @polaris/app`).
- **CSS Hygiene:** Verified clean. Deleted `prompt.css` in its entirety (248 lines). All new styling is neatly scoped under `.notch-prompt` in `app/src/index.css:343-576`.
- **A6 Behavior Preservation:**
  - **Enter to submit:** Verified preserved in `PromptPanel.tsx:126-131`.
  - **Escape to dismiss:** Verified preserved in `PromptPanel.tsx:133-138`.
  - **Spoken-reply toggle & persistence:** Verified preserved in `PromptPanel.tsx:29-51, 68, 152-162`.
  - **Double-Control tap debouncing:** Verified preserved in `notch/tap.rs:28-71` using the identical `CtrlTap` state machine from A6.

---

### 5. Evaluation of Author's TCC Argument in Section 6

The author argues in Section 6 that the dev-mode `SFSpeechRecognizer` TCC SIGABRT cannot be solved by embedding `Info.plist` into `main.rs` (the fix prescribed in the spec), and documents why the issue was misdiagnosed.

**Evaluation: The author's analysis is completely sound and factually accurate.**

1. **Plist is already embedded in the dev binary:**
   Inspection with `otool -s __TEXT __info_plist app/src-tauri/target/debug/polaris-app` confirms that Tauri's `generate_context!` macro (`tauri-codegen` 2.6.3) already embeds `app/src-tauri/Info.plist` directly into the binary's `__TEXT,__info_plist` section. Both `NSMicrophoneUsageDescription` and `NSSpeechRecognitionUsageDescription` are present in the Mach-O image.
2. **Duplicate symbol conflict:**
   Adding `embed_info_plist!` into `main.rs` results in a direct linker error (`duplicate symbol '__EMBED_INFO_PLIST'`) because Tauri's runtime code generation already injects the symbol.
3. **macOS Responsible-Process Model:**
   On macOS 14+ / 15+, when an unbundled Mach-O executable is launched from a terminal emulator (e.g. `zsh` running in `Terminal.app`), TCC evaluates the *responsible process* in the execution tree. Because `Terminal.app` itself does not possess the `NSSpeechRecognitionUsageDescription` entitlement/key, TCC aborts the process immediately via SIGABRT before displaying an authorization modal. When the same binary is packaged inside a code-signed `.app` bundle and launched via LaunchServices (`open Polaris.app`), LaunchServices designates `Polaris.app` as the responsible process and the authorization dialog appears normally.

The author was entirely correct to reject the duplicate symbol hack and document the genuine macOS platform constraint.

---

## Required Fixes Before Final Approval

Before merging `review/a5` / `feat/a5-notch-shell` into `main`, the author must apply the following targeted fixes:

1. **Fix focus restoration on outside-click dismiss ([`app/src-tauri/src/notch/focus.rs:45-64`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src-tauri/src/notch/focus.rs#L45-L64)):**
   Query `NSWorkspace::sharedWorkspace().frontmostApplication()`. Only activate the remembered application if the currently frontmost application's PID matches Polaris's own process ID. Otherwise, drop the remembered PID without activating.
2. **Fix prompt dismissal morphing into panel ([`app/src/notch/useShellState.ts:210-212`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L210-L212)):**
   Ensure `dismiss()` clears `hoverActive` and aborts `enterTimer.current`, so dismissing the prompt collapses to the pill even if the cursor rests on the prompt.
3. **Allow height transitions in `onTransitionEnd` ([`app/src/notch/useShellState.ts:279`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L279)):**
   Allow `event.propertyName === "height"` to trigger `commit` when `applied === "prompt"`.
4. **Guard `applyContentHeight` against `NaN` ([`app/src/notch/useShellState.ts:220`](file:///Users/fatih/StellarVoiceControlProject/.worktrees/a5-review/app/src/notch/useShellState.ts#L220)):**
   Use `if (!Number.isFinite(rounded) || rounded <= 0) return;` to avoid serializing `{"height": null}` across IPC.

---

## Final Verdict

**APPROVE WITH FIXES**

The single-surface fold architecture is robust, elegant, and preserves all click-through invariants established in Round 2. Once the focus-stealing bug on outside-click (MAJOR-1) and the prompt-to-panel morphing bug (MAJOR-2) are addressed, this branch is ready for `main`.
