# A5-clean (round 2): a clean prompt surface + the fold review's two MAJORs

- **Date:** 2026-09-20
- **Branch:** `feat/a5-notch-shell` (worktree `.worktrees/a5-notch-shell`)
- **Worker:** opencode worker (`opencode-go/deepseek-v4.1-flash`)
- **Scope:** this is the UI-cleanup round after the owner rejected the folded prompt
  twice ("çok karışık" / "Ask Polaris ve sağ üstteki mor düşünme kısmı tamamen kalksın"),
  plus the two MAJOR and two MINOR findings of `backlog/2026-09-20-a5-fold-review.md`.
- **Verdict requested:** no PR, no merge, no tag (per task). Branch pushed.

---

## 1. The redesign decision

The fold produced a *working* prompt but not a *quiet* one: the status strip, a prompt
header bar and a nested input card stacked three visual layers inside a 32 pt notch.
The owner read that as clutter. The redesign is a subtraction, not a restyle.

### 1.1 The status strip is a voice affordance, not a prompt one (A1)

`ShellSurface` rendered `.notch-content` (`.notch-copy` + `<StageLabel>` and
`.notch-indicator`, whose `::before` is the purple radial wash) for **every** state.
In `prompt` that strip was the "Ask Polaris" heading and the purple blob.

It is now removed from the tree while the prompt is applied:

```tsx
const showStrip = applied !== "prompt";
...
{showStrip ? (<div className="notch-content">…</div>) : null}
```

Removed, not hidden: no `opacity`, no `visibility`, no `aria-hidden`-while-occupying-space.
The prompt body owns the whole surface. Acceptance #3 (no `.notch-copy` / `.notch-indicator`
in the prompt tree) holds by construction.

### 1.2 One surface, no chrome (A2/A3)

`PromptPanel.tsx` lost its entire `<header className="prompt-bar">`:

- the pill `prompt-speaker` toggle **and its "Speak replies" / "Text only" label** — gone;
- the round `prompt-close` ✕ — gone. Dismissal is Escape, outside click or the
  double-Control trigger again.

The nested card is gone too: `.prompt-input` (its own border, radius and `#0d0d12`
background inside the shell) became `.prompt-row`, a plain flex row on the shell's own
background. One surface, one background, no inner shadow, no second radius.

What the prompt is now:

- **Idle:** one text row, caret + muted `Ask Polaris…` placeholder, full width, 16 px left
  inset. It reads as "the notch grew one text row".
- **Send:** Enter; Shift+Enter inserts a newline. The round `↑` button became a small,
  low-contrast arrow glyph that only exists once `text.trim()` is non-empty.
- **Spoken replies:** no pill, no words. One small speaker glyph at the right end of the
  input row; on/off is the glyph shape (waves vs. cross) plus opacity, carried for AT by
  `aria-label` + `aria-pressed` + `title`. The `localStorage` preference is unchanged
  (`polaris.prompt.speaker`).
- **Answer:** under the input in the notch's own type scale; only then does the shell grow
  (content height), up to the declared max, after which `.notch-prompt` scrolls.
- **Error:** one compact muted line, `white-space: nowrap` + `text-overflow: ellipsis`,
  full text in `title`. The two-line red block is gone.
- **Housing:** `.notch-prompt` is anchored to `top: var(--safe-top)` (the menu-bar/notch
  inset) instead of the strip height, and `ShellSurface` sets `--safe-top` from
  `geometry.notch.safeTop` (equals `cutoutHeight` on a notched display). The half-clipped
  control in the owner's screenshot was the header sitting at the top of a too-short
  measured body; both the header and the wrong anchor are removed.

CSS hygiene: `.notch-prompt` inherits the shell's background and `--shell-bottom-radius`;
no leftover `prompt.css` rules (`prompt-bar`, `prompt-speaker` pill, `prompt-knob`,
`prompt-close`, `prompt-submit`, `prompt-input`, `prompt-tag` are all deleted, and the
reduced-motion block was updated to the surviving classes).

### 1.3 The `sr-only` bug (A4)

`App.tsx:364` rendered `<span className="sr-only">` and no `.sr-only` rule existed, so the
live-region sentence was painted on the overlay. `.sr-only` is now defined explicitly with
the clip-rect pattern (unlayered, so it wins over any generated Tailwind utility). Every
class name still used in the tree was checked against `index.css` — nothing else is
unresolved.

---

## 2. Review findings

