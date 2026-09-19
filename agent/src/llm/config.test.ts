import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentError } from "../errors.ts";
import { openAiOptionsFromEnv } from "./config.ts";

test("defaults to OpenCode Zen Go when the environment is empty", () => {
  const options = openAiOptionsFromEnv({});
  assert.equal(options.baseUrl, "https://opencode.ai/zen/go/v1");
  assert.equal(options.model, "deepseek-v4.1-flash");
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

test("a same-origin path is allowed so the webview can use its dev proxy", () => {
  assert.equal(openAiOptionsFromEnv({ POLARIS_AGENT_BASE_URL: "/agent-api" }).baseUrl, "/agent-api");
});

test("a non-http base URL is a config error, not a bad request later", () => {
  assert.throws(
    () => openAiOptionsFromEnv({ POLARIS_AGENT_BASE_URL: "ftp://nope" }),
    (error: unknown) => error instanceof AgentError && error.kind === "config",
  );
});
