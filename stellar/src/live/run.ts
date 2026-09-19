/**
 * `e2e:run` — the live testnet scenario suite (S0–S11).
 *
 *   npm run e2e:run -w @polaris/stellar -- --live
 *
 * Build with our production chain-lane tools, sign with the right throwaway
 * key, submit, wait, then verify on-chain with an independent read. Every
 * scenario records its tx hashes and verdict in the results JSON.
 *
 * TESTNET ONLY. No secrets are printed; the results file is public data only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Horizon, rpc as StellarRpc } from "@stellar/stellar-sdk";
import { toRawUnits } from "../guard/amount.ts";
import { isGuardClientError } from "../guard/errors.ts";
import { createSendPayment } from "../payments/sendPayment.ts";
import { cancelSchedule, isScheduleRefusal, listUpcoming, schedulePayment } from "../schedule/index.ts";
import * as approval from "../approval/index.ts";
import { loadLiveConfig, type LiveConfig, type LoadLiveConfigOptions } from "./config.ts";
import { readSac } from "./assets.ts";
import {
  assert,
  assertBigEqual,
  assertEqual,
  e2eAliasBook,
  e2eAssetRegistry,
  liveAllowanceReader,
  liveGuardClient,
  livePaymentDeps,
  liveScheduleDeps,
  Recorder,
  signAndSubmitClassic,
  signAndSubmitSoroban,
  txUrl,
  type LiveDepsInput,
  type TxEvidence,
} from "./e2e.ts";
import { createLiveRpc } from "./rpc.ts";
import { loadOrCreateKeys, publicAddresses, type KeysFile } from "./keys.ts";

const UNIT = 10_000_000n;
const allowanceRaw = 5_000n * UNIT;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Ctx {
  config: LiveConfig;
  keys: KeysFile;
  server: StellarRpc.Server;
  horizon: Horizon.Server;
  assetCode: string;
  assetIssuer: string;
  sac: string;
  /** Owner-sourced guard client. */
  guard: ReturnType<typeof liveGuardClient>;
  rpc: ReturnType<typeof createLiveRpc>;
}

const ownerSecret = (keys: KeysFile): string => keys.keys.owner.secret;
const ownerAddress = (keys: KeysFile): string => keys.keys.owner.public;
const executorAddress = (keys: KeysFile): string => keys.keys.executor.public;
const recipientAddress = (keys: KeysFile): string => keys.keys.recipient.public;

function firstRunUtc(at: Date): { localDate: string; localTime: string; timeZone: string } {
  const iso = at.toISOString();
  return { localDate: iso.slice(0, 10), localTime: iso.slice(11, 16), timeZone: "UTC" };
}

async function balanceOf(ctx: Ctx, address: string): Promise<string> {
  const account = await ctx.horizon.loadAccount(address);
  const line = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === ctx.assetCode && b.asset_issuer === ctx.assetIssuer,
  );
  return line ? line.balance : "0";
}

// ── keeper child process ─────────────────────────────────────────────────────

interface KeeperExec {
  id: number;
  hash: string;
  ledger: number;
}

function parseLogLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function waitExit(child: ChildProcess, ms: number): Promise<void> {
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    sleep(ms).then(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }),
  ]);
}

/**
 * Run the EXISTING keeper CLI in the foreground for a bounded time until it
 * executes `scheduleId`. The keeper is untrusted and needs no authority beyond
 * paying the network fee.
 */
