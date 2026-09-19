/**
 * MCP scaffolding entry point (step A9).
 *
 * `attachMcpToolsFromEnv` is the one call a composition root makes. It is inert
 * when `POLARIS_MCP_SERVER_URL` is unset, so the default (tests, offline demo)
 * constructs no client and makes no request.
 */
import type { ToolRegistry } from "../tools/registry.ts";
import { registerReadOnlyMcpTools, type McpBridgeOptions } from "./bridge.ts";
import { McpClient } from "./client.ts";
import { mcpConfigFromEnv, type EnvLike, type McpConfig } from "./config.ts";

export {
  McpClient,
  McpError,
  DEFAULT_PROTOCOL_VERSION,
  type McpClientOptions,
  type McpContentBlock,
  type McpServerInfo,
  type McpTool,
  type McpToolCallResult,
} from "./client.ts";
export {
  mcpConfigFromEnv,
  parseAllowedTools,
  MCP_ALLOWED_TOOLS_ENV,
  MCP_SERVER_URL_ENV,
  type EnvLike,
  type McpConfig,
} from "./config.ts";
export {
  mcpToolName,
  mcpToolReadOnly,
  registerReadOnlyMcpTools,
  MCP_TOOL_PREFIX,
  type McpBridgeOptions,
  type McpReadOnlyPolicy,
} from "./bridge.ts";

export interface AttachMcpOptions {
  /** Pre-parsed config; defaults to `mcpConfigFromEnv(env)`. `null` = feature off. */
  config?: McpConfig | null;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Extra bridge policy (e.g. a denylist). */
  bridge?: McpBridgeOptions;
}

/**
 * Discovers the configured MCP server's tools and registers the read-only ones.
 *
 * Returns `[]` (a no-op, no network) when no server is configured. Errors are
 * propagated to the caller so it can log them and continue: MCP is an
 * enhancement, never on the money path.
 */
export async function attachMcpToolsFromEnv(
  registry: ToolRegistry,
  env: EnvLike = process.env,
  options: AttachMcpOptions = {},
): Promise<string[]> {
  const config = options.config === undefined ? mcpConfigFromEnv(env) : options.config;
  if (!config) return [];

  const client = new McpClient({ url: config.serverUrl, fetchImpl: options.fetchImpl });
  await client.initialize();
  return registerReadOnlyMcpTools(registry, client, {
    ...options.bridge,
    policy: {
      allowedTools: config.allowedTools,
      ...options.bridge?.policy,
    },
  });
}
