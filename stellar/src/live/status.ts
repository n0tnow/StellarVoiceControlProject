/**
 * `e2e:status` — read-only TESTNET state snapshot for the manual tester.
 *
 *   npm run e2e:status -w @polaris/stellar                 # plan only, no network
 *   npm run e2e:status -w @polaris/stellar -- --live       # read the live chain
 *   npm run e2e:status -w @polaris/stellar -- --live --json
 *
 * It prints only PUBLIC data (addresses, balances, on-chain policy). It never
 * reads a secret from anywhere other than the throwaway `~/.polaris-e2e`
 * keys file, never signs and never submits.
 */
import { Horizon, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { fromRawUnits, toRawUnits } from "../guard/amount.ts";
import { getAllowance } from "../guard/allowance.ts";
import type { Rule, Schedule } from "../guard/types.ts";
import { formatInZone, intervalWords } from "../schedule/time.ts";
import { parseCommandLine, renderUsage, UsageError, type ArgSpec } from "./args.ts";
import { loadLiveConfig, type LiveConfig, type LoadLiveConfigOptions } from "./config.ts";
import { KEY_ROLES, loadOrCreateKeys, publicAddresses, type KeyRole, type KeysFile } from "./keys.ts";
import { createLiveRpc } from "./rpc.ts";
import { liveGuardClient } from "./e2e.ts";
import { withNetworkTimeout } from "./timeout.ts";

export interface StatusBalance {
  role: KeyRole;
  address: string;
  balance: string;
}

export interface StatusSchedule {
  id: number;
  to: string;
  amount: string;
  amountRaw: string;
  nextRunUtc: string;
  nextRunLocal: string;
  runsLeft: number;
  intervalWords: string;
  active: boolean;
}

export interface StatusReport {
  network: LiveConfig["network"];
  rpcUrl: string;
  horizonUrl: string;
  guardContractId: string;
  asset: { code: string; issuer: string; sac: string };
  addresses: Record<KeyRole, string>;
  balances: StatusBalance[];
  rule: Rule | null;
  ruleDecoded: StatusRuleView | null;
  executor: string | null;
  aliasAda: string | null;
  spentToday: string;
  spentTodayRaw: string;
  allowance: string;
  allowanceRaw: string;
  schedules: StatusSchedule[];
  timeZone: string;
}

export interface StatusRuleView {
  auto_approve_limit: string;
  per_tx_limit: string;
  daily_limit: string;
  allowed_assets: string[];
  known_recipients_only: boolean;
}

const STATUS_SPEC: ArgSpec = {
  program: "e2e:status",
  description: "print a read-only snapshot of the TESTNET e2e environment",
  commands: {},
  globalFlags: {
    live: { type: "boolean", description: "perform the reads on Stellar testnet (default: print the plan only)" },
    json: { type: "boolean", description: "emit the snapshot as JSON" },
    tz: { type: "string", value: "<IANA>", description: "IANA zone for local next-run times (default: system zone)" },
  },
};

function plan(config: LiveConfig, timeZone: string): string {
  return [
    "e2e:status plan (no network; pass --live to read the chain)",
    `  network        ${config.network}`,
    `  rpc            ${config.rpcUrl}`,
    `  horizon        ${config.horizonUrl}`,
    `  guard contract ${config.guardContractId}`,
    `  keys file      ${config.keysPath}`,
    `  timezone       ${timeZone}`,
    "  reads          addresses, balances, get_rule, get_executor, get_alias(ada),",
    "                 spent_today, SAC allowance, list_schedules",
  ].join("\n");
}

function resolveTimeZone(requested: string | undefined): string {
  if (requested) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: requested });
      return requested;
    } catch {
      throw new UsageError(`--tz must be a valid IANA zone, got ${JSON.stringify(requested)}`);
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

async function balanceOf(
  horizon: Horizon.Server,
  address: string,
  code: string,
  issuer: string,
): Promise<string> {
  const account = await withNetworkTimeout(horizon.loadAccount(address), "horizon.loadAccount");
  const line = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === code && b.asset_issuer === issuer,
  );
  return line ? fromRawUnits(toRawUnits(line.balance)) : "0";
}

function scheduleRows(schedules: Schedule[], timeZone: string): StatusSchedule[] {
  return [...schedules]
    .sort((a, b) => (a.next_run_at === b.next_run_at ? a.id - b.id : a.next_run_at < b.next_run_at ? -1 : 1))
    .map((s) => ({
      id: s.id,
      to: s.to,
      amount: fromRawUnits(s.amount),
      amountRaw: s.amount.toString(),
      nextRunUtc: new Date(Number(s.next_run_at) * 1000).toISOString(),
      nextRunLocal: formatInZone(Number(s.next_run_at), timeZone),
      runsLeft: s.runs_left,
      intervalWords: intervalWords(Number(s.interval_secs)),
      active: s.active,
    }));
}

export interface GatherStatusDeps {
  config: LiveConfig;
  keys: KeysFile;
  server: StellarRpc.Server;
  horizon: Horizon.Server;
  timeZone: string;
}