### MAJOR-1 — focus stealing on outside-click dismiss

**Changed:** `app/src-tauri/src/notch/focus.rs`. `restore_frontmost` now queries
`NSWorkspace::sharedWorkspace().frontmostApplication()` and activates the remembered app
**only while Polaris is still frontmost**. On an outside click the user has already
activated another app, so macOS's activation stands and the remembered pid is simply
dropped. The rule is the pure `should_reactivate(frontmost_pid, our_pid)`.

**Test:** `app/src-tauri/src/notch/focus.rs::tests::only_reactivates_while_polaris_is_still_frontmost`
— asserts `Some(our)=true`, `Some(other)=false`, `None=false`. Without the rule the
function would be `|_, _| true` and the second/third assertions fail.

### MAJOR-2 — Escape (and outside click) while hovering morphs into the 420 pt panel

**Changed:** `app/src/notch/useShellState.ts` (+ `shellState.ts` helper). Two layers:

1. `dismiss()` drops hover and arms a **hover latch**: `inside` edges are swallowed until
   the cursor leaves the shell (`inside: false`), which clears it. A latch, not a timer.
2. While an explicit mode is latched (`hotkeyState !== "collapsed"`), hover edges are
   ignored entirely, and every mode transition goes through `releaseHover()`.

Layer 2 was added **after manual verification caught a second path**: the Rust watchdog's
forced collapse emits `notch_hover(false)` *before* `notch_hotkey(false)` and the webview
`blur` does not always arrive on a space change, so the 400 ms leave grace could set
`hoverActive` while the hotkey latch was already clear — the reducer then resolved to
`panel`, and the cursor inside the panel rect kept it open. With hover suppressed while the
mode is latched, that transition can no longer produce a panel.

**Test:** `shellState.test.ts::"MAJOR-2: an explicit dismissal latches hover until the cursor leaves"`
covers `applyHoverEdge` (pure): an `inside` edge under a latch is `{latched:true, accept:false}`,
a leave edge clears it, and a quiet leave is idempotent. Without the latch the first case
would be `accept:true`.

### MINOR-1 — content-driven height bypasses the `transitionend` fast path

**Changed:** `onTransitionEnd` used `if (event.propertyName !== "width") return;`. Now
`isCommitTransition(propertyName, contentDriven)` returns true for `width` always, and for
`height` when the applied state is content-driven (`appliedRef.current === "prompt"`).

**Test:** `shellState.test.ts::"MINOR-1: a content-driven state commits on its height transition"`
— `isCommitTransition("height", true) === true` (fails under the old width-only rule),
`("height", false) === false`, `("width", *) === true`, radius/opacity false.

### MINOR-2 — `NaN` content height slips past the guard

**Changed:** `applyContentHeight` used `if (rounded <= 0) return;` and `NaN <= 0` is `false`.
Now `if (!isUsableShellHeight(rounded)) return;` with
`Number.isFinite(height) && height > 0`.

**Test:** `shellState.test.ts::"MINOR-2: a NaN/Infinity/non-positive height is rejected before IPC"`
— `NaN`, `Infinity`, `0`, `-12` false; `244` true; plus a pin that `Math.round(NaN)` stays
`NaN` (which is exactly why `isFinite` is required).

---

## 3. Verification

### 3.1 Static / automated

`caffeinate -i bash scripts/check.sh` → **`== all checks passed`**.

- JS typecheck (all workspaces): clean.
- `@polaris/stellar`: 67 keeper `node:test` + 111 anchor vitest = all green.
- `@polaris/app`: **30/30** (was 27; +3 for MINOR-1 / MINOR-2 / MAJOR-2). Count not dropped.
- Vite production build: green.
- `@polaris/agent` smoke: green.
- `cargo clippy --all-targets -- -D warnings`: clean.
- `cargo test` (Tauri shell): **141 passed, 0 failed, 3 ignored** (was 140; +1 focus test).

Acceptance greps:

- `grep -rn "prompt-bar\|prompt-close\|Speak replies\|Text only" app/src` → **nothing**.
- The `prompt` tree contains no `.notch-copy` / `.notch-indicator` (see §1.1).
- Every class name in the rendered tree resolves in `index.css` (incl. `.sr-only`).

### 3.2 Manual — debug bundle, by hand

