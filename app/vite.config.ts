import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri sets TAURI_DEV_HOST when developing on a device/emulator; keep the mobile
// path working even though the hackathon target is macOS desktop.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": `${import.meta.dirname}/src`,
      // Workspace package points at TS source (no build step); keep this alias so
      // Vite never has to resolve it through node_modules.
      "@polaris/interfaces": `${import.meta.dirname}/../interfaces/src/index.ts`,
    },
  },

  // Tauri expects a fixed port and owns the terminal output.
  clearScreen: false,
  envPrefix: ["VITE_", "TAURI_ENV_"],
  server: {
    port: 1420,
    strictPort: true,
    host: host ?? false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      // Rust sources are rebuilt by cargo, not by Vite.
      ignored: ["**/src-tauri/**"],
    },
  },

  build: {
    // macOS 15 = Safari 18; WKWebView is always current on the target machine.
    target: "safari15",
    // Vite 8 dropped esbuild in favour of Oxc — keep the default minifier (Oxc);
    // pinning "esbuild" would require installing it separately.
    minify: process.env.TAURI_ENV_DEBUG === "true" ? false : true,
    sourcemap: process.env.TAURI_ENV_DEBUG === "true",
  },
});