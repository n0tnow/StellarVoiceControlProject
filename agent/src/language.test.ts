import assert from "node:assert/strict";
import { test } from "node:test";

import { languageBase, languageFromToolCalls, normalizeLanguage, resolveTurnLanguage, stripLanguageTag } from "./language.ts";

test("a language tag is normalized to a lowercase BCP-47 base", () => {
  assert.equal(normalizeLanguage("TR"), "tr");
  assert.equal(normalizeLanguage(" en-US "), "en-us");
  assert.equal(normalizeLanguage("en_US"), "en-us");
  // Not plausible tags are rejected rather than passed on.
  assert.equal(normalizeLanguage(""), undefined);
  assert.equal(normalizeLanguage("   "), undefined);
  assert.equal(normalizeLanguage("hello world"), undefined);
  assert.equal(normalizeLanguage(5), undefined);
  assert.equal(normalizeLanguage(undefined), undefined);
});

test("the language base drops the region", () => {
  assert.equal(languageBase("en-US"), "en");
  assert.equal(languageBase("tr"), "tr");
  assert.equal(languageBase(undefined), undefined);
});

test("a leading [xx] tag is stripped from the answer and reported", () => {
  assert.deepEqual(stripLanguageTag("[en] Yes, I can hear you."), {
    text: "Yes, I can hear you.",
    language: "en",
  });
  assert.deepEqual(stripLanguageTag("(tr) Onaylıyor musun?"), {
    text: "Onaylıyor musun?",
    language: "tr",
  });
  // No tag: the text is untouched and no language is invented.
  assert.deepEqual(stripLanguageTag("No tag here."), { text: "No tag here." });
  assert.deepEqual(stripLanguageTag(undefined), {});
});

test("a language on a tool call input wins, and malformed inputs are ignored", () => {
  assert.equal(languageFromToolCalls([{ input: { language: "TR" } }]), "tr");
  assert.equal(languageFromToolCalls([{ input: { language: "not a tag!" } }]), undefined);
  assert.equal(languageFromToolCalls([{ input: "a string" }, { input: { amount: "5" } }]), undefined);
});

test("the detected language wins over the model's report (step A12)", () => {
  // The A11 bug: the model claimed English while the audio (and the garbled
  // transcript) was actually Turkish — or the reverse. The detector reads the
  // audio, so it decides.
  const decision = resolveTurnLanguage("tr-TR", "en");
  assert.equal(decision.language, "tr-tr");
  assert.equal(decision.source, "stt");
  assert.equal(decision.disagreed, true);
  assert.equal(decision.detected, "tr-tr");
  assert.equal(decision.reported, "en");
});

test("agreement keeps the detected language and is not a disagreement", () => {
  const decision = resolveTurnLanguage("en-US", "en");
  assert.equal(decision.language, "en-us");
  assert.equal(decision.source, "stt");
  assert.equal(decision.disagreed, false);
});

test("the model's report is the fallback only when nothing was detected", () => {
  const decision = resolveTurnLanguage(undefined, "en");
  assert.equal(decision.language, "en");
  assert.equal(decision.source, "model");
  assert.equal(decision.disagreed, false);
  // Garbage on either side is not a language.
  assert.deepEqual(resolveTurnLanguage("not a tag", undefined), {
    source: "none",
    disagreed: false,
  });
  assert.deepEqual(resolveTurnLanguage(undefined, undefined), {
    source: "none",
    disagreed: false,
  });
});
