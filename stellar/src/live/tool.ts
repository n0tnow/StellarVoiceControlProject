/**
 * `e2e:tool` — the manual-testing tool for the chain lane (TESTNET ONLY).
 *
 *   npm run e2e:tool -w @polaris/stellar -- --live <command> [options]
 *
 * Every state-changing command follows the same safe pipeline:
 *
 *   BUILD with the production tools (the exact chain-lane code the app uses)
 *     -> decode the approval CARD from the produced XDR (never from the flags)
 *     -> require an explicit confirmation (`y/N`, default NO; `--yes` for scripts)
 *     -> sign the EXACT displayed XDR with the correct throwaway key
 *     -> submit, wait, print the hash + explorer link + a read-back verification.
 *
 * Safety: testnet only (enforced by `config.ts`), throwaway keys only
 * (`~/.polaris-e2e/keys.json`), secrets are never printed, nothing is signed
 * that the card did not show. Without `--live` it prints a plan and touches no
 * network.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Horizon, StrKey, Transaction, TransactionBuilder, rpc as StellarRpc } from "@stellar/stellar-sdk";
import type { AssetRegistry } from "../payments/assets.ts";
import { parseAliasBook, resolveAlias, type AliasBook } from "../payments/aliases.ts";
import { createSendPayment, type PaymentDeps, type PaymentRoute } from "../payments/sendPayment.ts";
import { payloadHashOf } from "../payments/summary.ts";
import { schedulePayment, cancelSchedule, listUpcoming } from "../schedule/index.ts";
import type { ScheduleDeps } from "../schedule/types.ts";
import * as approval from "../approval/index.ts";
import { profileFromChain, type ApprovalProfile } from "../approval/index.ts";
import { fromRawUnits, toRawUnits } from "../guard/amount.ts";
import { getAllowance } from "../guard/allowance.ts";
import { decodeInvocation, shortKey } from "../guard/describe.ts";
import type { GuardClient, GuardRpcLike, Rule } from "../guard/types.ts";
import { formatInZone } from "../schedule/time.ts";
import {
  optionalInt,
  optionalString,
  parseCommandLine,
  renderUsage,
  requireInt,
  requireString,
  UsageError,
  type ArgSpec,
} from "./args.ts";
import { interactiveConfirm } from "./confirm.ts";
import { loadLiveConfig, type LiveConfig, type LoadLiveConfigOptions } from "./config.ts";
import { e2eAssetRegistry, txUrl, liveGuardClient, EXPLORER_BASE } from "./e2e.ts";
import { loadOrCreateKeys, type KeyRole, type KeysFile } from "./keys.ts";
import { createLiveRpc } from "./rpc.ts";
import { signEnvelope } from "./signer.ts";
import { setSequence, submitClassic, submitSoroban, type SubmitResult } from "./submit.ts";
import { Deadline, DEFAULT_OPERATION_TIMEOUT_MS, withNetworkTimeout } from "./timeout.ts";

// ── shared types ─────────────────────────────────────────────────────────────

export type SignerRole = Extract<KeyRole, "owner" | "executor">;

export interface ToolIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Print the card and ask; `true` only for the exact lowercase `y`/`yes`. */
  confirm(card: string): Promise<boolean>;
}

export interface PlanStep {
  kind: string;
  role: SignerRole;
  signerAddress: string;
  classic: boolean;
  arming: boolean;
  /** The FINAL, resequenced XDR shown on the card and then signed verbatim. */
  unsignedXdr: string;
  title: string;
  lines: string[];
  warnings: string[];
  payloadHash: string;
  explorerUrl: string;
}

export interface Plan {
  command: string;
  title: string;
  route?: string;
  steps: PlanStep[];
  notes: string[];
  verify: () => Promise<string>;
}

/** Raw (pre-resequence) step produced by a command builder. */
interface RawStep {
  kind: string;
  role: SignerRole;
  classic?: boolean;
  arming?: boolean;
  unsignedXdr: string;
  title: string;
  lines: string[];
  warnings?: string[];
}

export interface ToolChain {
  config: LiveConfig;
  keys: KeysFile;
  server: StellarRpc.Server;
  horizon: Horizon.Server;
  guard: GuardClient;
  rpc: GuardRpcLike;
  sac: string;
  assetCode: string;
  assetIssuer: string;
  aliases: AliasBook;
  assets: AssetRegistry;
}

export interface KeeperRunOptions {
  mode: "once" | "watch";
  seconds?: number;
}

export interface ToolDeps {
  io: ToolIO;
  /** Overrides forwarded to `loadLiveConfig` (tests). */
  config?: LoadLiveConfigOptions;
  /** Build the live chain; tests inject a fake so no network is touched. */
  createChain?: (config: LiveConfig, keys: KeysFile) => ToolChain;
  /** Build the command plan; tests inject a synthetic plan (no network). */
  buildPlan?: (command: string, chain: ToolChain, flags: Record<string, string | boolean>, deadline: Deadline) => Promise<Plan | null>;
  /** Run the keeper child; tests inject a fake. */
  runKeeper?: (chain: ToolChain, options: KeeperRunOptions, io: ToolIO) => Promise<number>;
  /** Injected clock for the operation deadline. */
  now?: () => number;
}

// ── argument spec ────────────────────────────────────────────────────────────