async function runKeeperUntil(
  config: LiveConfig,
  keys: KeysFile,
  scheduleId: number,
  timeoutMs: number,
): Promise<KeeperExec> {
  const cliPath = fileURLToPath(new URL("../keeper/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KEEPER_SECRET: keys.keys.keeper.secret,
    GUARD_CONTRACT_ID: config.guardContractId,
    SOROBAN_RPC_URL: config.rpcUrl,
    NETWORK_PASSPHRASE: config.networkPassphrase,
    KEEPER_POLL_SECONDS: "5",
    KEEPER_MAX_PER_TICK: "5",
    KEEPER_TX_TIMEOUT_SECONDS: "30",
    KEEPER_LOG_LEVEL: "info",
  };

  const child = spawn(process.execPath, [cliPath], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const lines: string[] = [];
  const onData = (d: Buffer): void => {
    for (const line of String(d).split("\n")) if (line.trim()) lines.push(line.trim());
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);

  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      const executed = lines
        .map(parseLogLine)
        .find((entry) => entry?.event === "executed" && Number(entry.id) === scheduleId);
      if (executed) return { id: scheduleId, hash: String(executed.hash), ledger: Number(executed.ledger) };
      if (Date.now() > deadline) {
        throw new Error(
          `keeper did not execute schedule #${scheduleId} within ${timeoutMs} ms; last output:\n${lines.slice(-8).join("\n")}`,
        );
      }
      await sleep(3_000);
    }
  } finally {
    child.kill("SIGTERM");
    await waitExit(child, 5_000);
  }
}

// ── scenarios ────────────────────────────────────────────────────────────────

