# Review: blobatar-avatar (PR #30)

- **Date:** 2026-09-20
- **Reviewer:** Claude Opus 5 (reviewer worker)
- **Branch/Worktree:** `review/blobatar` / `.worktrees/blobatar-review`
- **Under review:** PR #30 `feat/blobatar-avatar` @ `536176b`
- **Review posted:** https://github.com/n0tnow/StellarVoiceControlProject/pull/30#pullrequestreview-5259554904

## Outcome

**Approve the code. Three documentation corrections requested before merge.**

No behavioural defect was found. Every load-bearing claim the author made was
re-derived from the installed packages and the source rather than taken at face
value, and all of them hold. The requested changes are factual errors in
comments and in the PR/report prose — no code change is needed, so the PR is
mergeable as soon as a `docs:` commit lands. The merge decision itself is the
coordinator's; this review was posted as `COMMENTED`, not `APPROVED`.

## Checks re-run (CLAUDE.md §4 — `caffeinate -i`)

Run in `.worktrees/blobatar-review` with its own `npm install`.

| Check | Observed | Author reported | Match |
|---|---|---|---|
| `caffeinate -i bash scripts/check.sh` | green; stellar `tests 67 / pass 67 / fail 0`; `cargo check` 29.19s | green, 67/0 | ✅ |
| `npm test -w @polaris/app` | **372 pass / 0 fail / 0 skipped**, 1677 ms | 372/0 | ✅ |
| `npm run build -w @polaris/app` | green, `✓ built in 307ms` | green | ✅ |
| `main-*.js` | 671,831 B raw / 205,228 B gz | 671,831 B | ✅ |
| `main-*.css` | 53,503 B raw / 10,093 B gz | 53,503 B | ✅ |

Baseline measured independently by checking `origin/main`'s `app/src` +
`app/package.json` into the same worktree and rebuilding against the same
`node_modules`: 659,154 B / 199,644 B gz (JS) and 45,151 B / 8,683 B gz (CSS) —
byte-identical to the author's "before" column.

**Delta: +12,677 B raw / +5,584 B gz (JS), +8,352 B raw / +1,410 B gz (CSS) =
+6,994 B gzipped.** The report's "~+7 KB gzipped" is accurate.

`grep mo-root app/dist/assets/main-*.css` hits, so the `blobatar/motion.css`
subpath import does resolve under Vite and does reach the bundle.

## Findings by severity

### MAJOR — none.

### MINOR-1 — the `surprised` justification is factually wrong (three artifacts)

`faceState.ts:78-81`, the PR body's stage→pose table, and
`backlog/blobatar-avatar.md` all say `surprised` is "the roster's only pose that
enlarges the eyes (`esy` 1.34 where every other pose squashes below 0.6)".
Dumping all fourteen exported poses' channels from the installed package:

```
happy     esx 1.72  esy 0.30      sad       esx 0.60  esy 0.56
idle      esx 1.00  esy 1.00      scared    esx 0.78  esy 0.96
love      esx 0.86  esy 1.28      shy       esx 0.62  esy 0.50
mad       esx 1.85  esy 0.26      sick      esx 1.25  esy 0.34
sleepy    esx 1.14  esy 0.22      smug      esx 1.30  esy 0.42
surprised esx 1.34  esy 1.20      thinking  esx 1.15  esy 0.62
unsure    esx 0.95  esy 1.02      wink      esx 1.32  esy 0.76
```

1. `1.34` is `esx`, not `esy`; `surprised`'s `esy` is `1.20`.
2. `love` (1.28) and `unsure` (1.02) also exceed 1, and `idle` sits at 1.
3. Six of thirteen are not "below 0.6": `thinking` 0.62, `wink` 0.76, `scared`
   0.96, `unsure` 1.02, `love` 1.28, `idle` 1.00.

The *choice* survives — `surprised` is the only pose that enlarges on **both**
axes (`esx` 1.34 and `esy` 1.20), `love` narrows horizontally and `unsure` is
effectively neutral — so it is genuinely the most legible "eyes wide" read at
22 px. But in a codebase whose convention is that the comment *is* the argument,
an argument resting on the wrong number is worse than no argument. Restate as
the both-axes property.

### MINOR-2 — "the tests assert the tree, not the paint" is not true

