import assert from "node:assert/strict";
import { test } from "node:test";

import type { Intent } from "@polaris/interfaces";

import { confirmationSentence, isSpeakable, SpeechQueue, spokenText } from "./speech.ts";

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

test("whenIdle resolves immediately when nothing is speaking", async () => {
  const queue = new SpeechQueue(async () => {});
  await queue.whenIdle();
  assert.equal(queue.speaking, false);
});
