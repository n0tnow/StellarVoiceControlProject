/// <reference types="vite/client" />

/**
 * The webview only ever sees non-secret agent config. The API key stays in Rust
 * (the `agent_chat` command), never in this bundle.
 */
interface ImportMetaEnv {
  /** Model id from `.env`; the provider URL and credential live in Rust. */
  readonly POLARIS_AGENT_MODEL?: string;
}
