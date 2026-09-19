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

/// Provider root; the same variable the TypeScript config reads (`config.ts`).
pub const AGENT_BASE_URL_ENV: &str = "POLARIS_AGENT_BASE_URL";
/// Bearer credential; server-side only.
pub const AGENT_API_KEY_ENV: &str = "OPENCODE_API_KEY";
/// OpenCode Zen Go — the owner-chosen provider (`docs/architecture.md` §4.2).
pub const DEFAULT_AGENT_BASE_URL: &str = "https://opencode.ai/zen/go/v1";
/// A descriptive User-Agent; some providers reject generic SDK defaults.
pub const AGENT_USER_AGENT: &str = "polaris/0.1";

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

/// Builds the chat-completions URL from a provider root, tolerating a trailing
/// slash (`.env` values are hand-written).
pub fn endpoint(base: &str) -> String {
    format!("{}/chat/completions", base.trim().trim_end_matches('/'))
}

/// The `Authorization` value for a configured key, or `None` when no key is set.
/// Blank keys are treated as unset so a stray empty line in `.env` cannot send
/// `Bearer ` to the provider.
pub fn bearer(key: Option<&str>) -> Option<String> {
    key.map(str::trim)
        .filter(|key| !key.is_empty())
        .map(|key| format!("Bearer {key}"))
}

/// Performs one blocking provider call. Split from the command so the pure pieces
/// (`endpoint`, `bearer`) can be unit-tested without a network.
fn request(
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

    let mut builder = client
        .post(endpoint(base))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        // Always present: the endpoint rejects requests without it.
        .header("x-opencode-session", session_id)
        .header(reqwest::header::USER_AGENT, AGENT_USER_AGENT)
        .body(body.to_string());
    if let Some(value) = bearer(key) {
        builder = builder.header(reqwest::header::AUTHORIZATION, value);
    }

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

/// Sends one chat-completions request to the configured provider.
///
/// `body` is the JSON the TypeScript client built; `sessionId` is its stable
/// `ses_<32 hex>` conversation id. Blocking HTTP runs on the blocking pool so the
/// Tauri main thread and async workers are never blocked.
#[tauri::command]
pub async fn agent_chat(body: String, session_id: String) -> Result<AgentHttpResponse, String> {
    let base = env::var(AGENT_BASE_URL_ENV).unwrap_or_else(|| DEFAULT_AGENT_BASE_URL.to_string());
    let key = env::var(AGENT_API_KEY_ENV);
    match tauri::async_runtime::spawn_blocking(move || {
        request(&base, key.as_deref(), &session_id, &body)
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
    fn endpoint_trims_trailing_slashes() {
        assert_eq!(
            endpoint("https://opencode.ai/zen/go/v1"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            endpoint("https://opencode.ai/zen/go/v1/"),
            "https://opencode.ai/zen/go/v1/chat/completions"
        );
        assert_eq!(
            endpoint("  https://example.test/v1// "),
            "https://example.test/v1/chat/completions"
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
    fn the_response_serializes_camel_case_for_the_webview() {
        let json = serde_json::to_string(&AgentHttpResponse {
            status: 200,
            body: "{}".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"status":200,"body":"{}"}"#);
    }

    #[test]
    fn the_default_base_url_is_the_documented_provider() {
        assert_eq!(DEFAULT_AGENT_BASE_URL, "https://opencode.ai/zen/go/v1");
        assert_eq!(AGENT_BASE_URL_ENV, "POLARIS_AGENT_BASE_URL");
        assert_eq!(AGENT_API_KEY_ENV, "OPENCODE_API_KEY");
    }
}