async function runScenarios(ctx: Ctx, rec: Recorder): Promise<void> {
  const { config, keys, server, horizon, guard, rpc } = ctx;
  const aliases = e2eAliasBook(recipientAddress(keys));
  const assets = e2eAssetRegistry(ctx.assetCode, ctx.assetIssuer);
  const baseInput: LiveDepsInput = {
    config,
    horizon,
    server,
    ownerAddress: ownerAddress(keys),
    aliases,
    assets,
    guard,
    guardAssetContracts: { [ctx.assetCode]: ctx.sac },
  };
  const owner = ownerAddress(keys);
  const recipient = recipientAddress(keys);
  const executor = executorAddress(keys);
  const allowanceReader = liveAllowanceReader(config, server, owner, config.guardContractId);

  // -- S0: setup verified ----------------------------------------------------
  await rec.run("S0", "setup verified (accounts, asset, SAC, owner balance)", async () => {
    const ownerAccount = await horizon.loadAccount(owner);
    assert(ownerAccount.accountId() === owner, "owner account exists");
    assertBigEqual(toRawUnits(await balanceOf(ctx, owner)), 10_000n * UNIT, "owner E2EUSD balance");
    const decimals = await readSac(server, {
      sac: ctx.sac,
      method: "decimals",
      args: [],
      source: owner,
      networkPassphrase: config.networkPassphrase,
    });
    assertEqual(Number(decimals), 7, "SAC decimals");
    return { detail: `owner balance 10000 ${ctx.assetCode}; SAC ${ctx.sac} decimals 7` };
  });

  // -- S1: baseline (Always ask) --------------------------------------------
  const baselineRule = {
    auto_approve_limit: 0n,
    per_tx_limit: 500n * UNIT,
    daily_limit: 2_000n * UNIT,
    allowed_assets: [ctx.sac],
    known_recipients_only: false,
  };
  await rec.run("S1", "baseline Always-ask setup (approve + set_rule)", async () => {
    const built = await approval.buildBaselineSetup(
      { owner, guard, rpc, networkPassphrase: config.networkPassphrase },
      { rule: baselineRule, allowanceRaw, allowanceDays: 30, assetContractId: ctx.sac },
    );
    const txs: TxEvidence[] = [];
    for (const step of built.steps) {
      txs.push(await signAndSubmitSoroban(config, server, step.unsignedXdr, ownerSecret(keys)));
    }
    const rule = await guard.getRule(owner);
    assert(rule !== null, "rule published");
    assertBigEqual(rule.auto_approve_limit, 0n, "auto_approve_limit");
    assertBigEqual(rule.per_tx_limit, 500n * UNIT, "per_tx_limit");
    assertBigEqual(rule.daily_limit, 2_000n * UNIT, "daily_limit");
    assertEqual(rule.known_recipients_only, false, "known_recipients_only");
    assertBigEqual(await allowanceReader(ctx.sac), allowanceRaw, "SAC allowance");
    assertEqual(await guard.getExecutor(owner), null, "no executor");
    return { detail: "rule + allowance on-chain; no executor", txs };
  });

  // -- S2: alias -------------------------------------------------------------
  await rec.run("S2", 'setAlias("ada", recipient)', async () => {
    const call = await guard.setAlias(owner, "ada", recipient);
    const tx = await signAndSubmitSoroban(config, server, call.unsignedXdr, ownerSecret(keys));
    assertEqual(await guard.getAlias(owner, "ada"), recipient, "getAlias");
    assertEqual(await guard.isKnownRecipient(owner, recipient), true, "isKnownRecipient");
    return { detail: "alias ada -> recipient", txs: [tx] };
  });

  // -- S3: direct payment ----------------------------------------------------
  await rec.run("S3", "direct payment 25 E2EUSD via alias", async () => {
    const tool = createSendPayment(livePaymentDeps(baseInput, "direct"));
    const before = toRawUnits(await balanceOf(ctx, recipient));
    const { unsignedXdr } = await tool({ kind: "send", asset: "USDC", amount: "25", recipient: "ada" });
    const tx = await signAndSubmitClassic(config, horizon, unsignedXdr, ownerSecret(keys));
    const after = toRawUnits(await balanceOf(ctx, recipient));
    assertBigEqual(after - before, 25n * UNIT, "recipient delta");
    return { detail: "recipient +25 E2EUSD (classic)", txs: [tx] };
  });

  // -- S4: guarded pay_owner (default profile) -------------------------------
  await rec.run("S4", "guarded sendPayment default profile -> pay_owner 40", async () => {
    const tool = createSendPayment(livePaymentDeps(baseInput, "guarded"));
    const before = toRawUnits(await balanceOf(ctx, recipient));
    const { unsignedXdr, summary } = await tool({ kind: "send", asset: "USDC", amount: "40", recipient: "ada" });
    assert(summary.title.includes("pay_owner"), `route is pay_owner (${summary.title})`);
    assert(summary.lines.some((l) => l.includes("Approval card required: yes")), "card required");
    const tx = await signAndSubmitSoroban(config, server, unsignedXdr, ownerSecret(keys));
    const after = toRawUnits(await balanceOf(ctx, recipient));
    assertBigEqual(after - before, 40n * UNIT, "recipient delta");
    assertBigEqual(await guard.spentToday(owner), 40n * UNIT, "spent_today");
    return { detail: "recipient +40; spent_today = 40", txs: [tx] };
  });

  // -- S5: on-chain limit rejection -----------------------------------------
  // The client simulates before signing (by design), so an over-limit call is
  // rejected by the chain at simulation with no transaction and no balance
  // change. A submitted failure cannot be produced from a valid assembled call
  // because the Soroban authorized invocation binds the arguments (patching the
  // amount invalidates the auth), so this is the honest evidence.
  await rec.run("S5", "over per_tx_limit rejected on-chain (#103)", async () => {
    const before = toRawUnits(await balanceOf(ctx, recipient));
    let name = "";
    let code: number | undefined;
    try {
      await guard.payOwner(owner, recipient, ctx.sac, 600n * UNIT);
    } catch (e) {
      assert(isGuardClientError(e), "payOwner over limit throws a typed guard error");
      name = e.name;
      code = e.code;
    }
    assertEqual(name, "OverPerTxLimit", "on-chain rejection name");
    assertEqual(code, 103, "on-chain rejection code");
    const after = toRawUnits(await balanceOf(ctx, recipient));
    assertBigEqual(after, before, "no balance change");
    return { detail: "contract rejected #103 OverPerTxLimit at simulation; no tx, no balance change" };
  });

  // -- S6: enable auto-pay ---------------------------------------------------
  await rec.run("S6", "enable auto-pay (approve -> set_rule -> set_executor)", async () => {
    const currentRule = await guard.getRule(owner);
    const draft = approval.makeAutoPayDraft({
      executor,
      threshold: "100",
      perTxLimit: "500",
      dailyLimit: "2000",
      allowedAssets: [ctx.sac],
      knownRecipientsOnly: false,
      allowance: "5000",
      allowanceDays: 30,
    });
    const built = await approval.buildEnableAutoPay(
      {
        owner,
        guard,
        rpc,
        networkPassphrase: config.networkPassphrase,
        current: currentRule ? { rule: currentRule } : {},
      },
      draft,
    );
    const txs: TxEvidence[] = [];
    for (const step of built.steps) {
      txs.push(await signAndSubmitSoroban(config, server, step.unsignedXdr, ownerSecret(keys)));
    }
    const profile = approval.profileFromChain(await guard.getRule(owner), await guard.getExecutor(owner));
    assertEqual(profile.mode, "auto_under_limit", "chain profile");
    return { detail: "executor registered; profile auto_under_limit", txs };
  });

  // -- S7: auto-pay path -----------------------------------------------------
  await rec.run("S7", "auto-pay route (executor 30; owner 150; raw 150 rejected)", async () => {
    const tool = createSendPayment(
      livePaymentDeps({ ...baseInput, approvalProfile: { mode: "auto_under_limit" } }, "guarded"),
    );
    const txs: TxEvidence[] = [];
    const before = toRawUnits(await balanceOf(ctx, recipient));

    const small = await tool({ kind: "send", asset: "USDC", amount: "30", recipient: "ada" });
    assert(small.summary.title.includes("pay_executor"), `route is pay_executor (${small.summary.title})`);
    txs.push(await signAndSubmitSoroban(config, server, small.unsignedXdr, keys.keys.executor.secret));

    const big = await tool({ kind: "send", asset: "USDC", amount: "150", recipient: "ada" });
    assert(big.summary.title.includes("pay_owner"), `route is pay_owner (${big.summary.title})`);
    txs.push(await signAndSubmitSoroban(config, server, big.unsignedXdr, ownerSecret(keys)));

    assertBigEqual(
      toRawUnits(await balanceOf(ctx, recipient)) - before,
      180n * UNIT,
      "recipient delta (30 + 150)",
    );

    let rawName = "";
    try {
      await guard.payExecutor(executor, owner, recipient, ctx.sac, 150n * UNIT);
    } catch (e) {
      assert(isGuardClientError(e), "raw payExecutor throws a typed guard error");
      rawName = e.name;
    }
    assertEqual(rawName, "NeedsOwnerApproval", "raw payExecutor rejection");
    return { detail: "executor 30 settled, owner 150 settled, raw 150 rejected #105", txs };
  });

  // -- S8: schedule + keeper -------------------------------------------------
  await rec.run("S8", "one-shot schedule fires via keeper (delay measured)", async () => {
    const schedDeps = liveScheduleDeps(baseInput);
    const firstRun = firstRunUtc(new Date(Date.now() + 100_000));
    const built = await schedulePayment(schedDeps)({ recipient: "ada", asset: "USDC", amount: "20", firstRun, runs: 1 });
    const tx = await signAndSubmitSoroban(config, server, built.unsignedXdr, ownerSecret(keys));
    const created = (await guard.listSchedules(owner)).find(
      (s) => s.to === recipient && s.amount === 20n * UNIT && s.active,
    );
    assert(created !== undefined, "schedule visible and active");
    const scheduleId = created.id;
    const firstRunAt = Number(created.next_run_at);

    const before = toRawUnits(await balanceOf(ctx, recipient));
    const executed = await runKeeperUntil(config, keys, scheduleId, 180_000);
    const onChain = await server.getTransaction(executed.hash);
    const closeTime = "createdAt" in onChain ? Number(onChain.createdAt) : 0;
    const measuredDelaySeconds = closeTime > 0 ? closeTime - firstRunAt : -1;
    assert(measuredDelaySeconds >= 0 && measuredDelaySeconds <= 180, `delay within bounds (${measuredDelaySeconds}s)`);

    const after = toRawUnits(await balanceOf(ctx, recipient));
    assertBigEqual(after - before, 20n * UNIT, "recipient delta via schedule");
    const schedule = await guard.getSchedule(scheduleId);
    assert(schedule !== null && schedule.active === false, "schedule inactive after run");
    return {
      detail: `schedule #${scheduleId} executed; delay ${measuredDelaySeconds}s`,
      txs: [
        tx,
        { hash: executed.hash, ledger: executed.ledger, status: "SUCCESS", summary: "keeper executed", url: txUrl(executed.hash) },
      ],
    };
  });

  // -- S9: cancel ------------------------------------------------------------
  await rec.run("S9", "cancel a far-future schedule (keeper never runs it)", async () => {
    const schedDeps = liveScheduleDeps(baseInput);
    const firstRun = firstRunUtc(new Date(Date.now() + 3_600_000));
    const built = await schedulePayment(schedDeps)({ recipient: "ada", asset: "USDC", amount: "5", firstRun, runs: 1 });
    const createTx = await signAndSubmitSoroban(config, server, built.unsignedXdr, ownerSecret(keys));
    const created = (await guard.listSchedules(owner)).find(
      (s) => s.to === recipient && s.amount === 5n * UNIT && s.active,
    );
    assert(created !== undefined, "far-future schedule created");
    const id = created.id;
    const upcoming = await listUpcoming(schedDeps)({ timeZone: "UTC" });
    assert(upcoming.some((u) => u.id === id && u.status === "scheduled"), "listUpcoming shows it scheduled");

    const cancel = await cancelSchedule(schedDeps)({ recipient: "ada" });
    assertEqual(cancel.id, id, "cancel resolved by recipient");
    const cancelTx = await signAndSubmitSoroban(config, server, cancel.unsignedXdr, ownerSecret(keys));
    const after = await guard.getSchedule(id);
    assert(after !== null && after.active === false, "schedule inactive after cancel");
    assert(Number(after.next_run_at) > Date.now() / 1000 + 3_000, "next run far in the future (keeper skips)");
    return { detail: `schedule #${id} created and cancelled`, txs: [createTx, cancelTx] };
  });

  // -- S10: disable + tighten ------------------------------------------------
  await rec.run("S10", "disable executor (#107) and tighten per_tx (#103)", async () => {
    const txs: TxEvidence[] = [];
    const disable = await approval.buildDisableAutoPay(
      { owner, guard, rpc, networkPassphrase: config.networkPassphrase },
      { revokeAllowance: false },
    );
    for (const step of disable.steps) {
      txs.push(await signAndSubmitSoroban(config, server, step.unsignedXdr, ownerSecret(keys)));
    }
    let noExecName = "";
    try {
      await guard.payExecutor(executor, owner, recipient, ctx.sac, 10n * UNIT);
    } catch (e) {
      assert(isGuardClientError(e), "payExecutor after revoke throws a typed guard error");
      noExecName = e.name;
    }
    assertEqual(noExecName, "NoExecutor", "payExecutor rejection after disable");

    const currentRule = await guard.getRule(owner);
    const nextRule = {
      auto_approve_limit: 0n,
      per_tx_limit: 100n * UNIT,
      daily_limit: 2_000n * UNIT,
      allowed_assets: [ctx.sac],
      known_recipients_only: false,
    };
    const tighten = await approval.buildTightenRule({ owner, guard, current: currentRule ?? undefined }, nextRule);
    assertEqual(tighten.classification, "tightening", "classification");
    assert(tighten.steps.length === 1, "one set_rule step");
    txs.push(await signAndSubmitSoroban(config, server, tighten.steps[0]!.unsignedXdr, ownerSecret(keys)));
    const onChain = await guard.getRule(owner);
    assert(onChain !== null, "rule still on chain");
    assertBigEqual(onChain.per_tx_limit, 100n * UNIT, "per_tx_limit after tighten");

    let overName = "";
    try {
      await guard.payOwner(owner, recipient, ctx.sac, 200n * UNIT);
    } catch (e) {
      assert(isGuardClientError(e), "over-tightened payOwner throws a typed guard error");
      overName = e.name;
    }
    assertEqual(overName, "OverPerTxLimit", "over new per_tx rejection");
    return { detail: "executor revoked (#107); rule tightened; 200 rejected (#103)", txs };
  });

  // -- S11: allowance boundary ----------------------------------------------
  await rec.run("S11", "schedule refused when allowance < amount*runs", async () => {
    const schedDeps = liveScheduleDeps(baseInput);
    const firstRun = firstRunUtc(new Date(Date.now() + 200_000));
    let code = "";
    try {
      await schedulePayment(schedDeps)({
        recipient: "ada",
        asset: "USDC",
        amount: "100",
        firstRun,
        repeat: { every: "custom", customSeconds: 86_400 },
        runs: 60,
      });
    } catch (e) {
      assert(isScheduleRefusal(e), "allowance boundary throws a typed schedule refusal");
      code = e.code;
    }
    assertEqual(code, "allowance_insufficient", "allowance refusal code");
    return { detail: "100 x 60 = 6000 > allowance 5000 -> allowance_insufficient" };
  });
}

