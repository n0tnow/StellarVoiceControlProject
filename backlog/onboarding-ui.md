# ONBOARDING-UI — first-run window (React)

- **Date:** 2026-09-20
- **Worker/Agent:** Claude Opus 5 (UI worker)
- **Branch/Worktree:** `feat/onboarding-ui` / `.worktrees/onboarding-ui`
- **PR:** none (the coordinator opens it)

---

## 1. BLOCKING FINDING — page 5 cannot be gated on a real notch hover

**Verdict: `notch_hover` can never reach the onboarding window while it is focused. Page 5 illustrates instead of testing.** The brief anticipated this and asked for evidence. Here it is.

### The keyboard lessons (pages 3 and 4) — WORK, no Rust change needed

`app/src-tauri/src/hotkey_flags.rs` installs a **monitor pair** over
`NSEventMask::FlagsChanged | KeyDown` — a global monitor *and* a local one — and both call
the same `on_sample` and the same `notify_sample_observers` fan-out. Its module header
says so verbatim: "a **global** monitor for events delivered to other apps and a
**local** monitor for events delivered to our own".

Neither consumer gates on application activation:

- `hotkey.rs::apply` emits `PolarisEvent::Hotkey { Down | Up }` straight from the latch.
- `notch/tap.rs` emits `notch_hotkey` straight from the `CtrlTap` machine (it only reads
  `ShellRuntime` to decide the *payload* — `!prompt_open` — never whether to emit).

Keyboard events are delivered to the key window, which is ours, so the local monitor sees
them. **Both lessons are genuinely gatable from a focused window.**

### Hover (page 5) — DOES NOT WORK

`app/src-tauri/src/notch/hover.rs` installs the same shaped pair for `mouseMoved`. The
symmetry is where the reasoning usually stops, and it is wrong, because mouse events are
delivered by different rules than key events. Both halves are blind at the same time:

1. **The global monitor is paused while Polaris is the active app.** Not inference —
   `notch.rs::hover_health` ships it as a user-facing diagnostic string: *"Polaris is the
   active app, so macOS pauses the global mouse monitor; close the open panel to restore
   hover"*, exposed through `notch_hover_health` and the `active` field of
   `NotchHoverHealth`. `lib.rs` (~line 91) resigns active once the last panel closes
   **specifically to bring hover back**, and comments that hover "went dead after any
   panel/approval interaction". The onboarding window is `focusable` and frontmost, which
   is exactly that state.
2. **The local monitor never sees a cursor over the notch.** The overlay is
   `set_ignore_cursor_events(true)`; `hover.rs`' header opens by saying CSS `:hover` can
   never fire there, and its own `install` comment says the global monitor exists because
   "while the overlay is click-through, moves over it are delivered to whatever is
   underneath". A cursor over the notch is therefore not delivered to any window of ours.
   The onboarding card is 900x640 in the middle of the screen, nowhere near it.

Also note `observe()` — the only function that emits `notch_hover` — is called **only**
from the two monitor callbacks. The watchdog thread samples the cursor every 250 ms but
never emits; it only forces click-through.

### What was done instead

`notch` is **not** in `GATED_STEPS` (`steps.ts`, pinned by a unit test). The page shows an
accurate CSS recreation of the notch expanding, on the shell's own
470 ms / `cubic-bezier(0.32, 0.72, 0, 1)`, and advances freely. It **still subscribes** to
`notch_hover` via `useNotchHoverProbe` and shows a confirmation if one ever arrives — the
probe can only add a confirmation, never withhold one, so it is safe to leave in.

### Optional hand-off to worker 2 (NOT required for this branch to ship)

If a real hover gate is ever wanted, the Rust side must emit `notch_hover` from a source
that survives our own app being active. The UI needs no change — the probe is already
wired. Options, in order of preference:

1. In `notch/hover.rs::spawn_watchdog`, let the watchdog's existing 250 ms
   `platform::cursor_location()` sample feed `runtime.observe_cursor(...)` and emit the
   edge, at least while the onboarding window is visible. The sampling already happens; only
   the emit is missing, and it is the one path that does not depend on event delivery at all.
2. A dedicated local `NSEvent` monitor is **not** sufficient on its own here, for the
   reason in (2) above — the overlay is `ignoresMouseEvents`, so there is no window of ours
   under the cursor to deliver to.

---

## 2. Stubs and placeholders to reconcile at merge

