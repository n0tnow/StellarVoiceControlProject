import { describe, expect, it } from "vitest";

import { P2pRefusal, p2pErrorMessage } from "../errors.ts";

/** The exact live shape: a SAC failure plus an event log. */
const simText = (code: number): string =>
  `HostError: Error(Contract, #${code})\n\nEvent log (newest first):\n   0: [Diagnostic Event] ...`;

describe("p2pErrorMessage — token/SAC codes become plain sentences", () => {
  it("maps #13 (trustline missing) to the asset's trustline sentence", () => {
    expect(p2pErrorMessage(new Error(simText(13)), { asset: "USDC" })).toBe(
      "Your wallet has no USDC trustline yet.",
    );
  });

  it("maps #10 (balance) to a not-enough sentence", () => {
    expect(p2pErrorMessage(new Error(simText(10)), { asset: "PGUSD" })).toBe(
      "Not enough PGUSD in your wallet.",
    );
  });

  it("maps an unmapped token code to the calm fallback, never raw host text", () => {
    const message = p2pErrorMessage(new Error(simText(3)), { asset: "USDC" });
    expect(message).not.toContain("HostError");
    expect(message).not.toContain("Error(Contract");
  });
});

describe("p2pErrorMessage — escrow codes (200+) become plain sentences", () => {
  it("maps offer lifecycle failures", () => {
    expect(p2pErrorMessage(new Error(simText(200)))).toBe("That offer no longer exists.");
    expect(p2pErrorMessage(new Error(simText(204)))).toBe(
      "That offer is no longer open, so this action is not allowed.",
    );
    expect(p2pErrorMessage(new Error(simText(205)))).toBe("That offer has expired.");
    expect(p2pErrorMessage(new Error(simText(208)))).toBe("Only the offer's seller can do that.");
  });

  it("maps an unknown escrow code to a generic escrow sentence", () => {
    expect(p2pErrorMessage(new Error(simText(299)))).toBe("The escrow rejected this trade.");
  });
});

describe("p2pErrorMessage — refusals and transport stay readable", () => {
  it("keeps the instructive config/price refusal messages", () => {
    const refusal = new P2pRefusal("not_configured", "POLARIS_P2P_CONTRACT_ID is not set");
    expect(p2pErrorMessage(refusal)).toBe("POLARIS_P2P_CONTRACT_ID is not set");
    const price = new P2pRefusal("invalid_price", "price must be greater than zero");
    expect(p2pErrorMessage(price)).toBe("price must be greater than zero");
  });

  it("classifies a wrapped simulation refusal and drops the event log", () => {
    const refusal = new P2pRefusal("simulation_failed", simText(13));
    expect(p2pErrorMessage(refusal, { asset: "XLM" })).toBe("Your wallet has no XLM trustline yet.");
  });

  it("returns the first line of an unclassified transport error", () => {
    expect(p2pErrorMessage(new Error("fetch failed\nat somewhere"))).toBe("fetch failed");
  });
});
