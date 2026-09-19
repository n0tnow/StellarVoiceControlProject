/**
 * SEP-12: customer (KYC) data. The mock anchor auto-approves after any PUT with
 * no personal data. A real anchor may answer NEEDS_INFO with required fields —
 * we surface those instead of guessing/inventing personal data.
 */
import { requestJson } from "./http.ts";
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
  constructor(
    message: string,
    readonly status: CustomerStatus,
    readonly missingFields: string[],
  ) {
    super(message);
    this.name = "KycRequiredError";
  }
}

function parseCustomer(body: unknown): CustomerInfo {
  const b = (body ?? {}) as Record<string, unknown>;
  const fields = (b.fields ?? {}) as Record<string, { optional?: boolean }>;
  const missing = Object.entries(fields)
    .filter(([, v]) => !v?.optional)
    .map(([k]) => k);
  const info: CustomerInfo = { status: typeof b.status === "string" ? b.status : "NEEDS_INFO", missingFields: missing };
  if (typeof b.id === "string") info.id = b.id;
  if (typeof b.message === "string") info.message = b.message;
  return info;
}

function kycServer(toml: AnchorToml): string {
  if (!toml.kycServer) throw new KycRequiredError(`${toml.homeDomain} publishes no KYC_SERVER`, "NEEDS_INFO", []);
  return toml.kycServer;
}

export async function getCustomer(ctx: AnchorContext, toml: AnchorToml, token: AuthToken): Promise<CustomerInfo> {
  const body = await requestJson(ctx, `${kycServer(toml)}/customer`, {
    bearer: token.jwt,
    query: { account: token.account },
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
