import { describe, expect, it } from "vitest";
import {
  optionalInt,
  optionalString,
  parseCommandLine,
  renderUsage,
  requireInt,
  requireString,
  UsageError,
  type ArgSpec,
} from "../args.ts";

const SPEC: ArgSpec = {
  program: "prog",
  description: "test program",
  globalFlags: {
    live: { type: "boolean", description: "run live" },
    yes: { type: "boolean", description: "skip prompt" },
  },
  commands: {
    pay: {
      name: "pay",
      summary: "pay",
      usage: "pay --to <alias> --amount <n> [--route direct|guarded]",
      flags: {
        to: { type: "string", value: "<alias>", description: "recipient" },
        amount: { type: "string", value: "<n>", description: "amount" },
        route: { type: "string", value: "<direct|guarded>", description: "route" },
      },
    },
    list: { name: "list", summary: "list", usage: "list", flags: {} },
  },
};

describe("parseCommandLine", () => {
  it("parses a command, value flags and booleans", () => {
    const parsed = parseCommandLine(["pay", "--to", "ada", "--amount=5", "--live", "--yes"], SPEC);
    expect(parsed.command).toBe("pay");
    expect(parsed.flags).toEqual({ to: "ada", amount: "5", live: true, yes: true });
    expect(parsed.help).toBe(false);
  });

  it("rejects an unknown flag (never silently ignored)", () => {
    expect(() => parseCommandLine(["pay", "--to", "ada", "--nope"], SPEC)).toThrowError(UsageError);
  });

  it("rejects an unknown command", () => {
    expect(() => parseCommandLine(["frobnicate"], SPEC)).toThrowError(/unknown command/);
  });

  it("rejects a value flag without a value", () => {
    expect(() => parseCommandLine(["pay", "--to"], SPEC)).toThrowError(/needs a value/);
    expect(() => parseCommandLine(["pay", "--to", "--amount", "1"], SPEC)).toThrowError(/needs a value/);
  });

  it("rejects a boolean flag with a value", () => {
    expect(() => parseCommandLine(["pay", "--live=true"], SPEC)).toThrowError(/does not take a value/);
  });

  it("rejects a second positional", () => {
    expect(() => parseCommandLine(["pay", "extra"], SPEC)).toThrowError(/unexpected argument/);
  });

  it("rejects a duplicated flag instead of silently taking the last value (non-blocking #6)", () => {
    expect(() => parseCommandLine(["pay", "--to", "a", "--to", "b"], SPEC)).toThrowError(/more than once/);
    expect(() => parseCommandLine(["pay", "--to=a", "--to", "b"], SPEC)).toThrowError(/more than once/);
    expect(() => parseCommandLine(["pay", "--live", "--live"], SPEC)).toThrowError(/more than once/);
  });

  it("accepts --help anywhere", () => {
    expect(parseCommandLine(["pay", "--help"], SPEC).help).toBe(true);
    expect(parseCommandLine(["--help"], SPEC).help).toBe(true);
  });
});

describe("flag readers", () => {
  it("requireString / requireInt validate", () => {
    expect(requireString({ to: "ada" }, "to")).toBe("ada");
    expect(() => requireString({}, "to")).toThrowError(/--to is required/);
    expect(requireInt({ runs: "3" }, "runs")).toBe(3);
    expect(() => requireInt({ runs: "x" }, "runs")).toThrowError(/non-negative integer/);
  });

  it("optional helpers return undefined when absent", () => {
    expect(optionalString({}, "tz")).toBeUndefined();
    expect(optionalInt({}, "runs")).toBeUndefined();
    expect(optionalInt({ runs: "2" }, "runs")).toBe(2);
  });
});

describe("renderUsage", () => {
  it("renders program and command help", () => {
    expect(renderUsage(SPEC)).toContain("prog — test program");
    expect(renderUsage(SPEC)).toContain("pay");
    const commandHelp = renderUsage(SPEC, "pay");
    expect(commandHelp).toContain("--to <alias>");
    expect(commandHelp).toContain("--live");
  });
});
