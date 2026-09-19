import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_PROMPT,
  DEFAULT_CONFIRM_TIMEOUT_MS,
  interactiveConfirm,
  parseConfirmation,
} from "../confirm.ts";

describe("parseConfirmation — strict lowercase gate (B3)", () => {
  const approve = ["y", "yes", "y\n", "yes\n"];
  const deny = [
    "Y",
    "Y ",
    " y",
    " y ",
    "YES",
    "Yes",
    "yes please",
    "1",
    "true",
    "no",
    "N",
    "",
    "yes\n\n",
    "y\r\n",
    "yes\r\n",
  ];

  it.each(approve)("approves the exact lowercase %j", (answer) => {
    expect(parseConfirmation(answer)).toBe(true);
  });

  it.each(deny)("aborts %j", (answer) => {
    expect(parseConfirmation(answer)).toBe(false);
  });

  it("states the newline rules explicitly", () => {
    // Exactly one trailing newline is tolerated...
    expect(parseConfirmation("yes\n")).toBe(true);
    expect(parseConfirmation("y\n")).toBe(true);
    // ...but a CRLF keeps the `\r` and therefore aborts.
    expect(parseConfirmation("y\r\n")).toBe(false);
    // ...and a second newline is not stripped.
    expect(parseConfirmation("yes\n\n")).toBe(false);
  });
});

describe("interactiveConfirm — injected streams (B1)", () => {
  /** A writable that records everything written to it. */
  function collector(): { stream: PassThrough; text: () => string } {
    const chunks: string[] = [];
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(String(chunk)));
    return { stream, text: () => chunks.join("") };
  }

  it("approves an exact lowercase y / yes read from the input stream", async () => {
    for (const answer of ["y\n", "yes\n"]) {
      const input = new PassThrough();
      const output = collector();
      const pending = interactiveConfirm("CARD-BODY", { input, output: output.stream, timeoutMs: 500 });
      input.end(answer);
      await expect(pending).resolves.toBe(true);
      expect(output.text()).toContain("CARD-BODY");
      expect(output.text()).toContain(CONFIRM_PROMPT);
    }
  });

  it("denies an uppercase or padded answer end-to-end (B3)", async () => {
    for (const answer of ["Y\n", "Y \n", "YES\n", "yes please\n", "1\n"]) {
      const input = new PassThrough();
      const output = collector();
      const pending = interactiveConfirm("CARD-BODY", { input, output: output.stream, timeoutMs: 500 });
      input.end(answer);
      await expect(pending).resolves.toBe(false);
    }
  });

  it("defaults to deny on EOF (nothing is signed)", async () => {
    const input = new PassThrough();
    const output = collector();
    const pending = interactiveConfirm("CARD-BODY", { input, output: output.stream, timeoutMs: 500 });
    input.end();
    await expect(pending).resolves.toBe(false);
  });

  it("defaults to deny and says so on an idle timeout (non-blocking #1)", async () => {
    const input = new PassThrough(); // never closes, never answers
    const output = collector();
    const pending = interactiveConfirm("CARD-BODY", { input, output: output.stream, timeoutMs: 20 });
    await expect(pending).resolves.toBe(false);
    expect(output.text()).toContain("approval timed out");
    expect(DEFAULT_CONFIRM_TIMEOUT_MS).toBe(120_000);
  });
});
