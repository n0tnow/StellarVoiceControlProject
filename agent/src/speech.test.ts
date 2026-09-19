import assert from "node:assert/strict";
import { test } from "node:test";

import type { Intent } from "@polaris/interfaces";

import { capSpokenText, confirmationSentence, isSpeakable, MAX_SPOKEN_CHARS, SpeechQueue, spokenText } from "./speech.ts";

function intent(overrides: Partial<Intent> = {}): Intent {
  return { kind: "send", asset: "USDC", amount: "5", ...overrides };
}

/** A manually-released promise, used to hold an utterance "in flight". */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a send intent becomes a short confirmation with the recipient", () => {
  assert.equal(
    confirmationSentence(intent({ recipient: "Ahmet" })),
    "Sending 5 USDC to Ahmet. Do you confirm?",
  );
});

test("the recipient falls back to the alias, then to a neutral phrase", () => {
  assert.equal(
    confirmationSentence(intent({ alias: "ada" })),
    "Sending 5 USDC to ada. Do you confirm?",
  );
  assert.equal(
    confirmationSentence(intent()),
    "Sending 5 USDC to the recipient. Do you confirm?",
  );
});

test("every intent kind produces a non-empty confirmation ending in a question", () => {
  const intents: Intent[] = [
    intent({ kind: "send", recipient: "Ahmet" }),
    intent({ kind: "deposit" }),
    intent({ kind: "swap" }),
    intent({ kind: "guard_policy" }),
    intent({ kind: "raw_tx" }),
  ];
  for (const value of intents) {
    const sentence = confirmationSentence(value);
    assert.ok(sentence.length > 0, `${value.kind} must be speakable`);
    assert.ok(sentence.endsWith("Do you confirm?"), `${value.kind}: ${sentence}`);
    // A confirmation prompt is read aloud: no newlines, no raw structure.
    assert.equal(sentence.includes("\n"), false);
  }
});

test("an intent is spoken as its confirmation, not as the raw answer", () => {
  const spoken = spokenText({
    answer: '{"kind":"send","amount":"5"}',
    intent: intent({ recipient: "Ahmet" }),
  });
  assert.equal(spoken, "Sending 5 USDC to Ahmet. Do you confirm?");
  assert.ok(!spoken.includes("{"), "the spoken sentence must not read JSON aloud");
});

test("a turn without an intent is spoken as its trimmed answer", () => {
  assert.equal(
    spokenText({ answer: "  Bu bir cüzdan işlemi değil. Bir ödeme mi yapmak istiyorsunuz?  " }),
    "Bu bir cüzdan işlemi değil. Bir ödeme mi yapmak istiyorsunuz?",
  );
  assert.equal(spokenText({ answer: "   " }), "");
});

test("regression: a conversational turn is speakable, intent or not", () => {
  // This is the A5 bug: the end-to-end driver treated "no intent" as "nothing
  // to say" and silently discarded a real model answer. The driver now decides
  // with `isSpeakable`; these cases pin that a text-only turn speaks.
  assert.equal(isSpeakable({ answer: "I can hear you." }), true);
  assert.equal(
    isSpeakable({ answer: "no intent here", intent: intent({ recipient: "Ahmet" }) }),
    true,
  );
  // Only an actually empty turn is silent.
  assert.equal(isSpeakable({ answer: "   " }), false);
  assert.equal(isSpeakable({ answer: "" }), false);
});

test("the confirmation follows the model-reported language (step A11)", () => {
  assert.equal(
    confirmationSentence(intent({ recipient: "bilal" }), "en"),
    "Sending 5 USDC to bilal. Do you confirm?",
  );
  // Turkish for a Turkish turn: the A11 bug was an English sentence for a
  // Turkish speaker (and the reverse).
  assert.match(
    confirmationSentence(intent({ recipient: "bilal" }), "tr"),
    /Onaylıyor musun\?$/,
  );
  assert.match(confirmationSentence(intent({ recipient: "bilal" }), "tr-TR"), /bilal adresine/);
  // An unknown language falls back to English, never to silence.
  assert.match(confirmationSentence(intent({ recipient: "bilal" }), "de"), /Do you confirm\?$/);
  assert.match(confirmationSentence(intent({ recipient: "bilal" })), /Do you confirm\?$/);
});

test("an intent is spoken in the turn's language", () => {
  const spoken = spokenText({
    answer: "ignored for an intent",
    intent: intent({ recipient: "Ahmet" }),
    language: "tr",
  });
  assert.match(spoken, /^Ahmet adresine 5 USDC gönderiyorum\./);
});

test("the reported language reaches the speak backend", async () => {
  const seen: Array<[string, string | undefined]> = [];
  const queue = new SpeechQueue(async (text, language) => {
    seen.push([text, language]);
  });
  // `enqueue(text, onError?, language?)` — language is the third argument.
  queue.enqueue("merhaba", undefined, "tr");
  queue.enqueue("hello");
  await queue.whenIdle();
  assert.deepEqual(seen, [
    ["merhaba", "tr"],
    ["hello", undefined],
  ]);
});

test("a second utterance waits for the first and never overlaps", async () => {
  const spoken: string[] = [];
  const first = gate();
  const queue = new SpeechQueue(async (text) => {
    spoken.push(text);
    if (text === "one") {
      await first.promise;
    }
  });

  queue.enqueue("one");
  queue.enqueue("two");
  assert.deepEqual(spoken, ["one"], "the second must not start while the first plays");
  assert.equal(queue.queued, 1);
  assert.equal(queue.speaking, true);

  first.release();
  await queue.whenIdle();
  assert.deepEqual(spoken, ["one", "two"]);
  assert.equal(queue.speaking, false);
  assert.equal(queue.queued, 0);
});

