# Report: notch-shape-fix

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a0-push-to-talk-notch` @ `.worktrees/a0`
- **PR:** none (per task: no PR, no merge, no tag)
- **Scope:** shape only. `capture.rs`, `hotkey.rs`, the event stream, the state machine, and the
  native window placement/level/collection/click-through are untouched.

## What was wrong

The overlay was visible but did not match the physical camera housing. Two root causes were
confirmed by reading the code and by re-measuring the built-in display at runtime.

1. **The idle pill was deliberately inflated past the real cutout.**
   `app/src-tauri/src/notch.rs::configure` computed the housing correctly as
   `right.origin.x - (left.origin.x + left.size.width)` = `824.5 - 645.5` = **179 pt**, with the
   cutout height `safeAreaInsets.top` = **32 pt**, and then shipped
   `((housing + 20.0).max(180.0), safe_top + 4.0)` → **199 x 36**. A black shape 20 pt wider and
   4 pt taller than the hardware can never align with it; it reads as a separate blob.
2. **The corner radii were large and hardcoded in CSS.** `app/src/index.css` used
   `border-radius: 0 0 25px 25px` plus an 18 px radial-gradient "shoulder". Real hardware corners
   are much tighter and asymmetric (top ≈ 4 pt, bottom ≈ 8 pt), and the expanded Dynamic-Island
   look needs a small **concave** top "ear" plus a **convex** bottom corner — neither of which a
   single symmetric `border-radius` can express.

## What changed

### 1. Idle geometry is now the measured cutout (`notch.rs`)

`idle_cutout_size(housing, safe_top)` returns `(housing.max(0.0), safe_top)` with no inflation.
The menu-bar decision is recorded in a comment:

> The menu bar paints ~5 pt deeper than the physical housing (notchbay.com), but the system
> already draws that strip for us; painting black into it is what made the overlay read as a blob
> in light mode, so the resting pill stops at `safe_top`.

Decision: **do not overdraw.** `safeAreaInsets.top` *is* the cutout height; the ~5 pt menu bar
margin is drawn by macOS behind our transparent window. Extending the pill to 37 pt would paint
5 pt of black into a light menu bar — exactly the failure being fixed.

### 2. Corner radii are derived, not hardcoded (`notch.rs` + seam + React + CSS)

`radii_for(idle_height, expanded_height)` scales four radii and clamps them:

| Field | Formula | Value @ 179x32 / 680x66 |
|---|---|---|
| `pillTopRadius` | `clamp(idle_h * 0.125, 3, 5)` | **4.0 pt** |
| `pillBottomRadius` | `clamp(idle_h * 0.25, 7, 10)` | **8.0 pt** |
| `shellEarRadius` | `clamp(expanded_h * 0.09, 5, 8)` | **5.94 pt** |
| `shellBottomRadius` | `clamp(expanded_h * 0.21, 12, 18)` | **13.86 pt** |

`NotchGeometry` gained those four fields in the Rust struct, the TS mirror
(`interfaces/src/index.ts`), and the React consumer (`app/src/App.tsx`), which now publishes them
as CSS custom properties (`--pill-top-radius`, `--pill-bottom-radius`, `--shell-ear-radius`,
`--shell-bottom-radius`) exactly like width/height.

### 3. The silhouette is geometry-driven (`index.css`)

- `.notch` is now a rounded rectangle: `border-radius: var(--top-radius) … var(--bottom-radius) …`.
- The idle pill uses the **hardware** radii and `--ear: 0px`, so it coincides with the cutout.
- `.notch.is-expanded` sets `--ear: var(--shell-ear-radius)`, `--top-radius: 0px`,
  `--bottom-radius: var(--shell-bottom-radius)`. The concave top ears are the existing radial
  gradient quarter-circles, now parameterised by `--ear` and **zero while idle** — the old code
  added an 18 pt shoulder even at rest.
- `--ear` is registered with `@property` (`syntax: "<length>"`) so the ear box and its gradient
  radius animate in lockstep during expansion instead of popping in at the end.

**Why CSS and not a single SVG path.** A single `clip-path: path()` / SVG path can express the
silhouette exactly, but it cannot follow the width/height/radius transition between the idle pill
and the expanded shell without per-frame JavaScript. The CSS primitives used here (border-radius
+ radial-gradient ears) reproduce the top-concave / bottom-convex silhouette to sub-point accuracy
and animate through the existing CSS transition machinery. Trade-off accepted deliberately.

## Geometry numbers produced on this display

Measured on the user's built-in display (`frame` 1470x956 pt, `safeAreaInsets.top` = 32,
`auxL` = (0, 924, 645.5, 32), `auxR` = (824.5, 924, 645.5, 32)), printed by the real binary:

```
polaris: notch geometry NotchGeometry { idle_width: 179.0, idle_height: 32.0, expanded_width: 680.0, expanded_height: 66.0, pill_top_radius: 4.0, pill_bottom_radius: 8.0, shell_ear_radius: 5.9399999999999995, shell_bottom_radius: 13.86 }
```

Idle is **179 x 32** — the measured cutout — versus the previous **199 x 36**.

## Sources

- notchbay.com, *MacBook Notch Size: 220x38 pt on 16-inch, 185x32 on 14-inch* and
  *How to Build a Dynamic Island for Mac*: hardware cutout corners ≈ 4 pt (top) / 8 pt (bottom),
  the bottom flares wider, the menu bar draws ~5 pt deeper than the cutout, and notch width =
  `screen.frame.width - auxL.width - auxR.width` with height = `safeAreaInsets.top`.
  Reference point sizes: 185x32 pt (14"), 220x38 pt (16").
- TheBoredTeam/boring.notch, `NotchShape.swift`: canonical concave quadratic-Bézier top "ears"
  and convex bottom corners; defaults `topCornerRadius = 6`, `bottomCornerRadius = 14`.
- MrKai77/DynamicNotchKit: second reference for notch-attached geometry/expansion.

## Verification (real command output)

### `cd app/src-tauri && caffeinate -i cargo build` — succeeds

```
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 9.23s
```

### `cd app/src-tauri && caffeinate -i cargo test` — 14 passed (10 pre-existing + 4 new)

```
running 14 tests
test notch::tests::fallback_radii_match_the_shared_derivation ... ok
test notch::tests::idle_pill_is_the_measured_cutout_not_inflated ... ok
test notch::tests::idle_size_never_goes_negative_on_a_degenerate_report ... ok
test notch::tests::radii_track_the_measured_heights ... ok
... (10 pre-existing) ...
test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

