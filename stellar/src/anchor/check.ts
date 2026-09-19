/**
 * `anchor:check` — a small, self-contained health/plan tool for the anchor demo.
 *
 *   npm run anchor:check -w @polaris/stellar -- [--home-domain <d>] [--live] [--payout-check]
 *
 * Without `--live` it prints the plan only and makes ZERO network requests. With
 * `--live` it runs, per requested domain (default: both approved scenarios):
 *   1. SEP-1 discovery (signing key + endpoints)
 *   2. SEP-6 `/info` (which fields are present)
 *   3. SEP-10: fetch the challenge, VALIDATE it, sign with an in-memory throwaway
 *      key and obtain the JWT (the token is never printed).
 *
 * `--payout-check` additionally reads the TR mock treasury's public Horizon
 * history and classifies whether deposit payouts are flowing.
 *
 * SAFETY: only the approved hosts are contacted, no deposits/withdrawals, no
 * SEP-12 customer creation, no treasury use, throwaway in-memory keys only, and
 * no secret is ever printed.
 */
import { pathToFileURL } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { TESTNET_FRIENDBOT_URL, TESTNET_HORIZON_URL, TESTNET_PASSPHRASE } from "./config.ts";
import { AnchorHttpError, requestJson } from "./http.ts";
import { ExplainLog, shortKey } from "./explain.ts";
import { readPayoutHealth, type PayoutHealthResult } from "./payoutHealth.ts";
import {
  describeAnchorScenario,
  SDF_TEST_ANCHOR_HOME_DOMAIN,
  TR_MOCK_HOME_DOMAIN,
  type AnchorScenario,
} from "./scenarios.ts";
import { discoverAnchor } from "./sep1.ts";
import { completeChallenge, requestChallenge } from "./sep10.ts";
import { EnvSigner } from "./testSigner.ts";
import { sanitizeAnchorText } from "./text.ts";
import type { AnchorContext, AnchorToml, FetchLike } from "./types.ts";

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The mandatory closing line for the NON-TR (SDF) scenario. It must be printed
 * on EVERY SDF outcome, including a discovery failure: the whole point of the
 * scenario is that a deposit stops at SEP-12 KYC, so the boundary is never
 * dependent on the network succeeding.
 */
export const SDF_KYC_FINAL_LINE =
  "Deposit is not attempted: this anchor requires SEP-12 KYC fields (first_name, last_name, email_address)";

export interface PlannedStep {
  name: string;
  detail: string;
}

export interface ScenarioPlan {
  scenario: AnchorScenario;
  homeDomain: string;
  steps: PlannedStep[];
}

export type StepStatus = "PASS" | "FAIL" | "SKIP";

export interface StepOutcome {
  name: string;
  status: StepStatus;
  detail: string;
}

export interface ScenarioResult {
  scenario: AnchorScenario;
  homeDomain: string;
  steps: StepOutcome[];
  /** A clear closing line when the scenario has a hard boundary (e.g. SDF KYC). */
  finalLine?: string;
}

export interface AnchorCheckReport {
  live: boolean;
  payoutCheck: boolean;
  plans: ScenarioPlan[];
  results: ScenarioResult[];
  payout?: PayoutHealthResult;
  payoutError?: string;
  /** True when every live scenario step passed (plan mode is always true). */
  ok: boolean;
}

export interface AnchorCheckOptions {
  /** Home domains to check. Default: both approved scenarios. */
  homeDomains?: string[];
  live?: boolean;
  payoutCheck?: boolean;
  fetch?: FetchLike;
  now?: () => Date;
  /** Line sink (default: console.log). */
  out?: (line: string) => void;
  requestTimeoutMs?: number;
}

/** The plan is fully derivable from the scenario; no network needed. */
export function buildScenarioPlan(scenario: AnchorScenario, homeDomain: string): ScenarioPlan {
  return {
    scenario,
    homeDomain,
    steps: [
      {
        name: "SEP-1 discovery",
        detail: `GET https://${homeDomain}/.well-known/stellar.toml (signing key + auth/transfer/kyc/quote endpoints)`,
      },
      {
        name: "SEP-6 /info",
        detail: "GET <TRANSFER_SERVER>/info (authentication_required, min/max amounts, fees)",
      },
      {
        name: "SEP-10 login",
        detail: "GET <WEB_AUTH_ENDPOINT>?account=<throwaway> -> validate challenge -> sign -> POST token (JWT never printed)",
      },
    ],
  };
}

function makeCtx(fetch: FetchLike, now: () => Date, requestTimeoutMs: number): AnchorContext {
  return {
    fetch,
    explain: new ExplainLog(now),
    horizonUrl: TESTNET_HORIZON_URL,
    friendbotUrl: TESTNET_FRIENDBOT_URL,
    networkPassphrase: TESTNET_PASSPHRASE,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now,
    requestTimeoutMs,
  };
}

