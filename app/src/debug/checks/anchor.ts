/**
 * Anchor on/off-ramp readiness (milestone W5b).
 *
 * It answers, for a non-developer: is the TR mock anchor reachable, does its
 * `stellar.toml` parse, and does it publish the SEP-10 auth endpoint the login
 * needs? The read is the standard SEP-1 discovery, so it is safe to run
 * automatically — it never signs, submits or moves funds.
 *
 * Challenge signing is feature-detected at use time (`wallet_sign_challenge`,
 * W5a); it is not probed here because even an invalid probe would invoke the
 * signer. The panel reports that as `unknown` until the command merges.
 */
import { anchor } from "@polaris/stellar";

import { getStellarConfigIfAvailable } from "@/debug/commands.ts";
import { errorDetail, makeResult } from "@/debug/runner.ts";
import type { FeatureCheck } from "@/debug/types.ts";

/** A syntactically valid key only used so the session can be constructed. */
const DUMMY_KEY = `G${"A".repeat(55)}`;

/** The live check. Read-only; safe for the panel's auto-run. */
export default {
  id: "anchor",
  title: "Anchor on/off-ramp",
  milestone: "W5",
  async run() {
    try {
      const config = await getStellarConfigIfAvailable();
      const owner = config?.ownerAddress;
      const signer: anchor.Signer = {
        publicKey: async () => owner ?? DUMMY_KEY,
        signTransaction: async () => {
          throw new Error("the anchor check never signs");
        },
      };
      const session = new anchor.AnchorSession({ signer });
      const { data } = await session.discover();
      if (!data.signingKey || !data.webAuthEndpoint || !data.transferServer) {
        return makeResult(
          "fail",
          `${session.homeDomain} does not publish a complete SEP-1 stellar.toml (signing key, auth or transfer endpoint)`,
        );
      }
      const authHost = new URL(data.webAuthEndpoint).host;
      return makeResult("ok", `${session.homeDomain} reachable · SEP-1 parsed · SEP-10 endpoint ${authHost}`);
    } catch (error) {
      return makeResult(
        "fail",
        `anchor ${anchor.DEFAULT_HOME_DOMAIN} unreachable or its stellar.toml is invalid: ${errorDetail(error)}`,
      );
    }
  },
} satisfies FeatureCheck;