| Path | What it is | Action at merge |
|---|---|---|
| `app/src/lib/sfx.ts` | **MERGE STUB.** No-op module with the agreed signatures. Only exists because this branch cannot compile an import of a file that is not on it. | **Delete / take the `feat/ui-sfx` worker's version.** Git will report it as an add/add conflict, which is deliberate — it announces itself. Verify `CueName` includes `forward`, `back`, `check`, `success`, `complete`, `press`. |
| `app/onboarding.html` | Written here (3 lines, modelled on `bridge.html`) because the page could not otherwise be looked at. Worker 2 also owns a placeholder. | Keep one copy. **Then add it to `rollupOptions.input` in `app/vite.config.ts`** — this branch deliberately does not touch that file, so a production build currently does **not** emit the onboarding entry. Vite's dev server serves it regardless, which is why `npm run dev` works. |
| `app/src/onboarding/main.tsx` | Same — written here; worker 2 also owns a placeholder. | Keep one copy; the shapes should be identical. It carries this note in its own doc comment. |

A dynamic `import()` was considered instead of the sfx stub and rejected: Vite resolves
dynamic specifiers at build time too, so it fails identically, and the one form that does
not (`@vite-ignore` + a non-analyzable specifier) would keep failing *after* the merge,
silently and forever.

No file under `app/src-tauri/**` was created or edited. `app/vite.config.ts` was not touched.

---

## 3. Files

**Created**

- `app/src/onboarding/steps.ts` + `steps.test.ts` — the pure flow machine (15 tests)
- `app/src/onboarding/useShortcutProbe.ts` + `useShortcutProbe.test.ts` — the gesture rules (20 tests)
- `app/src/onboarding/usePermissions.ts` — live snapshot, event + poll
- `app/src/onboarding/bridge.ts` — every `onboarding_*` command, each degrading to a neutral value
- `app/src/onboarding/sfx.ts` — the six cues this window may play, and why two are unused
- `app/src/onboarding/OnboardingRoot.tsx` — card, page turn, window keyboard, live region
- `app/src/onboarding/icons.tsx` — the window's two glyphs
- `app/src/onboarding/Clip.tsx` — video/still + the reduced-motion rule
- `app/src/onboarding/pages/{Welcome,Permissions,PushToTalk,TypePrompt,Notch,Ready}Page.tsx`
- `app/src/onboarding/main.tsx`, `app/onboarding.html` — see §2
- `app/src/lib/sfx.ts` — **stub**, see §2
- `app/src/assets/onboarding/blob-hero-still.png` — extracted from the clip; see §4

**Edited**

- `app/src/index.css` — one appended `Onboarding window` section at the end. **No existing rule modified.**

**Committed (were untracked)**

- `app/src/assets/onboarding/**` — the prepared media

---

## 4. Design notes worth knowing

- **Motion.** Page-to-page is a horizontal slide + fade on `470ms` /
  `cubic-bezier(0.32, 0.72, 0, 1)` — the notch's own values, restated rather than imported
  because `--shell-motion` is declared on `.notch`, which never exists in this document.
  Forward slides left, back slides right. The stage never resizes.
- **Two pages are mounted during a turn** (outgoing + incoming, absolutely stacked), and a
  `setTimeout` of exactly the motion duration unmounts the outgoing one. A timeout rather
  than `animationend`, because a missed event would strand a dead page over the live one
  forever.
- **The lesson pages are two columns.** Stacked, the portrait keycap clip plus the face
  plus a heading plus a result line overflows 640 px and everything has to shrink.
- **The face is `BlobatarFace` + `FACE_PLACEMENTS.panel`**, unchanged. That table chooses
  size and gaze excursion *together* and is pinned by a unit test; a third placement
  invented here would reintroduce the "hareketsiz" bug it exists to fix.
- **Colour budget:** black, `--color-notch-text`, `--color-notch-muted`, and
  `--color-notch-accent` spent on exactly one meaning — "this is done". Everything else
  that glows is inside the media.
- **`blob-hero-still.png` was added** because the hero clip materialises the creature out
  of nothing: its first frame (the shipped poster) is an all-but-empty rectangle. Correct
  as a poster, useless as the reduced-motion still.
- **Skipping is recorded, not conflated with passing.** The final page says something
  different when anything was skipped, rather than congratulating a setup that is not
  finished.
- **Accessibility:** real `<button>`s throughout, one `aria-live` region for the whole
  window, Enter/Space advance (suppressed when a button already has focus, or it would
  advance twice), Escape closes, focus moves to the new page on arrival, one
  `:focus-visible` ring for every control.

---

## 5. Verification