/** Gather the full read-only snapshot (network reads, no writes, no signing). */
export async function gatherStatus(deps: GatherStatusDeps): Promise<StatusReport> {
  const { config, keys, server, horizon, timeZone } = deps;
  if (!keys.asset) throw new Error("no asset record in the keys file; run `e2e:setup --live` first");
  const owner = keys.keys.owner.public;
  const guard = liveGuardClient(config, server, owner);
  const rpc = createLiveRpc(server);
  const asset = keys.asset;
  const addresses = publicAddresses(keys);

  const balances = await Promise.all(
    KEY_ROLES.map(async (role): Promise<StatusBalance> => ({
      role,
      address: addresses[role],
      balance: await balanceOf(horizon, addresses[role], asset.code, asset.issuer),
    })),
  );

  const [rule, executor, aliasAda, spentToday, allowance, schedules] = await Promise.all([
    guard.getRule(owner),
    guard.getExecutor(owner),
    guard.getAlias(owner, "ada"),
    guard.spentToday(owner),
    getAllowance(rpc, {
      assetContractId: asset.sac,
      from: owner,
      spender: config.guardContractId,
      networkPassphrase: config.networkPassphrase,
    }),
    guard.listSchedules(owner),
  ]);

  return {
    network: config.network,
    rpcUrl: config.rpcUrl,
    horizonUrl: config.horizonUrl,
    guardContractId: config.guardContractId,
    asset,
    addresses,
    balances,
    rule,
    ruleDecoded: rule
      ? {
          auto_approve_limit: fromRawUnits(rule.auto_approve_limit),
          per_tx_limit: fromRawUnits(rule.per_tx_limit),
          daily_limit: fromRawUnits(rule.daily_limit),
          allowed_assets: [...rule.allowed_assets],
          known_recipients_only: rule.known_recipients_only,
        }
      : null,
    executor,
    aliasAda,
    spentToday: fromRawUnits(spentToday),
    spentTodayRaw: spentToday.toString(),
    allowance: fromRawUnits(allowance),
    allowanceRaw: allowance.toString(),
    schedules: scheduleRows(schedules, timeZone),
    timeZone,
  };
}

/** Machine-readable snapshot; raw bigints are rendered as decimal strings. */
export function statusJson(report: StatusReport): string {
  return `${JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}

/** Human-readable snapshot (public data only). */
export function renderStatus(report: StatusReport): string {
  const lines: string[] = [];
  lines.push(`e2e:status — Stellar TESTNET (${report.network})`);
  lines.push(`  guard contract ${report.guardContractId}`);
  lines.push(`  asset          ${report.asset.code}:${report.asset.issuer}`);
  lines.push(`  SAC            ${report.asset.sac}`);
  lines.push("");
  lines.push("Addresses:");
  for (const role of KEY_ROLES) lines.push(`  ${role.padEnd(10)} ${report.addresses[role]}`);
  lines.push("");
  lines.push(`Balances (${report.asset.code}):`);
  for (const row of report.balances) lines.push(`  ${row.role.padEnd(10)} ${row.balance}`);
  lines.push("");
  lines.push("Guard policy:");
  if (report.ruleDecoded) {
    lines.push(`  auto_approve_limit   ${report.ruleDecoded.auto_approve_limit}`);
    lines.push(`  per_tx_limit         ${report.ruleDecoded.per_tx_limit}`);
    lines.push(`  daily_limit          ${report.ruleDecoded.daily_limit}`);
    lines.push(`  allowed_assets       ${report.ruleDecoded.allowed_assets.join(", ")}`);
    lines.push(`  known_recipients_only ${report.ruleDecoded.known_recipients_only}`);
  } else {
    lines.push("  (no rule published)");
  }
  lines.push(`  executor             ${report.executor ?? "(none)"}`);
  lines.push(`  alias ada            ${report.aliasAda ?? "(not set)"}`);
  lines.push(`  spent_today          ${report.spentToday}`);
  lines.push(`  SAC allowance        ${report.allowance}`);
  lines.push("");
  lines.push(`Schedules (${report.schedules.length}) — local zone ${report.timeZone}:`);
  if (report.schedules.length === 0) {
    lines.push("  (none)");
  } else {
    for (const s of report.schedules) {
      lines.push(
        `  #${s.id} ${s.amount} ${report.asset.code} -> ${s.to} — ${s.intervalWords}, runs left ${s.runsLeft}` +
          `, active=${s.active}`,
      );
      lines.push(`      next run: ${s.nextRunLocal} (${report.timeZone}) / ${s.nextRunUtc} UTC`);
    }
  }
  return lines.join("\n");
}

export async function main(argv: readonly string[], overrides: LoadLiveConfigOptions = {}): Promise<number> {
  const parsed = parseCommandLine(argv, STATUS_SPEC);
  if (parsed.help) {
    process.stdout.write(`${renderUsage(STATUS_SPEC)}\n`);
    return 0;
  }

  const live = parsed.flags.live === true;
  const json = parsed.flags.json === true;
  let timeZone: string;
  try {
    timeZone = resolveTimeZone(typeof parsed.flags.tz === "string" ? parsed.flags.tz : undefined);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    throw e;
  }

  let config: LiveConfig;
  try {
    config = loadLiveConfig(overrides);
  } catch (e) {
    process.stderr.write(`e2e:status config error: ${(e as Error).message}\n`);
    return 1;
  }

  if (!live) {
    process.stdout.write(`${plan(config, timeZone)}\n`);
    return 0;
  }

  try {
    const keys = loadOrCreateKeys(config.keysPath);
    const server = new StellarRpc.Server(config.rpcUrl);
    const horizon = new Horizon.Server(config.horizonUrl);
    const report = await gatherStatus({ config, keys, server, horizon, timeZone });
    const text = json ? statusJson(report) : `${renderStatus(report)}\n`;
    process.stdout.write(text);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`${e.message}\n`);
      return 2;
    }
    process.stderr.write(`e2e:status failed: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`e2e:status failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
