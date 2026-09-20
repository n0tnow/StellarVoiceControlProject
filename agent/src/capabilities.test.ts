import assert from "node:assert/strict";
import { test } from "node:test";

import { ASSET_SYNONYMS, DEFAULT_ASSET, SUPPORTED_ASSETS } from "./assets.ts";
import { buildSystemPrompt } from "./capabilities.ts";

const sendPayment = {
  name: "send_payment",
  description: "Send a Stellar payment. The recipient may be a name or alias.",
};

test("the capability list is generated from the tools passed in", () => {
  const withOne = buildSystemPrompt({ tools: [sendPayment] });
  assert.match(withOne, /- send_payment: Send a Stellar payment/);
  const withExtra = buildSystemPrompt({
    tools: [sendPayment, { name: "deposit", description: "Deposit TRY via the anchor." }],
  });
  assert.match(withExtra, /- deposit: Deposit TRY via the anchor/);
});

test("the prompt names every asset and the default from the single list", () => {
  const prompt = buildSystemPrompt({ tools: [sendPayment] });
  for (const asset of SUPPORTED_ASSETS) {
    assert.ok(prompt.includes(asset), `prompt must mention ${asset}`);
  }
  assert.match(prompt, new RegExp(`mean ${DEFAULT_ASSET}`));
  assert.match(prompt, /there is no default/);
  for (const word of Object.keys(ASSET_SYNONYMS)) {
    assert.ok(prompt.includes(word), `prompt must mention the word ${word}`);
  }
});

test("the account table carries config labels and short addresses", () => {
  const prompt = buildSystemPrompt({
    tools: [sendPayment],
    ownerAddress: "GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5",
    aliases: { acc2: "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO" },
  });
  assert.match(prompt, /- acc1 \(GB3H…YLX5\)/);
  assert.match(prompt, /- acc2 \(GARX…WWCO\)/);
  assert.match(prompt, /ONLY sender/);
});

test("the prompt encodes the alias synonyms and STT garbles", () => {
  const prompt = buildSystemPrompt({ tools: [sendPayment], aliases: { acc2: "G..." } });
  for (const phrase of [
    "wallet 1",
    "hesap 2",
    "ikinci hesap",
    "iki numaralı hesap",
    "ek 2",
    "AC2",
    "a c c 2",
    "O 2",
    "benim hesabım",
  ]) {
    assert.ok(prompt.includes(phrase), `prompt must mention ${phrase}`);
  }
});

test("negative behaviour is stated: only acc1 sends and mainnet is out", () => {
  const prompt = buildSystemPrompt({ tools: [sendPayment] });
  assert.match(prompt, /from acc1/);
  assert.match(prompt, /mainnet/);
  assert.match(prompt, /approval card/);
  assert.match(prompt, /Never invent a balance/);
});

test("the exact owner utterance appears as a few-shot example", () => {
  const prompt = buildSystemPrompt({ tools: [sendPayment] });
  assert.ok(prompt.includes("acc1'den acc2'ye 10 XLM gönder"));
  assert.ok(prompt.includes("wallet 1'den wallet 2'ye 10 XLM gönder"));
  assert.ok(prompt.includes("send 10 xlm from wallet 1 to wallet 2"));
});

test("the prompt teaches navigation and when not to navigate", () => {
  const prompt = buildSystemPrompt({
    tools: [sendPayment, { name: "navigate", description: "Open a screen." }],
  });
  assert.match(prompt, /Opening screens \(navigation\)/);
  assert.match(prompt, /navigate with that target/);
  assert.match(prompt, /Do NOT navigate/);
  assert.match(prompt, /no navigation/);
});