function endpointPath(url: string): string {
  try {
    return sanitizeAnchorText(new URL(url).pathname, 60) ?? "/";
  } catch {
    return "?";
  }
}

/** One line per asset: which SEP-6 `/info` fields are actually present. */
export function summarizeInfoAssets(value: unknown): string {
  if (!value || typeof value !== "object") return "none";
  const parts: string[] = [];
  for (const [code, info] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9]{1,12}$/.test(code) || !info || typeof info !== "object") continue;
    const i = info as Record<string, unknown>;
    const fields = [
      `enabled=${i.enabled === true}`,
      `auth=${authFlag(i.authentication_required)}`,
      `min=${typeof i.min_amount === "number" ? i.min_amount : "absent"}`,
      `max=${typeof i.max_amount === "number" ? i.max_amount : "absent"}`,
      `fee_percent=${typeof i.fee_percent === "number" ? i.fee_percent : "absent"}`,
    ];
    if (typeof i.fee_fixed === "number") fields.push(`fee_fixed=${i.fee_fixed}`);
    parts.push(`${code}(${fields.join(", ")})`);
  }
  return parts.length > 0 ? parts.join("; ") : "none";
}

/** `true` / `false` when the anchor set a boolean flag, `absent` otherwise. */
function authFlag(value: unknown): "true" | "false" | "absent" {
  if (value === true) return "true";
  if (value === false) return "false";
  return "absent";
}

/** True when the failure looks like "this anchor needs the account to exist first". */
export function looksLikeAccountMissing(e: unknown): boolean {
  if (e instanceof AnchorHttpError) {
    if (e.status === 404) return true;
    if (e.status === 400 && /account/i.test(e.message)) return true;
  }
  return e instanceof Error && /account (?:is )?(?:not found|does not exist)|unfunded/i.test(e.message);
}

async function runScenarioLive(
  scenario: AnchorScenario,
  homeDomain: string,
  ctx: AnchorContext,
): Promise<ScenarioResult> {
  const steps: StepOutcome[] = [];
  let toml: AnchorToml | undefined;
  try {
    toml = await discoverAnchor(ctx, homeDomain);
    steps.push({
      name: "SEP-1 discovery",
      status: "PASS",
      detail:
        `signing key ${shortKey(toml.signingKey)}; auth=${endpointPath(toml.webAuthEndpoint)}; ` +
        `transfer=${endpointPath(toml.transferServer)}; kyc=${toml.kycServer ? endpointPath(toml.kycServer) : "none"}; ` +
        `quote=${toml.quoteServer ? endpointPath(toml.quoteServer) : "none"}`,
    });
  } catch (e) {
    steps.push({ name: "SEP-1 discovery", status: "FAIL", detail: message(e) });
    steps.push({ name: "SEP-6 /info", status: "SKIP", detail: "skipped: no stellar.toml" });
    steps.push({ name: "SEP-10 login", status: "SKIP", detail: "skipped: no stellar.toml" });
    const failed: ScenarioResult = { scenario, homeDomain, steps };
    if (scenario.id === "sdf-test") failed.finalLine = SDF_KYC_FINAL_LINE;
    return failed;
  }

  try {
    const raw = await requestJson<Record<string, unknown>>(ctx, `${toml.transferServer}/info`);
    steps.push({
      name: "SEP-6 /info",
      status: "PASS",
      detail:
        `authentication_required(top)=${authFlag(raw.authentication_required)}; ` +
        `deposit: ${summarizeInfoAssets(raw.deposit)}; withdraw: ${summarizeInfoAssets(raw.withdraw)}`,
    });
  } catch (e) {
    steps.push({ name: "SEP-6 /info", status: "FAIL", detail: message(e) });
  }

  try {
    const signer = new EnvSigner(Keypair.random().secret());
    const account = await signer.publicKey();
    let fundedNote = "";
    let challenge: string;
    try {
      challenge = await requestChallenge(ctx, toml, account);
    } catch (e) {
      if (scenario.id === "sdf-test" && looksLikeAccountMissing(e)) {
        await requestJson(ctx, ctx.friendbotUrl, { query: { addr: account } });
        fundedNote = " (throwaway account funded by Friendbot first: this anchor needs an existing account)";
        challenge = await requestChallenge(ctx, toml, account);
      } else {
        throw e;
      }
    }
    const signed = await signer.signTransaction(challenge, { networkPassphrase: ctx.networkPassphrase });
    const token = await completeChallenge(ctx, toml, account, challenge, signed);
    steps.push({
      name: "SEP-10 login",
      status: "PASS",
      detail:
        `account=${shortKey(account)}; challenge validated before signing; ` +
        `jwt length=${token.jwt.length}; expiresAt=${token.expiresAt ? token.expiresAt.toISOString() : "not reported"}${fundedNote}`,
    });
  } catch (e) {
    steps.push({ name: "SEP-10 login", status: "FAIL", detail: message(e) });
  }

  const result: ScenarioResult = { scenario, homeDomain, steps };
  if (scenario.id === "sdf-test") {
    result.finalLine = SDF_KYC_FINAL_LINE;
  }
  return result;
}

