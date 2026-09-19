/**
 * JSON-over-fetch helper shared by all SEP clients. Hardened because every URL it
 * calls is derived from an anchor we do not control: redirects are refused, bodies
 * are read with a hard size cap, and every request has a timeout that also covers
 * reading the body.
 */
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext } from "./types.ts";

/** SEP-1: a stellar.toml may be at most 100 KB. */
export const MAX_TOML_BYTES = 100 * 1024;
/** Sane cap for JSON API responses (info, quotes, transactions, Horizon). */
export const MAX_JSON_BYTES = 1024 * 1024;

export class AnchorHttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** Parsed JSON body when the server sent one, otherwise the raw text. */
  readonly body: unknown;

  constructor(message: string, status: number, url: string, body: unknown) {
    super(message);
    this.name = "AnchorHttpError";
    this.status = status;
    this.url = url;
    this.body = body;
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
  /** Response body cap in bytes (default MAX_JSON_BYTES). */
  maxBytes?: number;
  /** Rewrites the raw response text BEFORE JSON parsing (e.g. to keep huge integers exact). */
  preParse?: (text: string) => string;
}

export function buildUrl(base: string, query?: RequestOptions["query"]): string {
  if (!query) return base;
  const url = new URL(base);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

type HttpCtx = Pick<AnchorContext, "fetch" | "requestTimeoutMs">;

/** Reads at most `max` bytes of a response body; throws (and cancels the stream) beyond that. */
export async function readCapped(res: Response, max: number, url: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new AnchorHttpError(`response from ${url} is larger than ${max} bytes`, res.status, url, "");
  }
  if (!res.body) {
    const text = await res.text();
    if (new TextEncoder().encode(text).byteLength > max) {
      throw new AnchorHttpError(`response from ${url} is larger than ${max} bytes`, res.status, url, "");
    }
    return text;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new AnchorHttpError(`response from ${url} is larger than ${max} bytes`, res.status, url, "");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function send(ctx: HttpCtx, url: string, init: RequestInit): Promise<Response> {
  return ctx.fetch(url, {
    ...init,
    // A redirect could bounce an https anchor to http or to an internal address.
    redirect: "error",
    signal: AbortSignal.timeout(ctx.requestTimeoutMs),
  });
}

/** Performs a request and returns parsed JSON. Non-2xx throws AnchorHttpError. */
export async function requestJson<T = unknown>(ctx: HttpCtx, url: string, opts: RequestOptions = {}): Promise<T> {
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
  const init: RequestInit = { method: opts.method ?? "GET", headers };
  if (body !== undefined) init.body = body;
  const res = await send(ctx, finalUrl, init);
  const text = await readCapped(res, opts.maxBytes ?? MAX_JSON_BYTES, finalUrl);
  let parsed: unknown = text;
  try {
    parsed = text.length > 0 ? JSON.parse(opts.preParse ? opts.preParse(text) : text) : {};
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    // The anchor's error text is untrusted: sanitised and capped before it can reach the agent.
    const detail =
      sanitizeAnchorText(
        parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string" ? parsed.error : parsed,
      ) ?? `HTTP ${res.status}`;
    throw new AnchorHttpError(
      `${opts.method ?? "GET"} ${finalUrl} failed (${res.status}): ${detail}`,
      res.status,
      finalUrl,
      parsed,
    );
  }
  return parsed as T;
}

/** GET text (stellar.toml), capped at `maxBytes`. */
export async function requestText(ctx: HttpCtx, url: string, maxBytes = MAX_JSON_BYTES): Promise<string> {
  const res = await send(ctx, url, {});
  const text = await readCapped(res, maxBytes, url);
  if (!res.ok) throw new AnchorHttpError(`GET ${url} failed (${res.status})`, res.status, url, sanitizeAnchorText(text) ?? "");
  return text;
}
