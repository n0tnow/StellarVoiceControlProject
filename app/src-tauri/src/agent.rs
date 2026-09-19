//! The webview → provider transport (step A6).
//!
//! The webview cannot be trusted to make the provider request itself. Two reasons
//! were established while fixing the "Net error" bug:
//!
//! 1. **Environment.** The Tauri WKWebView enforces the WebIDL receiver for
//!    `Window.fetch`; a client that stores `globalThis.fetch` and calls it as a
//!    method dies with `TypeError: Can only call Window.fetch on instances of
//!    Window` before a byte leaves the process.
//! 2. **Packaging.** The old path relied on the Vite dev proxy (`/agent-api`),
//!    which only exists under `npm run dev`; a packaged Polaris had no way to
//!    reach the provider at all.
//!
//! Moving the request into Rust fixes both at once, and it is also the only place
//! the credential already lives, so the key never enters the webview bundle. The
//! command returns the provider's **status and raw body** (not a parsed shape):
//! the agent core in TypeScript still owns request construction, the error
//! taxonomy and the response shape, so this stays a transport, not a second
//! client.
//!
//! The API key is only ever placed in the `Authorization` header. It is never
//! logged, and no error string produced here contains it.

use std::time::{Duration, Instant};

use serde::Serialize;

use crate::env;
use crate::timing;

/// Which wire format the transport speaks (step A11). Named by the same
/// `POLARIS_AGENT_PROVIDER` the TypeScript config reads.
pub const AGENT_PROVIDER_ENV: &str = "POLARIS_AGENT_PROVIDER";
/// Provider root; the same variable the TypeScript config reads (`config.ts`).
pub const AGENT_BASE_URL_ENV: &str = "POLARIS_AGENT_BASE_URL";
/// Bearer credential for the OpenAI-compatible provider; server-side only.
pub const AGENT_API_KEY_ENV: &str = "OPENCODE_API_KEY";
/// Anthropic credential; server-side only, never logged and never bundled.
pub const ANTHROPIC_API_KEY_ENV: &str = "ANTHROPIC_API_KEY";
/// Anthropic base root (the endpoint is `{base}/v1/messages`). A dedicated
/// variable on purpose: `POLARIS_AGENT_BASE_URL` points at OpenCode Zen Go, so
/// reusing it would send the Messages body to the wrong host.
pub const ANTHROPIC_BASE_URL_ENV: &str = "POLARIS_ANTHROPIC_BASE_URL";
/// OpenCode Zen Go — the owner-chosen default provider (`docs/architecture.md` §4.2).
pub const DEFAULT_AGENT_BASE_URL: &str = "https://opencode.ai/zen/go/v1";
/// Anthropic's root; used when `POLARIS_ANTHROPIC_BASE_URL` is unset.
pub const DEFAULT_ANTHROPIC_BASE_URL: &str = "https://api.anthropic.com";
/// Pinned by the Anthropic API reference; sent on every Messages request.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// A descriptive User-Agent; some providers reject generic SDK defaults.
pub const AGENT_USER_AGENT: &str = "polaris/0.1";

/// The two supported wire formats.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// OpenAI-compatible `POST {base}/chat/completions` (OpenCode Zen Go, Groq…).
    OpenAi,
    /// Anthropic `POST {base}/v1/messages`.
    Anthropic,
}

/// Parses `POLARIS_AGENT_PROVIDER`.
///
/// Missing or blank means the OpenAI-compatible default; an unknown value also
/// means that default with `recognized = false`, so the caller can warn instead
/// of silently changing where the request goes.
pub fn parse_provider(value: Option<&str>) -> (Provider, bool) {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None => (Provider::OpenAi, true),
        Some(value) if value.eq_ignore_ascii_case("openai") || value.eq_ignore_ascii_case("opencode") => {
            (Provider::OpenAi, true)
        }
        Some(value) if value.eq_ignore_ascii_case("anthropic") => (Provider::Anthropic, true),
        Some(_) => (Provider::OpenAi, false),
    }
}

/// Whole-request budget, matching the TypeScript client's default timeout.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long to wait for the TCP/TLS handshake before giving up.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The transport's reply: the provider's HTTP status plus its raw body.
///
/// A non-2xx status is **not** an error here: the TypeScript client inspects
/// `status`/`ok` to distinguish auth failures from other provider errors and to
/// keep the body detail. Only a transport failure (DNS, TLS, connection reset,
/// timeout) becomes an `Err`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHttpResponse {
    pub status: u16,
    pub body: String,
}

/// Builds the request URL from a provider root, tolerating a trailing slash
/// (`.env` values are hand-written). OpenAI-compatible providers use
/// `/chat/completions`; Anthropic uses `/v1/messages`.
pub fn endpoint(provider: Provider, base: &str) -> String {
    let root = base.trim().trim_end_matches('/');
    match provider {
        Provider::OpenAi => format!("{root}/chat/completions"),
        // A base that already ends in `/v1` must not become `/v1/v1/messages`.
        Provider::Anthropic => format!("{}/v1/messages", root.trim_end_matches("/v1")),
    }
}

