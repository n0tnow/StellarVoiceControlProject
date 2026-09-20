# Report: blobatar-avatar

- **Date:** 2026-09-20 (round 1), 2026-09-20 (round 2 — owner feedback + review), 2026-09-20 (round 3 — owner feedback)
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
| `recording` | `listening` | `listening` | `surprised` | The only pose in the roster that enlarges the eyes on **both** axes at once: `esx` 1.34 *and* `esy` 1.20. (Round 1 said "`esy` 1.34, every other pose below 0.6" — wrong on both counts: 1.34 is `esx`, `love` 1.28 and `unsure` 1.02 also exceed 1 vertically, and six of thirteen poses are not below 0.6. The choice survives; the number did not.) It is also the far end of the axis `speaking` sits on (`happy` is `esy` 0.30), so listening→speaking is a 4× change in eye height — the motion the small strip face actually has. |
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

## Round 2 — owner feedback (2026-09-20)

> "geldi ama hem çok küçük beklediğimden hem de hareketsiz — mouse'u izlemeli ve
> hareketlerini yapmalı."

### 1. Why it was motionless — the measured cause

**Nothing was broken, and nothing was switched off.** Read out of the running
page (a temporary harness rendering the real component under the real
`index.css`, since the shell itself needs Tauri IPC to mount):

- `blobatar/motion.css` reaches the DOM: `--mo-amp` computes to `1`.
- The discriminated union took the animated branch: the root `<g>` carries
  `mo-root mo-always`, i.e. inline SVG, not `<img>`.
- All seven idle loops exist and are `running`; `@property` is supported
  (`CSS.supports('--mo-amp','1')` is true).
- `prefers-reduced-motion` was **not** on.

The cause is arithmetic. The library authors its idle layer in **viewBox units**
— the bob is 1.1 units, the breathe 2.2%, the saccade ~1.3 units — so the
amplitude in *screen pixels* is whatever the face is multiplied by. Driving each
loop by hand through the Web Animations API and measuring the resulting
transforms:

| channel | at 22 px | at 104 px |
|---|---|---|
| bob | **0.24 px** | 1.15 px |
| breathe (body width) | **0.48 px** | 2.28 px |
| saccade | **0.29 px** | 1.37 px |

A quarter-pixel of eased drift over 3.4 s is not motion anybody can see. **"Too
small" and "motionless" were one bug, not two**, which is why the fix for both is
the same fix. (`blobatar/idle` was checked and is not the answer: it is the React
Native port of the stylesheet, for platforms with no CSS. On the web the
stylesheet *is* the idle layer and it was already running.)

One consequence worth stating plainly: **the strip face is at a hard ceiling.**
`compact` is exactly one cutout tall (~32 px, a Rust state-table value), so 28 px
is as large as the face can be there, and at that size the ambient layer is still
sub-pixel. There is no amplitude dial in the library (`--mo-rate` is a
slow-motion debugging aid, not a gain). What carries the strip face is the **pose
morph** — a 4× eye-height change between `speaking` and `listening` — and the
blink. That is a real limitation of the voice state, not something left undone.

### 2. Gaze — wired, and verified rather than assumed

`useGaze({ travel, lookAt: "pointer" })` from `@blobatar/react/gaze`, plus
`blobatar/gaze.css`. The documented failure mode is a face that renders
perfectly and never moves, so all three prerequisites were checked in the page:

- `gaze.css` is loaded (its `--mo-track-hold` rules are in `document.styleSheets`);
- `--mo-track-travel` computes to the placement's value **on `.mo-eyes`**, i.e.
  the inline property inherits down and nothing overrides it;
- after a `pointermove`, `--mo-gz-dx1` computes non-zero and the eye's `translate`
  changes.

`travel` is passed as a hook option and is deliberately set **nowhere in
`index.css`**: a rule matching `.mo-eyes` directly beats an inherited inline
value, and getting that wrong is indistinguishable from not wiring gaze at all.

It is in **viewBox units, not pixels** — the blobatar is 100 units across — so it
already scales with the rendered size. The two values differ for a perceptual
reason instead: the strip face gets the *wider* excursion (3.6 vs 2.8) because it
has so few pixels that only a near-maximum excursion registers, while the panel
face would look deranged at that amplitude.

### 3. The voice states are the face's alone

