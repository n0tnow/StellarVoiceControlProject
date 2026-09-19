import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Step A6: the prompt panel is its own React root and its own Vite entry. It
// reuses the shared design tokens (`@/index.css`) but holds no state in common
// with the notch overlay (`@/App`), which lives in the other window.
import "@/index.css";
import "@/prompt/prompt.css";

import { PromptPanel } from "@/prompt/PromptPanel";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing from prompt.html");
}

createRoot(container).render(
  <StrictMode>
    <PromptPanel />
  </StrictMode>,
);
