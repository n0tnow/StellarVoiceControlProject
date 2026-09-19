import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARD_ERRORS, TOKEN_ERRORS, type ErrorKind } from "../../keeper/errors.ts";
import {
  GUARD_ERROR_NAMES,
  TOKEN_ERROR_NAMES,
  GuardClientError,
  asGuardClientError,
  classifyGuardText,
  guardErrorFromCode,
  isGuardClientError,
} from "../errors.ts";

const simText = (code: number): string => `HostError: Error(Contract, #${code})\n\nEvent log (newest first):\n   0: ...`;

describe("GuardClientError mapping", () => {
  it("maps guard policy codes to names/kinds/codes", () => {
    const e = classifyGuardText(simText(103));
    expect(e).toBeInstanceOf(GuardClientError);
    expect(e.name).toBe("OverPerTxLimit");
    expect(e.kind).toBe("rule_violated");
    expect(e.code).toBe(103);
  });

  it("maps NeedsOwnerApproval (the Touch ID signal) and InsufficientAllowance", () => {
    expect(classifyGuardText(simText(105)).name).toBe("NeedsOwnerApproval");
    expect(classifyGuardText(simText(116)).kind).toBe("allowance_missing");
  });

  it("maps SAC/token codes below 100 without mislabelling them as policy", () => {
    const allowance = classifyGuardText(simText(9));
    expect(allowance.name).toBe("SacAllowanceError");
    expect(allowance.kind).toBe("allowance_missing");
    expect(classifyGuardText(simText(13)).name).toBe("SacTrustlineMissing");
  });

  it("keeps an unknown code and degrades to unknown_contract", () => {
    const e = classifyGuardText(simText(999));
    expect(e.name).toBe("ContractError#999");
    expect(e.kind).toBe("unknown_contract");
    expect(e.code).toBe(999);
  });

  it("trims the message to the first line (no event-log spam)", () => {
    expect(classifyGuardText(simText(110)).message).toBe("HostError: Error(Contract, #110)");
  });

  it("guardErrorFromCode works without simulation text", () => {
    expect(guardErrorFromCode(106).name).toBe("AssetNotAllowed");
    expect(guardErrorFromCode(106).kind).toBe("rule_violated");
    expect(guardErrorFromCode(7).name).toBe("SacAccountIsNotClassic");
  });

  it("asGuardClientError wraps transport failures as rpc", () => {
    const e = asGuardClientError(new Error("fetch failed"));
    expect(isGuardClientError(e)).toBe(true);
    expect(e.kind).toBe("rpc");
    expect(asGuardClientError(e)).toBe(e);
  });

  it("every guard code 100..116 maps to a known name", () => {
    for (let code = 100; code <= 116; code++) {
      expect(GUARD_ERROR_NAMES[code]).toBeTruthy();
      expect(guardErrorFromCode(code).name).toBe(GUARD_ERROR_NAMES[code]);
    }
  });
});

describe("drift guards", () => {
  it("GUARD_ERROR_NAMES matches keeper/errors.ts GUARD_ERRORS", () => {
    const fromKeeper = Object.fromEntries(Object.entries(GUARD_ERRORS).map(([c, d]) => [Number(c), d.name]));
    expect(GUARD_ERROR_NAMES).toEqual(fromKeeper);
  });

  it("TOKEN_ERROR_NAMES matches keeper/errors.ts TOKEN_ERRORS", () => {
    const fromKeeper = Object.fromEntries(Object.entries(TOKEN_ERRORS).map(([c, d]) => [Number(c), d.name]));
    expect(TOKEN_ERROR_NAMES).toEqual(fromKeeper);
  });

  it("GUARD_ERROR_NAMES matches the #[contracterror] enum in contracts/polaris_guard/src/lib.rs", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../../../contracts/polaris_guard/src/lib.rs", import.meta.url)),
      "utf8",
    );
    const block = /#\[contracterror\][\s\S]*?pub enum Error\s*\{([\s\S]*?)\n\}/.exec(src)?.[1];
    expect(block, "no #[contracterror] enum found in the contract source").toBeTruthy();
    const fromSource = new Map<number, string>();
    for (const m of (block ?? "").matchAll(/^\s*([A-Za-z0-9]+)\s*=\s*(\d+)\s*,/gm)) {
      fromSource.set(Number(m[2]), m[1] as string);
    }
    expect(fromSource.size).toBeGreaterThan(0);
    expect([...fromSource].sort((a, b) => a[0] - b[0])).toEqual(
      Object.entries(GUARD_ERROR_NAMES)
        .map(([c, n]) => [Number(c), n] as [number, string])
        .sort((a, b) => a[0] - b[0]),
    );
  });

  it("keeps the guard/token code ranges disjoint and every kind valid", () => {
    const kinds: ErrorKind[] = [
      "already_executed",
      "not_due",
      "inactive",
      "rule_violated",
      "allowance_missing",
      "unknown_contract",
      "auth_required",
      "keeper_funds",
      "bad_seq",
      "tx_expired",
      "rpc",
      "unknown",
    ];
    for (const code of Object.keys(GUARD_ERRORS).map(Number)) expect(code).toBeGreaterThanOrEqual(100);
    for (const code of Object.keys(TOKEN_ERRORS).map(Number)) expect(code).toBeLessThan(100);
    for (const def of [...Object.values(GUARD_ERRORS), ...Object.values(TOKEN_ERRORS)]) {
      expect(kinds).toContain(def.kind);
    }
  });
});
