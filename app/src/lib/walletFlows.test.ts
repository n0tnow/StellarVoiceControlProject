import assert from "node:assert/strict";
import { test } from "node:test";

import {
  CONNECT_COPY,
  initialCreateState,
  initialImportState,
  parseImportIndex,
  reduceCreate,
  reduceImport,
  validateImportIndex,
  validateImportValue,
} from "./walletFlows.ts";

test("create: the phrase is shown once, then dropped on confirmation", () => {
  let state = reduceCreate(initialCreateState, { type: "start" });
  assert.equal(state.step, "working");

  state = reduceCreate(state, {
    type: "created",
    address: "GAAA",
    recoveryPhrase: "one two  three four",
  });
  assert.equal(state.step, "phrase");
  assert.deepEqual(state.phrase, ["one", "two", "three", "four"]);

  state = reduceCreate(state, { type: "confirmed" });
  assert.equal(state.step, "saved");
  assert.equal(state.address, "GAAA");
  assert.equal(state.phrase, null, "the phrase must not survive confirmation");
});

test("create: a confirmation outside the phrase step is a no-op, and reset clears everything", () => {
  const idle = reduceCreate(initialCreateState, { type: "confirmed" });
  assert.deepEqual(idle, initialCreateState);

  const failed = reduceCreate(
    reduceCreate(initialCreateState, { type: "created", address: "GAAA", recoveryPhrase: "a b" }),
    { type: "failed", error: "Touch ID cancelled" },
  );
  assert.equal(failed.phrase, null);
  assert.equal(failed.step, "idle");

  assert.deepEqual(reduceCreate(failed, { type: "reset" }), initialCreateState);
});

test("import: preview -> confirm -> store clears the secret at submit", () => {
  let state = reduceImport(initialImportState, { type: "secret", value: "SABCD" });
  state = reduceImport(state, { type: "preview" });
  assert.equal(state.step, "previewing");

  state = reduceImport(state, { type: "previewed", address: "GAAA" });
  assert.equal(state.step, "preview");
  assert.equal(state.address, "GAAA");
  assert.equal(state.secret, "SABCD", "the value is still needed for the import call");

  state = reduceImport(state, { type: "store" });
  assert.equal(state.step, "storing");
  assert.equal(state.secret, "", "the secret is cleared the instant it is submitted");

  state = reduceImport(state, { type: "stored", address: "GAAA" });
  assert.equal(state.step, "stored");
  assert.equal(state.address, "GAAA");
});

test("import: cancel and failure both wipe the entry", () => {
  const entered = reduceImport(initialImportState, { type: "secret", value: "SABCD" });
  const cancelled = reduceImport(entered, { type: "back" });
  assert.deepEqual(cancelled, initialImportState);

  const failed = reduceImport(entered, { type: "failed", error: "bad checksum" });
  assert.equal(failed.secret, "");
  assert.equal(failed.step, "input");
  assert.equal(failed.error, "bad checksum");
});

test("import: switching mode clears the field", () => {
  const entered = reduceImport(initialImportState, { type: "secret", value: "SABCD" });
  const switched = reduceImport(entered, { type: "mode", mode: "phrase" });
  assert.equal(switched.mode, "phrase");
  assert.equal(switched.secret, "");
});

test("import value validation covers secret and phrase shapes", () => {
  assert.match(validateImportValue("secret", "S123") ?? "", /56/);
  assert.equal(validateImportValue("secret", "S" + "A".repeat(55)), null);
  assert.equal(validateImportValue("phrase", "word ".repeat(11).trim() + " last"), null);
  assert.match(validateImportValue("phrase", "only three words") ?? "", /12 or 24/);
  assert.match(validateImportValue("phrase", "x".repeat(13)) ?? "", /got 1/);
  assert.equal(validateImportValue("phrase", ""), "Enter a recovery phrase.");
});

test("the optional account index must be a whole number", () => {
  assert.equal(validateImportIndex(""), null);
  assert.equal(validateImportIndex("0"), null);
  assert.equal(validateImportIndex("12"), null);
  assert.match(validateImportIndex("-1") ?? "", /whole number/);
  assert.match(validateImportIndex("1.5") ?? "", /whole number/);
  assert.equal(parseImportIndex(""), undefined);
  assert.equal(parseImportIndex("12"), 12);
});

test("connect: the secret key is the default mode and survives a reset", () => {
  assert.equal(initialImportState.mode, "secret", "the secret-key mode must be first");
  assert.equal(reduceImport(initialImportState, { type: "reset" }).mode, "secret");
  assert.equal(reduceImport(initialImportState, { type: "back" }).mode, "secret");
});

test("connect: user-facing copy says Connect, never Import", () => {
  const labels = [
    CONNECT_COPY.screenTitle,
    CONNECT_COPY.connectExisting,
    CONNECT_COPY.createNew,
    CONNECT_COPY.importHeading,
    CONNECT_COPY.previewHeading,
    CONNECT_COPY.confirm,
  ];
  for (const label of labels) {
    assert.doesNotMatch(label, /import/i, `"${label}" must not say Import`);
  }
  assert.equal(CONNECT_COPY.connectExisting, "Connect existing wallet");
  assert.equal(CONNECT_COPY.confirm, "Connect and store in Keychain");
});