The PR body and the report both say this. All ten tests are on the pure
`faceState` module; **none** touches the React tree. `app/package.json` runs
`node --test "src/**/*.test.ts"`, there is no `.test.tsx` anywhere in the repo,
and there is no jsdom/testing-library dependency — so a tree test is not
currently possible, which is fine and out of this PR's scope. The claim should
simply be corrected, because a future agent will read it and believe coverage
exists that does not. Consequence worth stating plainly in the report: the
invariant this whole PR is built around (the `<svg>` is not remounted across
stages) has **zero** automated coverage, exactly as the author's own argument
predicts.

### MINOR-3 — the `.notch-face` entrance comment promises a delay the CSS lacks

`index.css:301-304` says "Same curve as `.notch-content`'s fade, **one beat
later**", but `animation: <name> <time> <easing> both` with a single `<time>`
binds it to `animation-duration` and leaves `animation-delay` at `0s`. Either
add the second time value or drop the claim. (My guess is the comment is wrong
and simultaneous is fine; only the author knows the intent.)

### NIT-1 — `FACE_SIZE` is restated as a literal in CSS

`index.css:298-299` hard-codes `22px` against `FACE_SIZE = 22` in
`faceState.ts`, with nothing linking them. The fixed box is load-bearing (it is
what keeps the strip's row height off the shell's Rust-owned height), and the
failure mode is a quiet off-centre creature. Threading it as a custom property
from `BlobatarFace` would match how the rest of the file handles shell metrics.

### NIT-2 — the halo is probably clipped

`index.css:311` applies `drop-shadow(0 0 6px …)` to a 22px face centred in a
32px `.notch-content` that is `overflow: hidden`, leaving ~5px of headroom. This
is the exact failure the `.notch-indicator::before` comment twelve lines below
was written to avoid ("cut off square by `.notch-content`'s overflow clip") and
it was not accounted for here. `overflow: visible` on the `<svg>` does not help;
the clip is on the ancestor. Needs an eye — see "unverifiable" below.

### NIT-3 — the mount invariant is stated slightly wider than the code guarantees

`ShellSurface.tsx:226` / `BlobatarFace`'s header say the face is mounted on the
state boundary and never the stage boundary. True — but the two boundaries
coincide in one flow: hovering (`applied === "panel"`) and then starting a turn
takes `applied` `panel → compact` on the same commit the stage goes
`null → listening`, so the first `idle → surprised` morph of a hover-initiated
turn does not exist; the face mounts already-surprised. The entrance animation
covers that frame and no code change is warranted, but one clause in the comment
would stop a future agent concluding the morph is broken.

### NIT-4 — entrance/exit asymmetry deserves a sentence

The face fades and scales in, but unmounts instantly on collapse, while
`showPrompt` forty lines above does the opposite (deferred unmount so the fade
can play). The asymmetry is **correct** — a deferred unmount would leave pixels
near the cutout during the collapse tween, which is the requirement — but it
reads as an oversight. Say so in the code.

## Claims verified in detail

### 1. The remount claim — holds, and for a tighter reason than stated

`node_modules/blobatar/dist/render.d.ts` documents the invariant the author
quotes, verbatim and in context. The adapter (`blobatar/dist/react.js`, which
`@blobatar/react@2.7.0` re-exports as a three-line passthrough) implements it as:

```js
let d = JSON.stringify([name, opts, animate]);          // opts includes `expression`
let h = useMemo(() => parts(name, {...opts, animate}), [d]);
let x = useMemo(() => ({__html: h?.inner ?? ""}), [h?.inner]);
// <svg style={{...h.vars}}><g className={h.cls} dangerouslySetInnerHTML={x}/></svg>
```

The pose lands as `style` on the `<svg>` and `className` on the `<g>`, both
diffed in place; `inner` is byte-identical across expressions, so React never
replaces the subtree and the registered-property transition keeps its previous
computed value. Two sub-claims checked that the PR asserts but does not show:

- **The memo keys on `JSON.stringify`, not identity.** Two poses with equal
  serialised `p` would silently never re-render. All four used poses serialise
  distinctly, so this is sound today. Note the test pins identity, which is the
  weaker property.
- **`applied` really is constant across a turn.** `shellVoiceInputs` returns
  `state: expanded ? "compact" : "collapsed"` — only two names — and
  `voiceAttention` is true for every active stage, so `resolveShellState`
  returns `"compact"` for the whole `recording → transcribing → speaking`
  sequence. Combined with no `key`, a fixed position in a two-child array and an
  unconditional `.notch-trail` parent, the element is stable.

