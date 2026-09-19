import path from "node:path";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

// Tauri sets TAURI_DEV_HOST when developing on a device/emulator; keep the mobile
// path working even though the hackathon target is macOS desktop.
const host = process.env.TAURI_DEV_HOST;

/**
 * The repo root is the env dir: the gitignored `.env` lives there and is shared
 * by the Rust shell, the agent CLI and this dev server.
 */
const rootDir = path.resolve(import.meta.dirname, "..");

export default defineConfig(({ mode }) => {
  // `prefix: ""` loads every variable, including the agent credential. These stay
  // in this Node process — they are never handed to the webview.
  const env = loadEnv(mode, rootDir, "");
  const agentBaseUrl = env.POLARIS_AGENT_BASE_URL || "https://opencode.ai/zen/go/v1";
  const agentKey = env.OPENCODE_API_KEY ?? "";

  return {
    plugins: [react(), tailwindcss()],

    // Let Vite read the repo-root `.env`, and expose only the non-secret model id
    // to the webview. The API key is deliberately NOT exposed: the webview talks
    // to the same-origin `/agent-api` proxy below, which injects the credential.
    envDir: rootDir,
    envPrefix: ["VITE_", "TAURI_ENV_", "POLARIS_AGENT_MODEL"],

    resolve: {
      alias: {
        "@": `${import.meta.dirname}/src`,
        // Workspace packages point at TS source (no build step); keep these
        // aliases so Vite never has to resolve them through node_modules.
        "@polaris/agent": `${import.meta.dirname}/../agent/src/index.ts`,
        "@polaris/interfaces": `${import.meta.dirname}/../interfaces/src/index.ts`,
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
      // Step A2: the OpenAI-compatible endpoint sends no CORS headers and the
      // desktop webview must not hold the credential. Both problems disappear
      // behind this same-origin proxy: the browser calls `/agent-api/...`, Vite
      // forwards it to the real provider with the key added server-side.
      // Swapping providers stays a `.env` change (POLARIS_AGENT_BASE_URL).
      proxy: {
        "/agent-api": {
          target: agentBaseUrl,
          changeOrigin: true,
          secure: true,
          rewrite: (requestPath) => requestPath.replace(/^\/agent-api/, ""),
          headers: {
            ...(agentKey ? { Authorization: `Bearer ${agentKey}` } : {}),
            // Browsers drop User-Agent; the provider wants a descriptive one.
            "User-Agent": "polaris/0.1",
          },
        },
      },
    },

    build: {
      // macOS 15 = Safari 18; WKWebView is always current on the target machine.
      target: "safari15",
      // Vite 8 dropped esbuild in favour of Oxc — keep the default minifier (Oxc);
      // pinning "esbuild" would require installing it separately.
      minify: process.env.TAURI_ENV_DEBUG === "true" ? false : true,
      sourcemap: process.env.TAURI_ENV_DEBUG === "true",
      rollupOptions: {
        // Two windows, two entries. `index.html` is the notch overlay;
        // `prompt.html` is step A6's focusable typed-prompt panel. Tauri's
        // `frontendDist` serves both straight out of `dist/`.
        input: {
          main: path.resolve(import.meta.dirname, "index.html"),
          prompt: path.resolve(import.meta.dirname, "prompt.html"),
        },
      },
    },
  };
});
