import { createRoot } from "react-dom/client";

// Placeholder entry for the native onboarding window (ONBOARDING-native).
// The onboarding UI worker replaces this component; the mount wiring and the
// `app/onboarding.html` entry are the stable contract.
const container = document.getElementById("root");
if (!container) {
  throw new Error("#root container missing from onboarding.html");
}

createRoot(container).render(
  <div
    style={{
      minHeight: "100vh",
      display: "grid",
      placeItems: "center",
      background: "#0b0b0f",
      color: "#f5f5f5",
      fontFamily: "system-ui, sans-serif",
    }}
  >
    Onboarding
  </div>,
);