// ── entry point ──────────────────────────────────────────────────────────────

function runPlan(config: LiveConfig): string {
  return [
    "e2e:run plan (no network; pass --live to execute)",
    `  network        ${config.network}`,
    `  rpc            ${config.rpcUrl}`,
    `  horizon        ${config.horizonUrl}`,
    `  guard contract ${config.guardContractId}`,
    `  keys file      ${config.keysPath}`,
    "  scenarios      S0 setup, S1 baseline, S2 alias, S3 direct, S4 pay_owner,",
    "                 S5 over-limit, S6 enable auto-pay, S7 auto route, S8 schedule,",
    "                 S9 cancel, S10 disable+tighten, S11 allowance boundary",
    "",
    "  NOT idempotent: the scenario assertions assume the fresh S0 baseline",
    "  (empty rule/executor, untouched balances). A second `e2e:run --live`",
    "  without a fresh `e2e:setup --reset --live` will fail mid-way by design.",
  ].join("\n");
}

export async function main(argv: readonly string[], overrides: LoadLiveConfigOptions = {}): Promise<number> {
  const live = argv.includes("--live");
  let config: LiveConfig;
  try {
    config = loadLiveConfig({ argv, ...overrides });
  } catch (e) {
    process.stderr.write(`e2e:run config error: ${(e as Error).message}\n`);
    return 1;
  }
  if (!live) {
    process.stdout.write(`${runPlan(config)}\n`);
    return 0;
  }

  const keys = loadOrCreateKeys(config.keysPath);
  if (!keys.asset) {
    process.stderr.write("e2e:run: no asset record in the keys file; run `e2e:setup --live` first\n");
    return 1;
  }
  const server = new StellarRpc.Server(config.rpcUrl);
  const horizon = new Horizon.Server(config.horizonUrl);
  const rpc = createLiveRpc(server);
  const guard = liveGuardClient(config, server, ownerAddress(keys));
  const ctx: Ctx = {
    config,
    keys,
    server,
    horizon,
    assetCode: keys.asset.code,
    assetIssuer: keys.asset.issuer,
    sac: keys.asset.sac,
    guard,
    rpc,
  };

  process.stdout.write(
    [
      "e2e:run against Stellar TESTNET",
      `  guard   ${config.guardContractId}`,
      `  asset   ${keys.asset.code}:${keys.asset.issuer} (SAC ${keys.asset.sac})`,
      `  owner   ${publicAddresses(keys).owner}`,
      `  exec    ${publicAddresses(keys).executor}`,
      `  recip   ${publicAddresses(keys).recipient}`,
      `  keeper  ${publicAddresses(keys).keeper}`,
      "",
    ].join("\n"),
  );

  const rec = new Recorder();
  const started = Date.now();
  await runScenarios(ctx, rec);
  const elapsedSeconds = Math.round((Date.now() - started) / 1000);

  const resultsPath = rec.write(config.resultsDir, {
    network: config.network,
    guardContractId: config.guardContractId,
    asset: keys.asset,
    addresses: publicAddresses(keys),
    elapsedSeconds,
  });

  const results = rec.all();
  const passed = results.filter((r) => r.status === "pass").length;
  process.stdout.write(`\nresults: ${passed}/${results.length} scenarios passed in ${elapsedSeconds}s\n`);
  process.stdout.write(`results file: ${resultsPath}\n`);
  for (const r of results) {
    const extra = r.status === "pass" ? r.detail : `ERROR: ${r.error}`;
    process.stdout.write(`  ${r.status === "pass" ? "PASS" : "FAIL"} ${r.id} ${r.name} — ${extra}\n`);
  }
  return passed === results.length ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`e2e:run failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
