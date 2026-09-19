/**
 * SEP-10: web authentication. The anchor sends a challenge transaction (never
 * submitted to the network — sequence number 0). We check it really came from
 * the anchor, sign it via the injected `Signer`, and trade it for a JWT.
 * No password, no funds move: the signature only proves we control the key.
 */
import { TransactionBuilder, WebAuth } from "@stellar/stellar-sdk";
import { requestJson } from "./http.ts";
import { shortKey } from "./explain.ts";
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, AuthToken, Signer } from "./types.ts";

/** Real anchors use 5-15 minutes; anything much longer is not a normal challenge. */
export const MAX_CHALLENGE_WINDOW_SECONDS = 15 * 60;

export class ChallengeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChallengeError";
  }
}

export interface ChallengeResponse {
  transaction: string;
  network_passphrase?: string;
}

/**
 * Validates a challenge BEFORE we sign it (all checks are client-side and pure,
 * so a malicious or tampered challenge is rejected without touching the signer).
 * Throws ChallengeError on any violation. Returns the parsed transaction facts.
 */
export function validateChallenge(input: {
  challengeXdr: string;
  toml: Pick<AnchorToml, "signingKey" | "homeDomain" | "webAuthEndpoint">;
  networkPassphrase: string;
  clientAccount: string;
  reportedPassphrase?: string | undefined;
  /** Injected clock (defaults to the system clock). */
  now?: Date;
}): { clientAccount: string; webAuthDomain: string } {
  const { challengeXdr, toml, networkPassphrase, clientAccount, reportedPassphrase } = input;
  const now = input.now ?? new Date();
  if (reportedPassphrase !== undefined && reportedPassphrase !== networkPassphrase) {
    throw new ChallengeError(
      `challenge was issued for network "${reportedPassphrase}", not "${networkPassphrase}"`,
    );
  }
  const webAuthDomain = new URL(toml.webAuthEndpoint).host;
  let read: ReturnType<typeof WebAuth.readChallengeTx>;
  try {
    // Checks: tx source is the anchor's SIGNING_KEY, sequence 0, all ops are
    // manage_data, first op key is "<homeDomain> auth", web_auth_domain matches,
    // time bounds are valid, and the anchor's own signature is present.
    read = WebAuth.readChallengeTx(challengeXdr, toml.signingKey, networkPassphrase, toml.homeDomain, webAuthDomain);
  } catch (e) {
    throw new ChallengeError(`challenge rejected: ${(e as Error).message}`);
  }
  if (read.clientAccountID !== clientAccount) {
    throw new ChallengeError(
      `challenge is for ${shortKey(read.clientAccountID)}, not for our account ${shortKey(clientAccount)}`,
    );
  }
  // We never ask for a memo, so a challenge carrying one is not the challenge we asked for.
  if (read.memo !== null && read.memo !== undefined) {
    throw new ChallengeError("challenge carries a memo although we did not request one");
  }
  // The SDK checks the time bounds against the system clock with a 5-minute grace. We
  // re-check with the injected clock, strictly, and refuse absurdly long validity windows.
  const tb = read.tx.timeBounds;
  const nowSec = Math.floor(now.getTime() / 1000);
  const minTime = Number(tb?.minTime ?? 0);
  const maxTime = Number(tb?.maxTime ?? 0);
  if (!tb || maxTime === 0) throw new ChallengeError("challenge has no expiry time");
  if (nowSec > maxTime) throw new ChallengeError("challenge has expired");
  if (minTime > nowSec + 60) throw new ChallengeError("challenge is not valid yet");
  if (maxTime - nowSec > MAX_CHALLENGE_WINDOW_SECONDS) {
    throw new ChallengeError("challenge stays valid for an unreasonably long time");
  }
  // SEP-10 v3: the web_auth_domain operation must be present, not merely "valid if present".
  const ops = read.tx.operations as Array<{ type: string; name?: string }>;
  if (!ops.some((o) => o.type === "manageData" && o.name === "web_auth_domain")) {
    throw new ChallengeError("challenge has no web_auth_domain operation, so we cannot tell which service issued it");
  }
  return { clientAccount: read.clientAccountID, webAuthDomain };
}

/** After signing: make sure the signer signed THIS challenge, adding our signature. */
function assertSignedChallenge(
  signedXdr: string,
  original: string,
  toml: Pick<AnchorToml, "signingKey" | "homeDomain" | "webAuthEndpoint">,
  networkPassphrase: string,
  clientAccount: string,
): void {
  const a = TransactionBuilder.fromXDR(original, networkPassphrase);
  const b = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  if (Buffer.from(a.hash()).toString("hex") !== Buffer.from(b.hash()).toString("hex")) {
    throw new ChallengeError("the signer returned a different transaction than the challenge we asked it to sign");
  }
  try {
    WebAuth.verifyChallengeTxSigners(
      signedXdr,
      toml.signingKey,
      networkPassphrase,
      [clientAccount],
      toml.homeDomain,
      new URL(toml.webAuthEndpoint).host,
    );
  } catch (e) {
    throw new ChallengeError(`signed challenge does not verify against our key: ${(e as Error).message}`);
  }
}

