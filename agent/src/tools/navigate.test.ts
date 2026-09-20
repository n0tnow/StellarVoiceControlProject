import assert from "node:assert/strict";
import { test } from "node:test";

import {
  navigationSentence,
  foldNavigationWord,
  navigateTool,
  normalizeNavTarget,
} from "./navigate.ts";

const ctx = { network: "testnet" as const, transcript: "cüzdanı aç" };

test("foldNavigationWord strips Turkish diacritics and the dotless i", () => {
  assert.equal(foldNavigationWord("Cüzdanı"), "cuzdani");
  assert.equal(foldNavigationWord("GÖREVLER"), "gorevler");
  assert.equal(foldNavigationWord("  Geçmiş  "), "gecmis");
  assert.equal(foldNavigationWord("Kuralları"), "kurallari");
});

test("normalizeNavTarget accepts canonical values and tr/en synonyms", () => {
  assert.equal(normalizeNavTarget("wallet"), "wallet");
  assert.equal(normalizeNavTarget("cüzdan"), "wallet");
  assert.equal(normalizeNavTarget("KURALLAR"), "rules");
  assert.equal(normalizeNavTarget("limitler"), "rules");
  assert.equal(normalizeNavTarget("zamanlanmış ödemeler"), "tasks");
  assert.equal(normalizeNavTarget("scheduled payments"), "tasks");
  assert.equal(normalizeNavTarget("geçmiş"), "history");
  assert.equal(normalizeNavTarget("ayarlar"), "settings");
  assert.equal(normalizeNavTarget("hata ayıkla"), "debug");
  assert.equal(normalizeNavTarget("gizli ödemeler"), "privacy");
  assert.equal(normalizeNavTarget("ilan"), "p2p");
  assert.equal(normalizeNavTarget("banka"), "anchor");
  assert.equal(normalizeNavTarget("kapat"), "close");
});

test("normalizeNavTarget rejects unknown or non-string targets", () => {
  assert.equal(normalizeNavTarget("send 10 xlm"), undefined);
  assert.equal(normalizeNavTarget(""), undefined);
  assert.equal(normalizeNavTarget(undefined), undefined);
  assert.equal(normalizeNavTarget(42), undefined);
});

test("navigationSentence speaks the user's language", () => {
  assert.equal(navigationSentence("wallet", "en"), "Opening your wallet.");
  assert.equal(navigationSentence("wallet", "tr"), "Cüzdanı açıyorum.");
  assert.equal(navigationSentence("close", "tr"), "Kapatıyorum.");
});

test("navigate's run produces a request and the exact sentence toSpeech returns", async () => {
  const result = await navigateTool.run({ target: "wallet", language: "en" }, ctx);
  assert.deepEqual(result.request, {
    target: "wallet",
    spoken: "Opening your wallet.",
    language: "en",
  });
  assert.equal(result.spoken, "Opening your wallet.");
  assert.equal(navigateTool.toSpeech?.(result), "Opening your wallet.");
  assert.deepEqual(navigateTool.toNavigation?.(result), result.request);
});

test("an unknown target asks instead of navigating", async () => {
  const result = await navigateTool.run({ target: "team", language: "tr" }, ctx);
  assert.equal(result.request, undefined);
  assert.equal(result.spoken, "Hangi sayfayı açayım?");
  assert.equal(navigateTool.toNavigation?.(result), undefined);
});

test("navigate is read-only: no approval and no intent", () => {
  assert.equal(navigateTool.requiresApproval, undefined);
  assert.equal(navigateTool.toIntent, undefined);
});
