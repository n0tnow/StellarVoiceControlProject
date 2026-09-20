/**
 * The avatar's pure state rules, split out of [`BlobatarFace`] so they can be
 * unit-tested without React, a DOM or a bundler (see `faceState.test.ts`).
 *
 * Polaris' face is a `blobatar`: a deterministic, seeded creature that is drawn
 * from a name and posed by an *expression*. Three independent decisions live
 * here, and all three are pure:
 *
 * 1. **Whether there is a face at all** ([`shouldRenderFace`]) — a function of
 *    the applied shell state, never of the voice stage. A collapsed notch is the
 *    macOS camera housing and nothing else; a face drawn there would be drawn
 *    behind the housing, where no pixels exist.
 * 2. **How big it is, and how far its eyes travel** ([`facePlacementFor`]) —
 *    also a function of the applied state, because the face has two genuinely
 *    different presentations (see that function).
 * 3. **Which pose it holds** ([`faceMoodFor`] + [`faceExpressionFor`]) — a
 *    function of the voice stage the shell already publishes.
 *
 * The morph between two poses is *not* implemented here and must not be: the
 * library registers every pose channel as an animatable custom property in
 * `blobatar/motion.css`, so changing `expression` on a mounted, animated
 * blobatar is a CSS transition on thirteen numbers. Hand-rolling a crossfade on
 * top of that would fight it. What this module owns is only *which* pose.
 *
 * Where the face *sits* is not here: that is layout, it belongs in the
 * stylesheet, and it is driven by the shell's own state class. Size is here
 * only because the gaze excursion has to be chosen alongside it and that one is
 * a JavaScript option.
 */
import { happy, idle, surprised, thinking, type Expression } from "blobatar/expression";

import type { ShellStateName, VoiceStage } from "./shellState";

/**
 * The seed. A blobatar is deterministic in its name, so this constant *is* the
 * identity: the same string always draws the same creature, and changing it
 * gives Polaris a different face. It is therefore treated as a fixed asset name
 * rather than as a tweakable, and it is not user-visible copy.
 */
export const FACE_NAME = "polaris";

/**
 * Hue and tone are **locked**, which deliberately gives up half of what the seed
 * would otherwise decide.
 *
 * A hashed palette is the right default for a crowd of user avatars, where
 * colour is identity. Polaris is one creature on a black shell, so here an
 * unlocked hue is a coin flip between "on brand" and "a random green blob on
 * black". `hue` pins it to the shell accent's magenta and `tone` picks a pale
 * swatch (the scale runs pale → ink), which is the half of the swatch set that
 * survives on `#000`. The name still drives the shape.
 */
export const FACE_HUE = 310;
/** See [`FACE_HUE`]. Low is pale; ink-dark tones vanish on the black shell. */
export const FACE_TONE = 0.12;

/**
 * One presentation of the face: how large it is drawn, and how far the gaze
 * layer may pull its eyes.
 */
export interface FacePlacement {
  /** Drawn size in px. The stylesheet reads it as `--face-size`. */
  readonly size: number;
  /**
   * The gaze excursion, in **viewBox units** — not pixels. The blobatar is 100
   * units across, so this is a *percentage of the face*: it scales with `size`
   * on its own. The library documents a generic 1.5–4 band for its whole roster,
   * but the honest ceiling for one specific face is where its eyes reach the
   * silhouette, which for Polaris is far outside that band (see
   * [`FACE_PLACEMENTS`] for the measured limit).
   */
  readonly travel: number;
}

/**
 * The two presentations, and why they are this far apart.
 *
 * **`strip`** — the voice states. The face is alone in the status strip's right
 * ear (the indicator dots it used to share the ear with are gone; the face *is*
 * the stage signal now). Its ceiling is not taste: the `compact` shell is
 * exactly one cutout tall, ~32 px, and that is a Rust state-table value. 28 px
 * is as large as a face can be there without standing proud of the black pill.
 *
 * **`panel`** — the hover surface. The face is the persistent identity mark at
 * the top of the 128 px left nav column, above History / Tasks / Rules / Wallet
 * and visible on all four pages. 80 px is chosen against that column rather than
 * the content body: it leaves 24 px of shoulder on each side, and the creature
 * (whose silhouette is ~68 of the 100 viewBox units) draws ~55 px across. It is
 * deliberately a little smaller than the 104 px content-header face it replaces,
 * which the owner asked to move out of the content column.
 *
 * The size gap is the fix for "hareketsiz". The library's ambient idle layer is
 * authored in viewBox units — the bob is 1.1 units, the breathe 2.2%, the
 * saccade ~1.3 units — so its amplitude in *screen pixels* is whatever the face
 * is multiplied by. Measured in the running page at the old 22 px, the entire
 * idle layer moved between 0.24 px and 0.48 px: a sub-pixel drift eased over
 * 2.8–3.4 s, which is not "broken", it is invisible. At 80 px the same numbers
 * are ~0.9–1.8 px, which reads. Nothing about the animation was ever switched
 * off (`--mo-amp` computes to `1`, `mo-always` is on the root, and all seven
 * loops are running) — it was drawn too small to see.
 *
 * `travel` is the fix for "mouseye çok az bakıyor". It is in viewBox units, so
 * it already scales with `size`; the old panel value, 2.8, put the eye ~3.75
 * units out (2.9 px on the old 104 px face, under 2 px on an 80 px one), which
 * reads as not tracking. It is now **10**: at 80 px that is ~7.6 px of eye
 * travel, obvious at a glance.
 *
 * The ceiling is empirical, not the library's roster-wide 1.5–4. That band is
 * authored for the whole roster, where `triangle`'s head is only ~9 units tall.
 * For *this* character the fitted head is an ellipse of radius ≈34.32 × 34.07
 * viewBox units (`_layout('polaris', …).face`), with the eye marks at
 * (-0.37, -0.19) and (0.24, -0.19) of that radius. Feeding those through the
 * library's own `project` turn (`yaw = travel / rx`, `pitch = travel / ry`)
 * saturates at `LIMB` 0.97 — the pupil stops at the silhouette and foreshortens
 * rather than leaving the head — and for this face that limb is not reached
 * until travel ≈ 36. At travel 10 the eye has moved ~9.5 of its 34-unit radius
 * and is still ~89% of its width: a big, clear glance with no vanishing and no
 * clipping. `FACE_PLACEMENTS.panel` is pinned by a unit test.
 *
 * Even so, be honest about the other presentation's ceiling: at 28 px a 3.6-unit
 * excursion is about 1 px. The strip face's visible motion is carried by the
 * **pose morph** (an eye-height change of 4× between `speaking` and `listening`)
 * and by the blink, not by the ambient layer, and no setting in this library
 * changes that — there is no amplitude dial, only `--mo-rate`, which is a
 * slow-motion debugging aid.
 */
