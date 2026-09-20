import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri sets TAURI_DEV_HOST when developing on a device/emulator; keep the mobile
// path working even though the hackathon target is macOS desktop.
const host = process.env.TAURI_DEV_HOST;

/**
 * The repo root is the env dir: the gitignored `.env` lives there and is shared
 * by the Rust shell, the agent CLI and this dev server.
 */
const rootDir = path.resolve(import.meta.dirname, "..");

export default defineConfig({
  plugins: [react(), tailwindcss()],

  // Let Vite read the repo-root `.env`, and expose only non-secret values to the
  // webview: the model id and the provider id (which wire format to build). The
  // agent credential is never exposed: the provider call runs in Rust
  // (`agent_chat`), which reads `OPENCODE_API_KEY`/`ANTHROPIC_API_KEY` itself.
  envDir: rootDir,
  envPrefix: [
    "VITE_",
    "TAURI_ENV_",
    "POLARIS_AGENT_MODEL",
    "POLARIS_AGENT_PROVIDER",
    "POLARIS_ALLOW_AUTO_APPROVE",
  ],

  resolve: {
    alias: {
      "@": `${import.meta.dirname}/src`,
      // Workspace packages point at TS source (no build step); keep these
      // aliases so Vite never has to resolve them through node_modules.
      "@polaris/agent": `${import.meta.dirname}/../agent/src/index.ts`,
      "@polaris/interfaces": `${import.meta.dirname}/../interfaces/src/index.ts`,
      // The A9 execution seam dispatches into Owner B's chain tools.
      "@polaris/stellar": `${import.meta.dirname}/../stellar/src/index.ts`,
    },
  },

  // Tauri expects a fixed port and owns the terminal output.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust sources are rebuilt by cargo, not by Vite.
      ignored: ["**/src-tauri/**"],
    },
    // Step A6: there is no `/agent-api` proxy any more. The webview talks to the
    // provider through the Rust `agent_chat` command, so the credential never
    // lives in this Node process either and a packaged build needs no dev server.
  },

  build: {
    // macOS 15 = Safari 18; WKWebView is always current on the target machine.
    target: "safari15",
    // Two entries: the Tauri shell (`index.html`) and the first-run onboarding
    // window (`onboarding.html`). The Freighter signing bridge is gone — the W10
    // embedded wallet replaced it, so `bridge.html` no longer exists.
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        onboarding: path.resolve(import.meta.dirname, "onboarding.html"),
      },
    },
    // Vite 8 dropped esbuild in favour of Oxc — keep the default minifier (Oxc);
    // pinning "esbuild" would require installing it separately.
    minify: process.env.TAURI_ENV_DEBUG === "true" ? false : true,
    sourcemap: process.env.TAURI_ENV_DEBUG === "true",
  },
});
