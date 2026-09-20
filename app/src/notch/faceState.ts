/**
 * The avatar's pure state rules, split out of [`BlobatarFace`] so they can be
 * unit-tested without React, a DOM or a bundler (see `faceState.test.ts`).
 *
 * Polaris' face is a `blobatar`: a deterministic, seeded creature that is drawn
 * from a name and posed by an *expression*. Two independent decisions live
 * here, and both are pure:
 *
 * 1. **Whether there is a face at all** ([`shouldRenderFace`]) — a function of
 *    the applied shell state, never of the voice stage. A collapsed notch is the
 *    macOS camera housing and nothing else; a face drawn there would be drawn
 *    behind the housing, where no pixels exist.
 * 2. **Which pose it holds** ([`faceMoodFor`] + [`faceExpressionFor`]) — a
 *    function of the voice stage the shell already publishes.
 *
 * The morph between two poses is *not* implemented here and must not be: the
 * library registers every pose channel as an animatable custom property in
 * `blobatar/motion.css`, so changing `expression` on a mounted, animated
 * blobatar is a CSS transition on thirteen numbers. Hand-rolling a crossfade on
 * top of that would fight it. What this module owns is only *which* pose.
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
 * Drawn size in px. The status strip is exactly the cutout height (~32 px) and
 * the face shares that row with the stage label and the three indicator dots, so
 * it is sized to sit inside the row rather than to define it.
 */
export const FACE_SIZE = 22;

/**
 * Hue and tone are **locked**, which deliberately gives up half of what the seed
 * would otherwise decide.
 *
 * A hashed palette is the right default for a crowd of user avatars, where
 * colour is identity. Polaris is one creature on a black shell next to a purple
 * indicator wash, so here an unlocked hue is a coin flip between "on brand" and
 * "a random green blob on black". `hue` pins it to the shell accent's magenta
 * and `tone` picks a pale swatch (the scale runs pale → ink), which is the half
 * of the swatch set that survives on `#000`. The name still drives the shape.
 */
export const FACE_HUE = 310;
/** See [`FACE_HUE`]. Low is pale; ink-dark tones vanish on the black shell. */
export const FACE_TONE = 0.12;

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
 * - `listening` → `surprised`. The roster's only pose that *enlarges* the eyes
 *   (`esy` 1.34 where every other pose squashes below 0.6), so at 22 px it is
 *   the one that cannot be confused with any other at a glance. Eyes wide open
 *   is the read we want while the microphone is hot.
 * - `thinking` → `thinking`. Purpose-built for this: two level eyes at
 *   mismatched heights trading places on a loop — the two-dot loader everybody
 *   already reads, except the creature does not have to grow the dots. It is
 *   also the only pose whose message is a *duration*, which is precisely what a
 *   pending turn is.
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
 * The face rides in the status strip (`.notch-content`), so it exists exactly
 * where the strip does:
 *
 * - `collapsed` — **no**. This is the hard requirement. The collapsed shell is
 *   the physical camera cutout: it is click-through, its content is faded out,
 *   and the middle column is the housing itself. A face there is at best
 *   invisible and at worst a smear behind the notch during the expand tween.
 * - `prompt` — **no**, for a different reason: `ShellSurface` removes the strip
 *   from the tree entirely while the typed prompt owns the surface, and the
 *   prompt carries the turn's stage itself through its own inline indicator.
 *   Mounting a face into a content-driven state would also feed the height
 *   measurement that sizes the native window.
 * - everything else (`compact` from the push-to-talk hotkey, `panel` from hover
 *   or from a voice navigation) — **yes**.
 *
 * Written as an exclusion rather than an allow-list on purpose: the state table
 * is owned by Rust, so a new row must not need an edit here to get a face.
 */
export function shouldRenderFace(applied: ShellStateName): boolean {
  return applied !== "collapsed" && applied !== "prompt";
}