Built with `caffeinate -i npm run tauri -w @polaris/app -- build --debug` and run from
`app/src-tauri/target/debug/bundle/macos/Polaris.app` (screen 1470×956, cutout 179×32,
`safe_top` 32). The double-Control tap was synthesized by posting real `flagsChanged`
`CGEvent`s (System Events `key code` cannot express a bare modifier tap: it also emits a
`keyDown`, which correctly poisons the tap detector). Observations, quoted from the
screenshots and the process log:

1. **Open, clean surface.** The prompt opens as a single text row: caret + muted
   `Ask Polaris…`, the speaker glyph at the right end, the menu bar reading `Polaris`.
   **No "Ask Polaris" heading and no purple blob.** The text row sits fully below the
   housing — nothing clipped.
2. **Enter sends.** Typed `ping`, pressed Enter: the row showed `ping` with the small `↑`
   send glyph, then `Thinking…`, then the answer **`👋 Nasıl yardımcı olabilirim?`** under a
   hairline. The shell grew to fit the answer; no panel, no second card.
3. **Escape while hovering.** Moved the cursor onto the shell (dwell armed hover), pressed
   Escape: the shell collapsed to the resting pill. **It did not morph into the 420 pt
   panel.** Focus returned to the previous app.
4. **Outside click.** Remembered app = `zen`; double-Control opened the prompt; a real click
   at (1200, 400) inside the **Claude** window. Result: `frontmost = Claude` — the clicked
   app kept focus, the remembered `zen` was **not** re-activated (MAJOR-1). The shell
   collapsed to the pill, **no panel** (the pre-fix run had produced the full black panel
   with the "menus land here" placeholder; the fix removed it). The Rust log confirms the
   watchdog path also ended collapsed:
   `polaris: hover watchdog restoring click-through (interactive with the cursor outside for 1.5s)`.

The first (pre-hardening) manual run is what exposed the watchdog-ordered failure in
MAJOR-2 §2 layer 2; it is fixed and re-verified above.

### 3.3 Known limitation (pre-existing, not this task)

On a fullscreen Space the overlay is not visible over the fullscreen app; the owner's
normal (non-fullscreen) desktop shows it. Left as-is; it is the A5 overlay behaviour, not
the prompt.

---

## 4. Files touched

- `app/src/notch/ShellSurface.tsx` — strip removed in `prompt`, `--safe-top`, body height
  measured from `safeTop`.
- `app/src/notch/PromptPanel.tsx` — one-surface body; header/card/buttons deleted; glyph
  controls; single-line error.
- `app/src/index.css` — `.sr-only`; prompt rules rewritten; dead prompt CSS deleted.
- `app/src/notch/shellState.ts` — `isCommitTransition`, `isUsableShellHeight`,
  `applyHoverEdge`.
- `app/src/notch/shellState.test.ts` — the three new pure tests.
- `app/src/notch/useShellState.ts` — `releaseHover`, dismissal latch, mode-latched hover
  suppression, helpers wired.
- `app/src-tauri/src/notch/focus.rs` — `should_reactivate` + `restore_frontmost` guard +
  unit test.

## 5. Status

Implemented and pushed on `feat/a5-notch-shell` (commits `928fdc8`, `4ca3f17`, `ba9846e`,
`077586d`, `de9e3ad`). No PR, no merge, no tag. Console/manual evidence above; the
remaining judgement (does it read as "the notch grew one text row") is the owner's.

---

## 6. Follow-up: the voice turn keeps a face while the prompt is open

The strip removal in §1.1 was correct but opened a gap the owner flagged: while the typed
prompt is open, the push-to-talk path (`Control`+`Option` hold → recording / transcribing /
thinking / speaking) had **no visual feedback at all**, because the strip that used to show
it is not rendered in the `prompt` state. This section closes that gap inside the single
surface, without bringing the strip back.

### 6.1 The rule (single surface, documented precedence)

`prompt` remains the top-priority proposal, so a voice turn that starts while the prompt is
latched **does not close it and does not drop the typed text**. This is a new *co-active*
case, so it is written down in `shellState.ts` rather than left to fall out of the ordering:
while the hotkey latch holds, an attention voice state does not take the surface; the turn's
stage rides into the prompt as an inline indicator instead.

- `app/src/notch/shellState.ts` — `resolveShellState`'s precedence doc now states the
  co-active rule explicitly; the stale "the status strip still shows Listening" sentence is
  gone.
- `inlineVoiceStage(visual)` is the new pure mapping: `recording → "listening"`,
  `transcribing → "thinking"`, `speaking → "speaking"`, and `null` for `idle` / `error` /
  anything unknown. The three names are the strip's own stage vocabulary — no new words.

