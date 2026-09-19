/**
 * SEP-12: customer (KYC) data. The mock anchor auto-approves after any PUT with
 * no personal data. A real anchor may answer NEEDS_INFO with required fields —
 * we surface those instead of guessing/inventing personal data.
 */
import { requestJson } from "./http.ts";
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, AuthToken } from "./types.ts";

export type CustomerStatus = "ACCEPTED" | "PROCESSING" | "NEEDS_INFO" | "REJECTED" | (string & {});

export interface CustomerInfo {
  id?: string;
  status: CustomerStatus;
  message?: string;
  /** Field names still required (NEEDS_INFO) and not marked optional. */
  missingFields: string[];
}

export class KycRequiredError extends Error {
  readonly status: CustomerStatus;
  readonly missingFields: string[];

  constructor(message: string, status: CustomerStatus, missingFields: string[]) {
    super(message);
    this.name = "KycRequiredError";
    this.status = status;
    this.missingFields = missingFields;
  }
}

function parseCustomer(body: unknown): CustomerInfo {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields = (b.fields ?? {}) as Record<string, { optional?: boolean }>;
  const missing = Object.entries(fields)
    .filter(([k, v]) => !v?.optional && /^[A-Za-z0-9_]{1,40}$/.test(k))
    .map(([k]) => k)
    .slice(0, 20);
  const status = typeof b.status === "string" && /^[A-Z_]{1,30}$/.test(b.status) ? b.status : "NEEDS_INFO";
  const info: CustomerInfo = { status, missingFields: missing };
  if (typeof b.id === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(b.id)) info.id = b.id;
  const message = sanitizeAnchorText(b.message);
  if (message) info.message = message;
  return info;
}

function kycServer(toml: AnchorToml): string {
  if (!toml.kycServer) throw new KycRequiredError(`${toml.homeDomain} publishes no KYC_SERVER`, "NEEDS_INFO", []);
  return toml.kycServer;
}

/** `GET /customer`; with `transactionId` it asks what a specific paused order still needs (SEP-6/12). */
export async function getCustomer(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  opts: { transactionId?: string } = {},
): Promise<CustomerInfo> {
  const body = await requestJson(ctx, `${kycServer(toml)}/customer`, {
    bearer: token.jwt,
    query: { account: token.account, transaction_id: opts.transactionId },
  });
  return parseCustomer(body);
}

/**
 * Makes sure the anchor considers us a known customer. With the mock this is a
 * single empty PUT. Real anchors that need documents are NOT auto-filled: the
 * missing field names are thrown so the agent can ask the user.
 */
export async function ensureCustomer(
  ctx: AnchorContext,
  toml: AnchorToml,
  token: AuthToken,
  fields: Record<string, string> = {},
): Promise<CustomerInfo> {
  if (!toml.kycServer) {
    ctx.explain.record(
      "sep12.skip",
      "SEP-12: this anchor publishes no KYC server, so there is no identity form to fill.",
      "Some anchors only ask for identity data when a specific transfer requires it.",
    );
    return { status: "ACCEPTED", missingFields: [] };
  }
  let info = await getCustomer(ctx, toml, token);
  if (info.status !== "ACCEPTED") {
    await requestJson(ctx, `${toml.kycServer}/customer`, {
      method: "PUT",
      bearer: token.jwt,
      json: { account: token.account, ...fields },
    });
    info = await getCustomer(ctx, toml, token);
  }
  if (info.status !== "ACCEPTED") {
    throw new KycRequiredError(
      `anchor KYC status is ${info.status}${info.missingFields.length ? `; needs: ${info.missingFields.join(", ")}` : ""}`,
      info.status,
      info.missingFields,
    );
  }
  ctx.explain.record(
    "sep12.customer",
    "SEP-12: the anchor has us on file as an approved customer (it asked for no personal data).",
    "Anchors are regulated, so they must know who they pay out to; SEP-12 is the standard place to send that information.",
  );
  return info;
}
