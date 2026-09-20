import "@/polyfills";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "@/App";
import { webLog } from "@/lib/weblog";
import "@/index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing from index.html");
}

/** A short, log-safe description of any thrown or rejected value. */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// F4: webview errors never reached the terminal. Pipe them through `webLog` so
// they do, and onto the `error` event so the Debug panel tail shows the detail.
window.addEventListener("error", (event) => {
  webLog(
    "error",
    `window error: ${event.message} (${event.filename}:${event.lineno}:${event.colno})`,
    true,
  );
});

window.addEventListener("unhandledrejection", (event) => {
  webLog("error", `unhandled rejection: ${describe(event.reason)}`, true);
});

// The notch overlay is the only window; there is no hash routing.
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);