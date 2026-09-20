/**
 * Settings page — session, status, privacy, diagnostics and quit (task W15d).
 *
 * The body lives in `notch/settings/**`; this file only wires it into the page
 * router. Nothing here moves value or reads a secret.
 */
import { SettingsView } from "@/notch/settings/SettingsView";

export function SettingsPage() {
  return <SettingsView />;
}