const TOOL_SPEC: ArgSpec = {
  program: "e2e:tool",
  description: "manual-test the TESTNET chain lane with an explicit approval step",
  globalFlags: {
    live: { type: "boolean", description: "build, show the card, confirm, sign and submit on testnet" },
    yes: {
      type: "boolean",
      description: "skip the strict lowercase y/yes prompt and approve (for scripted runs)",
    },
  },
  commands: {
    pay: {
      name: "pay",
      summary: "send E2EUSD to an alias (direct or guarded)",
      usage: "pay --to <alias> --amount <n> [--route direct|guarded] [--profile always_ask|auto_under_limit]",
      flags: {
        to: { type: "string", value: "<alias>", description: "recipient alias (e.g. ada)" },
        amount: { type: "string", value: "<n>", description: "decimal token amount" },
        route: { type: "string", value: "<direct|guarded>", description: "direct classic payment or guarded (default guarded)" },
        profile: {
          type: "string",
          value: "<always_ask|auto_under_limit>",
          description: "app-side approval profile (default always_ask)",
        },
      },
    },
    schedule: {
      name: "schedule",
      summary: "create a one-shot or repeating schedule through the guard",
      usage: "schedule --to <alias> --amount <n> --date YYYY-MM-DD --time HH:mm --tz <IANA> [--every day|week --runs <n>]",
      flags: {
        to: { type: "string", value: "<alias>", description: "recipient alias" },
        amount: { type: "string", value: "<n>", description: "amount per run" },
        date: { type: "string", value: "<YYYY-MM-DD>", description: "first run local date" },
        time: { type: "string", value: "<HH:mm>", description: "first run local time (24h)" },
        tz: { type: "string", value: "<IANA>", description: "IANA timezone for the first run" },
        every: { type: "string", value: "<day|week>", description: "repeat interval (omit for one-shot)" },
        runs: { type: "string", value: "<n>", description: "number of runs (with --every)" },
      },
    },
    cancel: {
      name: "cancel",
      summary: "cancel an active schedule by id or recipient alias",
      usage: "cancel (--id <n> | --to <alias>)",
      flags: {
        id: { type: "string", value: "<n>", description: "schedule id" },
        to: { type: "string", value: "<alias>", description: "cancel the schedule paying this alias" },
      },
    },
    list: {
      name: "list",
      summary: "list the owner's active (upcoming) schedules",
      usage: "list [--tz <IANA>]",
      flags: {
        tz: { type: "string", value: "<IANA>", description: "local zone for next-run times (default system zone)" },
      },
    },
    "alias-add": {
      name: "alias-add",
      summary: "add/update an address in the on-chain alias book",
      usage: "alias-add --name <name> --address <G...>",
      flags: {
        name: { type: "string", value: "<name>", description: "lowercase alias name" },
        address: { type: "string", value: "<G...>", description: "valid Stellar account address" },
      },
    },
    "alias-remove": {
      name: "alias-remove",
      summary: "remove an alias from the on-chain alias book",
      usage: "alias-remove --name <name>",
      flags: { name: { type: "string", value: "<name>", description: "alias name to remove" } },
    },
    "enable-auto": {
      name: "enable-auto",
      summary: "enable automatic payments (approve + set_rule + set_executor, one card)",
      usage: "enable-auto --threshold <n> --daily <n> [--per-tx <n>] [--days <n>]",
      flags: {
        threshold: { type: "string", value: "<n>", description: "auto-approve threshold (max unattended payment)" },
        daily: { type: "string", value: "<n>", description: "daily limit" },
        "per-tx": { type: "string", value: "<n>", description: "per-transaction limit (default: daily)" },
        days: { type: "string", value: "<n>", description: "SAC allowance lifetime in days (default 30)" },
      },
    },
    "disable-auto": {
      name: "disable-auto",
      summary: "revoke the executor (and optionally the allowance)",
      usage: "disable-auto [--revoke-allowance]",
      flags: {
        "revoke-allowance": { type: "boolean", description: "also approve 0 on the SAC (kill switch)" },
      },
    },
    rule: {
      name: "rule",
      summary: "show the owner's on-chain rule, executor and allowance",
      usage: "rule",
      flags: {},
    },
    tighten: {
      name: "tighten",
      summary: "lower the owner's limits (refuses loosening unless --allow-loosening)",
      usage: "tighten --per-tx <n> [--daily <n>] [--threshold <n>] [--allow-loosening]",
      flags: {
        "per-tx": { type: "string", value: "<n>", description: "new per-transaction limit" },
        daily: { type: "string", value: "<n>", description: "new daily limit" },
        threshold: { type: "string", value: "<n>", description: "new auto-approve threshold" },
        "allow-loosening": { type: "boolean", description: "allow a loosening change (needs the full card anyway)" },
      },
    },
    "keeper-once": {
      name: "keeper-once",
      summary: "run the existing keeper CLI for one tick",
      usage: "keeper-once",
      flags: {},
    },
    "keeper-watch": {
      name: "keeper-watch",
      summary: "run the existing keeper CLI in the foreground (max 300 s)",
      usage: "keeper-watch --seconds <n>",
      flags: { seconds: { type: "string", value: "<n>", description: "foreground run time in seconds (max 300)" } },
    },
  },
};

// ── chain wiring ─────────────────────────────────────────────────────────────

function aliasStorePath(config: LiveConfig): string {
  return join(dirname(config.keysPath), "aliases.json");
}

/** Seed with `ada`; merge any aliases the tester previously added via the tool. */
export function loadToolAliases(config: LiveConfig, recipient: string): AliasBook {
  const book: AliasBook = { ada: { address: recipient, network: "testnet" } };
  const path = aliasStorePath(config);
  if (existsSync(path)) {
    try {
      const parsed = parseAliasBook(readFileSync(path, "utf8"));
      for (const [name, entry] of Object.entries(parsed.book)) book[name] = entry;
    } catch {
      // A malformed optional store must not stop the tool; `ada` still works.
    }
  }
  return book;
}

