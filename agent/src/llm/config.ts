/**
 * LLM configuration from the environment (step A2).
 *
 * Exactly three variables, and they are the only place a provider lives:
 *
 * * `POLARIS_AGENT_BASE_URL` — OpenAI-compatible provider root.
 * * `POLARIS_AGENT_MODEL`    — model id.
 * * `OPENCODE_API_KEY`       — bearer credential.
 *
 * Swapping OpenCode Zen Go for Groq or OpenRouter is therefore a `.env` change,
 * not a code change. The key is read here and handed straight to the client; it
 * is never logged.
 */
import { AgentError } from "../errors.ts";
import type { OpenAiCompatibleOptions } from "./openai.ts";

export const AGENT_BASE_URL_ENV = "POLARIS_AGENT_BASE_URL";
export const AGENT_MODEL_ENV = "POLARIS_AGENT_MODEL";
export const AGENT_API_KEY_ENV = "OPENCODE_API_KEY";

/** OpenCode Zen Go — the owner-chosen provider (docs/architecture.md §4.2). */
export const DEFAULT_AGENT_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_AGENT_MODEL = "deepseek-v4.1-flash";

/** A descriptive User-Agent; some providers reject generic SDK defaults. */
export const AGENT_USER_AGENT = "polaris/0.1";

export type AgentEnv = Record<string, string | undefined>;

/**
 * Reads the process environment when one is not supplied. Guarded so the module
 * can be bundled for the webview (where `process` does not exist) without
 * throwing at import time.
 */
export function processEnv(): AgentEnv {
  return typeof process === "undefined" ? {} : process.env;
}

function pick(env: AgentEnv, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value && value.length > 0 ? value : fallback;
}

/**
 * Builds the options for an OpenAI-compatible client.
 *
 * `apiKey` may legitimately be empty: the desktop webview calls a local proxy
 * that injects the credential, so the secret never reaches the webview. The
 * client then simply omits the Authorization header.
 */
export function openAiOptionsFromEnv(env: AgentEnv = processEnv()): OpenAiCompatibleOptions {
  const baseUrl = pick(env, AGENT_BASE_URL_ENV, DEFAULT_AGENT_BASE_URL);
  const model = pick(env, AGENT_MODEL_ENV, DEFAULT_AGENT_MODEL);
  const apiKey = env[AGENT_API_KEY_ENV]?.trim() ?? "";

  if (!/^https?:\/\//i.test(baseUrl) && !baseUrl.startsWith("/")) {
    throw new AgentError(
      "config",
      `${AGENT_BASE_URL_ENV} must be an absolute URL or a same-origin path, got: ${baseUrl}`,
    );
  }

  return {
    baseUrl,
    model,
    apiKey,
    headers: { "User-Agent": AGENT_USER_AGENT },
  };
}
