# UI-SFX review — PR #33 (`feat/ui-sfx` → `main`)

- **Reviewer:** separate reviewer (per AGENTS.md §3; did not write this code)
- **Date:** 2026-09-20
- **Scope reviewed:** `main...HEAD` — `app/package.json`, `app/src/lib/sfx.ts`,
  `app/src/lib/sfx.test.ts`, `app/src/components/ui/button.tsx`,
  `app/src/notch/ShellSurface.tsx`, `app/src/notch/MoreMenu.tsx`,
  `app/src/panels/ApprovalPanel.tsx`, `backlog.md`, `backlog/ui-sfx.md`,
  `package-lock.json`.

## Verdict

**REQUEST CHANGES** — small, targeted. The module design is sound (lazy,
fail-silent, reduced-motion-aware, no-network, exactly-pinned) and both
verification commands pass. Two issues must be resolved before merge:

1. The explicit "the `collapsed <-> compact` voice-strip transition is
   deliberately silent" invariant does **not** hold: `close` fires on the
   `compact → collapsed` direction. The one-line fix (or a corrected comment)
   is in `ShellSurface.tsx`.
2. The tests do not exercise the branches the fail-silent contract actually
   depends on (blocked/private-mode `localStorage`, JSON parsing, the
   stored-wins/reduced-motion precedence). They mostly assert on the injected
   fake or the `!hasWindow()` early return.

Everything else is approvable. If the team decides a close chirp at the end of
a voice turn is acceptable, finding 1 reduces to a comment correction and the
verdict becomes **APPROVE WITH NITS**.

## Verification (run in this worktree; real output)

```
$ cd app && caffeinate -i npx tsc -p tsconfig.json
TSC EXIT: 0
(no output)
```

```
$ cd app && caffeinate -i npm test
...
# tests 392
# suites 0
# pass 392
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2132.106083
TEST EXIT: 0
```

- `tsc` is clean.
- 392/392 tests pass. The 14 new `src/lib/sfx.test.ts` cases are tests
  #156–#169 and all pass. No `AudioContext` is constructed during the run.

I also read the installed dependency to check the claims against it:
`node_modules/uisfx/dist/index.js` and `dist/index.d.ts` (0.4.0, MIT, zero
declared dependencies). Cue names used (`hover`/`press`/`select`/`open`/
`close`/`success`/`error`) all exist; `UISFXOptions` accepts `pack`, `volume`,
`enabled`, `cooldownMs`, `preferences`; `play()` returns `null` when there is
no `AudioContext`; `play()` gates on the enabled flag internally.

## Findings (most severe first)

### 1. The "deliberately silent" voice-strip transition is not silent on the close path — `app/src/notch/ShellSurface.tsx:106-116`

The effect plays `open` when `applied` lands on `panel`/`prompt` and plays
`close` whenever `applied` becomes `collapsed` (`:113-114`). `previous` is read
at `:108` but is only used for the equality early-return at `:110`; it is never
used to distinguish *which* state we came from.

The voice source proposes `compact` while a turn is live and `collapsed` once
the session clears (`app/src/lib/turnSession.ts:296-297`; active stages and the
terminal dwell keep `session !== null`, and only the `settled` signal nulls it —
`turnSession.ts:245-247`). So the turn-end transition is literally
`compact → collapsed`, and that hits the `else if (applied === "collapsed")`
branch: `close` plays.