function saveToolAliases(config: LiveConfig, book: AliasBook): void {
  const path = aliasStorePath(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(book, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function createToolChain(config: LiveConfig, keys: KeysFile): ToolChain {
  if (!keys.asset) throw new Error("no asset record in the keys file; run `e2e:setup --live` first");
  const server = new StellarRpc.Server(config.rpcUrl);
  const horizon = new Horizon.Server(config.horizonUrl);
  const owner = keys.keys.owner.public;
  return {
    config,
    keys,
    server,
    horizon,
    guard: liveGuardClient(config, server, owner),
    rpc: createLiveRpc(server),
    sac: keys.asset.sac,
    assetCode: keys.asset.code,
    assetIssuer: keys.asset.issuer,
    aliases: loadToolAliases(config, keys.keys.recipient.public),
    assets: e2eAssetRegistry(keys.asset.code, keys.asset.issuer),
  };
}

function scheduleDeps(chain: ToolChain, owner: string): ScheduleDeps {
  return {
    ownerAddress: owner,
    aliases: chain.aliases,
    guard: chain.guard,
    assets: chain.assets,
    guardAssetContracts: { [chain.assetCode]: chain.sac },
    networkPassphrase: chain.config.networkPassphrase,
    explorerBase: EXPLORER_BASE,
    getAllowance: (assetContractId) =>
      getAllowance(chain.rpc, {
        assetContractId,
        from: owner,
        spender: chain.config.guardContractId,
        networkPassphrase: chain.config.networkPassphrase,
      }),
  };
}

async function readBalance(chain: ToolChain, address: string): Promise<bigint> {
  const account = await withNetworkTimeout(chain.horizon.loadAccount(address), "horizon.loadAccount");
  const line = account.balances.find(
    (b) => "asset_code" in b && b.asset_code === chain.assetCode && b.asset_issuer === chain.assetIssuer,
  );
  return line ? toRawUnits(line.balance) : 0n;
}

// ── card rendering (pure; the proof is decoded from the XDR) ─────────────────

function describeArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return `[${value.map(describeArg).join(", ")}]`;
  if (value === null || value === undefined) return String(value);
  if (typeof value === "object") {
    return `{ ${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${describeArg(v)}`)
      .join(", ")} }`;
  }
  return String(value);
}

/** Best-effort decoded proof line for a step (contract call or classic payment). */
export function decodedProofLine(step: PlanStep, networkPassphrase: string): string | null {
  if (step.classic) {
    const tx = TransactionBuilder.fromXDR(step.unsignedXdr, networkPassphrase);
    if (!(tx instanceof Transaction)) return null;
    const op = tx.operations[0];
    if (!op || op.type !== "payment") return null;
    const code = op.asset.isNative() ? "XLM" : op.asset.code;
    return `XDR: payment ${op.amount} ${code} -> ${op.destination}`;
  }
  const decoded = decodeInvocation(step.unsignedXdr, networkPassphrase);
  return `XDR: ${decoded.functionName}(${decoded.args.map(describeArg).join(", ")}) @ ${shortKey(decoded.contractId)}`;
}

/** Render the decoded approval card. Pure — no network, no flags. */
export function renderCard(plan: Plan, networkPassphrase: string): string {
  const lines: string[] = [];
  lines.push("┌─ APPROVAL CARD ─────────────────────────────");
  lines.push(`│ ${plan.title}`);
  lines.push(`│ Command: e2e:tool ${plan.command}`);
  if (plan.route) lines.push(`│ Route: ${plan.route}`);
  plan.steps.forEach((step, index) => {
    lines.push("│");
    lines.push(`│ Step ${index + 1}/${plan.steps.length}: ${step.kind}${step.arming ? "  [ARMING]" : ""}`);
    if (step.title && step.title !== plan.title) lines.push(`│   ${step.title}`);
    for (const line of step.lines) lines.push(`│   ${line}`);
    const proof = decodedProofLine(step, networkPassphrase);
    if (proof) lines.push(`│   ${proof}`);
    lines.push(`│   Signer: ${step.role} (${step.signerAddress})`);
    lines.push(`│   Payload hash: ${step.payloadHash}`);
    lines.push(`│   Explorer: ${step.explorerUrl}`);
    for (const warning of step.warnings) lines.push(`│   WARNING: ${warning}`);
  });
  for (const note of plan.notes) lines.push(`│ Note: ${note}`);
  lines.push("└─────────────────────────────────────────────");
  lines.push(`This will submit ${plan.steps.length} transaction(s) to Stellar TESTNET.`);
  return lines.join("\n");
}

// ── build -> resequence -> card -> sign -> submit ────────────────────────────

async function finalize(chain: ToolChain, raw: RawStep[], deadline: Deadline): Promise<PlanStep[]> {
  const roles = [...new Set(raw.map((s) => s.role))];
  const base = new Map<SignerRole, bigint>();
  for (const role of roles) {
    deadline.check();
    const account = await withNetworkTimeout(
      chain.server.getAccount(chain.keys.keys[role].public),
      "getAccount",
    );
    base.set(role, BigInt(account.sequenceNumber()));
  }
  const counters = new Map<SignerRole, number>();
  return raw.map((step) => {
    const n = (counters.get(step.role) ?? 0) + 1;
    counters.set(step.role, n);
    const sequence = (base.get(step.role) as bigint) + BigInt(n);
    const unsignedXdr = setSequence(step.unsignedXdr, chain.config.networkPassphrase, sequence);
    const payloadHash = payloadHashOf(unsignedXdr, chain.config.networkPassphrase);
    return {
      kind: step.kind,
      role: step.role,
      signerAddress: chain.keys.keys[step.role].public,
      classic: step.classic ?? false,
      arming: step.arming ?? false,
      unsignedXdr,
      title: step.title,
      lines: step.lines,
      warnings: step.warnings ?? [],
      payloadHash,
      explorerUrl: `${EXPLORER_BASE}/tx/${payloadHash}`,
    };
  });
}

/** Sign the exact displayed XDR and verify the signed hash equals the card's. */
function signExact(step: PlanStep, secret: string, networkPassphrase: string): string {
  const signed = signEnvelope(step.unsignedXdr, secret, networkPassphrase);
  const signedHash = payloadHashOf(signed, networkPassphrase);
  if (signedHash !== step.payloadHash) {
    throw new Error(
      `refusing to submit: signed hash ${signedHash} does not equal the displayed payload hash ${step.payloadHash}`,
    );
  }
  return signed;
}

function formatSubmit(index: number, total: number, step: PlanStep, res: SubmitResult): string {
  const head = `[${res.status}] step ${index + 1}/${total} ${step.kind}: ${res.hash}${res.ledger ? ` (ledger ${res.ledger})` : ""}`;
  const link = `  ${txUrl(res.hash)}`;
  if (res.status === "SUCCESS") return `${head}\n${link}`;
  const reason = res.error?.message ?? res.resultXdrSummary;
  return `${head}\n${link}\n  reason: ${res.resultXdrSummary} — ${reason}`;
}

async function executePlan(
  plan: Plan,
  chain: ToolChain,
  io: ToolIO,
  yes: boolean,
  deadline: Deadline,
): Promise<number> {
  const card = renderCard(plan, chain.config.networkPassphrase);
  if (yes) {
    io.stdout(card);
  } else {
    const approved = await io.confirm(card);
    if (!approved) {
      io.stdout("aborted: nothing was signed or submitted.");
      return 0;
    }
  }
  for (let index = 0; index < plan.steps.length; index += 1) {
    const step = plan.steps[index] as PlanStep;
    deadline.check();
    const signed = signExact(step, chain.keys.keys[step.role].secret, chain.config.networkPassphrase);
    let res: SubmitResult;
    if (step.classic) {
      res = await submitClassic(chain.horizon, signed, {
        networkPassphrase: chain.config.networkPassphrase,
        operationTimeoutMs: deadline.remainingMs,
      });
    } else {
      res = await submitSoroban(chain.server, signed, {
        networkPassphrase: chain.config.networkPassphrase,
        waitMs: deadline.clamp(60_000),
        operationTimeoutMs: deadline.remainingMs,
      });
    }
    io.stdout(formatSubmit(index, plan.steps.length, step, res));
    if (res.status !== "SUCCESS") return 1;
  }
  io.stdout(await plan.verify());
  return 0;
}

// ── read-only commands ───────────────────────────────────────────────────────

async function runRule(chain: ToolChain, io: ToolIO): Promise<number> {
  const owner = chain.keys.keys.owner.public;
  const [rule, executor, allowance, spent] = await Promise.all([
    chain.guard.getRule(owner),
    chain.guard.getExecutor(owner),
    getAllowance(chain.rpc, {
      assetContractId: chain.sac,
      from: owner,
      spender: chain.config.guardContractId,
      networkPassphrase: chain.config.networkPassphrase,
    }),
    chain.guard.spentToday(owner),
  ]);
  io.stdout(
    [
      "Owner rule (on-chain):",
      rule ? `  auto_approve_limit    ${fromRawUnits(rule.auto_approve_limit)}` : "  (no rule published)",
      rule ? `  per_tx_limit          ${fromRawUnits(rule.per_tx_limit)}` : "",
      rule ? `  daily_limit           ${fromRawUnits(rule.daily_limit)}` : "",
      rule ? `  allowed_assets        ${rule.allowed_assets.join(", ")}` : "",
      rule ? `  known_recipients_only ${rule.known_recipients_only}` : "",
      `  executor              ${executor ?? "(none)"}`,
      `  spent_today           ${fromRawUnits(spent)}`,
      `  SAC allowance         ${fromRawUnits(allowance)}`,
      `  profile               ${profileFromChain(rule, executor).mode}`,
    ]
      .filter((line) => line.length > 0)
      .join("\n"),
  );
  return 0;
}

async function runList(chain: ToolChain, io: ToolIO, flags: Record<string, string | boolean>): Promise<number> {
  const owner = chain.keys.keys.owner.public;
  const timeZone = resolveTimeZone(typeof flags.tz === "string" ? flags.tz : undefined);
  const rows = await listUpcoming(scheduleDeps(chain, owner))({ timeZone });
  if (rows.length === 0) {
    io.stdout("No active schedules.");
    return 0;
  }
  const lines = [`Active schedules (${rows.length}) — local zone ${timeZone}:`];
  for (const row of rows) {
    lines.push(
      `  #${row.id} ${row.amount} ${row.asset} -> ${row.recipientAlias ?? row.recipientAddress}` +
        ` — ${row.intervalWords}, runs left ${row.runsLeft}, status ${row.status}`,
    );
    lines.push(`      next run: ${row.nextRunLocal} (${timeZone}) / ${row.nextRunUtc} UTC`);
  }
  io.stdout(lines.join("\n"));
  return 0;
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

