import { getNotchHoverHealth, simulateNotchHover } from "@/notch/shellBridge";
import { readShellDiagnostics } from "@/notch/shellDiagnostics";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

/**
 * Hover-chain health and the resolved shell state. The notch expands when the
 * native `mouseMoved` monitor emits `notch_hover`; that monitor is **paused
 * while Polaris is the active app**, so a panel (e.g. the approval card) that
 * took focus used to leave hover dead with no log line anywhere. This check
 * surfaces the whole chain: are the monitors installed, when did one last
 * deliver, what rect is being hit-tested, and are we active (the failure state).
 *
 * It also prints the webview's last resolved state/sources/pin plus the native
 * window height, so a React/native size mismatch (the notch-clip bug: React
 * rendered the panel while the native window had been forced back to the
 * collapsed frame) is readable from the Debug panel.
 *
 * The "Simulate hover" action bypasses the native monitor and emits the same
 * `notch_hover` edge from Rust, so the webview/reducer half can be verified
 * even when the native half is paused. It has no side effects beyond the notch
 * visibly expanding.
 */
export default {
  id: "notch-hover",
  title: "Notch hover / state",
  milestone: "W0",
  async run() {
    try {
      const health = await getNotchHoverHealth();
      if (!health.monitorsInstalled) {
        return makeResult("fail", health.detail);
      }
      const age =
        health.lastSampleAgeMs === null
          ? "no sample yet"
          : `last sample ${Math.round(health.lastSampleAgeMs)} ms ago`;
      const state = readShellDiagnostics();
      const resolved = state
        ? `applied ${state.applied} / target ${state.target} / source ${state.source}` +
          ` / voiceAttention ${state.voiceAttention}`
        : "applied ? (webview not rendered)";
      if (health.active) {
        return makeResult("warn", `${health.detail}; ${resolved}`);
      }
      return makeResult(
        "ok",
        `${health.detail}; ${age}; native ${health.state} ${Math.round(health.windowHeight)} pt; ` +
          `pinned ${health.pinned}; ${resolved}`,
      );
    } catch (error) {
      return makeResult("fail", `hover health failed: ${errorDetail(error)}`);
    }
  },
  actions: [
    {
      id: "simulate-hover",
      label: "Simulate hover",
      description: "Emit the notch_hover edge the native monitor uses; watch the notch expand.",
      async run() {
        try {
          await simulateNotchHover();
          return makeResult("ok", "sent notch_hover inside=true; watch the notch expand");
        } catch (error) {
          return makeResult("fail", `simulate hover failed: ${errorDetail(error)}`);
        }
      },
    },
  ],
} satisfies FeatureCheck;