### 6.2 The indicator

`PromptPanel` renders a small three-bar `.prompt-voice` element as the last child of
`.prompt-row`, i.e. the right end of the input row, the same corner as the speaker glyph.
It is `aria-hidden` (the `App` live region already announces "Listening. Release to finish."
et al.) and carries `data-stage` for inspectability.

Its bars reuse the strip's accent, glow and — critically — its animation rules: the existing
`.state-recording` / `.state-transcribing` / `.state-speaking .notch-indicator span` rules
were extended with `.prompt-voice span`, so listening pulses fast and thinking/speaking pulse
slow from one source, not a copy. The reduced-motion block disables both. No `::before`
purple wash is reused: the prompt is still a clean surface.

Because the element is only rendered when `voiceStage !== null`, it disappears the moment the
turn settles and the prompt returns to exactly its normal look with the typed text intact.

### 6.3 The double-Control tap during a voice turn (decision)

**Decided: ignored while the microphone hold owns the moment, and live again afterwards.**

- *Ignored while recording* needs **no new runtime gate**: push-to-talk holds `Control` **and**
  `Option`, and `ctrl_tap` rule 3 poisons any sequence that ever sees Option/Command/Shift, so
  the short Control edges inside the hold can never seed or complete a pair. The existing
  `option_or_command_contamination_invalidates_the_sequence` test is untouched (not weakened).
- New test `ctrl_tap::tests::a_push_to_talk_hold_owns_the_control_key_so_no_tap_can_fire`
  walks the full hold (Control down, Option joins, Control mashed twice under Option, Option
  released first) and asserts nothing fires, then asserts a fresh pair fires once everything
  is released — so the hold re-arms rather than permanently poisoning the machine.
- *After the hold* (transcribing / thinking / speaking) the tap toggles the prompt normally.
  Prompt and voice turn are explicitly allowed to be active together (§6.1), so a blanket
  "ignore the tap for the whole turn" rule would force Rust to own a voice-turn notion it does
  not have (thinking/speaking live in the webview turn session, not in `Capture`), duplicating
  state and risking a second source of truth. The rationale is recorded in `notch/tap.rs`.

### 6.4 Verification — `caffeinate -i bash scripts/check.sh`

```
== JS: typecheck all workspaces
== JS: workspace tests (keeper node:test + anchor vitest)
# tests 67
# pass 67
# fail 0
...
 Test Files  5 passed (5)
      Tests  111 passed (111)
== JS: app tests (notch shell reducer, node:test)
# tests 32
# pass 32
# fail 0
== JS: production build of the shell (vite)
== JS: agent skeleton smoke test
== Rust: cargo clippy (Tauri shell; warnings are errors)
== Rust: cargo test (Tauri shell; the notch state-table tests live here)
test result: ok. 142 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out; finished in 0.01s
== all checks passed
```

Counts moved: app **30 → 32** (+2: the co-active reducer test and the `inlineVoiceStage`
mapping test); cargo **141 → 142** (+1: the push-to-talk-hold tap test). `clippy
--all-targets -- -D warnings` clean; Vite build green.

### 6.5 Files touched

- `app/src/notch/shellState.ts` — co-active precedence documented; `VoiceStage` +
  `inlineVoiceStage`.
- `app/src/notch/shellState.test.ts` — the two new pure tests; the latched-prompt comment
  updated to the inline-indicator wording.
- `app/src/notch/ShellSurface.tsx` — maps `visual` to the inline stage and passes it in.
- `app/src/notch/PromptPanel.tsx` — `voiceStage` prop; the `.prompt-voice` element.
- `app/src/index.css` — `.prompt-voice` styles; state selectors and reduced-motion extended.
- `app/src-tauri/src/notch/tap.rs` — the decided-interaction rationale.
- `app/src-tauri/src/ctrl_tap.rs` — the hold-owns-the-Control-key test.

### 6.6 Status

Implemented and pushed on `feat/a5-notch-shell` (commits `a104ce1`, `d9278ff`, `17b2438`,
plus the docs commit). No PR, no merge, no tag. The round-2 safety invariants are untouched:
one writer per native flag, the watchdog still polls the real cursor and forces both flags
back, and the commit path is still guaranteed. Manual GUI judgement of the inline indicator's
look is left to the owner (automated proof is the pure mapping tests + the shared animation
rules).
