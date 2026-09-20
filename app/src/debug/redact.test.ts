import assert from "node:assert/strict";
import { test } from "node:test";

import { redact, REDACTED } from "./redact.ts";

const SEED = `S${"A".repeat(55)}`;
const PUBLIC_KEY = `G${"A".repeat(55)}`;

test("OpenAI-style and Groq keys are redacted", () => {
  assert.equal(redact("key sk-abcdefghijklmnop"), `key ${REDACTED}`);
  assert.equal(redact("key gsk_abcdefghijklmnop"), `key ${REDACTED}`);
});

test("a Stellar secret seed is redacted", () => {
  const scrubbed = redact(`seed ${SEED} must go`);
  assert.ok(!scrubbed.includes(SEED), scrubbed);
  assert.equal(scrubbed, `seed ${REDACTED} must go`);
});

test("long base64 and hex blobs are redacted", () => {
  const base64 = "A".repeat(64);
  const hex = "deadbeef".repeat(8);
  assert.equal(redact(base64), REDACTED);
  assert.equal(redact(hex), REDACTED);
});

test("a Stellar public key is preserved — it is not a secret", () => {
  assert.equal(redact(PUBLIC_KEY), PUBLIC_KEY);
  assert.equal(redact(`send to ${PUBLIC_KEY} please`), `send to ${PUBLIC_KEY} please`);
});

test("a public key and a seed in the same string are handled differently", () => {
  const scrubbed = redact(`public ${PUBLIC_KEY} secret ${SEED}`);
  assert.ok(scrubbed.includes(PUBLIC_KEY), scrubbed);
  assert.ok(!scrubbed.includes(SEED), scrubbed);
});

test("a BIP-39 recovery phrase is redacted", () => {
  const phrase =
    "illness spike retreat truth genius clock brain pass fit cave bargain toe";
  assert.equal(redact(`seed: ${phrase}`), `seed: ${REDACTED}`);
  // A short lowercase sentence is not a phrase and survives.
  const short = "recipient alice is not a known alias";
  assert.equal(redact(short), short);
});

test("ordinary text is untouched", () => {
  const text = "capture idle; last clip 1234 ms; Accessibility granted";
  assert.equal(redact(text), text);
});

test("every secret in a multi-secret string is redacted", () => {
  const scrubbed = redact(`a sk-abcdefghijklmnop b ${SEED} c gsk_abcdefghijklmnop`);
  assert.equal(scrubbed, `a ${REDACTED} b ${REDACTED} c ${REDACTED}`);
});
