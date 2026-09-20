# Report: blobatar-avatar

- **Date:** 2026-09-20
- **Worker/Agent:** Claude Opus 5 (worker)
- **Branch/Worktree:** `feat/blobatar-avatar` / `.worktrees/blobatar`
- **PR:** see the index row in `backlog.md`

## Objective

Give Polaris a visible identity: an animated avatar in the notch that reacts to
the voice pipeline stage (`listening` / `thinking` / `speaking`), never drawn
while the shell is collapsed.

## What landed

| File | Change |
|---|---|
| `app/package.json` | `blobatar@2.7.0`, `@blobatar/react@2.7.0` — exact pins, matching the file's existing no-caret style. Installed from the repo root (npm workspaces). |
| `app/src/notch/faceState.ts` | **New.** The pure, tested half: seed/size/palette constants, `FaceMood`, `faceMoodFor`, `FACE_EXPRESSIONS` + `faceExpressionFor`, `shouldRenderFace`. |
| `app/src/notch/faceState.test.ts` | **New.** 10 `node --test` cases (see "How it was tested"). |
| `app/src/notch/BlobatarFace.tsx` | **New.** Mounts `<Blobatar>` with those values; imports `blobatar/motion.css`. |
| `app/src/notch/ShellSurface.tsx` | Renders the face in the status strip's right ear, gated on `shouldRenderFace(applied)`. |
| `app/src/index.css` | New `.notch-trail` (right-ear flex row) + `.notch-face`; `.notch-indicator` loses its own `grid-column`/`justify-self` (the wrapper carries them now); reduced-motion block covers the entrance animation. |

## API facts found in the installed packages

Read from `node_modules/blobatar/dist/*.d.ts` and `motion.css` rather than from
memory. The ones that changed the design:

1. **`BlobatarProps`** = `{ name }` + `BlobatarOptions`
   (`size`, `background`, `palette`, `hue`, `tone`, `normalize`, `contrast`,
   `title`, `animate`, `expression`, `traits`) + a **discriminated union** on
   `animate`: without it the component renders an `<img>` (and accepts
   `ImgHTMLAttributes`); with it, inline `<svg>` (and `SVGProps`). `onLoad`
   deliberately stops type-checking once animation is on.
2. **Expressions are imported values, not strings.** `blobatar/expression`
   exports `idle, happy, sad, mad, surprised, wink, sleepy, smug, unsure,
   scared, love, shy, sick, thinking` as `Expression` objects, precisely so the
   poses you do not import never enter the bundle. A `Record<FaceMood,
   Expression>` is therefore the natural shape, and it is directly testable by
   object identity.
3. **The morph is free, and it is a CSS transition.** `motion.css` registers 15
   `--mo-*` pose channels with `@property` and puts `transition-property` on
   `.mo-root`; `--mo-morph` is ~0.3 s adopting a pose (`.mo-expr`) and ~0.4 s
   returning to idle. So changing the `expression` prop morphs by itself — there
   is nothing to hand-roll, and hand-rolling would fight it.
4. **…but only if the element is not remounted.** `render.d.ts` documents the
   invariant explicitly: nothing that varies with `expression` may appear in the
   `innerHTML` half, because a brand-new element has no previous computed value
   and "the morph would not be slow or wrong; it would not exist", and every
   idle loop underneath would restart from phase zero. **This is the trap that
   shaped the wiring:** the face is mounted/unmounted on the *shell-state*
   boundary only, never on the stage boundary. A naive `key={stage}` or a
   per-stage conditional render would have looked fine in a screenshot and
   killed every transition.
5. **`animate` is `"hover" | "always"`.** `"hover"` is the default-ish choice for
   grids; `.mo-always` is the documented escape hatch for a single avatar. The
   notch expands on a hotkey with the pointer elsewhere, so `"hover"` would
   freeze the face during exactly the turn it exists for → `"always"`.
6. **`blobatar/react` is deprecated and frozen** (removed in v3);
   `@blobatar/react` re-exports the same object. We import from `@blobatar/react`.
   Its peer range is `blobatar: 2.x` and the set is released in lockstep, so the
   two versions must stay equal.
7. **`prefers-reduced-motion` is handled by the library**: `motion.css` drops
   every animation *and* transition under the query, leaving a still face that
   still changes pose. Only our own entrance keyframe needed adding to the app's
   reduced-motion block.
8. **Gaze was evaluated and deliberately skipped.** `useGaze` needs `gaze.css`
   *and* a `--mo-track-travel` custom property to opt in; without it the hook
   renders and never moves — the documented classic failure mode. During a
   push-to-talk turn the user is talking, not moving the mouse, so pointer
   tracking would add a stylesheet, a hook and a silent-failure mode to buy
   almost nothing. `surprised` carries "listening" on its own.

## Stage → pose mapping, and why

