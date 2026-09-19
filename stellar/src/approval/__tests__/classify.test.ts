import { describe, expect, it } from "vitest";
import { chooseGuardedRoute } from "../../guard/route.ts";
import { ASSET_SAC, EXECUTOR, GUARD_ID_2, RULE } from "../../guard/__tests__/helpers.ts";
import type { Rule } from "../../guard/types.ts";
import {
  assertTightening,
  classifyChange,
  confirmationLevel,
  profileFromChain,
  type ChangeKind,
} from "../classify.ts";
import { requiresApprovalCard, resolveApprovalRoute } from "../routing.ts";
import { ApprovalError, type ApprovalProfile } from "../types.ts";

const known: Rule = { ...RULE, known_recipients_only: true };
const tighten = (over: Partial<Rule>): Rule => ({ ...RULE, ...over });

describe("classifyChange", () => {
  it("returns new_rule when there is no current rule", () => {
    expect(classifyChange(undefined, RULE)).toBe("new_rule");
  });

  it("returns same for an identical rule", () => {
    expect(classifyChange(RULE, { ...RULE, allowed_assets: [...RULE.allowed_assets] })).toBe("same");
  });

  it("treats a threshold increase as loosening", () => {
    expect(classifyChange(RULE, tighten({ auto_approve_limit: RULE.auto_approve_limit + 1n }))).toBe("loosening");
  });

  it("treats a threshold decrease as tightening", () => {
    expect(classifyChange(RULE, tighten({ auto_approve_limit: RULE.auto_approve_limit - 1n }))).toBe("tightening");
  });

  it("treats a per_tx increase as loosening", () => {
    expect(classifyChange(RULE, tighten({ per_tx_limit: RULE.per_tx_limit + 1n }))).toBe("loosening");
  });

  it("treats a daily decrease as tightening", () => {
    expect(classifyChange(RULE, tighten({ daily_limit: RULE.daily_limit - 1n }))).toBe("tightening");
  });

  it("treats a growing allowed-asset set as loosening", () => {
    expect(classifyChange(RULE, tighten({ allowed_assets: [ASSET_SAC, GUARD_ID_2] }))).toBe("loosening");
  });

  it("treats a shrinking allowed-asset set as tightening", () => {
    const two = tighten({ allowed_assets: [ASSET_SAC, GUARD_ID_2] });
    expect(classifyChange(two, RULE)).toBe("tightening");
  });

  it("treats replacing one asset with another as mixed", () => {
    expect(classifyChange(RULE, tighten({ allowed_assets: [GUARD_ID_2] }))).toBe("mixed");
  });

  it("treats known_recipients_only turning off as loosening", () => {
    expect(classifyChange(known, RULE)).toBe("loosening");
  });

  it("treats known_recipients_only turning on as tightening", () => {
    expect(classifyChange(RULE, known)).toBe("tightening");
  });

  it("is mixed when a limit rises and an asset is dropped", () => {
    const two = tighten({ allowed_assets: [ASSET_SAC, GUARD_ID_2] });
    expect(classifyChange(two, tighten({ daily_limit: RULE.daily_limit + 1n }))).toBe("mixed");
  });

  it("is mixed when a limit falls and an asset is added", () => {
    const next = tighten({ allowed_assets: [ASSET_SAC, GUARD_ID_2], auto_approve_limit: RULE.auto_approve_limit - 1n });
    expect(classifyChange(RULE, next)).toBe("mixed");
  });
});

describe("confirmationLevel", () => {
  const cases: Array<[ChangeKind, string]> = [
    ["loosening", "card_and_touch_id"],
    ["mixed", "card_and_touch_id"],
    ["new_rule", "card_and_touch_id"],
    ["tightening", "light"],
    ["same", "none"],
  ];
  for (const [change, level] of cases) {
    it(`maps ${change} -> ${level}`, () => {
      expect(confirmationLevel(change)).toBe(level);
    });
  }
});

