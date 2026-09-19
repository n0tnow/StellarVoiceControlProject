/// <reference types="vite/client" />

/**
 * The webview only ever sees non-secret agent config. The API key stays in Rust
 * (the `agent_chat` command), never in this bundle.
 */
interface ImportMetaEnv {
  /** Model id from `.env`; the provider URL and credential live in Rust. */
  readonly POLARIS_AGENT_MODEL?: string;
  /**
   * Non-secret kill-switch for the A9 approval seam. `"1"` installs the loud
   * auto-approving placeholder (stubbed demo only); anything else keeps the
   * fail-closed deny-all approver. See `app/src/lib/chain.ts`.
   */
  readonly POLARIS_ALLOW_AUTO_APPROVE?: string;
}
