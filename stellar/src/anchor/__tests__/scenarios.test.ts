import { describe, expect, it } from "vitest";
import { UnsafeAnchorError } from "../net.ts";
import {
  assertPlainAnchorDomain,
  describeAnchorScenario,
  SDF_TEST_ANCHOR_HOME_DOMAIN,
  TR_MOCK_HOME_DOMAIN,
} from "../scenarios.ts";

describe("anchor scenario registry", () => {
  it("labels the TR mock as the SEP-6-only Turkish path", () => {
    const s = describeAnchorScenario(TR_MOCK_HOME_DOMAIN);
    expect(s.id).toBe("tr-mock");
    expect(s.label).toBe("TR path — SEP-6 only (SEP-24 prohibited in Turkey)");
    expect(s.sepScope).toBe("SEP-6 only");
    expect(s.allowed).toContain("sep6.deposit");
    expect(s.notes).toMatch(/MASAK/);
  });

  it("labels the SDF test anchor as the labelled NON-TR fallback (discovery + login + info only)", () => {
    const s = describeAnchorScenario(SDF_TEST_ANCHOR_HOME_DOMAIN);
    expect(s.id).toBe("sdf-test");
    expect(s.label).toBe(
      "NON-TR test scenario (SDF test anchor) — discovery + SEP-10 login + SEP-6 info only; deposit stops at SEP-12 KYC",
    );
    expect(s.sepScope).toBe("SEP-6 only");
    expect(s.allowed).toEqual(["sep1.discovery", "sep10.login", "sep6.info"]);
    expect(s.allowed).not.toContain("sep6.deposit");
    expect(s.notes).toMatch(/NON-TR/);
  });

  it("refuses an unknown domain unless it is explicitly passed as custom (with a warning label)", () => {
    expect(() => describeAnchorScenario("anchor.example.com")).toThrow(UnsafeAnchorError);
    expect(() => describeAnchorScenario("anchor.example.com")).toThrow(/not an approved anchor scenario/);
    const custom = describeAnchorScenario("anchor.example.com", { custom: true });
    expect(custom.id).toBe("custom");
    expect(custom.label).toMatch(/CUSTOM/);
    expect(custom.label).toMatch(/UNVERIFIED/);
    expect(custom.allowed).toEqual([]);
  });

  it("never names SEP-24 as an allowed step on any scenario", () => {
    for (const s of [describeAnchorScenario(TR_MOCK_HOME_DOMAIN), describeAnchorScenario(SDF_TEST_ANCHOR_HOME_DOMAIN)]) {
      expect(s.allowed.join(" ")).not.toMatch(/sep[-_.]?24/i);
      expect(s.notes).not.toMatch(/allowed.*sep[-_.]?24/i);
    }
  });

  it.each([
    ["suffix look-alike", "tr-mock-anchor.fly.dev.evil.com"],
    ["prefix look-alike", "evil.com.tr-mock-anchor.fly.dev"],
    ["credentials", "https://tr-mock-anchor.fly.dev@evil.com"],
    ["path injection", "evil.com/tr-mock-anchor.fly.dev"],
    ["uppercase", "TR-MOCK-ANCHOR.FLY.DEV"],
    ["trailing dot", "tr-mock-anchor.fly.dev."],
    ["empty label", "tr-mock-anchor..fly.dev"],
    ["leading hyphen", "-tr-mock-anchor.fly.dev"],
    ["port", "tr-mock-anchor.fly.dev:443"],
    ["ipv4 literal", "1.2.3.4"],
    ["ipv6 literal", "[::1]"],
    ["localhost", "localhost"],
    ["internal TLD", "anchor.local"],
    ["single label", "flydev"],
    ["unicode homoglyph (cyrillic)", "tr-mock-anchor.fly.de\u0432"],
    ["unicode dot leader", "tr-mock-anchor\u2024fly.dev"],
    ["non-string", 42 as unknown as string],
  ])("refuses %s", (_name, input) => {
    expect(() => assertPlainAnchorDomain(input)).toThrow(UnsafeAnchorError);
    expect(() => describeAnchorScenario(input)).toThrow(UnsafeAnchorError);
    expect(() => describeAnchorScenario(input, { custom: true })).toThrow(UnsafeAnchorError);
  });

  it("accepts only the two exact canonical hosts", () => {
    expect(assertPlainAnchorDomain("tr-mock-anchor.fly.dev")).toBe("tr-mock-anchor.fly.dev");
    expect(assertPlainAnchorDomain("testanchor.stellar.org")).toBe("testanchor.stellar.org");
  });
});