/** Decodes the JWT payload WITHOUT verifying the signature (we have no key; the anchor verifies its own tokens). */
export function decodeJwt(jwt: string): { sub?: string; exp?: number; iss?: string } {
  const part = jwt.split(".")[1];
  if (!part) throw new ChallengeError("anchor returned a malformed token");
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as { sub?: string; exp?: number; iss?: string };
  } catch {
    throw new ChallengeError("anchor returned a malformed token");
  }
}

/** Step 1+2 of SEP-10: fetch the challenge and validate it BEFORE anything is signed. */
export async function requestChallenge(ctx: AnchorContext, toml: AnchorToml, account: string): Promise<string> {
  const ch = await requestJson<ChallengeResponse>(ctx, toml.webAuthEndpoint, {
    query: { account, home_domain: toml.homeDomain },
  });
  if (!ch || typeof ch.transaction !== "string") throw new ChallengeError("anchor did not return a challenge transaction");
  validateChallenge({
    challengeXdr: ch.transaction,
    toml,
    networkPassphrase: ctx.networkPassphrase,
    clientAccount: account,
    reportedPassphrase: ch.network_passphrase,
    now: ctx.now(),
  });
  ctx.explain.record(
    "sep10.challenge",
    `SEP-10: the anchor sent a login challenge for ${shortKey(account)}. It is a transaction with sequence number 0, so it cannot be run on the network.`,
    "It is the anchor's way of asking \"prove you own this account\" without a password.",
  );
  ctx.explain.record(
    "sep10.verify",
    `SEP-10: checked the challenge before signing — it is signed by the key ${toml.homeDomain} publishes (${shortKey(toml.signingKey)}), ` +
      `has sequence number 0, contains only login entries for ${toml.homeDomain}, and is not expired.`,
    "This stops a login prompt from smuggling in a real payment. It confirms the challenge is well-formed and matches what the anchor's own domain publishes; it cannot prove the domain itself is trustworthy.",
  );
  return ch.transaction;
}

/** Step 3+4 of SEP-10: check the signed challenge is the one we asked for, trade it for a JWT. */
export async function completeChallenge(
  ctx: AnchorContext,
  toml: AnchorToml,
  account: string,
  challengeXdr: string,
  signedXdr: string,
): Promise<AuthToken> {
  assertSignedChallenge(signedXdr, challengeXdr, toml, ctx.networkPassphrase, account);
  ctx.explain.record(
    "sep10.sign",
    `SEP-10: proved we own ${shortKey(account)} by signing the challenge — no password involved and no funds moved.`,
    "A signature can only be made by the holder of the private key, so the anchor now knows this is really you.",
  );
  const res = await requestJson<{ token?: string }>(ctx, toml.webAuthEndpoint, {
    method: "POST",
    json: { transaction: signedXdr },
  });
  if (!res.token) throw new ChallengeError("anchor accepted the signature but returned no token");
  const claims = decodeJwt(res.token);
  // We asked for no memo, so the token subject must be exactly our account.
  if (claims.sub !== account) {
    throw new ChallengeError(
      claims.sub ? `anchor issued a token for ${shortKey(sanitizeAnchorText(String(claims.sub), 20) ?? "?")}, not for us` : "anchor issued a token without a subject",
    );
  }
  const token: AuthToken = { jwt: res.token, account };
  if (typeof claims.exp === "number") token.expiresAt = new Date(claims.exp * 1000);
  ctx.explain.record(
    "sep10.token",
    `SEP-10: the anchor accepted the signature and gave us a session token${token.expiresAt ? ` valid until ${token.expiresAt.toISOString()}` : ""}.`,
    "The token is like a short-lived visitor badge: it lets us ask for quotes, deposits and withdrawals for this account only.",
  );
  return token;
}

/** Full SEP-10 login through the injected signer: challenge -> validate -> sign -> JWT. */
export async function authenticate(ctx: AnchorContext, toml: AnchorToml, signer: Signer): Promise<AuthToken> {
  const account = await signer.publicKey();
  const challenge = await requestChallenge(ctx, toml, account);
  const signed = await signer.signTransaction(challenge, { networkPassphrase: ctx.networkPassphrase });
  return completeChallenge(ctx, toml, account, challenge, signed);
}

/** True when the token is missing or within `skewMs` of expiry. */
export function isExpired(token: AuthToken | undefined, now: Date, skewMs = 60_000): boolean {
  if (!token) return true;
  if (!token.expiresAt) return false;
  return token.expiresAt.getTime() - skewMs <= now.getTime();
}