Also confirmed against `motion.css`: 15 `@property`-registered `--mo-*` channels,
13 of them in the transitioned `--mo-tp` list; `--mo-morph` is `.3s` under
`.mo-expr` and `.4s` otherwise (the "~300 ms in, ~400 ms out" claim);
`.mo-always` sets `--mo-amp: 1` (the `animate="always"` claim); and the
`prefers-reduced-motion` block drops both `animation` and `transition` (the
"library handles it" claim). All accurate. Poses omit channels that sit at their
initial value, which still transitions correctly because registered properties
fall back to `initial-value`.

### 2. The collapsed gate — holds

`shouldRenderFace` reads `applied` only. `applied` flips to `"collapsed"` at the
*start* of the collapse — it is what sets the `shell-collapsed` class that drives
the tween — so the face unmounts on the first frame rather than riding the tween
toward the cutout. The requirement ("no pixels there, including during the
transition") is genuinely met, not merely asserted.

### 3. CSS regression risk — no displacement

`.notch-indicator::before` is `position: absolute` with no offsets, so it is
placed at `.notch-indicator`'s static position and translated from there. Both
axes are unmoved:

- **Horizontal:** `.notch-trail` inherits `grid-column: 3` + `justify-self: end`;
  `.notch-indicator` is its last flex child with `flex-shrink: 0`, so its right
  edge is still the ear's trailing edge.
- **Vertical:** `.notch-content` centres the grid item; the item is now the 22px
  `.notch-trail` with `align-items: center`, so the 20px indicator's centre still
  coincides with the row's centre.

Every `.notch-indicator` rule in `index.css` was checked (`::before`, `span`, and
the `.state-*` animation selectors); none read `grid-column`/`justify-self`.
Fit is fine: `compact` is 399 px wide with a 179 px cutout → 110 px ear, 18 px
padding, and the trail needs 22 + 10 + 26 = 58 px. `.notch-copy` carries
`min-width: 0`, so the left ear absorbs any shrink during the tween rather than
the label being pushed.

### 5. Dependency hygiene — clean

Exact `2.7.0` pins in the right workspace, matching the file's no-caret style.
`package-lock.json` adds exactly two entries and no transitive packages; both
MIT; `blobatar` has zero runtime dependencies. Neither package has an
install-time hook (`prepack` only runs on publish). Grepping both `dist/` trees
for `fetch(`, `XMLHttpRequest`, `eval(`, `new Function`, `process.env` and
`require(` returns nothing — the rendering is pure arithmetic over a hash. The
non-deprecated `@blobatar/react` entry point is used and its
`peerDependencies: { blobatar: "2.x" }` is satisfied by the equal pin.

### 6. Conventions — compliant

Three atomic conventional commits (`chore(app):`, `feat(notch):`, `docs:`), all
English, all correctly co-authored. Docs land in the same PR per §7. Scope is
exactly `app/src/notch/**`, `app/src/index.css`, `app/package.json`, the
lockfile and docs — nothing in `app/src-tauri/**`, `stellar/**`, `contracts/**`
or `agent/**`.

## ⚠️ Not verifiable by this reviewer — no rendered UI was seen

No GUI was launched and no screenshot was taken. Everything above is evidence
from source, type definitions, bundle bytes and test runners. **No visual claim
is made.** Still open for a human on a real Mac, in addition to the author's own
five items:

1. That the pose actually **morphs** rather than hard-cuts on a live
   `listening → thinking → speaking` sequence. The element provably survives;
   only the screen can confirm the transition fires.
2. Whether the `drop-shadow` halo is clipped square by `.notch-content`'s
   `overflow: hidden` (NIT-2). If it is: smaller radius (~4px), or move the halo
   to a `radial-gradient` background shaped like the indicator's wash.
3. Whether the instant unmount on collapse reads as a pop against the strip's
   470 ms fade (NIT-4). If it does, the fix is a shrinking exit animation, *not*
   a deferred unmount — a deferred unmount would break the collapsed requirement.
4. Whether `animate="always"` — breathe 2.8 s, bob 3.4 s, blink, saccade, plus an
   unconditional 112 ms `mo-shake` keyframe on `.mo-root` — behind a `filter:
   drop-shadow` costs measurable battery while a `panel` sits open indefinitely.
   Almost certainly noise, but unmeasured.

## Follow-ups for the backlog (not blocking)

- DOM test infrastructure for the notch (jsdom or happy-dom + a `.test.tsx` glob
  in `app/package.json`'s test script). Without it, element-stability invariants
  like this one cannot be pinned, and this will not be the last one.
- Consider a serialised-distinctness assertion in `faceState.test.ts`
  (`new Set(poses.map(p => JSON.stringify(p.p))).size`), which pins the property
  the adapter's memo actually keys on rather than a proxy for it.
