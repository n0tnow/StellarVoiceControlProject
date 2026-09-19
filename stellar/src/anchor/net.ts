/**
 * Trust-boundary checks for everything derived from the anchor's domain: the home
 * domain itself and every endpoint its stellar.toml points at. The domain may one
 * day come from a spoken sentence, so it is treated as hostile input.
 *
 * Rules: hostname only (no scheme other than https, port, credentials, path, query,
 * fragment, backslash), a real DNS name (no IP literals, no single-label or
 * local/internal names), https-only endpoints on the anchor's own domain.
 * `allowInsecure` exists for TEST CODE ONLY (local mock servers).
 *
 * Not covered: DNS rebinding (a public name resolving to a private address) needs
 * resolver-level control; see README "Known limits".
 */

export class UnsafeAnchorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeAnchorError";
  }
}

export interface NetPolicy {
  /** TEST ONLY: allow http, ports, localhost and IP literals. */
  allowInsecure?: boolean | undefined;
  /** Extra hosts (besides the home domain and its subdomains) toml endpoints may use. */
  allowedEndpointHosts?: readonly string[] | undefined;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const BLOCKED_TLDS = ["localhost", "local", "internal", "intranet", "lan", "home", "corp", "private", "arpa", "onion", "invalid"];

/** True for dotted-quad IPv4 and anything containing `:` (IPv6) or bracketed forms. */
function looksLikeIp(host: string): boolean {
  return host.includes(":") || host.startsWith("[") || /^[0-9.]+$/.test(host) || /^0x[0-9a-f]+$/i.test(host);
}

function assertPublicDnsName(host: string, label: string): void {
  if (host.length === 0 || host.length > 253) throw new UnsafeAnchorError(`${label} is not a valid host name`);
  if (looksLikeIp(host)) throw new UnsafeAnchorError(`${label} must be a domain name, not an IP address`);
  const labels = host.split(".");
  if (labels.length < 2) throw new UnsafeAnchorError(`${label} must be a fully qualified domain name`);
  if (!labels.every((l) => LABEL.test(l))) {
    throw new UnsafeAnchorError(`${label} contains characters that are not allowed in a domain name`);
  }
  const tld = labels[labels.length - 1] as string;
  if (/^[0-9]+$/.test(tld)) throw new UnsafeAnchorError(`${label} must be a domain name, not an IP address`);
  if (BLOCKED_TLDS.includes(tld)) throw new UnsafeAnchorError(`${label} is a local or private name`);
}

/**
 * Validates a home domain typed or spoken by the user. Accepts `example.com` or
 * `https://example.com[/]`; returns the lower-case host name.
 */
export function parseHomeDomain(input: string, policy: NetPolicy = {}): string {
  if (typeof input !== "string") throw new UnsafeAnchorError("the anchor domain must be text");
  let s = input.trim();
  if (policy.allowInsecure) s = s.replace(/^http:\/\//i, "");
  s = s.replace(/^https:\/\//i, "");
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (policy.allowInsecure) {
    if (!/^[A-Za-z0-9.-]+(:[0-9]{1,5})?$/.test(s)) throw new UnsafeAnchorError(`"${input.slice(0, 60)}" is not a valid host`);
    return s.toLowerCase();
  }
  // Anything besides letters, digits, dots and hyphens (userinfo, port, path, query, fragment,
  // backslash, spaces, brackets, unicode look-alikes) is rejected outright, never "cleaned".
  if (!/^[A-Za-z0-9.-]+$/.test(s)) {
    throw new UnsafeAnchorError(
      `"${input.slice(0, 60)}" is not a plain domain name (no ports, paths, credentials or special characters)`,
    );
  }
  const host = s.toLowerCase();
  assertPublicDnsName(host, "the anchor domain");
  return host;
}

/** Endpoint host must be the anchor's domain or one of its subdomains (or explicitly allowed). */
function hostBelongs(host: string, home: string, policy: NetPolicy): boolean {
  const homeHost = home.replace(/:[0-9]+$/, "");
  return (
    host === homeHost ||
    host.endsWith(`.${homeHost}`) ||
    (policy.allowedEndpointHosts ?? []).some((h) => h.toLowerCase() === host)
  );
}

/** Validates one toml-provided endpoint and returns it without a trailing slash. */
export function assertSafeEndpoint(raw: string, label: string, homeDomain: string, policy: NetPolicy = {}): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UnsafeAnchorError(`${label} is not a valid URL`);
  }
  const insecure = policy.allowInsecure === true;
  if (u.protocol !== "https:" && !(insecure && u.protocol === "http:")) {
    throw new UnsafeAnchorError(`${label} must use https (got ${u.protocol.replace(":", "")})`);
  }
  if (u.username || u.password) throw new UnsafeAnchorError(`${label} must not contain credentials`);
  if (u.hash) throw new UnsafeAnchorError(`${label} must not contain a fragment`);
  if (!insecure) {
    if (u.port) throw new UnsafeAnchorError(`${label} must use the default https port`);
    assertPublicDnsName(u.hostname, label);
  }
  if (!hostBelongs(u.hostname, homeDomain, policy)) {
    throw new UnsafeAnchorError(`${label} points at ${u.hostname}, which is not part of ${homeDomain}`);
  }
  return u.toString().replace(/\/$/, "");
}