test("a newer waiting utterance replaces an older one (latest-wins)", async () => {
  const spoken: string[] = [];
  const first = gate();
  const queue = new SpeechQueue(async (text) => {
    spoken.push(text);
    if (text === "one") {
      await first.promise;
    }
  });

  queue.enqueue("one");
  queue.enqueue("two");
  queue.enqueue("three");
  assert.equal(queue.queued, 1, "at most one utterance is pending");

  first.release();
  await queue.whenIdle();
  assert.deepEqual(spoken, ["one", "three"], "the stale pending utterance is dropped");
});

test("blank text is ignored and never reaches the backend", async () => {
  const spoken: string[] = [];
  const queue = new SpeechQueue(async (text) => {
    spoken.push(text);
  });

  queue.enqueue("   ");
  queue.enqueue("");
  await queue.whenIdle();
  assert.deepEqual(spoken, []);
  assert.equal(queue.speaking, false);
});

test("a failed utterance is reported and does not stop the queue", async () => {
  const errors: unknown[] = [];
  const spoken: string[] = [];
  const queue = new SpeechQueue(
    async (text) => {
      if (text === "bad") {
        throw new Error("tts down");
      }
      spoken.push(text);
    },
    (error) => errors.push(error),
  );

  queue.enqueue("bad");
  queue.enqueue("good");
  await queue.whenIdle();

  assert.equal(errors.length, 1);
  assert.deepEqual(spoken, ["good"]);
  assert.equal(queue.speaking, false);
});

test("the per-utterance error hook fires only for its own utterance", async () => {
  const own: unknown[] = [];
  const queue = new SpeechQueue(async (text) => {
    if (text === "bad") throw new Error("tts down");
  });

  queue.enqueue("bad", (error) => own.push(error));
  queue.enqueue("good", (error) => own.push(error));
  await queue.whenIdle();

  assert.equal(own.length, 1, "only the failing utterance reports");
});

test("a dropped (superseded) utterance never reports a failure", async () => {
  const own: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new SpeechQueue(async (text) => {
    if (text === "one") await held;
  });

  queue.enqueue("one");
  queue.enqueue("two", () => own.push("two"));
  queue.enqueue("three", () => own.push("three"));
  release();
  await queue.whenIdle();

  // "two" was superseded by "three" and must never run — nor report.
  assert.deepEqual(own, []);
});

test("whenIdle resolves immediately when nothing is speaking", async () => {
  const queue = new SpeechQueue(async () => {});
  await queue.whenIdle();
  assert.equal(queue.speaking, false);
});

test("the spoken text is capped so a rambling answer cannot reach TTS (step A12)", () => {
  // The owner's real log: 261 chars → 30 s of Fish synthesis. The answer below
  // is far past the cap and must be cut down before it is spoken.
  const rambling =
    "Sure! Let me explain. Sending money on Stellar is fast and cheap because " +
    "the network settles in a few seconds and fees are fractions of a cent, so " +
    "you can move USDC to bilal right away if you want, just confirm the amount.";
  const spoken = spokenText({ answer: rambling });
  assert.ok(spoken.length <= MAX_SPOKEN_CHARS, `spoken length ${spoken.length}`);
  // It must still read like a sentence, not a fragment of a word.
  assert.ok(spoken.endsWith(".") || spoken.endsWith("…"), spoken);
  assert.ok(!/\s\S{20}$/.test(spoken), "must not cut mid-sentence-word");
  // The cap is the whole point: the raw answer is much longer than the cap.
  assert.ok(rambling.length > MAX_SPOKEN_CHARS);
});

test("capSpokenText keeps short text exactly and only shortens long text", () => {
  assert.equal(capSpokenText("  Sending 5 USDC to Ahmet. Do you confirm?  "), "Sending 5 USDC to Ahmet. Do you confirm?");
  // A 120-char boundary is inclusive.
  const exact = "a".repeat(MAX_SPOKEN_CHARS);
  assert.equal(capSpokenText(exact), exact);
  assert.equal(capSpokenText("a".repeat(MAX_SPOKEN_CHARS + 1)).length, MAX_SPOKEN_CHARS + 1);
});

test("capSpokenText prefers a sentence boundary, then a word boundary", () => {
  // A sentence boundary inside the window wins and needs no ellipsis.
  const twoSentences = `${"x".repeat(80)}. ${"y".repeat(80)}.`;
  const bySentence = capSpokenText(twoSentences, 90);
  assert.ok(bySentence.endsWith("."), bySentence);
  assert.ok(!bySentence.endsWith("…"), bySentence);
  assert.ok(bySentence.length <= 90);

  // No terminator: cut at a word boundary and mark the cut.
  const words = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ");
  const byWord = capSpokenText(words, 40);
  assert.ok(byWord.endsWith("…"), byWord);
  assert.ok(byWord.length <= 41, `length ${byWord.length}`);
  // Every kept token is a complete original word (never cut mid-word).
  const kept = byWord.slice(0, -1).split(" ");
  for (const token of kept) {
    assert.match(token, /^word\d+$/, `partial token: ${token}`);
  }

  // A single token longer than the cap is cut hard, still with the marker.
  const single = "z".repeat(200);
  const hard = capSpokenText(single, 40);
  assert.equal(hard, `${"z".repeat(40)}…`);
});

test("a confirmation is never affected by the cap", () => {
  const spoken = spokenText({
    answer: "ignored",
    intent: intent({ recipient: "bilal" }),
    language: "en",
  });
  assert.equal(spoken, "Sending 5 USDC to bilal. Do you confirm?");
  assert.ok(spoken.length < MAX_SPOKEN_CHARS);
});
