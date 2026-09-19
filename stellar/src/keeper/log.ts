/** Structured JSON-lines logging. One object per line on stdout; never secrets. */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  event: string;
  [key: string]: unknown;
}

export type Logger = (level: LogLevel, fields: LogFields) => void;

/** JSON.stringify that survives bigint (i128/u64 values from the contract). */
export function safeStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Default logger: `{"ts":"...","level":"info","event":"...",...}` per line.
 * Entries below `minLevel` are dropped (`debug` is silent by default).
 */
export function jsonLogger(
  opts: { minLevel?: LogLevel; write?: (line: string) => void } = {},
): Logger {
  const min = ORDER[opts.minLevel ?? "info"];
  const write = opts.write ?? ((l: string) => void process.stdout.write(`${l}\n`));
  return (level, fields) => {
    if (ORDER[level] < min) return;
    write(safeStringify({ ts: new Date().toISOString(), level, ...fields }));
  };
}
