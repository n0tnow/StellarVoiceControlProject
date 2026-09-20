/**
 * The onboarding window's entry point.
 *
 * Three lines of mounting, exactly as `bridge.html` does it, plus the
 * stylesheet. Everything else is in [`OnboardingRoot`].
 *
 * ⚠️ MERGE NOTE: `app/onboarding.html` and this file are also listed as the
 * native worker's placeholders. Neither existed on this branch, and a page with
 * no entry point cannot be looked at, so both were written here. At merge, keep
 * one copy — they are three lines and the shapes should be identical — and make
 * sure `onboarding.html` is added to `rollupOptions.input` in
 * `app/vite.config.ts`, which this branch deliberately does not touch. Vite's
 * dev server serves any root-level `.html` without that entry, which is why
 * `npm run dev` + `/onboarding.html` works here and a production build would
 * not.
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
