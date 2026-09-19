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

test("the model's report wins over the STT label (step A14)", () => {
  // The A14 finding: Whisper labelled correct English text `tr`, so trusting
  // the audio detector produced a Turkish reply to an English command.
  const decision = resolveTurnLanguage("tr-TR", "en");
  assert.equal(decision.language, "en");
  assert.equal(decision.source, "model");
  assert.equal(decision.disagreed, true);
  assert.equal(decision.detected, "tr-tr");
  assert.equal(decision.reported, "en");
});

test("the real A14 failing transcript answers in English (step A14)", () => {
  // `transcript in 479 ms (audio 2560 ms) via stt [lang tr]: Can you send 400$ to Bilal?`
  // — the text is plainly English while the STT label says Turkish. The model
  // read the transcript and reported `en`; English must win for both the reply
  // and the TTS voice.
  const decision = resolveTurnLanguage("tr", "en");
  assert.equal(decision.language, "en");
  assert.equal(decision.source, "model");
  assert.equal(decision.disagreed, true);
});

test("agreement keeps the model's report and is not a disagreement", () => {
  const decision = resolveTurnLanguage("en-US", "en");
  assert.equal(decision.language, "en");
  assert.equal(decision.source, "model");
  assert.equal(decision.disagreed, false);
});

test("the STT label is the fallback only when the model reports nothing", () => {
  const decision = resolveTurnLanguage("tr-TR", undefined);
  assert.equal(decision.language, "tr-tr");
  assert.equal(decision.source, "stt");
  assert.equal(decision.disagreed, false);
  // Garbage on either side is not a language.
  assert.deepEqual(resolveTurnLanguage(undefined, "not a tag"), {
    source: "none",
    disagreed: false,
  });
  assert.deepEqual(resolveTurnLanguage(undefined, undefined), {
    source: "none",
    disagreed: false,
  });
});
