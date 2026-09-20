/**
 * Recipients readiness (task W10b).
 *
 * Answers "can the voice lane resolve my saved recipients right now?": it reads
 * the contact book through the same command the Wallet page uses. Read-only and
 * non-destructive — it never adds, removes or moves anything.
 */
import { contactsClient } from "@/lib/contacts.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

export default {
  id: "contacts",
  title: "Recipients (contacts)",
  milestone: "W10",
  async run() {
    try {
      const contacts = await contactsClient.list();
      if (contacts.length === 0) {
        return makeResult("warn", "no recipients saved yet; add one in the Wallet page");
      }
      const names = contacts.map((contact) => contact.nickname).slice(0, 5);
      return makeResult("ok", `${contacts.length} recipient(s): ${names.join(", ")}`);
    } catch (error) {
      const detail = errorDetail(error);
      return makeResult(
        "fail",
        /not found|unknown command/i.test(detail)
          ? "the contacts store is not in this build (contacts commands missing)"
          : `contacts check failed: ${detail}`,
      );
    }
  },
} satisfies FeatureCheck;