/// The `Authorization` value for a configured key, or `None` when no key is set.
/// Blank keys are treated as unset so a stray empty line in `.env` cannot send
/// `Bearer ` to the provider.
pub fn bearer(key: Option<&str>) -> Option<String> {
    key.map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| format!("Bearer {key}"))
}

/// The raw key for Anthropic's `x-api-key` header (never a Bearer token), or
/// `None` when unset. Blank keys are treated as unset, like [`bearer`].
pub fn api_key(key: Option<&str>) -> Option<String> {
    key.map(str::trim)
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

/// The exact header set for one request. Pure, so the provider-specific wire
/// requirements are pinned by a unit test with no network:
///
/// * OpenAI-compatible: `x-opencode-session` is mandatory and the key is a
///   `Bearer` token.
/// * Anthropic: `anthropic-version` is mandatory and the key goes in
///   `x-api-key`; no session header and no `Authorization`.
pub fn request_headers(
    provider: Provider,
    key: Option<&str>,
    session_id: &str,
) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("content-type", "application/json".to_string()),
        ("accept", "application/json".to_string()),
        ("user-agent", AGENT_USER_AGENT.to_string()),
    ];
    match provider {
        Provider::OpenAi => {
            headers.push(("x-opencode-session", session_id.to_string()));
            if let Some(value) = bearer(key) {
                headers.push(("authorization", value));
            }
        }
        Provider::Anthropic => {
            headers.push(("anthropic-version", ANTHROPIC_VERSION.to_string()));
            if let Some(value) = api_key(key) {
                headers.push(("x-api-key", value));
            }
        }
    }
    headers
}

/// Performs one blocking provider call. Split from the command so the pure pieces
/// (`endpoint`, `request_headers`) can be unit-tested without a network.
fn request(
    provider: Provider,
    base: &str,
    key: Option<&str>,
    session_id: &str,
    body: &str,
) -> Result<AgentHttpResponse, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("could not build the HTTP client: {error}"))?;

    let mut builder = client.post(endpoint(provider, base));
    for (name, value) in request_headers(provider, key, session_id) {
        builder = builder.header(name, value);
    }
    let builder = builder.body(body.to_string());

    let started = Instant::now();
    // Step A11: the provider phases of the turn. `request sent` is the hand-off
    // to the network; `first byte` is when the response headers arrive; `full
    // response` is after the body has been read. The gap between the last two is
    // the provider's body-transfer time, which matters for a slow model.
    timing::mark("provider request sent");
    let response = builder
        .send()
        .map_err(|error| format!("could not reach the model provider: {error}"))?;
    timing::mark("provider first byte");
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|error| format!("could not read the provider response: {error}"))?;
    timing::mark("provider full response");
    println!(
        "polaris: agent → provider HTTP {status} in {} ms",
        started.elapsed().as_millis()
    );
    Ok(AgentHttpResponse { status, body })
}

/// Resolves the provider for one request: the webview's explicit choice wins,
/// then `POLARIS_AGENT_PROVIDER`, then the OpenAI-compatible default. The
/// webview passes the same value it used to build the body, so the two cannot
/// drift even if the environment changes between turns.
fn resolve_provider(explicit: Option<&str>) -> Provider {
    let from_env = env::var(AGENT_PROVIDER_ENV);
    let (provider, recognized) = parse_provider(explicit.or(from_env.as_deref()));
    if !recognized {
        eprintln!(
            "polaris: unknown {AGENT_PROVIDER_ENV} value — using the OpenAI-compatible default \
             (accepted values are `openai` and `anthropic`)"
        );
    }
    provider
}

