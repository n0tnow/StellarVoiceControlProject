/**
 * LLM configuration from the environment (step A2; provider split in A11).
 *
 * The provider is selected by `POLARIS_AGENT_PROVIDER`; the model by
 * `POLARIS_AGENT_MODEL` in every case, so switching is a `.env` change, not a
 * code change:
 *
 * * `openai` (default) — any OpenAI-compatible root (`POLARIS_AGENT_BASE_URL`),
 *   credential `OPENCODE_API_KEY`.
 * * `anthropic` — the Anthropic Messages API, credential `ANTHROPIC_API_KEY`.
 *
 * The keys are read here and handed straight to the client; they are never
 * logged, and the Anthropic key never reaches the webview bundle (the desktop
 * app reads it in Rust, `app/src-tauri/src/agent.rs`).
 */
import { AgentError } from "../errors.ts";
import {
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_ANTHROPIC_MODEL,
  type AnthropicOptions,
} from "./anthropic.ts";
import type { OpenAiCompatibleOptions } from "./openai.ts";

export const AGENT_PROVIDER_ENV = "POLARIS_AGENT_PROVIDER";
export const AGENT_BASE_URL_ENV = "POLARIS_AGENT_BASE_URL";
export const AGENT_MODEL_ENV = "POLARIS_AGENT_MODEL";
export const AGENT_API_KEY_ENV = "OPENCODE_API_KEY";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/**
 * Anthropic's own base URL variable. Deliberately **not** `POLARIS_AGENT_BASE_URL`:
 * that one points at OpenCode Zen Go, so reusing it would send the Messages body
 * to the wrong host the moment the provider is switched.
 */
export const ANTHROPIC_BASE_URL_ENV = "POLARIS_ANTHROPIC_BASE_URL";

/** The provider ids accepted by `POLARIS_AGENT_PROVIDER`. */
export type AgentProvider = "openai" | "anthropic";

/** OpenCode Zen Go — the owner-chosen provider (docs/architecture.md §4.2). */
export const DEFAULT_AGENT_BASE_URL = "https://opencode.ai/zen/go/v1";
/**
 * Fallback model when `POLARIS_AGENT_MODEL` is unset. `glm-5.3-flash` replaced
 * `deepseek-v4.1-flash` in step A5: both were always correct on the real task,
 * glm's median was lower (1857 ms vs 2085 ms) and it spends no reasoning tokens.
 * The model stays env-driven — this is only the last-resort default.
 */
export const DEFAULT_AGENT_MODEL = "glm-5.3-flash";

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

function assertBaseUrl(baseUrl: string, varName: string = AGENT_BASE_URL_ENV): void {
  if (!/^https?:\/\//i.test(baseUrl) && !baseUrl.startsWith("/")) {
    throw new AgentError(
      "config",
      `${varName} must be an absolute URL or a same-origin path, got: ${baseUrl}`,
    );
  }
}

/**
 * Resolves `POLARIS_AGENT_PROVIDER`.
 *
 * Missing or blank means the OpenAI-compatible default (OpenCode Zen Go); an
 * unknown value also means that default but is reported as `recognized = false`
 * so the caller can warn instead of silently picking a provider.
 */
export function resolveProvider(env: AgentEnv = processEnv()): {
  provider: AgentProvider;
  recognized: boolean;
} {
  const value = env[AGENT_PROVIDER_ENV]?.trim().toLowerCase();
  if (!value) {
    return { provider: "openai", recognized: true };
  }
  if (value === "openai" || value === "opencode") {
    return { provider: "openai", recognized: true };
  }
  if (value === "anthropic") {
    return { provider: "anthropic", recognized: true };
  }
  return { provider: "openai", recognized: false };
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

  assertBaseUrl(baseUrl);

  return {
    baseUrl,
    model,
    apiKey,
    headers: { "User-Agent": AGENT_USER_AGENT },
  };
}

/**
 * Builds the options for the Anthropic Messages client.
 *
 * `POLARIS_AGENT_MODEL` is read the same way as for the OpenAI client — that is
 * what makes `claude-sonnet-5` vs `claude-haiku-4-5` an env-only comparison. The
 * base URL default is Anthropic's root; the credential is `ANTHROPIC_API_KEY`.
 */
export function anthropicOptionsFromEnv(env: AgentEnv = processEnv()): AnthropicOptions {
  const baseUrl = pick(env, ANTHROPIC_BASE_URL_ENV, DEFAULT_ANTHROPIC_BASE_URL);
  const model = pick(env, AGENT_MODEL_ENV, DEFAULT_ANTHROPIC_MODEL);
  const apiKey = env[ANTHROPIC_API_KEY_ENV]?.trim() ?? "";

  assertBaseUrl(baseUrl, ANTHROPIC_BASE_URL_ENV);

  return {
    baseUrl,
    model,
    apiKey,
    headers: { "User-Agent": AGENT_USER_AGENT },
  };
}
