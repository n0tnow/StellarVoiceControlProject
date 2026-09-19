/**
 * The read-only MCP → `ToolRegistry` bridge (step A9 scaffolding).
 *
 * Discovers a server's tools and registers the read-only ones as ordinary,
 * **non-approval** `AgentTool`s, so the model can call them like any other tool.
 * The whole point of the policy below is that a value-moving tool must be
 * *impossible* to reach through this path — not merely discouraged.
 *
 * ## Defence in depth
 *
 * A tool is exposed only if **all** of these hold:
 *
 * 1. Its name is not on the write-verb denylist (`send`, `swap`, `submit`, …).
 *    This catches the common case even when a server lies about or omits
 *    annotations.
 * 2. It does not declare `readOnlyHint: false`.
 * 3. It either declares `readOnlyHint: true`, or the operator explicitly named it
 *    in `POLARIS_MCP_ALLOWED_TOOLS` (the escape hatch for unannotated-but-known
 *    read-only servers).
 *
 * The check runs twice: when the tool is registered, and again at call time, so
 * tightening the policy later cannot be bypassed by an already-registered entry.
 * A tool that fails is dropped with a warning; it never reaches the model.
 */
import type { AgentTool, ToolRegistry } from "../tools/registry.ts";
import type { McpClient, McpTool } from "./client.ts";

/** Registry namespace so an MCP tool can never shadow a local tool. */
export const MCP_TOOL_PREFIX = "mcp_";

/**
 * Tokens that name value movement or state change. The tool name is split into
 * tokens first (snake_case, kebab-case and camelCase all handled), so
 * `search`/`get_project` pass while `execute`, `send_payment`, `submit_tx` and
 * `createOrder` do not. A plain word-boundary regex is not enough: `send_payment`
 * has no boundary between `send` and `_`.
 */
const WRITE_TOKENS = new Set([
  "send",
  "transfer",
  "submit",
  "sign",
  "pay",
  "payment",
  "swap",
  "trade",
  "buy",
  "sell",
  "deposit",
  "withdraw",
  "create",
  "delete",
  "remove",
  "update",
  "set",
  "mint",
  "burn",
  "approve",
  "claim",
  "stake",
  "unstake",
  "bridge",
  "write",
  "execute",
  "invoke",
  "publish",
  "register",
  "fund",
  "refund",
]);

/** Splits a tool name into lowercase tokens across snake/kebab/camelCase. */
export function mcpNameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** Operator-controlled read-only policy. */
export interface McpReadOnlyPolicy {
  /** Names the operator vouches for even without a `readOnlyHint`. */
  allowedTools?: readonly string[];
  /** Names to deny in addition to the write-verb rule. */
  deniedTools?: readonly string[];
}

export interface McpBridgeOptions {
  policy?: McpReadOnlyPolicy;
  /** Called for each discovered tool that was refused, for a visible audit trail. */
  onDenied?: (tool: McpTool, reason: string) => void;
  /** Called for each tool that was registered. */
  onRegistered?: (name: string, tool: McpTool) => void;
}

/** Whether one advertised tool may be exposed to the model. Pure and testable. */
export function mcpToolReadOnly(
  tool: McpTool,
  policy: McpReadOnlyPolicy = {},
): { ok: true } | { ok: false; reason: string } {
  if (policy.deniedTools?.includes(tool.name)) {
    return { ok: false, reason: "operator denylist" };
  }
  if (mcpNameTokens(tool.name).some((token) => WRITE_TOKENS.has(token))) {
    return { ok: false, reason: "name contains a value-moving token" };
  }
  if (tool.annotations?.readOnlyHint === false) {
    return { ok: false, reason: "server declares readOnlyHint: false" };
  }
  if (tool.annotations?.readOnlyHint === true) {
    return { ok: true };
  }
  if (policy.allowedTools?.includes(tool.name)) {
    return { ok: true };
  }
  return { ok: false, reason: "no readOnlyHint and not explicitly allowlisted" };
}

/** Maps an MCP tool name into the registry's `^[A-Za-z0-9_-]{1,64}$` namespace. */
export function mcpToolName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${MCP_TOOL_PREFIX}${cleaned}`.slice(0, 64);
}

/**
 * Registers every read-only tool the server advertises.
 *
 * Tools already present in the registry (by namespaced name) are skipped, so
 * calling this twice is safe. Returns the registered names for logging/tests.
 * Network/protocol failures propagate to the caller, which decides how loud to
 * be: MCP is an enhancement and must never take the agent down.
 */
export async function registerReadOnlyMcpTools(
  registry: ToolRegistry,
  client: McpClient,
  options: McpBridgeOptions = {},
): Promise<string[]> {
  const policy = options.policy ?? {};
  const tools = await client.listTools();
  const registered: string[] = [];

  for (const tool of tools) {
    const decision = mcpToolReadOnly(tool, policy);
    if (!decision.ok) {
      options.onDenied?.(tool, decision.reason);
      continue;
    }
    const name = mcpToolName(tool.name);
    if (registry.get(name)) {
      // Never clobber a local tool that happens to share the name.
      options.onDenied?.(tool, `"${name}" is already registered`);
      continue;
    }
    const entry: AgentTool<unknown, unknown> = {
      name,
      description: `[MCP read-only] ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      // Read-only tools are not approval-gated: they cannot move value.
      requiresApproval: false,
      async run(input) {
        // Re-check at call time; a policy tightened after registration must still
        // bind. This is what makes the restriction impossible to route around.
        const callDecision = mcpToolReadOnly(tool, policy);
        if (!callDecision.ok) {
          throw new Error(`refusing to call MCP tool "${tool.name}": ${callDecision.reason}`);
        }
        return client.callTool(tool.name, input);
      },
    };
    registry.register(entry);
    registered.push(name);
    options.onRegistered?.(name, tool);
  }

  return registered;
}
