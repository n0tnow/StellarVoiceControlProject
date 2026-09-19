/**
 * @polaris/agent — Polaris agent core.
 *
 * Step A2 status: the loop, the event bus and the tool registry are real; the
 * model is a real OpenAI-compatible client (`OpenAiCompatibleLlm`) behind the
 * `AgentLlm` port. The provider is selected entirely by environment variables
 * (`POLARIS_AGENT_BASE_URL`, `POLARIS_AGENT_MODEL`, `OPENCODE_API_KEY`), so
 * OpenCode Zen Go, Groq and OpenRouter are a config change, not a rewrite.
 * `send_payment` produces a validated `Intent`; nothing here touches a chain.
 */
export { createEventBus, PolarisEventBus, type PolarisEventHandler } from "./events.ts";
export { AgentError, isAgentError, toAgentError, type AgentErrorKind } from "./errors.ts";
export {
  describeIntent,
  MockLlm,
  runTurn,
  type AgentLlm,
  type AgentTurnOptions,
  type AgentTurnResult,
  type LlmToolCall,
  type LlmTurn,
} from "./loop.ts";
export { POLARIS_SYSTEM_PROMPT } from "./prompt.ts";
export {
  confirmationSentence,
  SpeechQueue,
  spokenText,
  type SpeakFn,
  type SpokenResult,
} from "./speech.ts";
export {
  AGENT_API_KEY_ENV,
  AGENT_BASE_URL_ENV,
  AGENT_MODEL_ENV,
  AGENT_USER_AGENT,
  DEFAULT_AGENT_BASE_URL,
  DEFAULT_AGENT_MODEL,
  openAiOptionsFromEnv,
  processEnv,
  type AgentEnv,
} from "./llm/config.ts";
export {
  newSessionId,
  OpenAiCompatibleLlm,
  type OpenAiCompatibleOptions,
} from "./llm/openai.ts";
export { createAgentRuntime, createDefaultRegistry, type AgentRuntime } from "./runtime.ts";
export {
  createToolRegistry,
  ToolRegistry,
  type AgentTool,
  type IntentTool,
  type ToolContext,
} from "./tools/registry.ts";
export { noopTool, type NoopInput, type NoopOutput } from "./tools/noop.ts";
export {
  parseSendPayment,
  sendPaymentTool,
  type SendPaymentInput,
} from "./tools/payment.ts";