This contradicts the invariant the comment at `:100-105` states (`collapsed <->
compact` is silent), and the same claim in `backlog/ui-sfx.md` ("No cue … it
isn't in the open/close/other-else branches"). With the current state machine
the feared collision with TTS does not occur — the collapse happens *after*
`speech_finished` → `done` → dwell → `settled` — so the audible harm is mild
(one `close` chirp at the end of a voice turn). But the code does not do what it
says, and a future stage change could make `compact → collapsed` happen while
audio is live.

**Fix (one of):**
- Honor the stated invariant:
  ```ts
  } else if (applied === "collapsed" && previous !== "compact") {
    playSfx("close");
  }
  ```
- Or accept the turn-end close cue deliberately and rewrite the comment at
  `:102-105` plus the backlog claim so they describe actual behaviour.

Either way, `previous` should then be used for its intended purpose instead of
being captured and ignored.

### 2. Tests cover the fake and the no-window return, not the fail-silent branches — `app/src/lib/sfx.test.ts:117-129`

The 14 cases are real assertions about the wrapper (forwarding to the injected
player, swallowing a throwing `play()`, swallowing a rejected `unlock()`,
`useSfx` reference stability) — those are genuine. But the tests that look like
they cover the interesting logic only exercise `!hasWindow()`:

- `readStoredEnabled` (`:117`) only asserts the `typeof window === "undefined"`
  early return; the JSON parse, the `typeof parsed.enabled === "boolean"` guard,
  and the `catch` for throwing storage are untested.
- `prefersReducedMotion` (`:121`) only asserts the no-window `false`.
- `initialEnabled` (`:125`) only asserts the no-window default; the
  stored-wins-over-reduced-motion precedence (`sfx.ts:73-77`) is untested.

The exact situation the review brief calls out — `localStorage` **throws** in
private mode / blocked storage — is never exercised. Since the module's central
promise is "never throws", that is the most important missing test.

Also untested: `playSfx(cue, options)` forwarding of `PlayOptions`
(`sfx.ts:111-119` passes `options` through, but no test asserts it arrives), and
the real `createUISFX` configuration (`sfx.ts:95-101`).

**Fix:** inject a fake `window`/`storage` into the pure helpers (or export a
narrower seam) and add cases for: throwing `getItem`; `JSON.parse` garbage;
`enabled` non-boolean; stored `false` beating reduced-motion; options
forwarding. This is where a regression would actually hide.

### 3. `press` in the shared `Button` hits every call site, including destructive and debug controls — `app/src/components/ui/button.tsx:43-49`

Wiring `playSfx("press")` into the shared component is a defensible
"one-cue" choice, and the handler composition is correct (the caller's `onClick`
still runs; `onClick` is destructured out so the spread cannot clobber it).
But the app-wide blast radius (~16+ call sites) means the cue also lands on
controls where it reads wrong for a quiet, premium surface:

- `app/src/panels/security/ProfileForm.tsx:227` — `variant="danger"`,
  "Disable auto-pay": a cheerful `press` on a destructive disable.
- `app/src/panels/approval/ApprovalCard.tsx:162-182` — Approve/Deny each get
  `press`, then `success`/`error` from `ApprovalPanel.tsx:95-121`; Deny is a
  low-confidence action that now emits two cues (press + error).
- `app/src/panels/DebugPanel.tsx:229-239` (Copy report / Run all) — a debug
  harness is exactly where UI sound should not be advertising itself.
- `app/src/panels/SchedulesPanel.tsx:95` and
  `app/src/panels/P2pPanel.tsx:202,217` — refresh/reload controls a user can
  click repeatedly; `cooldownMs: 40` softens but does not remove the machine-gun
  feel on a held/rapid click.

**Fix:** either exclude by `variant` (e.g. skip `danger`, optionally `ghost`),
add an opt-out prop (`sound?: boolean`), or scope `press` to the call sites
where it reads as tactile confirmation. At minimum, drop it from the
destructive/diagnostic controls above. (The author flagged this in
`backlog/ui-sfx.md` "Review Notes"; I agree it needs a narrower scope.)

### 4. Opening the MoreMenu emits a spurious `hover` cue via programmatic focus — `app/src/notch/MoreMenu.tsx:42,87`

When the menu opens, the effect focuses the first item (`:42`), which fires the
item's `onFocus` → `playSfx("hover")` (`:87`). So merely opening the "⋯" menu
plays a hover sound with no pointer involved, and click-through focus restoration
can repeat it. The focus cue is a reasonable idea, but `hover` is the wrong
semantic for it and the automatic-first-focus makes it fire unconditionally.

**Fix:** use `onMouseEnter` only, or gate the `onFocus` cue so it does not fire
for the programmatic open focus (e.g. skip while `open` just became true), or
use a distinct `focus` cue (`uisfx` has one) rather than `hover`.

### 5. Doc comments describe `uisfx`'s precedence backwards (and one rationale is inaccurate) — `app/src/lib/sfx.ts:12-15,68-72`

The header says an eager `createUISFX` "would crash the test run"; reading
`node_modules/uisfx/dist/index.js`, `createUISFX` never touches `AudioContext`
(only `play`/`preload`/`unlock` do, via a lazy `AudioContext` lookup) and its
preference read is already `try`/`catch`-guarded, so it would not throw without
`window` — the lazy design is still justified by the user-gesture requirement,
but the stated reason is wrong.

`sfx.ts:68-72` says the stored value wins and "this default is ignored".
`uisfx` actually computes `enabled = options.enabled ?? stored.enabled ?? true`
— the constructor option wins over storage. Behaviour is still correct only
because `initialEnabled()` itself re-reads storage (`:73-77`); if someone later
"simplifies" that away, stored preferences would silently stop applying.

**Fix:** correct both comments to state the real precedence, and keep the
"why not eager" rationale tied to the gesture requirement rather than a
non-existent crash.

## Verified correct (no action)

- **Fail-silent contract.** `playSfx` cannot throw: `getPlayer()` is internally
  `try`-wrapped (`sfx.ts:94-107`) and `instance.play()` is wrapped (`:114-118`);
  the same pattern covers `unlockSfx`/`setSfxEnabled`/`isSfxEnabled`.
- **Lazy construction.** Importing the module does not construct an
  `AudioContext`: the only module-level side effect is adding one-shot
  `pointerdown`/`keydown` listeners (`sfx.ts:166-174`); the player is built on
  first exported call.
- **Gesture listener.** `arm` removes both listeners explicitly and they are
  also registered `{ once: true }` (`:167-173`), so it is idempotent and
  `unlockSfx()` is safe to call repeatedly (`:127-135`).
- **`localStorage` guarded.** Both the read (`:49-56`) and the `storage:
  window.localStorage` access inside `getPlayer` (`:100`, within the `try`) are
  guarded; a throwing storage degrades to `null`, not a throw. (Untested — see
  finding 2.)
- **`useSfx` is stable.** It returns the module-level `playSfx` directly
  (`:162-164`); no `useCallback` needed and the test confirms identity.
- **No render-path plays.** Every new call site is an event handler, an effect,
  or a promise callback — none execute during render.
- **No mount chirp.** The `ShellSurface` effect seeds `previousApplied` with the
  initial `applied` and early-returns on equality (`:106-110`), so a restored
  panel does not chirp.
- **Silence on `collapsed → compact`.** The open direction of the voice strip
  reaches no branch (destination is `compact`), so it is silent — the close
  direction is the gap in finding 1.
- **Conventions.** Dependency is exactly pinned (`"uisfx": "0.4.0"`), all new
  prose/comments are English, and the module carries the same WHY-first doc
  style as the `BlobatarFace.tsx` reference. No files outside the assigned scope
  were touched.
- **Green gates.** `tsc` clean; 392/392 tests pass (output above).

## Nits

- `sfx.ts:176-190` exports `__testing` (including the mutable `setPlayer`) from
  the production module; `sideEffects: false` on `uisfx` does not help this
  file. It is documented as a private seam, but consider a separate
  `sfx.testing.ts` (or `process.env.NODE_ENV` guard) so it cannot be imported by
  feature code.
- `setSfxEnabled`/`isSfxEnabled` are exported but no UI calls them yet, so the
  persistence and reduced-motion-default paths are currently unreachable in the
  running app (the onboarding consumer is expected to wire a toggle). Worth a
  backlog note so it is not forgotten.
- `button.tsx` still ends without a trailing newline (pre-existing; the diff did
  not introduce it).