// ── plan builders (state-changing commands) ──────────────────────────────────

async function buildPay(chain: ToolChain, flags: Record<string, string | boolean>, deadline: Deadline): Promise<Plan> {
  const to = requireString(flags, "to");
  const amount = requireString(flags, "amount");
  const route = optionalString(flags, "route") ?? "guarded";
  if (route !== "direct" && route !== "guarded") {
    throw new UsageError(`--route must be "direct" or "guarded", got ${JSON.stringify(route)}`);
  }
  const profile = optionalString(flags, "profile") ?? "always_ask";
  if (profile !== "always_ask" && profile !== "auto_under_limit") {
    throw new UsageError(`--profile must be "always_ask" or "auto_under_limit", got ${JSON.stringify(profile)}`);
  }
  const alias = to.trim().toLowerCase();
  const entry = resolveAlias(chain.aliases, alias);
  if (!entry) throw new UsageError(`unknown alias ${JSON.stringify(alias)} (known: ${Object.keys(chain.aliases).join(", ")})`);

  const deps: PaymentDeps = {
    ownerAddress: chain.keys.keys.owner.public,
    aliases: chain.aliases,
    loadAccount: (address) => chain.horizon.loadAccount(address),
    networkPassphrase: chain.config.networkPassphrase,
    horizonUrl: chain.config.horizonUrl,
    explorerBase: EXPLORER_BASE,
    assets: chain.assets,
    route: route as PaymentRoute,
    approvalProfile: { mode: profile } as ApprovalProfile,
    guard: chain.guard,
    guardAssetContracts: { [chain.assetCode]: chain.sac },
  };

  const built = await createSendPayment(deps)({ kind: "send", asset: "USDC", amount, recipient: alias });
  const step = built.unsignedXdr;
  const classic = route === "direct";
  let role: SignerRole = "owner";
  let fnName = "payment";
  if (!classic) {
    fnName = decodeInvocation(step, chain.config.networkPassphrase).functionName;
    if (fnName === "pay_executor") role = "executor";
  }
  const before = await readBalance(chain, entry.address);

  const notes: string[] = [];
  if (classic) {
    notes.push("Direct classic payment: bypasses the guard entirely; the owner signs.");
  } else if (fnName === "pay_executor") {
    notes.push(
      "No owner approval card is required on this path: the registered executor signs unattended " +
        "(on-chain profile auto_under_limit). This tool still asks you to confirm.",
    );
  } else if (profile === "always_ask") {
    notes.push("Profile always_ask: the owner signs this payment after approval.");
  } else {
    notes.push("Amount is above the auto-approve threshold, so the owner must sign this payment.");
  }

  return {
    command: "pay",
    title: built.summary.title,
    route: classic ? "direct (classic payment; owner signs)" : undefined,
    steps: await finalize(
      chain,
      [
        {
          kind: fnName,
          role,
          classic,
          unsignedXdr: step,
          title: built.summary.title,
          lines: built.summary.lines,
        },
      ],
      deadline,
    ),
    notes,
    verify: async () => {
      const after = await readBalance(chain, entry.address);
      const lines = [
        "Verification (read back from chain):",
        `  recipient ${alias} balance ${fromRawUnits(after)} ${chain.assetCode} (delta +${fromRawUnits(after - before)})`,
      ];
      if (!classic) {
        const spent = await chain.guard.spentToday(chain.keys.keys.owner.public);
        lines.push(`  spent_today ${fromRawUnits(spent)} ${chain.assetCode}`);
      }
      return lines.join("\n");
    },
  };
}

