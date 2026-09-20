import assert from "node:assert/strict";
import { test } from "node:test";

import { happy, idle, surprised, thinking } from "blobatar/expression";

import {
  FACE_EXPRESSIONS,
  faceExpressionFor,
  faceMoodFor,
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
