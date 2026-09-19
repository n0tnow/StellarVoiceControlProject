/**
 * Scenario registry: which anchor home domains this project is allowed to talk
 * to, and what each one is allowed to prove in a demo.
 *
 * This is a STRICTER layer than `net.ts`'s `parseHomeDomain`. The session accepts
 * and normalises a user-spoken domain (it lower-cases and strips a scheme); the
 * scenario registry demands an already-canonical, plain lowercase host and
 * refuses anything that is not exactly one of the two approved scenarios unless
 * the caller deliberately opts into `custom`. It exists so a demo/check can never
 * silently drift onto a look-alike host.
 *
 * The Turkish path is SEP-6 ONLY: the hosted/interactive SEP-24 flow is
 * prohibited under MASAK rules, so SEP-24 must appear nowhere in the TR domain's
 * code paths.
 */
import { UnsafeAnchorError } from "./net.ts";

export type ScenarioId = "tr-mock" | "sdf-test" | "custom";

export interface AnchorScenario {
  id: ScenarioId;
  /** Human label that must travel with every result for this scenario. */
  label: string;
  /** Both approved scenarios are programmatic-only. */
  sepScope: "SEP-6 only";
  /** Steps this scenario is allowed to exercise, in order. */
  allowed: string[];
  notes: string;
}

/** The one host that is the Turkish path (SEP-6 only). */
export const TR_MOCK_HOME_DOMAIN = "tr-mock-anchor.fly.dev";
/** The one host that is the labelled NON-TR fallback (SDF test anchor). */
export const SDF_TEST_ANCHOR_HOME_DOMAIN = "testanchor.stellar.org";

const BLOCKED_TLDS = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "arpa", "onion", "invalid"];
/** Plain lowercase DNS labels only: no uppercase, no unicode homoglyphs. */
const PLAIN_DOMAIN = /^[a-z0-9.-]+$/;

function looksLikeIp(host: string): boolean {
  return host.includes(":") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

const KNOWN: Record<string, Omit<AnchorScenario, "allowed"> & { allowed: readonly string[] }> = {
  [TR_MOCK_HOME_DOMAIN]: {
    id: "tr-mock",
    label: "TR path — SEP-6 only (SEP-24 prohibited in Turkey)",
    sepScope: "SEP-6 only",
    allowed: ["sep1.discovery", "sep10.login", "sep6.info", "sep12.customer", "sep38.quote", "sep6.deposit", "sep6.withdraw"],
    notes:
      "The Turkish path uses the programmatic SEP-6 flow only. SEP-24's hosted/interactive flow is prohibited under MASAK rules and is never read, configured or demoed here.",
  },
  [SDF_TEST_ANCHOR_HOME_DOMAIN]: {
    id: "sdf-test",
    label: "NON-TR test scenario (SDF test anchor) — discovery + SEP-10 login + SEP-6 info only; deposit stops at SEP-12 KYC",
    sepScope: "SEP-6 only",
    allowed: ["sep1.discovery", "sep10.login", "sep6.info"],
    notes:
      "NON-TR comparison only, never presented as the Turkish path. A deposit here stops at SEP-12 KYC: the anchor requires first_name, last_name and email_address. This check never attempts a deposit or withdraw.",
  },
};

/**
 * Validates a home domain for the scenario registry. Returns the canonical host.
 * Rejects (never "cleans"): schemes, ports, credentials, paths, uppercase, a
 * trailing dot, IP literals, localhost/internal names, unicode homoglyphs, and
 * hosts that merely embed a known domain as a label prefix/suffix.
 */
export function assertPlainAnchorDomain(input: string): string {
  if (typeof input !== "string") throw new UnsafeAnchorError("the anchor domain must be text");
  const s = input.trim();
  if (s.length === 0) throw new UnsafeAnchorError("the anchor domain is empty");
  if (s.length > 253) throw new UnsafeAnchorError("the anchor domain is too long");
  if (!PLAIN_DOMAIN.test(s)) {
    throw new UnsafeAnchorError(
      `"${input.slice(0, 60)}" is not a plain lowercase domain name (no scheme, port, credentials, path, uppercase or special characters)`,
    );
  }
  if (s.endsWith(".")) throw new UnsafeAnchorError("the anchor domain must not have a trailing dot");
  if (s.includes("..")) throw new UnsafeAnchorError("the anchor domain has an empty label");
  if (looksLikeIp(s)) throw new UnsafeAnchorError("the anchor domain must be a domain name, not an IP address");
  const labels = s.split(".");
  if (labels.length < 2) throw new UnsafeAnchorError("the anchor domain must be a fully qualified domain name");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) throw new UnsafeAnchorError("the anchor domain has an invalid label");
    if (label.startsWith("-") || label.endsWith("-")) throw new UnsafeAnchorError("the anchor domain has an invalid label");
  }
  const tld = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(tld)) throw new UnsafeAnchorError("the anchor domain must be a domain name, not an IP address");
  if (BLOCKED_TLDS.includes(tld)) throw new UnsafeAnchorError("the anchor domain is a local or private name");
  for (const known of Object.keys(KNOWN)) {
    if (s !== known && (s.startsWith(`${known}.`) || s.endsWith(`.${known}`))) {
      throw new UnsafeAnchorError(`"${s}" looks like a look-alike of ${known} but is a different host — refusing`);
    }
  }
  return s;
}

/**
 * Describes the scenario for a home domain. Unknown domains are REFUSED unless
 * the caller explicitly passes `{ custom: true }`, which yields a clearly
 * warning-labelled, unverified scenario.
 */
export function describeAnchorScenario(homeDomain: string, opts: { custom?: boolean } = {}): AnchorScenario {
  const host = assertPlainAnchorDomain(homeDomain);
  const known = KNOWN[host];
  if (known) return { ...known, allowed: [...known.allowed] };
  if (opts.custom) {
    return {
      id: "custom",
      label: `CUSTOM anchor (${host}) — UNVERIFIED, not a TR or SDF demo scenario`,
      sepScope: "SEP-6 only",
      allowed: [],
      notes:
        "Custom home domain: strict validation passed, but nothing about this anchor is verified. SEP-24 is never used. Development only — never present it as the Turkish path.",
    };
  }
  throw new UnsafeAnchorError(
    `"${host}" is not an approved anchor scenario; this check supports ${TR_MOCK_HOME_DOMAIN} and ${SDF_TEST_ANCHOR_HOME_DOMAIN} only (pass { custom: true } to override deliberately)`,
  );
}