| Shell `visual` | `inlineVoiceStage` | mood | pose | Why |
|---|---|---|---|---|
| anything else | `null` | `idle` | `idle` | The library's resting pose = every channel at its registered initial value, so returning to it transitions instead of snapping. Breathing/blinking/saccades still run: alive and waiting, not off. |
| `recording` | `listening` | `listening` | `surprised` | The roster's only pose that **enlarges** the eyes (`esy` 1.34, where every other pose squashes below 0.6). At 22 px it cannot be confused with anything else — the widest possible read for "the mic is hot". |
| `transcribing` | `thinking` | `thinking` | `thinking` | Purpose-built: two level eyes at mismatched heights trading places on a loop — the two-dot loader everybody already reads, on a face that already has exactly two dots. The only pose whose message is a *duration*, which is what a pending turn is. |
| `speaking` | `speaking` | `speaking` | `happy` | Wide flat arcs riding high. The library is pose-only and a blob has **no mouth**, so nothing in the roster can mime talking; the honest choice is the lively, engaged pose rather than a fake mouth. |

The test `no two moods share a pose` pins the thing that actually matters: a
stage change the user cannot see is the same as no stage change at all.

## Placement

The face sits in the **status strip's right ear**, to the left of the three
indicator dots (new `.notch-trail` flex row at grid column 3). Reasons:

- The left ear is the stage label, which already relies on `text-overflow:
  ellipsis` inside a 110 px ear (`EAR_WIDTH`); labels like "Approval timed out"
  are long. Spending ~30 px there would have made ellipsising routine.
- The dots keep the ear's trailing edge, so the indicator's purple radial wash
  stays anchored exactly where it was. Nothing existing moved.

`shouldRenderFace(applied)` excludes two states:

- **`collapsed`** — the requirement. The collapsed shell *is* the camera cutout;
  content there is faded out and the middle column is the physical housing.
- **`prompt`** — `ShellSurface` removes the strip from the tree entirely while
  the typed prompt owns the surface, and the prompt already carries the stage
  through its own inline indicator. Mounting a face into a *content-driven*
  state would also feed the height measurement that sizes the native window.

It is written as an exclusion list, not an allow-list, so a new Rust state-table
row gets a face without a TypeScript edit — the same "one table row" promise
`shellState.ts` keeps.

## How it was tested

- `caffeinate -i bash scripts/check.sh` — green (tsc across workspaces, stellar
  tests, app build, agent smoke, `cargo check` on the Tauri shell).
- `npm test -w @polaris/app` — **372 pass / 0 fail** (362 before; +10 new).
- New cases in `faceState.test.ts`: collapsed has no face; `compact` (the
  Control+Option push-to-talk state) and `panel` do; `prompt` does not; an
  unknown future state does; `null` stage rests at idle; each stage is its own
  mood; each mood holds its documented pose; no two moods share a pose; the
  table is total over the union; and the full `visual → stage → mood → pose`
  chain end to end.
- `npm run build -w @polaris/app` — green; the `blobatar/motion.css` subpath
  import resolves under Vite (it lands in `main-*.css`).

## Bundle delta (measured, minified)

| Asset | Before | After | Δ | Δ gzip |
|---|---|---|---|---|
| `main-*.js` | 659,154 B | 671,831 B | **+12.4 KB** | **+5.5 KB** |
| `main-*.css` | 45,151 B | 53,503 B | **+8.2 KB** | **+1.4 KB** |

**~+7 KB gzipped total.** That is in line with the library's claim of being
deliberately small, so there is nothing to flag. Most of the CSS delta is
`motion.css` (8,029 B raw), which is already minified at the source and
compresses well. The four expressions we import are the only poses in the
bundle; the other ten tree-shake out by construction.

## Unfinished / handed off

- **Nothing is blocked**, but three things are unverified by eye (below).
- Optional follow-up: a face in the `prompt` state. It needs a decision about the
  prompt's content-driven height measurement first, so it was left out
  deliberately rather than forgotten.
- Optional follow-up: `useGaze` for `listening`, if the owner wants the eyes to
  track the pointer while the panel is open (not while a hotkey turn runs). It
  needs `gaze.css` + `--mo-track-travel`.

## Review notes / what the owner must verify by eye

**The agent could not see the running app.** Nothing below was visually
confirmed; it is all reasoned from the geometry and the library's stylesheet.

1. **Colour.** `hue: 310` / `tone: 0.12` are *locked* (the seed drives shape
   only). Without locking, the hashed palette could have put a dark blob on the
   black shell. The exact pale magenta should be eyeballed against the
   indicator's `#b91bae`/`#f05adc` wash — `FACE_TONE` is the single knob.
2. **Size and crowding.** 22 px in a ~32 px strip, 10 px from the dots. Check it
   does not feel cramped in `compact` (110 px ear) or lost in `panel` (300 px).
3. **The morph.** The whole point: tapping through
   listening → thinking → speaking should *morph*, never hard-cut. If it snaps,
   the cause is almost certainly a remount (see API fact #4), not the CSS.
4. **The entrance.** `.notch-face` fades/scales in over `--shell-motion`; check
   it reads as arriving *with* the notch rather than after it.
5. **The collapsed shell.** Confirm no pixel of the creature survives the
   collapse tween near the cutout. The test asserts the tree, not the paint.

## Suggested next step

Owner eyeballs items 1–5 above on a real Mac, then a second worker reviews the
PR (author cannot review own code, CLAUDE.md §3).