/// Sends one request to the configured provider.
///
/// `body` is the JSON the TypeScript client built and `sessionId` is its stable
/// `ses_<32 hex>` conversation id (OpenAI-compatible only). `provider` selects
/// the wire format: OpenAI-compatible headers/endpoint, or Anthropic's
/// `x-api-key` + `anthropic-version` against `/v1/messages`. Blocking HTTP runs
/// on the blocking pool so the Tauri main thread and async workers are never
/// blocked.
#[tauri::command]
pub async fn agent_chat(
    body: String,
    session_id: String,
    provider: Option<String>,
) -> Result<AgentHttpResponse, String> {
    let provider = resolve_provider(provider.as_deref());
    let (base, key) = match provider {
        Provider::OpenAi => (
            env::var(AGENT_BASE_URL_ENV).unwrap_or_else(|| DEFAULT_AGENT_BASE_URL.to_string()),
            env::var(AGENT_API_KEY_ENV),
        ),
        Provider::Anthropic => (
            env::var(ANTHROPIC_BASE_URL_ENV)
                .unwrap_or_else(|| DEFAULT_ANTHROPIC_BASE_URL.to_string()),
            env::var(ANTHROPIC_API_KEY_ENV),
        ),
    };
    match tauri::async_runtime::spawn_blocking(move || {
        request(provider, &base, key.as_deref(), &session_id, &body)
    })
    .await
    {
        Ok(result) => result,
        Err(error) => Err(format!("the agent request task did not finish: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openai_endpoint_trims_trailing_slashes() {
        assert_eq!(
            endpoint(Provider::OpenAi, "https://opencode.ai/zen/go/v1"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            endpoint(Provider::OpenAi, "https://opencode.ai/zen/go/v1/"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            endpoint(Provider::OpenAi, "  https://example.test/v1// "),
            "https://example.test/v1/chat/completions"
        );
    }

    #[test]
    fn anthropic_endpoint_is_v1_messages_and_never_doubles_v1() {
        assert_eq!(
            endpoint(Provider::Anthropic, "https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            endpoint(Provider::Anthropic, "https://api.anthropic.com/"),
            "https://api.anthropic.com/v1/messages"
        );
        // A base that already carries `/v1` must not become `/v1/v1/messages`.
        assert_eq!(
            endpoint(Provider::Anthropic, "https://api.anthropic.com/v1"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            endpoint(Provider::Anthropic, "  https://proxy.test/api/v1/ "),
            "https://proxy.test/api/v1/messages"
        );
    }

    #[test]
    fn a_missing_or_blank_key_sends_no_authorization() {
        assert_eq!(bearer(None), None);
        assert_eq!(bearer(Some("")), None);
        assert_eq!(bearer(Some("   ")), None);
        assert_eq!(bearer(Some("sk-secret")), Some("Bearer sk-secret".to_string()));
        assert_eq!(bearer(Some(" sk-secret ")), Some("Bearer sk-secret".to_string()));
    }

    #[test]
    fn a_missing_or_blank_anthropic_key_sends_no_api_key_header() {
        assert_eq!(api_key(None), None);
        assert_eq!(api_key(Some("")), None);
        assert_eq!(api_key(Some("   ")), None);
        assert_eq!(api_key(Some("sk-ant")), Some("sk-ant".to_string()));
        assert_eq!(api_key(Some(" sk-ant ")), Some("sk-ant".to_string()));
    }

    #[test]
    fn the_openai_headers_match_the_zen_contract() {
        let headers = request_headers(Provider::OpenAi, Some("secret"), "ses_abc");
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("x-opencode-session"), Some("ses_abc"));
        assert_eq!(get("authorization"), Some("Bearer secret"));
        assert_eq!(get("content-type"), Some("application/json"));
        assert_eq!(get("anthropic-version"), None);
        assert_eq!(get("x-api-key"), None);
    }

    #[test]
    fn the_anthropic_headers_use_x_api_key_not_a_bearer_token() {
        let headers = request_headers(Provider::Anthropic, Some("sk-ant"), "ses_abc");
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("anthropic-version"), Some("2023-06-01"));
        assert_eq!(get("x-api-key"), Some("sk-ant"));
        // Anthropic must never receive the OpenAI-specific headers.
        assert_eq!(get("authorization"), None);
        assert_eq!(get("x-opencode-session"), None);
        assert_eq!(get("content-type"), Some("application/json"));
    }

    #[test]
    fn the_response_serializes_camel_case_for_the_webview() {
        let json = serde_json::to_string(&AgentHttpResponse {
            status: 200,
            body: "{}".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"status":200,"body":"{}"}"#);
    }

    #[test]
    fn provider_selection_defaults_to_openai_and_never_hides_a_typo() {
        assert_eq!(parse_provider(None), (Provider::OpenAi, true));
        assert_eq!(parse_provider(Some("")), (Provider::OpenAi, true));
        assert_eq!(parse_provider(Some("   ")), (Provider::OpenAi, true));
        assert_eq!(parse_provider(Some("openai")), (Provider::OpenAi, true));
        assert_eq!(parse_provider(Some("OPENCODE")), (Provider::OpenAi, true));
        assert_eq!(parse_provider(Some(" anthropic ")), (Provider::Anthropic, true));
        // A typo must fall back to the default *and* be reported, so the caller
        // warns instead of silently changing where the request goes.
        assert_eq!(parse_provider(Some("claude")), (Provider::OpenAi, false));
    }

    #[test]
    fn the_default_base_urls_and_env_names_are_the_documented_ones() {
        assert_eq!(DEFAULT_AGENT_BASE_URL, "https://opencode.ai/zen/go/v1");
        assert_eq!(DEFAULT_ANTHROPIC_BASE_URL, "https://api.anthropic.com");
        assert_eq!(ANTHROPIC_VERSION, "2023-06-01");
        assert_eq!(AGENT_BASE_URL_ENV, "POLARIS_AGENT_BASE_URL");
        assert_eq!(AGENT_API_KEY_ENV, "OPENCODE_API_KEY");
        assert_eq!(AGENT_PROVIDER_ENV, "POLARIS_AGENT_PROVIDER");
        assert_eq!(ANTHROPIC_API_KEY_ENV, "ANTHROPIC_API_KEY");
        assert_eq!(ANTHROPIC_BASE_URL_ENV, "POLARIS_ANTHROPIC_BASE_URL");
    }
}
