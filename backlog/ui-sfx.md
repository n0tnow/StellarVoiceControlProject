# UI-SFX — Minimal UI sound layer (`uisfx`)

- **Date:** 2026-09-20
- **Worker/Agent:** worker (Claude Sonnet 5)
- **Branch/Worktree:** `feat/ui-sfx` / `.worktrees/ui-sfx`
- **PR:** none (coordinator opens it)

## What was built

Integrated `uisfx@0.4.0` (MIT, WebAudio-synthesized, no bundled assets, no
network calls) as the project's single UI sound layer, behind one internal
module: `app/src/lib/sfx.ts`.

### Public API shipped (`app/src/lib/sfx.ts`)

```ts
import type { CueName, PlayOptions } from "uisfx";

export function playSfx(cue: CueName, options?: PlayOptions): void;
export function unlockSfx(): Promise<boolean>;
export function setSfxEnabled(enabled: boolean): void;
export function isSfxEnabled(): boolean;
export function useSfx(): typeof playSfx;
```

Exactly the contract specified, plus one extra, deliberately-not-public test
seam: `export const __testing = { setPlayer, reset, readStoredEnabled,
prefersReducedMotion, initialEnabled, STORAGE_KEY }`, so `sfx.test.ts` can
inject a fake `UISFXPlayer` without constructing a real `AudioContext`. The
onboarding worker consuming this module should treat `__testing` as
private/unstable and only import the five contract functions.

Key implementation choices:
- The player is built lazily on first call to any exported function (never at
  import time), guarded by `typeof window === "undefined"` and wrapped in
  try/catch. Any failure sets the cached player to `null` and every exported
  function degrades to silence from then on.
