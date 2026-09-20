/**
 * Embedded wallet readiness (milestone W10).
 *
 * Answers "is the in-app wallet working right now?": whether a wallet exists
 * (`wallet_status`), where the seed is stored, and whether the active account is
 * funded on testnet. Read-only: it never signs, never prompts and moves no funds.
 */
import { getStellarConfigIfAvailable } from "@/debug/commands.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";
import { fetchOwnerAccount } from "@/lib/history.ts";
import { walletStatus } from "@/lib/wallet.ts";

export default {
  id: "wallet",
  title: "Autonomy wallet",
  milestone: "W10",
  async run() {
    try {
      const status = await walletStatus().catch(() => null);
      if (status === null) {
        return makeResult("warn", "wallet_status is not present on this build");
      }
      if (!status.active) {
        return makeResult(
          "warn",
          "No wallet yet — create or import one in the Wallet screen to sign payments",
        );
      }
      const address = status.active.address;
      const note =
        status.store === "keychain"
          ? "seed in the macOS Keychain"
          : `seed store: ${status.store}`;
      // Any store other than the Keychain is a warning: the plaintext fallback
      // and "keychain unavailable" are both weaker states (MINOR-4).
      const weakStore = status.store !== "keychain";

      const config = await getStellarConfigIfAvailable();
      if (config === null) {
        return makeResult("warn", `${address} is active (${note}); stellar_config is missing`);
      }
      if (!config.horizonUrl) {
        return makeResult("fail", "horizonUrl is not configured; balances cannot be read");
      }

      const account = await fetchOwnerAccount(config.horizonUrl, address);
      switch (account.status) {
        case "offline":
          return makeResult("fail", `Horizon is unreachable at ${config.horizonUrl}`);
        case "not_found":
          return makeResult(
            "warn",
            `${address} is active (${note}) but not funded on testnet; use Friendbot`,
          );
        case "ok": {
          const xlm = account.balances.find((balance) => balance.native);
          return makeResult(
            weakStore ? "warn" : "ok",
            `${address} active (${note}); XLM ${xlm?.balance ?? "0"} across ${account.balances.length} balance(s)`,
          );
        }
      }
    } catch (error) {
      return makeResult("fail", `wallet check failed: ${errorDetail(error)}`);
    }
  },
} satisfies FeatureCheck;