The new tests pin the regression: `idle_cutout_size(179.0, 32.0) == (179.0, 32.0)` and the radii
table above.

### `caffeinate -i npm run typecheck` (repo root) — green

All four workspaces (`interfaces`, `agent`, `stellar`, `app`) run `tsc` with no diagnostics.

### `caffeinate -i npm run build` (repo root) — green

```
dist/assets/index-yOUin2ZN.css   17.44 kB │ gzip:  4.41 kB
dist/assets/index-498aqxqC.js   223.71 kB │ gzip: 70.21 kB
✓ built in 222ms
```

The produced CSS keeps `@property --ear{syntax:"<length>";inherits:true;initial-value:0}`; a
browser probe confirmed the property is registered (an unset element computes `--ear: 0px`).

### `cargo clippy --all-targets` — only the pre-existing `large_enum_variant` warning

No new warnings.

### Shape sanity check in a browser

The built bundle was loaded outside Tauri and the measured geometry injected. Idle measured
`179 x 32`, `border-top-left-radius: 4px`, `border-bottom-left-radius: 8px`, `--ear: 0px`.
Expanded measured `680 x 66`, top radius `0`, bottom radius `13.86px`, `--ear: 5.94px`, and the
`::before` ear box/gradient matched. Screenshots showed a flush, asymmetric silhouette in both
states. (Screenshots are scratch and were not committed.)

## What remains unverified / honest limitations

- **No human visual check on the real display.** I cannot see the physical hardware. The user must
  confirm the idle pill disappears into the cutout and the expanded shell reads as attached.
- **Exact hardware corner radii are approximate.** 4 pt / 8 pt are third-party measurements, not
  Apple API values; the CSS uses circular arcs, not Apple's continuous "squircle" curvature.
- **Menu-bar overdraw decision is reasoned, not measured on this machine.** I did not capture a
  screenshot with the menu bar in light/dark mode to confirm the seam at `safe_top`; if a visible
  seam appears, `IDLE_OVERDRAW`-style logic would be the place to revisit.
- **Expanded ear scale is a derivation, not a measurement.** `shellEarRadius` ≈ 6 pt follows
  boring.notch's default; a wider/taller shell may want a larger ear.
- The non-notched fallback returns a centred pill with the same derived radii; it was type-checked
  and unit-tested only (no external display available).

## Suggested Next Step

User eyeball check on the built-in display. If the idle pill is still visible, the next knob is the
menu-bar overdraw (~5 pt) and the hardware top radius; both are one-line changes now that the
geometry flows through the seam.