- Config: `pack: "minimal"`, `volume: 0.35`, `cooldownMs: 40`.
- Persistence uses `uisfx`'s own `preferences: { key: "polaris.sfx.enabled",
  storage: window.localStorage }` — confirmed by reading `uisfx`'s bundled
  `dist/index.js`: it JSON-serializes `{pack, volume, enabled}` under that key
  and reloads it on construction, taking precedence over the constructor's
  `enabled` option whenever a stored value exists. So the module's own
  `initialEnabled()` computation only matters on a genuine first run.
- First-run default: enabled, *unless* `prefers-reduced-motion: reduce`
  matches *and* nothing has been stored yet — in which case it starts
  disabled. A stored preference (once the user has ever toggled it) always
  wins over the reduced-motion signal.
- `unlockSfx()` is armed automatically on module load via a one-shot
  `pointerdown`/`keydown` listener on `document`, guarded by the same
  `hasWindow()` check so it's a no-op under `node --test`.

## Every call site wired

1. **`app/src/notch/ShellSurface.tsx`** — one `useEffect` on `applied`
   (the committed shell state): `playSfx("open")` when it lands on `panel` or
   `prompt`, `playSfx("close")` when it returns to `collapsed`. No cue on any
   other transition, and in particular the `collapsed <-> compact` push-to-talk
   transition is silent by construction (it isn't in the
   `open`/`close`/other-else branches) — the comment above the effect explains
   why: that transition fires on every hotkey press/release while a turn's TTS
   may already be speaking, and a click cue racing the voice audio would read
   as a glitch.
2. **`app/src/notch/MoreMenu.tsx`** — `playSfx("hover")` on each menu item's
   `onMouseEnter`/`onFocus`, `playSfx("select")` on `onClick` (before the item
   runs and the menu closes).
3. **`app/src/components/ui/button.tsx`** — wired, not skipped.
   `playSfx("press")` fires on every `Button`'s `onClick`, composed with
   whatever `onClick` the caller passed (their handler still runs). It's used
   by ~16 call sites app-wide (approval Approve/Deny, settings, wallet,
   schedules, etc.), so this is a broad, deliberate choice: one shared cue
   beats each call site remembering to wire its own, and a light `press` tap
   underneath an outcome cue (see ApprovalPanel below) reads as tactile
   feedback followed by a result, not a double-cue glitch.
4. **`app/src/panels/ApprovalPanel.tsx`** — `playSfx("success")` when
   `commands.authorize()` resolves (before dispatching `authorizeOk`);
   `playSfx("error")` when `commands.authorize()` rejects, and also on both
   the resolve and reject paths of `commands.deny()` (a successful deny is
   still a rejection outcome from the user's perspective, per the task spec:
   "error when denied or failed").

## What was deliberately skipped, and why

- Nothing from the assigned wiring list was skipped — all four call sites in
  the task were wired as specified. `button.tsx`'s `press` cue was flagged as
  "skip if invasive" in the task, but with only 16 call sites and a simple
  `onClick` composition (no state, no re-render cost, forwards the caller's
  own handler), it was not invasive enough to skip.
- No `soundUrl()` usage and nothing copied out of `uisfx/sounds/*` — confirmed
  unnecessary; `uisfx` synthesizes every cue with WebAudio at play time.
- No changes to `app/src-tauri/**`, `app/vite.config.ts`, `app/onboarding.html`,
  or `app/src/onboarding/**`, per scope.

## Test / typecheck results (all run from the worktree)

- `cd app && npm install` — added `uisfx@0.4.0` (hoisted to the workspace
  root `node_modules`, since `app` is an npm workspace member), lockfile
  updated. 516 packages added, 19 pre-existing audit advisories (unrelated to
  this change, not investigated further).
- `cd app && npx tsc -p tsconfig.json` — **clean**, no output.
- `cd app && npm test` — **392/392 passed**, 0 failures (14 of those are the
  new `src/lib/sfx.test.ts` cases: forwarding to an injected player, silent
  no-op on a `null` player, silent no-op when the injected player's `play()`
  throws, `setSfxEnabled`/`isSfxEnabled` delegation, `unlockSfx` resolving
  `false` on a `null` player and swallowing a rejected `unlock()`, `useSfx`
  reference stability, and the pure preference/reduced-motion helpers under
  `__testing` with no `window` present). No `AudioContext` is constructed
  anywhere in the test run.
- `caffeinate -i ./scripts/check.sh` (from the worktree root) — **all checks
  passed**: JS typecheck across all workspaces, `@polaris/stellar` tests,
  `vite build` of the `@polaris/app` shell, the `@polaris/agent` skeleton
  smoke test, and `cargo check` on the Tauri shell (included a ~1m06s Rust
  compile; no errors).

## Remaining work

- None outstanding for this task's scope. The onboarding worker consuming
  `useSfx`/`playSfx` should call `unlockSfx()` is already armed automatically
  on module load — no action needed on their side beyond importing
  `playSfx`/`useSfx` from `@/lib/sfx`.
- Not investigated: the 19 `npm audit` advisories surfaced by `npm install`
  are pre-existing to the workspace (transitive, unrelated to `uisfx`) and out
  of this task's scope.

## Review Notes

- (for reviewer) Worth double-checking: whether `press` on every `Button`
  click is the right call app-wide vs. scoping it narrower — I judged it
  in-scope per the task's explicit "wire it, or skip and say so" instruction,
  and it reads as tasteful in combination with the `success`/`error` cues on
  ApprovalPanel, but a reviewer with the full app in front of them may want to
  dial `press`'s volume down further or exclude specific `variant`s (e.g.
  `ghost`) if it turns out busy in practice.

## Suggested Next Step

- Coordinator: open the PR from `feat/ui-sfx` to `main`, assign a separate
  reviewer per §3 of `CLAUDE.md`/`AGENTS.md`.

## Review fixes applied

Applied against `backlog/ui-sfx-review.md` (verdict: REQUEST CHANGES).

- **Finding 1 (must fix) — the "deliberately silent" voice strip was not
  silent.** `ShellSurface.tsx` now plays `close` only when `previous` was
  `panel` or `prompt`, so `compact -> collapsed` (the end of every
  push-to-talk turn) is silent as documented. The comment still states why the
  voice strip is silent (TTS collision), now for both directions.
- **Finding 2 (must fix) — fail-silent contract untested.** Added 10 cases to
  `sfx.test.ts`: throwing `localStorage.getItem`/`setItem`, malformed JSON, a
  non-boolean stored `enabled`, the stored-preference-beats-reduced-motion
  precedence both ways, the no-stored + reduced-motion default, `PlayOptions`
  forwarding, and a construction failure that is cached (no retry-construct).
  They install a fake `window` for the read/parse branches and exercise the
  real `createUISFX` path for the throwing-storage calls (no `AudioContext` is
  constructed; `play` returns `null` without one).
- **Finding 3 (judgement call) — `press` scope.** Chose a targeted scope rather
  than removing the wiring: `Button` gained a `sound?: boolean` opt-out and the
  `danger` variant is always silent; `sound={false}` was set on the DebugPanel
  harness (4 controls) and the repeated refresh/reload controls (Wallet,
  Schedules, Security, P2P refresh + P2P load-more). Ordinary single-action
  buttons, including Approval Approve/Deny, keep the cue — the author's
  press-then-outcome reading is fine there.
- **Finding 4 — MoreMenu spurious `hover` on programmatic open focus.** Dropped
  the `onFocus` cue entirely and kept `onMouseEnter` only (the review's first
  suggestion). This removes the no-pointer chirp on open and avoids the
  hover+focus+select triple-cue a pointer click would otherwise produce.
  Keyboard users still get the visual focus ring.
- **Finding 5 — doc comments.** Corrected the header's "why not eager"
  rationale to the user-gesture requirement, and corrected the
  `initialEnabled()` doc to `options.enabled ?? stored.enabled ?? true` (the
  constructor option wins over storage; the storage re-read here is what keeps
  a stored preference effective).
- **Nits.** Not changed: `__testing` still lives in the production module
  (documented private seam; splitting it is a separate refactor), and
  `setSfxEnabled`/`isSfxEnabled` remain unused by the UI pending the
  onboarding toggle consumer (still valid backlog work). `button.tsx` keeps
  its pre-existing missing trailing newline.

Verification after fixes: `npx tsc -p tsconfig.json` exit 0; `npm test`
402/402 pass (was 392; +10 new cases).
