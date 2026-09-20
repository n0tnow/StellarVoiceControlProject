import { getNotchHoverHealth, simulateNotchHover } from "@/notch/shellBridge";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

/**
 * Hover-chain health. The notch expands when the native `mouseMoved` monitor
 * emits `notch_hover`; that monitor is **paused while Polaris is the active
 * app**, so a panel (e.g. the approval card) that took focus used to leave
 * hover dead with no log line anywhere. This check surfaces the whole chain:
 * are the monitors installed, when did one last deliver, what rect is being
 * hit-tested, and are we active (the failure state).
 *
 * The "Simulate hover" action bypasses the native monitor and emits the same
 * `notch_hover` edge from Rust, so the webview/reducer half can be verified
 * even when the native half is paused. It has no side effects beyond the notch
 * visibly expanding.
 */
export default {
  id: "notch-hover",
  title: "Notch hover",
  milestone: "W0",
  async run() {
    try {
      const health = await getNotchHoverHealth();
      if (!health.monitorsInstalled) {
        return makeResult("fail", health.detail);
      }
      if (health.active) {
        return makeResult("warn", health.detail);
      }
      const age =
        health.lastSampleAgeMs === null
          ? "no sample yet"
          : `last sample ${Math.round(health.lastSampleAgeMs)} ms ago`;
      return makeResult(
        "ok",
        `${health.detail}; ${age}; state ${health.state}; ` +
          `click-through ${health.clickThrough}`,
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