function message(e: unknown): string {
  return sanitizeAnchorText(e instanceof Error ? e.message : String(e), 200) ?? "unknown error";
}

export function formatPlan(plan: ScenarioPlan): string[] {
  const lines = [`Scenario [${plan.scenario.id}]: ${plan.scenario.label}`, `  home domain : ${plan.homeDomain}`, `  scope       : ${plan.scenario.sepScope}`];
  lines.push(`  allowed     : ${plan.scenario.allowed.length > 0 ? plan.scenario.allowed.join(", ") : "none (unverified)"}`);
  lines.push(`  notes       : ${plan.scenario.notes}`);
  lines.push("  planned steps:");
  for (const s of plan.steps) lines.push(`    - ${s.name.padEnd(18)} ${s.detail}`);
  return lines;
}

export function formatResult(result: ScenarioResult): string[] {
  const lines = [`Scenario [${result.scenario.id}]: ${result.scenario.label}`, `  home domain: ${result.homeDomain}`];
  for (const s of result.steps) lines.push(`  ${s.name.padEnd(18)} ${s.status.padEnd(4)} ${s.detail}`);
  if (result.finalLine) lines.push(`  ${result.finalLine}`);
  return lines;
}

/**
 * Runs the plan (and, with `live`, the checks). Plan mode never touches the
 * network; `fetch` is only used when `live` is true.
 */
export async function runAnchorCheck(opts: AnchorCheckOptions = {}): Promise<AnchorCheckReport> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const now = opts.now ?? (() => new Date());
  const fetchFn: FetchLike = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const homeDomains = opts.homeDomains && opts.homeDomains.length > 0 ? opts.homeDomains : [TR_MOCK_HOME_DOMAIN, SDF_TEST_ANCHOR_HOME_DOMAIN];
  const live = opts.live === true;
  const payoutCheck = opts.payoutCheck === true;

  const scenarios = homeDomains.map((d) => describeAnchorScenario(d));
  const plans = scenarios.map((s, i) => buildScenarioPlan(s, homeDomains[i] as string));

  out(`Anchor check (${live ? "LIVE" : "PLAN ONLY — pass --live to run"})`);
  out("====================");
  if (!live) {
    for (const plan of plans) {
      for (const line of formatPlan(plan)) out(line);
      out("");
    }
    if (payoutCheck) {
      if (scenarios.some((s) => s.id === "tr-mock")) {
        out(`TR payout-health (planned): read https://${TR_MOCK_HOME_DOMAIN}/health and the treasury's Horizon payments, then classify.`);
      } else {
        out("TR payout-health (planned): payout-check applies to the TR mock only; the requested --home-domain is not the TR scenario, so no payout read is planned.");
      }
      out("");
    }
    return { live, payoutCheck, plans, results: [], ok: true };
  }

  const ctx = makeCtx(fetchFn, now, requestTimeoutMs);
  const results: ScenarioResult[] = [];
  for (const [i, scenario] of scenarios.entries()) {
    const result = await runScenarioLive(scenario, homeDomains[i] as string, ctx);
    results.push(result);
    for (const line of formatResult(result)) out(line);
    out("");
  }

  const report: AnchorCheckReport = { live, payoutCheck, plans, results, ok: results.every((r) => r.steps.every((s) => s.status !== "FAIL")) };
  if (payoutCheck) {
    out("TR payout-health (read-only)");
    try {
      const payout = await readPayoutHealth(ctx, { homeDomain: TR_MOCK_HOME_DOMAIN, now: now() });
      report.payout = payout;
      out(`  treasury       : ${shortKey(payout.treasury)} (${payout.treasurySource})`);
      out(`  verdict        : ${payout.verdict}`);
      out(`  newest outgoing: ${payout.newestOutgoingAt ?? "none in the last 200 records"}`);
      out(`  incoming since : ${payout.incomingSinceNewestOutgoing} (of ${payout.incomingCount} incoming)`);
      for (const r of payout.reasons) out(`  reason         : ${r}`);
    } catch (e) {
      report.payoutError = message(e);
      report.ok = false;
      out(`  FAILED: ${report.payoutError}`);
    }
    out("");
  }
  return report;
}

interface CliArgs {
  homeDomains: string[];
  live: boolean;
  payoutCheck: boolean;
}

export function parseArgs(argv: readonly string[]): CliArgs {
  const homeDomains: string[] = [];
  let live = false;
  let payoutCheck = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--home-domain") {
      const v = argv[i + 1];
      if (v && !v.startsWith("--")) {
        homeDomains.push(v);
        i++;
      }
    } else if (a === "--live") {
      live = true;
    } else if (a === "--payout-check") {
      payoutCheck = true;
    }
  }
  return { homeDomains, live, payoutCheck };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const report = await runAnchorCheck(args);
  if (report.live && !report.ok) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error("ANCHOR CHECK FAILED:", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
