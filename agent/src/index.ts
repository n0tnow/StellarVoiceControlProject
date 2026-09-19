/**
 * @polaris/agent — Polaris agent core.
 *
 * Skeleton status: the loop, the event bus and the tool registry are real; the
 * model call is mocked (`MockLlm`). Step A2 swaps in the Anthropic tool-use
 * client, step A4 adds the screen tool, step A5 adds Owner B's chain tools.
 */
export { createEventBus, PolarisEventBus, type PolarisEventHandler } from "./events.ts";
export {
  MockLlm,
  runTurn,
  type AgentLlm,
  type AgentTurnOptions,
  type AgentTurnResult,
  type LlmToolCall,
  type LlmTurn,
} from "./loop.ts";
export {
  createToolRegistry,
  ToolRegistry,
  type AgentTool,
  type IntentTool,
  type ToolContext,
} from "./tools/registry.ts";
export { noopTool, type NoopInput, type NoopOutput } from "./tools/noop.ts";