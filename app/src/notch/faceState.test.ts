import assert from "node:assert/strict";
import { test } from "node:test";

import { happy, idle, surprised, thinking } from "blobatar/expression";

import {
  FACE_EXPRESSIONS,
  FACE_PLACEMENTS,
  faceExpressionFor,
  faceMoodFor,
  facePlacementFor,
  shouldRenderFace,
  type FaceMood,
} from "./faceState.ts";
import { inlineVoiceStage } from "./shellState.ts";

test("the collapsed shell has no face", () => {
  // The hard requirement: the collapsed shell *is* the camera housing, so a
  // face drawn there is drawn where no pixels exist.
  assert.equal(shouldRenderFace("collapsed"), false);
});

test("the expanded voice and panel states have a face", () => {
  // `compact` is what the push-to-talk hotkey (Control+Option) resolves to;
  // `panel` is hover expansion and voice navigation.
  assert.equal(shouldRenderFace("compact"), true);
  assert.equal(shouldRenderFace("panel"), true);
});

test("the prompt state has no face: it removes the status strip from the tree", () => {
  assert.equal(shouldRenderFace("prompt"), false);
});

test("a state the Rust table grows later gets a face without a TypeScript edit", () => {
  // The exclusion-list shape is the point — see `shouldRenderFace`.
  assert.equal(shouldRenderFace("some-future-state"), true);
});

test("no live turn rests the face at idle", () => {
  assert.equal(faceMoodFor(null), "idle");
});

test("every voice stage is its own mood", () => {
  assert.equal(faceMoodFor("listening"), "listening");
  assert.equal(faceMoodFor("thinking"), "thinking");
  assert.equal(faceMoodFor("speaking"), "speaking");
});

test("each mood holds its documented pose", () => {
  assert.equal(faceExpressionFor("idle"), idle);
  assert.equal(faceExpressionFor("listening"), surprised);
  assert.equal(faceExpressionFor("thinking"), thinking);
  assert.equal(faceExpressionFor("speaking"), happy);
});

test("no two moods share a pose", () => {
  // A stage change the user cannot see is the same as no stage change at all.
  const poses = Object.values(FACE_EXPRESSIONS);
  assert.equal(new Set(poses).size, poses.length);
});

test("the table is total over the mood union", () => {
  const moods: FaceMood[] = ["idle", "listening", "thinking", "speaking"];
  assert.deepEqual(Object.keys(FACE_EXPRESSIONS).sort(), [...moods].sort());
  for (const mood of moods) assert.notEqual(faceExpressionFor(mood), undefined);
});

test("the shell's visual state reaches a pose end to end", () => {
  // `visual` -> stage -> mood -> pose is the whole chain the component runs.
  const poseFor = (visual: string) => faceExpressionFor(faceMoodFor(inlineVoiceStage(visual)));
  assert.equal(poseFor("recording"), surprised);
  assert.equal(poseFor("transcribing"), thinking);
  assert.equal(poseFor("speaking"), happy);
  assert.equal(poseFor("idle"), idle);
  assert.equal(poseFor("error"), idle);
});

test("the panel gets the large presentation and every other state the strip one", () => {
  assert.equal(facePlacementFor("panel"), FACE_PLACEMENTS.panel);
  assert.equal(facePlacementFor("compact"), FACE_PLACEMENTS.strip);
  // Collapsed never renders a face, but the lookup must still be total rather
  // than returning undefined for a state it has not heard of.
  assert.equal(facePlacementFor("collapsed"), FACE_PLACEMENTS.strip);
  assert.equal(facePlacementFor("some-future-state"), FACE_PLACEMENTS.strip);
});

test("the panel face is much larger than the strip face", () => {
  // The whole fix for the ambient layer being invisible: the library authors it
  // in viewBox units, so its amplitude in screen pixels is whatever the face is
  // multiplied by. Measured in the browser, 22px put every ambient channel
  // between 0.24px and 0.48px — real, running, and far too small to see. Round 3
  // bounds the panel face by the 128px nav column instead of the content header,
  // so the ratio is smaller than it was at 104px but still several times the
  // strip.
  assert.ok(FACE_PLACEMENTS.panel.size >= 2.5 * FACE_PLACEMENTS.strip.size);
});

test("the panel placement is the nav-column size and gaze excursion", () => {
  // Pinned so a re-tune is a deliberate edit rather than silent drift. 80px
  // leaves 24px of shoulder inside the 128px nav column; 10 viewBox units is
  // ~7.6px of eye travel on that face. See `faceState.ts` for the empirical
  // limit, measured with the library's own `project` against the fitted head.
  assert.equal(FACE_PLACEMENTS.panel.size, 80);
  assert.equal(FACE_PLACEMENTS.panel.travel, 10);
});

test("the strip face stays inside a one-cutout-tall shell", () => {
  // `compact` is exactly one cutout high (a Rust state-table value, ~32px), so
  // a larger face would stand proud of the black pill.
  assert.ok(FACE_PLACEMENTS.strip.size <= 30);
});

test("every placement asks for a gaze excursion the library can honour", () => {
  // `--mo-track-travel` is registered with an initial value of 0px: a placement
  // that forgot `travel` would render a face whose eyes never move, which is
  // indistinguishable from gaze not being wired at all. The floor is the
  // library's "imperceptible below ~1.5"; the ceiling is a sanity cap, not the
  // library's generic 1.5-4 band. That band is authored for the whole roster
  // (where `triangle`'s head is ~9 units tall); Polaris' fitted head has radius
  // ~34 units, its eye only reaches the silhouette near travel 36, and the panel
  // is deliberately at 10 — still ~89% of its width through `project`.
  for (const placement of Object.values(FACE_PLACEMENTS)) {
    assert.ok(placement.travel >= 1.5 && placement.travel <= 12, String(placement.travel));
  }
});

test("the interactive panel face is given the wider excursion", () => {
  // The intent flipped in round 3. Round 2 gave the tiny strip face the wider
  // excursion because at 28px only a near-maximum one registers. The owner then
  // reported the panel face barely tracked, and the panel is the surface the
  // pointer actually drives, so it now carries the excursion; the strip face
  // keeps a calmer value and its motion comes from the pose morph.
  assert.ok(FACE_PLACEMENTS.panel.travel > FACE_PLACEMENTS.strip.travel);
});
