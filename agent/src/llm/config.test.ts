import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import { anthropicOptionsFromEnv, openAiOptionsFromEnv, resolveProvider } from "./config.ts";

test("defaults to OpenCode Zen Go when the environment is empty", () => {
  const options = openAiOptionsFromEnv({});
  assert.equal(options.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(options.model, "glm-5.3-flash");
  assert.equal(options.apiKey, "");
  assert.equal(options.headers?.["User-Agent"], "polaris/0.1");
});

test("reads the three provider variables and trims them", () => {
  const options = openAiOptionsFromEnv({
    POLARIS_AGENT_BASE_URL: "  https://api.groq.com/openai/v1 ",
    POLARIS_AGENT_MODEL: " llama-3.3-70b ",
    OPENCODE_API_KEY: " secret ",
  });
  assert.equal(options.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(options.model, "llama-3.3-70b");
  assert.equal(options.apiKey, "secret");
});

test("a same-origin path is allowed for callers that front the provider", () => {
  assert.equal(openAiOptionsFromEnv({ POLARIS_AGENT_BASE_URL: "/agent-api" }).baseUrl, "/agent-api");
});

test("a non-http base URL is a config error, not a bad request later", () => {
  assert.throws(
    () => openAiOptionsFromEnv({ POLARIS_AGENT_BASE_URL: "ftp://nope" }),
    (error: unknown) => error instanceof AgentError && error.kind === "config",
  );
});

test("the provider defaults to openai and accepts anthropic", () => {
  assert.deepEqual(resolveProvider({}), { provider: "openai", recognized: true });
  assert.deepEqual(resolveProvider({ POLARIS_AGENT_PROVIDER: "" }), {
    provider: "openai",
    recognized: true,
  });
  assert.deepEqual(resolveProvider({ POLARIS_AGENT_PROVIDER: "  " }), {
    provider: "openai",
    recognized: true,
  });
  assert.deepEqual(resolveProvider({ POLARIS_AGENT_PROVIDER: "OpenAI" }), {
    provider: "openai",
    recognized: true,
  });
  assert.deepEqual(resolveProvider({ POLARIS_AGENT_PROVIDER: " anthropic " }), {
    provider: "anthropic",
    recognized: true,
  });
  // A typo must be reported so the caller can warn, never silently accepted.
  assert.deepEqual(resolveProvider({ POLARIS_AGENT_PROVIDER: "claude" }), {
    provider: "openai",
    recognized: false,
  });
});

test("anthropic options default to api.anthropic.com and the Anthropic key", () => {
  const options = anthropicOptionsFromEnv({
    POLARIS_AGENT_MODEL: "claude-sonnet-5",
    ANTHROPIC_API_KEY: " sk-ant ",
  });
  assert.equal(options.baseUrl, "https://api.anthropic.com");
  assert.equal(options.model, "claude-sonnet-5");
  assert.equal(options.apiKey, "sk-ant");
});

test("anthropic uses its own base URL variable, not the Zen one", () => {
  // A leftover `POLARIS_AGENT_BASE_URL` (which points at OpenCode Zen Go) must
  // not redirect the Messages request.
  const options = anthropicOptionsFromEnv({
    POLARIS_AGENT_BASE_URL: "https://opencode.ai/zen/go/v1",
    POLARIS_ANTHROPIC_BASE_URL: "https://proxy.test/anthropic/",
    POLARIS_AGENT_MODEL: "claude-haiku-4-5",
  });
  // The client trims the trailing slash when it builds the endpoint.
  assert.equal(options.baseUrl, "https://proxy.test/anthropic/");
  assert.equal(options.model, "claude-haiku-4-5");
  assert.equal(options.apiKey, "");
});

test("anthropic falls back to the Sonnet 5 model id when none is set", () => {
  assert.equal(anthropicOptionsFromEnv({}).model, "claude-sonnet-5");
});
