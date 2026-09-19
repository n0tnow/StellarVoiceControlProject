/** Small JSON-over-fetch helper shared by all SEP clients. */
import type { AnchorContext } from "./types.ts";

export class AnchorHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
    /** Parsed JSON body when the server sent one, otherwise the raw text. */
    readonly body: unknown,
  ) {
    super(message);
    this.name = "AnchorHttpError";
  }

  /** SEP-6/12 error `type` field (e.g. `non_interactive_customer_info_needed`). */
  get errorType(): string | undefined {
    const b = this.body;
    if (b && typeof b === "object" && "type" in b && typeof b.type === "string") return b.type;
    return undefined;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded (Horizon submit). */
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  bearer?: string;
}

export function buildUrl(base: string, query?: RequestOptions["query"]): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Performs a request and returns parsed JSON. Non-2xx throws AnchorHttpError. */
export async function requestJson<T = unknown>(
  ctx: Pick<AnchorContext, "fetch" | "requestTimeoutMs">,
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  }
  const finalUrl = buildUrl(url, opts.query);
  const init: RequestInit = {
    method: opts.method ?? "GET",
    headers,
    signal: AbortSignal.timeout(ctx.requestTimeoutMs),
  };
  if (body !== undefined) init.body = body;
  const res = await ctx.fetch(finalUrl, init);
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed === "string"
          ? parsed.slice(0, 200)
          : `HTTP ${res.status}`;
    throw new AnchorHttpError(`${opts.method ?? "GET"} ${finalUrl} failed (${res.status}): ${detail}`, res.status, finalUrl, parsed);
  }
  return parsed as T;
}

/** GET text (stellar.toml). */
export async function requestText(
  ctx: Pick<AnchorContext, "fetch" | "requestTimeoutMs">,
  url: string,
): Promise<string> {
  const res = await ctx.fetch(url, { signal: AbortSignal.timeout(ctx.requestTimeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new AnchorHttpError(`GET ${url} failed (${res.status})`, res.status, url, text.slice(0, 200));
  return text;
}