export const FACE_PLACEMENTS = {
  strip: { size: 28, travel: 3.6 },
  panel: { size: 80, travel: 10 },
} as const satisfies Record<string, FacePlacement>;

/**
 * The presentation for an applied shell state.
 *
 * Only `panel` gets the large one. Everything else that has a face at all is a
 * strip state, and saying it that way (rather than listing `compact`) keeps the
 * "a new state is one Rust table row" promise: a future expanded state inherits
 * the strip presentation instead of rendering at size `undefined`.
 */
export function facePlacementFor(applied: ShellStateName): FacePlacement {
  return applied === "panel" ? FACE_PLACEMENTS.panel : FACE_PLACEMENTS.strip;
}

/**
 * What the face is doing. Exactly the shell's three voice stages plus the
 * resting case — no fourth mood, because a mood with no stage behind it would
 * have nothing to switch it on.
 */
export type FaceMood = "idle" | VoiceStage;

/**
 * The stage the shell reports (`inlineVoiceStage`) as a mood. `null` — no live
 * turn — is `idle`, which is the pose the library treats as the identity: every
 * channel sits at its registered initial value, so returning to it transitions
 * back rather than snapping.
 */
export function faceMoodFor(stage: VoiceStage | null): FaceMood {
  return stage ?? "idle";
}

/**
 * The mood → pose table, and the argument for each row.
 *
 * - `idle` — the library's own resting pose. Ambient breathing, bobbing,
 *   blinking and saccades still run; it is "alive and waiting", not "off".
 * - `listening` → `surprised`. The roster's only pose that enlarges the eyes on
 *   **both** axes at once: `esx` 1.34 *and* `esy` 1.20. Two other poses go over
 *   1 vertically (`love` 1.28, `unsure` 1.02) and none of them also widens, so
 *   nothing else in the vocabulary reads as a plain open-eyed stare. It is also
 *   the far end of the axis `speaking` sits on — `happy` is `esy` 0.30 — which
 *   makes listening→speaking a 4× change in eye height, and *that* is the
 *   motion the small strip face actually has.
 * - `thinking` → `thinking`. Purpose-built for this: two level eyes at
 *   mismatched heights trading places on a loop (`edy2` −8.4 driven by
 *   `rock` 0.8) — the two-dot loader everybody already reads, except the
 *   creature does not have to grow the dots. It is also the only pose whose
 *   message is a *duration*, which is precisely what a pending turn is, and the
 *   only one of our four that animates on its own clock.
 * - `speaking` → `happy`. Wide flat arcs riding high. The library is pose-only
 *   and a blob has no mouth, so nothing in the roster can mime talking; the
 *   honest choice is the lively, engaged pose rather than a fake mouth.
 *
 * Each value is an imported object rather than a string: `blobatar` passes
 * expressions by value so that the poses a consumer never imports never enter
 * the bundle. That is why this is a table of values and why it lives in a module
 * that the component imports, rather than in a `switch` that names them.
 */
export const FACE_EXPRESSIONS: Record<FaceMood, Expression> = {
  idle,
  listening: surprised,
  thinking,
  speaking: happy,
};

/** The pose for a mood. See [`FACE_EXPRESSIONS`] for the reasoning per row. */
export function faceExpressionFor(mood: FaceMood): Expression {
  return FACE_EXPRESSIONS[mood];
}

/**
 * Whether the shell's applied state has a face in it.
 *
 * - `collapsed` — **no**. This is the hard requirement. The collapsed shell is
 *   the physical camera cutout: it is click-through, its content is faded out,
 *   and the middle column is the housing itself. A face there is at best
 *   invisible and at worst a smear behind the notch during the expand tween.
 * - `prompt` — **no**, for a different reason: the typed prompt owns the whole
 *   surface, and it carries the turn's stage itself through its own inline
 *   indicator. That state is also content-driven — its measured height sizes the
 *   native window — so a face in it would feed the measurement.
 * - everything else (`compact` from the push-to-talk hotkey, `panel` from hover
 *   or from a voice navigation) — **yes**.
 *
 * Written as an exclusion rather than an allow-list on purpose: the state table
 * is owned by Rust, so a new row must not need an edit here to get a face.
 *
 * Note what this deliberately does *not* distinguish: `compact` and `panel` are
 * both "yes", which is what lets one element serve both presentations and never
 * unmount between them. See [`BlobatarFace`] for why that matters.
 */
export function shouldRenderFace(applied: ShellStateName): boolean {
  return applied !== "collapsed" && applied !== "prompt";
}