describe("assertTightening", () => {
  it("allows a tightening change", () => {
    expect(() => assertTightening("tightening")).not.toThrow();
  });

  it("allows a same change", () => {
    expect(() => assertTightening("same")).not.toThrow();
  });

  it("refuses loosening/mixed/new_rule with use_enable_flow", () => {
    for (const change of ["loosening", "mixed", "new_rule"] as const) {
      try {
        assertTightening(change);
        throw new Error(`expected a throw for ${change}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ApprovalError);
        expect((e as ApprovalError).code).toBe("use_enable_flow");
      }
    }
  });
});

describe("profileFromChain", () => {
  it("is always_ask without an executor", () => {
    expect(profileFromChain(RULE, null)).toEqual({ mode: "always_ask" });
  });

  it("is always_ask without a rule", () => {
    expect(profileFromChain(null, EXECUTOR)).toEqual({ mode: "always_ask" });
  });

  it("is always_ask when auto_approve_limit is 0", () => {
    expect(profileFromChain({ ...RULE, auto_approve_limit: 0n }, EXECUTOR)).toEqual({ mode: "always_ask" });
  });

  it("is auto_under_limit with an executor and a positive threshold", () => {
    expect(profileFromChain(RULE, EXECUTOR)).toEqual({ mode: "auto_under_limit" });
  });
});

describe("resolveApprovalRoute", () => {
  const profile = (mode: ApprovalProfile["mode"]): ApprovalProfile => ({ mode });

  it("always_ask forces pay_owner even when the chain allowed pay_executor", () => {
    expect(resolveApprovalRoute({ mode: "always_ask" }, "pay_executor")).toBe("pay_owner");
  });

  it("auto_under_limit follows the chain decision", () => {
    expect(resolveApprovalRoute(profile("auto_under_limit"), "pay_executor")).toBe("pay_executor");
    expect(resolveApprovalRoute(profile("auto_under_limit"), "pay_owner")).toBe("pay_owner");
  });

  it("custom follows the chain decision", () => {
    expect(resolveApprovalRoute(profile("custom"), "pay_executor")).toBe("pay_executor");
  });

  it("defaults to always_ask when no profile is supplied", () => {
    expect(resolveApprovalRoute(undefined, "pay_executor")).toBe("pay_owner");
  });

  it("requiresApprovalCard is exactly the pay_owner path", () => {
    expect(requiresApprovalCard("pay_owner")).toBe(true);
    expect(requiresApprovalCard("pay_executor")).toBe(false);
  });
});

describe("app policy is never looser than the chain (property-style)", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
  }

  it("never yields pay_executor when chooseGuardedRoute would not", () => {
    const rand = lcg(20260919);
    const profiles: Array<ApprovalProfile | undefined> = [
      undefined,
      { mode: "always_ask" },
      { mode: "auto_under_limit" },
      { mode: "custom" },
    ];
    let allowed = 0;
    for (let i = 0; i < 250; i += 1) {
      const perTx = BigInt(1 + Math.floor(rand() * 1_000_000));
      const auto = BigInt(Math.floor(rand() * Number(perTx) + 1));
      const daily = perTx + BigInt(Math.floor(rand() * 1_000_000));
      const rule: Rule = {
        auto_approve_limit: auto,
        per_tx_limit: perTx,
        daily_limit: daily,
        allowed_assets: rand() < 0.85 ? [ASSET_SAC] : [GUARD_ID_2],
        known_recipients_only: rand() < 0.5,
      };
      const amountRaw = BigInt(1 + Math.floor(rand() * Number(perTx)));
      let chainRoute: "pay_executor" | "pay_owner";
      try {
        chainRoute = chooseGuardedRoute({
          rule,
          executor: rand() < 0.85 ? EXECUTOR : null,
          amountRaw,
          assetContractId: ASSET_SAC,
          recipientKnown: rand() < 0.5,
        }).route;
      } catch {
        continue;
      }
      if (chainRoute === "pay_executor") allowed += 1;
      for (const profile of profiles) {
        const appRoute = resolveApprovalRoute(profile, chainRoute);
        if (appRoute === "pay_executor") expect(chainRoute).toBe("pay_executor");
        if (profile?.mode === "always_ask" || profile === undefined) expect(appRoute).toBe("pay_owner");
      }
    }
    expect(allowed).toBeGreaterThan(0);
  });
});
