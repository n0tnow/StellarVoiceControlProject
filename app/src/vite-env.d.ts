/// <reference types="vite/client" />

/**
 * The webview only ever sees non-secret agent config. The API key stays in the
 * Vite dev-server proxy (`vite.config.ts`), never in this bundle.
 */
interface ImportMetaEnv {
  /** Model id from `.env`; the base URL is always the same-origin `/agent-api`. */
  readonly POLARIS_AGENT_MODEL?: string;
}
