import { describe, expect, it } from "vitest";
import { GuardClientError } from "../errors.ts";
import { chooseGuardedRoute, type GuardRouteInput } from "../route.ts";
import type { Rule } from "../types.ts";
import { ASSET_SAC, EXECUTOR, GUARD_ID_2, RULE } from "./helpers.ts";

const base: GuardRouteInput = {
  rule: RULE,
  executor: EXECUTOR,
  amountRaw: 3_000000n,
  assetContractId: ASSET_SAC,
  recipientKnown: false,
};

const knownOnly: Rule = { ...RULE, known_recipients_only: true };

function refusalOf(input: GuardRouteInput): GuardClientError {
  try {
    chooseGuardedRoute(input);
  } catch (e) {
    if (e instanceof GuardClientError) return e;
    throw e;
  }
  throw new Error("expected a GuardClientError");
}

describe("chooseGuardedRoute — pay_executor branch", () => {
  it("routes a small payment by a registered executor to pay_executor", () => {
    const decision = chooseGuardedRoute(base);
    expect(decision.route).toBe("pay_executor");
    expect(decision.reason).toMatch(/executor/i);
  });

  it("routes exactly at auto_approve_limit to pay_executor", () => {
    expect(chooseGuardedRoute({ ...base, amountRaw: RULE.auto_approve_limit }).route).toBe("pay_executor");
  });

  it("allows an unknown recipient when known_recipients_only is off", () => {
    expect(chooseGuardedRoute({ ...base, rule: knownOnly, recipientKnown: false }).route).toBe("pay_owner");
    expect(chooseGuardedRoute({ ...base, recipientKnown: false }).route).toBe("pay_executor");
  });

  it("allows a known recipient under known_recipients_only", () => {
    expect(chooseGuardedRoute({ ...base, rule: knownOnly, recipientKnown: true }).route).toBe("pay_executor");
  });
});

describe("chooseGuardedRoute — pay_owner branch", () => {
  it("falls back to pay_owner when no executor is registered", () => {
    const decision = chooseGuardedRoute({ ...base, executor: null });
    expect(decision.route).toBe("pay_owner");
    expect(decision.reason).toMatch(/no executor/i);
  });

  it("falls back to pay_owner just above auto_approve_limit", () => {
    const decision = chooseGuardedRoute({ ...base, amountRaw: RULE.auto_approve_limit + 1n });
    expect(decision.route).toBe("pay_owner");
    expect(decision.reason).toMatch(/auto_approve_limit/);
  });

  it("falls back to pay_owner for an unknown recipient under known_recipients_only", () => {
    const decision = chooseGuardedRoute({ ...base, rule: knownOnly, recipientKnown: false });
    expect(decision.route).toBe("pay_owner");
    expect(decision.reason).toMatch(/known_recipients_only/);
  });

  it("still allows exactly per_tx_limit through pay_owner (hard cap is inclusive)", () => {
    expect(chooseGuardedRoute({ ...base, amountRaw: RULE.per_tx_limit }).route).toBe("pay_owner");
  });
});

describe("chooseGuardedRoute — hard refusals", () => {
  it("refuses above per_tx_limit with OverPerTxLimit", () => {
    const e = refusalOf({ ...base, amountRaw: RULE.per_tx_limit + 1n });
    expect(e.name).toBe("OverPerTxLimit");
    expect(e.code).toBe(103);
    expect(e.kind).toBe("rule_violated");
  });

  it("refuses an asset outside allowed_assets with AssetNotAllowed", () => {
    const e = refusalOf({ ...base, assetContractId: GUARD_ID_2 });
    expect(e.name).toBe("AssetNotAllowed");
    expect(e.code).toBe(106);
  });

  it("refuses a zero/negative amount with InvalidAmount", () => {
    expect(refusalOf({ ...base, amountRaw: 0n }).name).toBe("InvalidAmount");
    expect(refusalOf({ ...base, amountRaw: -1n }).name).toBe("InvalidAmount");
  });

  it("checks the asset allowlist before the per-tx cap", () => {
    const e = refusalOf({ ...base, assetContractId: GUARD_ID_2, amountRaw: RULE.per_tx_limit + 1n });
    expect(e.name).toBe("AssetNotAllowed");
  });

  it("checks the per-tx cap before the executor fallback", () => {
    const e = refusalOf({ ...base, executor: null, amountRaw: RULE.per_tx_limit + 1n });
    expect(e.name).toBe("OverPerTxLimit");
  });
});