The three indicator dots are deleted from the status strip. The face is the stage
signal now, and one surface should not say the same thing twice. The
`.prompt-voice` half of every shared animation rule is untouched — the typed
prompt keeps its own inline indicator, which is a different surface with no face
in it.

### 4. Two presentations, one element

| state | size | position | gaze travel |
|---|---|---|---|
| `compact` (and any other expanded strip state) | 28 px | right ear, 16 px from the trailing edge, vertically centred in the cutout | 3.6 |
| `panel` | 104 px | content column's header band: 140 px from the shell's left edge (the nav's fixed 128 px column plus the body's padding), 14 px below the panel's top | 2.8 |

Measured in the page after the tween settles: `compact` 28 px at 2 px inset top
and bottom inside a 32 px shell; `panel` 104 px at (140, 46) from the shell
origin. Anchored to the nav's fixed column rather than to a screenshot's
coordinates, so it lands correctly at every panel width.

**The remount trap was taken seriously, and the single element survived.** The
face is a direct child of `.notch`, rendered in exactly one place in the tree;
the stylesheet moves and resizes it (`left`/`top`/`width`/`height`, all
transitioned on the shell's own curve). Rendering it inside the strip in one
state and inside the panel in the other would have remounted it, and a remount
destroys the pose morph (a CSS transition has no previous computed value on a
new element), restarts all seven idle loops from phase zero, and snaps the gaze
driver's eyes to centre because the driver holds their position.

Verified, not argued: across four stage changes *and* a `compact ↔ panel` round
trip, the `<svg>`, the `.mo-root` `<g>` and its inner markup are all
identity-stable, and the pose channels read **mid-transition** (`esx` 1.02 →
1.05 → 1.10 → 1.22) rather than snapped to their targets.

This also resolves the edge case the reviewer raised: hover-then-talk moves
`panel → compact` on the same commit as `null → listening`, and with a per-state
element that turn's first morph — the one the user is most likely watching —
would have been the one that did not happen. It now happens.

The panel's header band is reserved with
`.panel-body { padding-top: calc(var(--face-size) + 20px) }` rather than
overlaid, because an absolutely positioned face cannot push content out of its
own way. `--face-size` is published by the shell alongside every other geometry
custom property, so the band and the face cannot drift apart.

### 5. Review items folded in

1. **Entrance delay** — the old `animation: notch-face-in var(--shell-motion) …`
   bound its single `<time>` to duration, so the promised "one beat later" never
   happened. It is now a `transition` with an explicit `transition-delay: 90ms`.
2. **`surprised` numbers** — corrected in the code comment, in the stage table
   above, and in the PR body. See the table's note.
3. **`drop-shadow` halo** — removed. Inside `.notch-content`'s `overflow: hidden`
   it would have been clipped square at the strip's edge, which is exactly what
   the `.notch-indicator::before` comment existed to warn about, and the face is
   bigger now in both states.
4. **Test-coverage claim, corrected** — round 1's report said "the tests assert
   the tree, not the paint". They do not assert the tree either. All of them are
   on the pure module; the repo runs `node --test "src/**/*.test.ts"` with no
   jsdom and no testing-library, and there is no `.test.tsx` anywhere. **A DOM
   test is not possible in this repo today**, so "no face in `collapsed`" and "no
   dots in the voice states" are enforced by `shouldRenderFace` and by the
   markup's absence, and are covered by unit tests only at the level of the
   predicate — not at the level of what is mounted. Adding a DOM harness
   (jsdom + a renderer, plus `.test.tsx` in the glob) is the honest next step if
   that invariant is to be guarded automatically; it was out of scope here.

### Bundle delta after round 2

Against the same pre-blobatar baseline:

| asset | baseline | round 1 | round 2 | Δ gzip vs baseline |
|---|---|---|---|---|
| `main-*.js` | 659,154 B | 671,831 B | 677,400 B | **+7.8 KB** |
| `main-*.css` | 45,151 B | 53,503 B | 54,618 B | **+1.6 KB** |

**~+9.4 KB gzipped total**, of which the gaze driver and hook added ~2.6 KB over
round 1. `gaze.css` is 1,657 B raw. Still small; nothing to flag.

## Unfinished / handed off

- **Nothing is blocked.** What remains is judgement the owner has to make by eye
  (below).
- **No DOM test harness.** See review item 4. The mount invariants are unguarded
  by tests and will stay that way until someone adds jsdom + a renderer and
  widens the `node --test` glob to `.test.tsx`.
- **The strip face cannot animate much**, and no code change fixes that — see
  round 2 §1. If the owner wants visible ambient motion during a *voice turn*,
  the shell's `compact` height has to grow, which is a Rust state-table change
  and therefore a different task with a different owner.
- Optional follow-up: a face in the `prompt` state. It needs a decision about the
  prompt's content-driven height measurement first, so it was left out
  deliberately rather than forgotten.
- Optional follow-up: the page toolbars (refresh/trash) now sit *below* the
  header band rather than beside the face. Putting them level with it means
  touching each page's own layout, which is outside this task's file scope.

## Review notes / what the owner must verify by eye

**The agent still cannot see the running app.** Round 2's mechanism claims are
measured — computed styles, element identity and settled geometry, read out of a
real page — but *how it looks* is not, and a WKWebView is not the browser those
measurements came from. What needs a human:

1. **Does it actually move now?** The measurements say the panel face's ambient
   channels are 1.1–2.3 px and the eyes track the pointer. Confirm both in the
   app. If the panel face is still motionless there, the next suspect is
   WKWebView-specific and the first thing to check is whether
   `@container style(--mo-rock: 0)` and `@property` behave as they do in Chrome.
2. **The strip face during a Control+Option turn.** Expect the *pose* to change
   clearly and the ambient drift to be nearly invisible — that is the documented
   ceiling, not a defect. If the pose change is not obvious at 28 px, say so: the
   answer is a taller `compact` shell, not a different expression.
3. **The panel face's position and size.** 104 px at (140, 46) from the shell's
   top-left. The owner's circle was centred a little higher and further left
   (~(178, 77) with r≈62). Deliberately anchored to the layout instead; confirm
   it sits where it should at the real panel width.
4. **The header band.** `padding-top: calc(var(--face-size) + 20px)` pushes every
   page's content down by ~124 px on a 420 px panel. That is a lot of a small
   surface — check it against all four pages (History / Tasks / Rules / Wallet),
   not just History, and say if the band should be tighter.
5. **Colour.** `hue: 310` / `tone: 0.12` are locked. At 104 px the palette is far
   more visible than it was at 22 px; `FACE_TONE` is the single knob.
6. **The travel between states.** Hover the notch, then start a turn: the face
   should glide from the panel header to the ear and shrink on the shell's
   curve, and its pose should morph during the same move. This is the transition
   most likely to look wrong, and it is the one no test covers.
7. **The collapsed shell.** Confirm no pixel of the creature survives the
   collapse tween near the cutout.

## Suggested next step

Owner eyeballs items 1–7 above on a real Mac — especially 1 (does it move in
WKWebView) and 4 (is the header band too greedy) — then the reviewer re-reviews
round 2 on PR #30.

## Round 3 — owner feedback (2026-09-20)

Four changes, all on the same branch. Nothing was committed or pushed by the
worker; the tree is left dirty for the coordinator.

### 1. The panel face moved into the left nav column; the "Ready" label is gone

The "Ready" text was never a panel element: it is the shell status strip
(`StageLabel` in `.notch-copy`), which `ShellSurface` renders for every state
except `prompt` and which therefore painted over the panel's top-left. It is
removed from `panel` only, by one CSS rule scoped to the state class; `compact`
and every other state keep their strip and their label untouched.

| File | Change |
|---|---|
| `app/src/index.css` | `.notch.shell-panel .notch-content { display: none }` (the strip, and so the "Ready" label, leaves the panel and the a11y tree). `.notch.shell-panel .notch-face` is re-anchored to the left nav column: `--face-left: calc((128px - var(--face-size)) / 2)`, `--face-top: calc(var(--cutout-height) + 12px)`. |
| `app/src/index.css` | Removed `.notch.shell-panel .panel-body { padding-top: calc(var(--face-size) + 20px) }`. That override was the ~124 px header band; removing it returns `.panel-body` to its natural `12px 16px 14px` padding, so every page's toolbar and rows start where they did before the face existed. |
| `app/src/index.css` | Added `.notch.shell-panel .panel-nav { padding-top: calc(var(--face-size) + 28px) }`: reserves the nav header for the face. Derived from `--face-size`, so the two cannot drift. |
| `app/src/notch/faceState.ts` | `FACE_PLACEMENTS.panel` is now `{ size: 80, travel: 10 }` (was `{ 104, 2.8 }`); the module comment explains the nav-column sizing. |

80 px is chosen against the 128 px column (24 px of shoulder each side; the
creature's ~68-unit silhouette draws ~55 px across) rather than against the
420 px panel. It is a little smaller than the 104 px header face it replaces,
which is the point of moving it out of the content column. The face is centered
in the nav column and sits above History / Tasks / Rules / Wallet on all four
pages, and it is still the same single element — only its CSS box changed, so
the pose morph, the idle phase and the gaze position all survive the
presentation change (round 2's remount rule still holds).

### 2. Gaze excursion raised from 2.8 to 10 viewBox units

`travel` is in viewBox units (the face is 100 units across), set through the
hook and never in CSS. The old 2.8 put the eye ~3.75 units out — 2.9 px on the
old 104 px face, under 2 px on an 80 px one — which is why it read as not
tracking.

The ceiling is empirical, measured with the library's own exported `project`
against the real face geometry, not assumed from the library's generic 1.5–4
band (that band is authored for the whole roster, where `triangle`'s head is
~9 units tall):

- `_layout('polaris', {hue:310,tone:0.12}).face` = ellipse radius **34.32 x
  34.07** viewBox units; eye marks at **(-0.37, -0.19)** and **(0.24, -0.19)**
  of that radius.
- With `yaw = travel / rx`, `project` saturates at `LIMB` 0.97: the pupil stops
  at the silhouette and foreshortens instead of leaving the head. For this face
  the limb is not reached until **travel ≈ 36**.

| travel | eye offset (units) | eye scale at full excursion | px @ 80 |
|---|---|---|---|
| 2.8 | 2.63 | 0.98 | 2.1 |
| 4 | 3.74 | 0.97 | 3.0 |
| 6 | 5.61 | 0.94 | 4.5 |
| **10** | **9.49** | **0.89** | **7.6** |
| 20 | 19.26 | 0.71 | 15.4 |

**10** is the chosen value: ~7.6 px of eye travel at 80 px — obvious at a
glance — while the eye is still ~89 % of its width and nowhere near the
silhouette. `faceState.test.ts` pins the value and the sanity band.

### 3. The gaze no longer needs a click — it is driven by the native cursor stream

**The actual reason a click was required.** `lookAt: "pointer"` arms the gaze
driver with a DOM `pointermove` listener (`node_modules/blobatar/src/gaze.ts`,
`addEventListener("pointermove", ...)`). The overlay window is a non-focusable,
click-through, always-on-top webview: `tauri.conf.json` has
`"focus": false, "focusable": false`, `notch.rs::setup` starts it with
`set_ignore_cursor_events(true)`, and only the `prompt` state is ever
`window::focus`ed — the `panel` state is `focusable: false`. A non-key AppKit
window does not deliver `mouseMoved` to the webview, so `pointermove` never
fired and the driver had no target. This is the same structural reason the
project drives hover from a **native** monitor instead of CSS `:hover`
(`app/src-tauri/src/notch/hover.rs` header). A click makes the window
interactive enough that move events start arriving, which is why tracking began
only after one. (The exact AppKit detail — `acceptsMouseMovedEvents` on a
non-key window — is inferred; only the code chain above is directly verified,
and the agent cannot see the running app.)

**The fix removes the dependency rather than working around it.** Rust already
runs exactly one global `mouseMoved` monitor; it is extended, not duplicated:

- `app/src-tauri/src/events.rs` — new `notch_cursor` channel, a `NotchCursor
  { x, y }` payload, `emit_notch_cursor`, and a shape test.
- `app/src-tauri/src/notch/hover.rs` — `observe` now also calls
  `emit_gaze_cursor`, which (only while the active state is `compact` or
  `panel`) converts the sampled AppKit screen point into the webview's client
  space using the live `NSWindow` frame (`x - frame.x`,
  `frame.y + frame.height - y`) and emits it. No second monitor, no watchdog,
  no cached-sample polling.
- `app/src/notch/shellBridge.ts` — `NOTCH_CURSOR_EVENT_NAME` +
  `listenNotchCursor`.
- `app/src/notch/BlobatarFace.tsx` — `useGaze({ travel })` with **no**
  `lookAt` option; a single `useEffect` subscribes to `notch_cursor` and calls
  the hook's stable `lookAt(point)`.

The returned `lookAt` function is used rather than the `lookAt={{ x, y }}`
option on purpose: the option is applied from a React effect, so a target that
changes on every mouse move would be a render per move. The function writes the
same driver directly and is the library's documented seam for a target that
changes on every input. Either way the **driver is never rebuilt** — that is
the invariant that matters, because a rebuilt driver snaps the eyes to centre.

### 4. The blob is now the app icon

- **New `app/scripts/generate-icon.mjs`.** Imports `FACE_NAME` / `FACE_HUE` /
  `FACE_TONE` from `src/notch/faceState.ts` and `blobatarUri` from
  `blobatar/uri`, so the icon is the same character by construction — no second
  copy of the seed or palette. It decodes the data URI, re-frames the 100-unit
  viewBox to `8 9 84 84` (~9% margin around the ~68-unit body), inserts a black
  plate as the first child, rasterises **1024x1024** with macOS `sips`, asserts
  the PNG is 1024x1024, then runs `npx tauri icon` from `app/`. It prunes the
  non-macOS output (`android/`, `ios/`, `*.ico`, `Square*Logo.png`,
  `StoreLogo.png`, `64x64.png`), because Polaris ships only on macOS and the
  repo tracks just the five macOS icon files.
- **Changed:** `app/src-tauri/icons/{32x32,128x128,128x128@2x,icon,icon.icns}`
  regenerated from that source (the Tauri defaults are gone). `sips` is present
  on this machine, so no tool was missing; `npx tauri icon` also accepts SVG if
  a future host lacks `sips`, but the script keeps the PNG path the task asked
  for.
- **Re-run:** `cd app && node scripts/generate-icon.mjs` (or
  `npm run icon -w @polaris/app` from the repo root).

### Acceptance — the real numbers

- `caffeinate -i bash scripts/check.sh` — **`== all checks passed`** (JS
  typecheck across workspaces, `@polaris/stellar` tests, app production build,
  agent smoke, `cargo check` on the Tauri shell).
- `caffeinate -i npm test -w @polaris/app` — **378 tests, 378 pass, 0 fail**.
  Round 2 was 372; round 3 added/pinned the panel placement and the excursion
  band.
- `caffeinate -i npm run build -w @polaris/app` — **`built`** (Vite, ~0.3 s;
  only the pre-existing chunk-size and ineffective-dynamic-import warnings).
- Extra, because round 3 changes Rust: `caffeinate -i cargo test --manifest-path
  app/src-tauri/Cargo.toml` — **320 passed, 0 failed, 5 ignored**.

### What the agent could NOT verify

- **Anything visual.** The worker cannot see the running app. Not verified: the
  face actually sitting balanced in the nav column at the real panel width; that
  the nav buttons clear it on all four pages; that the eyes now visibly track in
  WKWebView without a click; that 10 reads as deliberate rather than deranged;
  that the "Ready" text is truly absent in `panel`; and that the icon looks right
  in the Dock/Finder (the generated 128x128@2x was inspected as an image and is
  the correct pale blobatar on black).
- **The AppKit mechanism behind the click.** The code chain (DOM `pointermove`
  never delivered by a non-key, click-through, non-focusable overlay) is
  verified from source; the precise reason a click flips it is inferred.
- **Cursor-stream cost.** The `notch_cursor` emit is gated to `compact`/`panel`
  and is event-driven, but its real per-move cost in WKWebView was not measured.
- **The `.notch-content { display: none }` transition.** In `panel` the strip is
  removed instantly rather than faded; leaving `panel` can replay the label's
  entrance animation. Unverified by eye.

### Bundle / build

No new frontend dependency. The only additions are the `notch_cursor` bridge
(~1 KB source) and `BlobatarFace`'s subscription; the icon script is not part of
the bundle.

## Suggested next step (round 3)

Owner eyeballs round 3 on a real Mac: (1) the face's size and position in the
nav column on all four pages, and that "Ready" is gone; (2) that the eyes now
track the cursor **without clicking** and that the excursion reads as obvious;
(3) the new app icon. Then the reviewer re-reviews round 3 on PR #30.
