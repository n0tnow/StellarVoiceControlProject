/**
 * MCP configuration (step A9 scaffolding).
 *
 * The feature is **off unless configured**: no `POLARIS_MCP_SERVER_URL` means the
 * client is never constructed and no request is ever made. That keeps a
 * credential-less, network-less default (tests, offline demo) completely clean —
 * an absent config is not an error and produces no log noise.
 */

/** Streamable HTTP endpoint of the MCP server, e.g. `https://raven.stellar.org/mcp`. */
export const MCP_SERVER_URL_ENV = "POLARIS_MCP_SERVER_URL";

/**
 * Optional comma-separated allowlist of tool names the operator vouches for.
 * It is an escape hatch for servers that do not annotate `readOnlyHint`; it can
 * never override the name-based write-verb denylist in `bridge.ts`.
 */
export const MCP_ALLOWED_TOOLS_ENV = "POLARIS_MCP_ALLOWED_TOOLS";

/** The minimal environment surface; `process.env` satisfies it. */
export interface EnvLike {
  readonly [key: string]: string | undefined;
}

export interface McpConfig {
  serverUrl: string;
  allowedTools: readonly string[];
}

/** Parses a comma/whitespace-separated tool list; blank entries are dropped. */
export function parseAllowedTools(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,\s]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/**
 * Reads MCP config from the environment.
 *
 * Returns `null` when unset (feature off) **or** when the URL is not a usable
 * http(s) endpoint — a typo must not turn into a runtime network call against an
 * unexpected scheme. Both are reported to the caller as "off", never as a crash.
 */
export function mcpConfigFromEnv(env: EnvLike = process.env): McpConfig | null {
  const raw = env[MCP_SERVER_URL_ENV]?.trim();
  if (!raw) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  return { serverUrl: url.toString(), allowedTools: parseAllowedTools(env[MCP_ALLOWED_TOOLS_ENV]) };
}