async function buildSchedule(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan> {
  const to = requireString(flags, "to");
  const amount = requireString(flags, "amount");
  const date = requireString(flags, "date");
  const time = requireString(flags, "time");
  const timeZone = requireString(flags, "tz");
  const every = optionalString(flags, "every");
  if (every !== undefined && every !== "day" && every !== "week") {
    throw new UsageError(`--every must be "day" or "week", got ${JSON.stringify(every)}`);
  }
  const runs = optionalInt(flags, "runs");
  const alias = to.trim().toLowerCase();
  const entry = resolveAlias(chain.aliases, alias);
  if (!entry) throw new UsageError(`unknown alias ${JSON.stringify(alias)} (known: ${Object.keys(chain.aliases).join(", ")})`);

  const draft: Record<string, unknown> = {
    recipient: alias,
    asset: "USDC",
    amount,
    firstRun: { localDate: date, localTime: time, timeZone },
  };
  if (every) draft.repeat = { every };
  if (runs !== undefined) draft.runs = runs;

  const built = await schedulePayment(scheduleDeps(chain, chain.keys.keys.owner.public))(draft);
  return {
    command: "schedule",
    title: built.summary.title,
    steps: await finalize(
      chain,
      [
        {
          kind: "create_schedule",
          role: "owner",
          unsignedXdr: built.unsignedXdr,
          title: built.summary.title,
          lines: built.summary.lines,
          warnings: built.warnings,
        },
      ],
      deadline,
    ),
    notes: [],
    verify: async () => {
      const schedules = await chain.guard.listSchedules(chain.keys.keys.owner.public);
      const created = schedules.find((s) => s.to === entry.address && s.active);
      if (!created) return "Verification: schedule created (not found in the active list yet).";
      return [
        "Verification (read back from chain):",
        `  schedule #${created.id} active=${created.active} runs_left=${created.runs_left}`,
        `  next run ${formatInZone(Number(created.next_run_at), timeZone)} (${timeZone})`,
      ].join("\n");
    },
  };
}

/** Map `cancel` flags to the schedule tool's request shape (`id` or `recipient`). */
export function cancelRequestFromFlags(
  flags: Record<string, string | boolean>,
): { id: number } | { recipient: string } {
  const idRaw = optionalInt(flags, "id");
  const to = optionalString(flags, "to");
  if (idRaw === undefined && to === undefined) throw new UsageError("cancel needs --id or --to");
  if (idRaw !== undefined && to !== undefined) throw new UsageError("cancel takes either --id or --to, not both");
  return idRaw !== undefined ? { id: idRaw } : { recipient: to as string };
}

async function buildCancel(chain: ToolChain, flags: Record<string, string | boolean>, deadline: Deadline): Promise<Plan> {
  const request = cancelRequestFromFlags(flags);
  const built = await cancelSchedule(scheduleDeps(chain, chain.keys.keys.owner.public))(request);
  return {
    command: "cancel",
    title: built.summary.title,
    steps: await finalize(
      chain,
      [
        {
          kind: "cancel_schedule",
          role: "owner",
          unsignedXdr: built.unsignedXdr,
          title: built.summary.title,
          lines: built.summary.lines,
        },
      ],
      deadline,
    ),
    notes: ["Cancelling only tightens limits, so the owner's signature is enough."],
    verify: async () => {
      const schedule = await chain.guard.getSchedule(built.id);
      return [
        "Verification (read back from chain):",
        `  schedule #${built.id} active=${schedule ? schedule.active : "missing"}`,
      ].join("\n");
    },
  };
}

const ALIAS_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

async function buildAliasAdd(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan> {
  const name = requireString(flags, "name").trim();
  const address = requireString(flags, "address").trim();
  if (!ALIAS_NAME.test(name)) {
    throw new UsageError(`--name must match [a-z][a-z0-9_-]{0,31}, got ${JSON.stringify(name)}`);
  }
  if (!StrKey.isValidEd25519PublicKey(address)) {
    throw new UsageError(`--address must be a valid Stellar G... account address, got ${JSON.stringify(address)}`);
  }
  const call = await chain.guard.setAlias(chain.keys.keys.owner.public, name, address);
  return {
    command: "alias-add",
    title: call.summary.title,
    steps: await finalize(
      chain,
      [{ kind: "set_alias", role: "owner", unsignedXdr: call.unsignedXdr, title: call.summary.title, lines: call.summary.lines }],
      deadline,
    ),
    notes: [`This also stores ${name} in the local alias book so \`pay --to ${name}\` works.`],
    verify: async () => {
      const onChain = await chain.guard.getAlias(chain.keys.keys.owner.public, name);
      const book = loadToolAliases(chain.config, chain.keys.keys.recipient.public);
      book[name] = { address, network: "testnet" };
      saveToolAliases(chain.config, book);
      return [
        "Verification (read back from chain):",
        `  get_alias(${name}) = ${onChain ?? "(null)"}`,
      ].join("\n");
    },
  };
}

async function buildAliasRemove(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan> {
  const name = requireString(flags, "name").trim();
  if (!ALIAS_NAME.test(name)) {
    throw new UsageError(`--name must match [a-z][a-z0-9_-]{0,31}, got ${JSON.stringify(name)}`);
  }
  const call = await chain.guard.removeAlias(chain.keys.keys.owner.public, name);
  return {
    command: "alias-remove",
    title: call.summary.title,
    steps: await finalize(
      chain,
      [{ kind: "remove_alias", role: "owner", unsignedXdr: call.unsignedXdr, title: call.summary.title, lines: call.summary.lines }],
      deadline,
    ),
    notes: [],
    verify: async () => {
      const onChain = await chain.guard.getAlias(chain.keys.keys.owner.public, name);
      const book = loadToolAliases(chain.config, chain.keys.keys.recipient.public);
      if (name !== "ada") delete book[name];
      saveToolAliases(chain.config, book);
      return [
        "Verification (read back from chain):",
        `  get_alias(${name}) = ${onChain ?? "(null)"}`,
      ].join("\n");
    },
  };
}

async function buildEnableAuto(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan> {
  const threshold = requireString(flags, "threshold");
  const daily = requireString(flags, "daily");
  const perTx = optionalString(flags, "per-tx") ?? daily;
  const days = optionalInt(flags, "days");
  const owner = chain.keys.keys.owner.public;
  const [currentRule, executor, currentAllowance] = await Promise.all([
    chain.guard.getRule(owner),
    chain.guard.getExecutor(owner),
    getAllowance(chain.rpc, {
      assetContractId: chain.sac,
      from: owner,
      spender: chain.config.guardContractId,
      networkPassphrase: chain.config.networkPassphrase,
    }),
  ]);
  const draft = approval.makeAutoPayDraft({
    executor: chain.keys.keys.executor.public,
    threshold,
    perTxLimit: perTx,
    dailyLimit: daily,
    allowedAssets: [chain.sac],
    knownRecipientsOnly: false,
    ...(days !== undefined ? { allowanceDays: days } : {}),
  });
  const built = await approval.buildEnableAutoPay(
    {
      owner,
      guard: chain.guard,
      rpc: chain.rpc,
      networkPassphrase: chain.config.networkPassphrase,
      currentAllowanceRaw: currentAllowance,
      current: { rule: currentRule ?? undefined, executor: executor ?? undefined },
    },
    draft,
  );
  const raw: RawStep[] = built.steps.map((step, index) => {
    const action = built.summary.actions[index];
    return {
      kind: step.kind,
      role: "owner",
      unsignedXdr: step.unsignedXdr,
      title: built.summary.title,
      lines: [...(action?.lines ?? [])],
      arming: action?.arming ?? step.kind === "set_executor",
    };
  });
  return {
    command: "enable-auto",
    title: built.summary.title,
    steps: await finalize(chain, raw, deadline),
    notes: [...built.summary.notes],
    verify: async () => {
      const [rule, exec] = await Promise.all([chain.guard.getRule(owner), chain.guard.getExecutor(owner)]);
      return [
        "Verification (read back from chain):",
        `  executor ${exec ?? "(none)"}`,
        `  auto_approve_limit ${rule ? fromRawUnits(rule.auto_approve_limit) : "?"}`,
        `  profile ${profileFromChain(rule, exec).mode}`,
      ].join("\n");
    },
  };
}

async function buildDisableAuto(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan> {
  const owner = chain.keys.keys.owner.public;
  const revokeAllowance = flags["revoke-allowance"] === true;
  const built = await approval.buildDisableAutoPay(
    {
      owner,
      guard: chain.guard,
      rpc: chain.rpc,
      networkPassphrase: chain.config.networkPassphrase,
      assetContractId: chain.sac,
    },
    { revokeAllowance },
  );
  const raw: RawStep[] = built.steps.map((step, index) => ({
    kind: step.kind,
    role: "owner",
    unsignedXdr: step.unsignedXdr,
    title: built.summary.title,
    lines: [...(built.summary.actions[index]?.lines ?? [])],
  }));
  return {
    command: "disable-auto",
    title: built.summary.title,
    steps: await finalize(chain, raw, deadline),
    notes: [...built.summary.notes],
    verify: async () => {
      const exec = await chain.guard.getExecutor(owner);
      const lines = ["Verification (read back from chain):", `  executor ${exec ?? "(none)"}`];
      if (revokeAllowance) {
        const allowance = await getAllowance(chain.rpc, {
          assetContractId: chain.sac,
          from: owner,
          spender: chain.config.guardContractId,
          networkPassphrase: chain.config.networkPassphrase,
        });
        lines.push(`  SAC allowance ${fromRawUnits(allowance)}`);
      }
      return lines.join("\n");
    },
  };
}

async function buildTighten(
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan | null> {
  const owner = chain.keys.keys.owner.public;
  const perTx = optionalString(flags, "per-tx");
  const daily = optionalString(flags, "daily");
  const threshold = optionalString(flags, "threshold");
  if (!perTx && !daily && !threshold) {
    throw new UsageError("tighten needs at least one of --per-tx / --daily / --threshold");
  }
  const allowLoosening = flags["allow-loosening"] === true;
  const current = await chain.guard.getRule(owner);
  if (!current) throw new Error("no rule published for the owner; run the baseline setup first");
  const next: Rule = {
    auto_approve_limit: threshold ? toRawUnits(threshold) : current.auto_approve_limit,
    per_tx_limit: perTx ? toRawUnits(perTx) : current.per_tx_limit,
    daily_limit: daily ? toRawUnits(daily) : current.daily_limit,
    allowed_assets: [...current.allowed_assets],
    known_recipients_only: current.known_recipients_only,
  };
  const result = await approval.buildTightenRule({ owner, guard: chain.guard, current }, next, { allowLoosening });
  if (result.steps.length === 0) return null;
  const step = result.steps[0];
  if (!step) return null;
  return {
    command: "tighten",
    title: `Update owner rule (${result.classification})`,
    steps: await finalize(
      chain,
      [
        {
          kind: "set_rule",
          role: "owner",
          unsignedXdr: step.unsignedXdr,
          title: `polaris_guard: set_rule`,
          lines: [
            `Classification: ${result.classification}`,
            `Confirmation: ${result.confirmation}`,
            `New per_tx_limit: ${fromRawUnits(next.per_tx_limit)}`,
            `New daily_limit: ${fromRawUnits(next.daily_limit)}`,
            `New auto_approve_limit: ${fromRawUnits(next.auto_approve_limit)}`,
          ],
        },
      ],
      deadline,
    ),
    notes: result.confirmation === "card_and_touch_id" ? ["This is a loosening/mixed change: full card required."] : [],
    verify: async () => {
      const rule = await chain.guard.getRule(owner);
      return [
        "Verification (read back from chain):",
        rule ? `  per_tx_limit ${fromRawUnits(rule.per_tx_limit)}` : "  (no rule)",
        rule ? `  daily_limit ${fromRawUnits(rule.daily_limit)}` : "",
        rule ? `  auto_approve_limit ${fromRawUnits(rule.auto_approve_limit)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

// ── keeper ───────────────────────────────────────────────────────────────────

/** Run the existing keeper CLI, streaming its JSON logs; bounded foreground run. */
export async function runKeeperChild(chain: ToolChain, options: KeeperRunOptions, io: ToolIO): Promise<number> {
  const cliPath = fileURLToPath(new URL("../keeper/cli.ts", import.meta.url));
  const cwd = fileURLToPath(new URL("../../", import.meta.url));
  const args = [cliPath, ...(options.mode === "once" ? ["--once"] : [])];
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    KEEPER_SECRET: chain.keys.keys.keeper.secret,
    GUARD_CONTRACT_ID: chain.config.guardContractId,
    SOROBAN_RPC_URL: chain.config.rpcUrl,
    NETWORK_PASSPHRASE: chain.config.networkPassphrase,
    KEEPER_POLL_SECONDS: "5",
    KEEPER_MAX_PER_TICK: "5",
    KEEPER_TX_TIMEOUT_SECONDS: "30",
  };
  const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const forward = (chunk: Buffer): void => io.stdout(String(chunk).replace(/\s+$/, ""));
  child.stdout?.on("data", forward);
  child.stderr?.on("data", forward);

  const softMs = options.mode === "watch" ? (options.seconds ?? 60) * 1000 : undefined;
  const hardMs = options.mode === "watch" ? (options.seconds ?? 60) * 1000 + 5_000 : 120_000;
  const code = await waitForChild(child, softMs, hardMs);
  return code === 0 || code === null ? 0 : 1;
}

function waitForChild(child: ChildProcess, softMs: number | undefined, hardMs: number): Promise<number | null> {
  return new Promise((resolve) => {
    const soft = softMs !== undefined ? setTimeout(() => child.kill("SIGTERM"), softMs) : undefined;
    const hard = setTimeout(() => child.kill("SIGKILL"), hardMs);
    child.once("exit", (code) => {
      if (soft) clearTimeout(soft);
      clearTimeout(hard);
      resolve(code);
    });
  });
}

// ── plan-only text (no network) ──────────────────────────────────────────────

function planText(command: string, flags: Record<string, string | boolean>, config: LiveConfig): string {
  const options = Object.entries(flags)
    .filter(([name]) => name !== "live" && name !== "yes" && name !== "help")
    .map(([name, value]) => `${name}=${String(value)}`)
    .sort()
    .join(" ");
  return [
    `e2e:tool ${command} plan (no network; pass --live to build the card, confirm and submit)`,
    `  network  ${config.network}`,
    `  rpc      ${config.rpcUrl}`,
    `  guard    ${config.guardContractId}`,
    `  keys     ${config.keysPath}`,
    `  options  ${options || "(none)"}`,
  ].join("\n");
}

async function buildPlan(
  command: string,
  chain: ToolChain,
  flags: Record<string, string | boolean>,
  deadline: Deadline,
): Promise<Plan | null> {
  switch (command) {
    case "pay":
      return buildPay(chain, flags, deadline);
    case "schedule":
      return buildSchedule(chain, flags, deadline);
    case "cancel":
      return buildCancel(chain, flags, deadline);
    case "alias-add":
      return buildAliasAdd(chain, flags, deadline);
    case "alias-remove":
      return buildAliasRemove(chain, flags, deadline);
    case "enable-auto":
      return buildEnableAuto(chain, flags, deadline);
    case "disable-auto":
      return buildDisableAuto(chain, flags, deadline);
    case "tighten":
      return buildTighten(chain, flags, deadline);
    default:
      throw new UsageError(`command "${command}" is not a state-changing command`);
  }
}

// ── IO + entry point ─────────────────────────────────────────────────────────

// The strict approval gate lives in `confirm.ts`; re-exported so existing
// importers keep working. `parseConfirmation` itself is unit-tested there.
export { interactiveConfirm, parseConfirmation, DEFAULT_CONFIRM_TIMEOUT_MS } from "./confirm.ts";

function defaultIO(): ToolIO {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    confirm: interactiveConfirm,
  };
}

export async function runTool(argv: readonly string[], deps: Partial<ToolDeps> = {}): Promise<number> {
  const io = deps.io ?? defaultIO();
  let parsed;
  try {
    parsed = parseCommandLine(argv, TOOL_SPEC);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${renderUsage(TOOL_SPEC)}`);
      return 2;
    }
    throw e;
  }

  if (parsed.help || parsed.command === undefined) {
    io.stdout(renderUsage(TOOL_SPEC, parsed.command));
    return 0;
  }
  const command = parsed.command;
  const live = parsed.flags.live === true;
  const yes = parsed.flags.yes === true;

  let config: LiveConfig;
  try {
    config = loadLiveConfig(deps.config);
  } catch (e) {
    io.stderr(`e2e:tool config error: ${(e as Error).message}`);
    return 1;
  }

  if (!live) {
    io.stdout(planText(command, parsed.flags, config));
    return 0;
  }

  try {
    const keys = loadOrCreateKeys(config.keysPath);
    const chain = (deps.createChain ?? createToolChain)(config, keys);
    const deadline = new Deadline({
      timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS,
      label: `e2e:tool ${command}`,
      ...(deps.now ? { now: deps.now } : {}),
    });

    if (command === "rule") return await runRule(chain, io);
    if (command === "list") return await runList(chain, io, parsed.flags);
    if (command === "keeper-once" || command === "keeper-watch") {
      const runner = deps.runKeeper ?? runKeeperChild;
      const options: KeeperRunOptions =
        command === "keeper-once" ? { mode: "once" } : { mode: "watch", seconds: requireInt(parsed.flags, "seconds") };
      if (command === "keeper-watch") {
        const seconds = options.seconds as number;
        if (seconds < 1 || seconds > 300) throw new UsageError("--seconds must be between 1 and 300");
      }
      return await runner(chain, options, io);
    }

    const plan = await (deps.buildPlan ?? buildPlan)(command, chain, parsed.flags, deadline);
    if (plan === null) {
      io.stdout("No change: the resulting rule is identical to the current one; nothing to sign.");
      return 0;
    }
    return await executePlan(plan, chain, io, yes, deadline);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`${e.message}\n\n${renderUsage(TOOL_SPEC, command)}`);
      return 2;
    }
    io.stderr(`e2e:tool ${command} failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

export async function main(argv: readonly string[]): Promise<number> {
  return runTool(argv);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`e2e:tool failed: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
