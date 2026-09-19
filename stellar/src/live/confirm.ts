/**
 * The explicit approval gate for destructive live operations.
 *
 * The gate is deliberately **strict** (review B3): the only accepted answers
 * are the exact lowercase strings `y` and `yes`. There is no trimming of
 * spaces and no case folding, so `Y`, `Y `, ` y`, `YES`, `yes please`, `1`,
 * the empty string and EOF all abort. A single trailing newline is tolerated
 * because a terminal may hand the line back with its terminator attached
 * (`"yes\n"` approves, `"y\r\n"` does not).
 *
 * The prompt is **bounded** (review non-blocking #1): an idle prompt returns
 * `false` after `DEFAULT_CONFIRM_TIMEOUT_MS` (120 s) and says so. EOF also
 * defaults to deny, so nothing is ever signed without an affirmative answer.
 */
import type { Readable, Writable } from "node:stream";

/** Idle time after which an unanswered prompt aborts. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 120_000;
/** The exact prompt text shown before reading the answer. */
export const CONFIRM_PROMPT = "Type y or yes (lowercase) to approve, anything else aborts: ";

/**
 * Pure answer parser. Approves ONLY the exact lowercase `y` / `yes` after
 * removing at most one trailing `\n`; everything else (including `Y`,
 * `" y"`, `"Y "`, `YES`, `"yes please"`, `"1"`, `""`) aborts.
 */
export function parseConfirmation(answer: string): boolean {
  const body = answer.endsWith("\n") ? answer.slice(0, -1) : answer;
  return body === "y" || body === "yes";
}

export interface ConfirmStreams {
  /** Input stream; defaults to `process.stdin`. Injected by tests. */
  input?: Readable;
  /** Output stream; defaults to `process.stdout`. Injected by tests. */
  output?: Writable;
  /** Override the idle timeout (tests). */
  timeoutMs?: number;
}

/**
 * Print the card and ask for approval. Resolves `true` only for a strict
 * `y` / `yes`; an EOF, an idle timeout or any other answer resolves `false`.
 */
export async function interactiveConfirm(card: string, streams: ConfirmStreams = {}): Promise<boolean> {
  const input = streams.input ?? process.stdin;
  const output = streams.output ?? process.stdout;
  const timeoutMs = streams.timeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
  output.write(`${card}\n\n`);

  const readline = await import("node:readline");
  const rl = readline.createInterface({ input, output });
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (approved: boolean, message?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      rl.close();
      if (message) output.write(`${message}\n`);
      resolve(approved);
    };
    timer = setTimeout(
      () => finish(false, "approval timed out; nothing was signed or submitted."),
      timeoutMs,
    );
    rl.question(CONFIRM_PROMPT, (answer) => finish(parseConfirmation(answer)));
    // EOF / closed stdin: default to deny rather than leaving the run hanging.
    rl.once("close", () => finish(false));
  });
}
