/**
 * `e2e:setup` — provision the throwaway testnet environment.
 *
 *   npm run e2e:setup -w @polaris/stellar -- --live
 *   npm run e2e:setup -w @polaris/stellar -- --live --reset [--yes]
 *
 * Without `--live` it only prints the plan (no network access at all).
 * `--reset` destroys the previous throwaway keys and asks for the same strict
 * lowercase `y`/`yes` approval as `e2e:tool` (`--yes` skips it for scripts).
 * Public output only; secrets live in the keys file.
 */
import { Horizon, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { fromRawUnits, toRawUnits } from "../guard/amount.ts";
import {
  E2E_DEFAULTS,
  loadLiveConfig,
  type LiveConfig,
  type LoadLiveConfigOptions,
} from "./config.ts";
import {
  accountHasTrustline,
  ensureSac,
  ensureTrustline,
  getAssetBalance,
  issueAsset,
  waitForHorizonAccount,
} from "./assets.ts";
import { interactiveConfirm } from "./confirm.ts";
import { e2eAsset } from "./e2e.ts";
import { fundWithFriendbot } from "./friendbot.ts";
import { KEY_ROLES, keypairOf, loadOrCreateKeys, writeKeys } from "./keys.ts";

const OWNER_TARGET_RAW = 10_000n * 10_000_000n;

interface SetupOptions {
  config: LiveConfig;
  reset: boolean;
}

function plan(config: LiveConfig, reset: boolean): string {
  return [
    "e2e:setup plan (no network; pass --live to execute)",
    `  network          ${config.network}`,
    `  rpc              ${config.rpcUrl}`,
    `  horizon          ${config.horizonUrl}`,
    `  friendbot        ${config.friendbotUrl}`,
    `  guard contract   ${config.guardContractId}`,
    `  keys file        ${config.keysPath}${reset ? " (regenerated)" : ""}`,
    `  results dir      ${config.resultsDir}`,
    `  asset            ${E2E_DEFAULTS.assetCode}`,
    `  mint to owner    ${E2E_DEFAULTS.mintAmount}`,
    "",
    "  --reset overwrites the previous throwaway keys.json (new keys; the stored",
    "  asset record is dropped). No backup is kept; these are throwaway keys only.",
    "  With --live, --reset asks for the strict y/yes confirmation (or pass --yes).",
  ].join("\n");
}

/** Card shown before a destructive `--reset`. */
function resetCard(config: LiveConfig): string {
  return [
    "┌─ DESTRUCTIVE RESET ─────────────────────────",
    `│ e2e:setup --reset will overwrite ${config.keysPath}`,
    "│ The previous throwaway keys and their asset record are destroyed;",
    "│ no backup is kept and they cannot be recovered.",
    "└─────────────────────────────────────────────",
  ].join("\n");
}

async function setup(opts: SetupOptions): Promise<void> {
  const { config } = opts;
  const keys = loadOrCreateKeys(config.keysPath, { reset: opts.reset });
  const server = new StellarRpc.Server(config.rpcUrl);
  const horizon = new Horizon.Server(config.horizonUrl);

  // -- fund every throwaway key with Friendbot (idempotent) ------------------
  for (const role of KEY_ROLES) {
    const publicKey = keys.keys[role].public;
    const res = await fundWithFriendbot(publicKey, { friendbotUrl: config.friendbotUrl });
    process.stdout.write(`friendbot ${role}: ${res.alreadyFunded ? "already funded" : "funded"}\n`);
  }

  const issuerKp = keypairOf(keys, "issuer");
  const ownerKp = keypairOf(keys, "owner");
  const recipientKp = keypairOf(keys, "recipient");
  // Friendbot submits through Horizon; ingestion can lag a few seconds.
  for (const kp of [issuerKp, ownerKp, recipientKp]) {
    await waitForHorizonAccount(horizon, kp.publicKey());
  }
  const asset = e2eAsset(E2E_DEFAULTS.assetCode, issuerKp.publicKey());

  // -- trustlines ------------------------------------------------------------
  for (const [label, kp] of [["owner", ownerKp], ["recipient", recipientKp]] as const) {
    const res = await ensureTrustline(horizon, kp, asset, config.networkPassphrase);
    process.stdout.write(`trustline ${label}: ${res.created ? `created (${res.hash})` : "exists"}\n`);
  }

  // -- mint to the owner (top up to the target, idempotent) ------------------
  const current = await getAssetBalance(horizon, ownerKp.publicKey(), asset);
  const currentRaw = toRawUnits(current);
  if (currentRaw < OWNER_TARGET_RAW) {
    const mint = fromRawUnits(OWNER_TARGET_RAW - currentRaw);
    const res = await issueAsset(horizon, issuerKp, ownerKp.publicKey(), asset, mint, config.networkPassphrase);
    process.stdout.write(`mint ${mint} ${E2E_DEFAULTS.assetCode} to owner: ${res.hash} (ledger ${res.ledger})\n`);
  } else {
    process.stdout.write(`mint: owner already holds ${current} ${E2E_DEFAULTS.assetCode}\n`);
  }

  // -- deploy the asset's SAC ------------------------------------------------
  const sac = await ensureSac(server, ownerKp, asset, config.networkPassphrase);
  process.stdout.write(`SAC ${sac.sac}: ${sac.deployed ? `deployed (${sac.hash})` : "already deployed"}\n`);

  // -- persist the public asset record --------------------------------------
  keys.asset = { code: asset.getCode(), issuer: issuerKp.publicKey(), sac: sac.sac };
  writeKeys(config.keysPath, keys);

  // -- setup summary ---------------------------------------------------------
  const ownerBalance = await getAssetBalance(horizon, ownerKp.publicKey(), asset);
  const hasOwnerTrust = await accountHasTrustline(horizon, ownerKp.publicKey(), asset);
  process.stdout.write(
    [
      "",
      "setup summary (public):",
      `  owner      ${keys.keys.owner.public}`,
      `  executor   ${keys.keys.executor.public}`,
      `  recipient  ${keys.keys.recipient.public}`,
      `  issuer     ${keys.keys.issuer.public}`,
      `  keeper     ${keys.keys.keeper.public}`,
      `  asset      ${asset.getCode()}:${asset.getIssuer()}`,
      `  SAC        ${sac.sac}`,
      `  owner bal  ${ownerBalance} (trustline ${hasOwnerTrust ? "yes" : "no"})`,
      "",
    ].join("\n"),
  );
}

export async function main(argv: readonly string[], overrides: LoadLiveConfigOptions = {}): Promise<number> {
  const live = argv.includes("--live");
  const reset = argv.includes("--reset");
  const yes = argv.includes("--yes");
  let config: LiveConfig;
  try {
    config = loadLiveConfig({ argv, ...overrides });
  } catch (e) {
    process.stderr.write(`e2e:setup config error: ${(e as Error).message}\n`);
    return 1;
  }

  if (!live) {
    process.stdout.write(`${plan(config, reset)}\n`);
    return 0;
  }
  if (reset) {
    if (!yes && !(await interactiveConfirm(resetCard(config)))) {
      process.stdout.write("aborted: the previous throwaway keys were not changed.\n");
      return 0;
    }
    process.stdout.write(
      "reset: the previous throwaway keys were destroyed; a fresh key set will be generated\n",
    );
  }

  await setup({ config, reset });
  process.stdout.write("e2e:setup done\n");
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`e2e:setup failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
