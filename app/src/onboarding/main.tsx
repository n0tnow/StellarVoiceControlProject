/**
 * The onboarding window's entry point.
 *
 * Three lines of mounting, exactly as `bridge.html` does it, plus the
 * stylesheet. Everything else is in [`OnboardingRoot`].
 *
 * This file and `app/onboarding.html` are the single copy of that pair: the
 * native worker's placeholder wrote the same two paths, and the merge kept
 * this one. `app/vite.config.ts` lists `onboarding.html` in
 * `rollupOptions.input`, so a production build emits the window too — a page
 * without that entry is still served by Vite's dev server, which is how a
 * missing entry stays invisible until packaging.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { OnboardingRoot } from "@/onboarding/OnboardingRoot";
import "@/index.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing from onboarding.html");
}

createRoot(container).render(
  <StrictMode>
    <OnboardingRoot />
  </StrictMode>,
);
