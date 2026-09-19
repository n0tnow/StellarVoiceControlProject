/**
 * Keeper CLI.
 *
 *   npm run keeper -w @polaris/stellar            # poll forever
 *   npm run keeper:once -w @polaris/stellar       # one tick, then exit
 *   ... -- --dry-run                              # simulate only, submit nothing
 *
 * Config comes from the environment (see `config.ts`); the npm scripts load
 * the repo-root `.env` when present. Exit codes: 0 ok, 1 config/tick error.
 */
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { SorobanChain } from "./chain.ts";
import { ConfigError, loadConfig, redactedConfig } from "./config.ts";
import { Keeper } from "./keeper.ts";
import { jsonLogger, type LogLevel } from "./log.ts";

async function main(argv: string[]): Promise<number> {
  const once = argv.includes("--once");
  const requested = process.env.KEEPER_LOG_LEVEL?.trim().toLowerCase();
  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  const level = levels.find((l) => l === requested) ?? "info";
  const log = jsonLogger({ minLevel: level });

  let cfg;
  try {
    cfg = loadConfig(process.env, argv.includes("--dry-run") ? { dryRun: true } : {});
  } catch (err) {
    if (err instanceof ConfigError) {
      log("error", { event: "config_error", message: err.message });
      return 1;
    }
    throw err;
  }
  log("info", { event: "config", config: redactedConfig(cfg) });

  const server = new StellarRpc.Server(cfg.rpcUrl, { allowHttp: cfg.rpcUrl.startsWith("http://") });
  const chain = new SorobanChain(server, {
    contractId: cfg.guardContractId,
    keypair: cfg.keypair,
    networkPassphrase: cfg.networkPassphrase,
    txTimeoutSeconds: cfg.txTimeoutSeconds,
    maxFeeStroops: cfg.maxFeeStroops,
    pollIntervalMs: cfg.pollIntervalMs,
  });
  const keeper = new Keeper(
    { pollSeconds: cfg.pollSeconds, maxPerTick: cfg.maxPerTick, dryRun: cfg.dryRun },
    { chain, log },
  );

  const stop = new AbortController();
  let signals = 0;
  const onSignal = (name: string): void => {
    signals += 1;
    if (signals > 1) {
      log("warn", { event: "forced_exit", signal: name });
      process.exit(130);
    }
    // First signal: finish the in-flight submission (so its hash is not lost), then stop.
    log("info", { event: "shutdown_requested", signal: name });
    stop.abort();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));

  if (once) {
    const summary = await keeper.tick(stop.signal);
    log("info", { event: "once_done", ...summary, pending: keeper.state().pending });
    return summary.ok ? 0 : 1;
  }
  await keeper.run(stop.signal);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    // Last-resort handler; the message never includes config, so no secrets.
    process.stderr.write(`keeper crashed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
