import assert from "node:assert/strict";
import { test } from "node:test";

import { languageBase, languageFromToolCalls, normalizeLanguage, stripLanguageTag } from "./language.ts";

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
