/**
 * Suggestions readiness (milestone W6).
 *
 * Answers "can the suggestions engine produce anything?": the owner's
 * payment history is fetched, mapped and fed to the offline engine. It reports
 * how many suggestions the engine returned, or why it returned none. Pure and
 * read-only: it never applies a suggestion (D11).
 */
import { getStellarConfigIfAvailable } from "@/debug/commands.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { fetchOwnerPayments, mapHistoryRecords } from "@/lib/history.ts";
import { computeSuggestions, pickDisplayAsset } from "@/lib/suggestionsModel.ts";

export default {
  id: "suggestions",
  title: "Suggestions engine",
  milestone: "W6",
  async run() {
    try {
      const config = await getStellarConfigIfAvailable();
      if (config === null) {
        return makeResult("warn", "stellar_config is not present on this build");
      }
      if (!config.ownerAddress) {
        return makeResult("warn", "POLARIS_OWNER_ADDRESS is not set; no history to analyse");
      }
      if (!config.horizonUrl) {
        return makeResult("fail", "horizonUrl is not configured; history cannot be fetched");
      }

      const payments = await fetchOwnerPayments(config.horizonUrl, config.ownerAddress, { limit: 50 });
      if (payments.status === "offline") {
        return makeResult("fail", `Horizon is unreachable at ${config.horizonUrl}`);
      }
      if (payments.status === "not_found") {
        return makeResult("warn", "the owner account has no history yet");
      }

      const history = mapHistoryRecords(payments.payments, config.ownerAddress);
      if (history.length === 0) {
        return makeResult("warn", "no outgoing payments yet; the engine needs history to suggest");
      }

      const run = computeSuggestions({
        history,
        now: Math.floor(Date.now() / 1000),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        displayAsset: pickDisplayAsset(history),
        dismissed: [],
      });
      if (run.suggestions.length > 0) {
        return makeResult(
          "ok",
          `suggest() ran on ${history.length} payments and returned ${run.suggestions.length} suggestion(s)`,
        );
      }
      const reason = run.noSuggestions;
      return makeResult(
        "warn",
        reason
          ? `not enough history: ${reason.count}/${reason.minPayments} payments over ${reason.spanDays}/${reason.minSpanDays} days`
          : "no suggestions for the current history",
      );
    } catch (error) {
      return makeResult("fail", `suggestions check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