| Command | Result |
|---|---|
| `cd app && npx tsc -p tsconfig.json` | clean |
| `cd app && npm test` | **413 / 413 pass**, 0 fail (35 of them new) |
| `caffeinate -i bash scripts/check.sh` | `== all checks passed` (JS typecheck all workspaces, stellar tests, **vite production build**, agent smoke, `cargo check`) |

Checked by hand in a browser at 900x640 (`npm run dev` + `/onboarding.html`):

- All six pages render and turn.
- Push-to-talk gate: a 580 ms synthetic Control+Option hold showed "Keep holding…" during
  and "That is the whole gesture." after; Continue enabled.
- Double-Control gate: two 60 ms taps 120 ms apart passed the step.
- The skipped ending copy appears after skipping permissions.
- Reduced motion swaps `<video>` for the PNG still (`key-control-option.png`).
- Console outside Tauri carries only the designed "command unavailable" warnings — no errors.

Two unit tests found real bugs while being written: `skipStep` advanced *before* recording
the skip, so `canAdvance` still returned `false` and the escape hatch on an unsatisfied
gate was dead; and `tapEventFor` had to be handed the timestamp rather than fabricating one.

---

## 6. Deliberately left undone

- **Live Tauri run.** Not attempted — worker 2's window does not exist on this branch, and
  the brief said not to. Every `onboarding_*` command is therefore **unexercised against
  real Rust**; only the fallback path has run. Needs a human once both branches are merged.
- **The `onboarding_open` / `onboarding_reset` commands are wrapped but never called** from
  the UI. `open` is the window's own job and `reset` belongs in the Debug panel; both are in
  `bridge.ts` so whoever wires them has a typed seam.
- **`onboarding_state()` is wrapped but not consulted.** Deciding whether to show first run
  at all is the native side's call (it decides whether to create the window); re-checking it
  in the webview would be a second, racier source of truth.
- **No `vite.config.ts` entry** — out of scope, see §2.
- **`hover` and `focus` sfx cues are unused** by design; documented in `sfx.ts`.
- **No i18n.** All copy is English per the project language rule; if the product later needs
  Turkish first-run copy, every string is in the six page components and nowhere else.
- **A native Control+Option hold will start a real capture.** `hotkey.rs::apply` calls
  `capture.start(app)`, so passing page 3 natively records a real WAV. Arguably correct for
  a "now you try it" lesson, but the coordinator should decide whether first run should
  suppress it.

## 7. Merge resolution — rebased onto `d864627` (main after #33 and #34)

The branch was **rebased** (not merged) onto `d864627` — main carrying the
UI-sound layer (#33) and the native first-run window plus rehearsal mode (#34).
Four conflicts came up and were resolved like this:

- **`app/src/lib/sfx.ts`** — the merge stub from §2 is **gone, not merged**: the
  add/add conflict was resolved in main's favour, so `@/lib/sfx` is #33's real
  module. `app/src/onboarding/sfx.ts` remains the single import site, which is
  the reason that re-export layer existed in the first place.
- **`app/onboarding.html` + `app/src/onboarding/main.tsx`** — **one copy, this
  branch's**. The native worker's placeholder occupied the same two paths, so
  the add/add pair was kept from here and the placeholder discarded.
  `app/vite.config.ts` arrived with #34 and already lists `onboarding.html` in
  `rollupOptions.input`, so the window is in the production build: a clean
  `vite build` emits `dist/onboarding.html` plus its own `assets/onboarding-*.js`
  chunk. The stale merge note at the top of `main.tsx` was replaced with that
  fact, so nobody later reads an instruction that no longer applies.
- **`backlog.md`** — both index rows kept (UI-SFX from #33, ONBOARDING-UI from
  this branch), and this row's old caveat ("`app/src/lib/sfx.ts` is a merge stub
  and `onboarding.html` still needs a `vite.config.ts` entry") was dropped
  because it no longer describes the tree.
- Nothing else needed a decision: the six pages, the step machine, the two
  probes and the media touch no file #33 or #34 changed.

### §6's open item is closed by #34, not by this branch

Section 6 ended with *"a native Control+Option hold will start a real capture …
the coordinator should decide whether first run should suppress it."* #34
answered it with **rehearsal mode**: while the onboarding window is visible,
`onboarding::is_rehearsing` makes `hotkey::apply` and `notch::tap` inert, so
both gesture lessons are side-effect free. This side needed no change —
`useShortcutProbe` reads the native events *and* plain DOM key events on the
focused window, so the lessons still gate while the Rust pipeline stays silent.

### Verified on the rebased branch

`tsc -p tsconfig.json` clean; `npm test -w @polaris/app` **437/437**;
`vite build` green with the onboarding entry emitted.

