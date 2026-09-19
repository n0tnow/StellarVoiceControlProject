/**
 * Strict command-line parsing for the live manual-test tooling.
 *
 * Rules (deliberate — a manual tester must never be surprised):
 *   - exactly one command positional; any extra positional is a usage error;
 *   - every accepted flag is declared up front; an **unknown flag is a usage
 *     error**, never silently ignored;
 *   - a value-taking flag without a value is a usage error;
 *   - a flag repeated on the command line is a usage error (never "last wins");
 *   - `--flag=value` is accepted; booleans never take a value.
 *
 * Pure: no I/O, no network. `--help` short-circuits.
 */

export class UsageError extends Error {
  readonly code = "usage" as const;
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface FlagSpec {
  type: "boolean" | "string";
  /** Placeholder shown in help for value flags, e.g. `"<alias>"`. */
  value?: string;
  description: string;
}

export interface CommandArgSpec {
  name: string;
  summary: string;
  usage: string;
  flags: Record<string, FlagSpec>;
}

export interface ArgSpec {
  program: string;
  description: string;
  /** Flags valid for every command (e.g. `--live`, `--yes`, `--help`). */
  globalFlags?: Record<string, FlagSpec>;
  commands: Record<string, CommandArgSpec>;
}

export interface ParsedCommand {
  /** Command name, or undefined only when `--help` was requested globally. */
  command?: string;
  flags: Record<string, string | boolean>;
  help: boolean;
}

const HELP: FlagSpec = { type: "boolean", description: "Show this help and exit." };

/**
 * Parse `argv` against `spec`. Throws `UsageError` on anything malformed; the
 * caller prints the message plus the relevant usage block.
 */
export function parseCommandLine(argv: readonly string[], spec: ArgSpec): ParsedCommand {
  // `--help` anywhere wins, before any validation (so `tool --help` works).
  const wantsHelp = argv.includes("--help") || argv.includes("-h");
  const flags: Record<string, string | boolean> = {};
  let command: string | undefined;
  let help = wantsHelp;

  const setFlag = (name: string, value: string | boolean): void => {
    if (Object.prototype.hasOwnProperty.call(flags, name)) {
      throw new UsageError(`flag "--${name}" was provided more than once`);
    }
    flags[name] = value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i] as string;

    if (token === "--help" || token === "-h") continue;

    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq >= 0 ? body.slice(0, eq) : body;
      if (name.length === 0) throw new UsageError(`invalid flag "${token}"`);

      const declared = lookupFlag(spec, command, name);
      if (!declared) {
        throw new UsageError(
          command
            ? `unknown flag "--${name}" for command "${command}" (see \`${spec.program} ${command} --help\`)`
            : `unknown flag "--${name}" (see \`${spec.program} --help\`)`,
        );
      }

      if (declared.type === "boolean") {
        if (eq >= 0) throw new UsageError(`flag "--${name}" does not take a value`);
        setFlag(name, true);
        continue;
      }

      if (eq >= 0) {
        const value = body.slice(eq + 1);
        if (value.length === 0) throw new UsageError(`flag "--${name}" needs a value`);
        setFlag(name, value);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new UsageError(`flag "--${name}" needs a value ${declared.value ?? ""}`.trim());
      }
      setFlag(name, next);
      i += 1;
      continue;
    }

    // A bare positional: the command name (exactly one).
    if (command !== undefined) {
      throw new UsageError(`unexpected argument "${token}"; only one command is allowed`);
    }
    if (!Object.prototype.hasOwnProperty.call(spec.commands, token)) {
      throw new UsageError(`unknown command "${token}" (see \`${spec.program} --help\`)`);
    }
    command = token;
  }

  return { ...(command !== undefined ? { command } : {}), flags, help };
}

/** Resolve a flag against the command's flags then the globals, or undefined. */
function lookupFlag(spec: ArgSpec, command: string | undefined, name: string): FlagSpec | undefined {
  if (name === "help") return HELP;
  if (command) {
    const cmd = spec.commands[command];
    const local = cmd?.flags[name];
    if (local) return local;
  }
  return spec.globalFlags?.[name];
}

/** Read a required string flag, or throw a usage error. */
export function requireString(flags: Record<string, string | boolean>, name: string): string {
  const value = flags[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new UsageError(`--${name} is required`);
  }
  return value;
}

/** Read an optional string flag (`undefined` when absent). */
export function optionalString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

/** Read a required positive-integer flag (decimal digits only). */
export function requireInt(flags: Record<string, string | boolean>, name: string): number {
  const raw = requireString(flags, name);
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

/** Read an optional positive-integer flag. */
export function optionalInt(flags: Record<string, string | boolean>, name: string): number | undefined {
  const raw = optionalString(flags, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}`);
  return Number(raw);
}

function flagLeft(name: string, flag: FlagSpec): string {
  const value = flag.type === "string" ? ` ${flag.value ?? "<value>"}` : "";
  return `  --${name}${value}`;
}

function renderFlagLines(entries: Array<[string, FlagSpec]>): string[] {
  const rows = entries.map(([name, flag]) => [flagLeft(name, flag), flag.description] as const);
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0) + 2;
  return rows.map(([left, desc]) => left.padEnd(width) + desc);
}

/** Full help text for the program or one command. */
export function renderUsage(spec: ArgSpec, command?: string): string {
  const lines: string[] = [];
  if (command && spec.commands[command]) {
    const cmd = spec.commands[command] as CommandArgSpec;
    lines.push(`${spec.program} ${cmd.usage}`, "", cmd.summary, "", "Flags:");
    lines.push(...renderFlagLines([...Object.entries(cmd.flags), ...Object.entries(spec.globalFlags ?? {}), ["help", HELP]]));
    return lines.join("\n");
  }
  lines.push(`${spec.program} — ${spec.description}`, "", "Usage:", `  ${spec.program} <command> [options]`, "");
  lines.push("Commands:");
  for (const cmd of Object.values(spec.commands)) lines.push(`  ${cmd.name.padEnd(14)} ${cmd.summary}`);
  lines.push("", "Global flags:");
  lines.push(...renderFlagLines([...Object.entries(spec.globalFlags ?? {}), ["help", HELP]]));
  lines.push("", `Run \`${spec.program} <command> --help\` for command-specific options.`);
  return lines.join("\n");
}
