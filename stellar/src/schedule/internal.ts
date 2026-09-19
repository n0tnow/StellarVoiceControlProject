/**
 * Shared internals for the schedule tools: dependency guards, alias
 * reverse-mapping and guard-error translation. Kept separate so `time.ts`
 * stays free of any `@stellar/stellar-sdk` dependency.
 */
import type { AliasBook } from "../payments/aliases.ts";
import { asGuardClientError } from "../guard/errors.ts";
import { ScheduleRefusal, type ScheduleRefusalCode } from "./errors.ts";
import type { ScheduleDeps } from "./types.ts";

export function notConfigured(message: string): ScheduleRefusal {
  return new ScheduleRefusal("not_configured", message);
}

/** Validate the injected dependencies. Throws `not_configured`, never a TypeError. */
export function assertScheduleDeps(deps: unknown, method: string): asserts deps is ScheduleDeps {
  if (deps === null || deps === undefined || typeof deps !== "object") {
    throw notConfigured(`${method} requires schedule dependencies (owner, guard client, aliases)`);
  }
  const d = deps as Partial<ScheduleDeps>;
  if (typeof d.ownerAddress !== "string" || d.ownerAddress.length === 0) {
    throw notConfigured(`${method} requires a non-empty ownerAddress`);
  }
  if (!d.guard || typeof d.guard !== "object") {
    throw notConfigured(`${method} requires an owner-side guard client`);
  }
  if (!d.aliases || typeof d.aliases !== "object") {
    throw notConfigured(`${method} requires an alias book`);
  }
  if (!d.assets || typeof (d.assets as { get?: unknown }).get !== "function") {
    throw notConfigured(`${method} requires an asset registry`);
  }
  if (typeof d.networkPassphrase !== "string" || d.networkPassphrase.length === 0) {
    throw notConfigured(`${method} requires a network passphrase`);
  }
}

/** Asset code -> SAC contract id, tolerating either case in the deps table. */
export function guardAssetContract(deps: ScheduleDeps, code: string): string | undefined {
  const table = deps.guardAssetContracts;
  if (!table || typeof table !== "object") return undefined;
  return table[code] ?? table[code.toUpperCase()] ?? table[code.toLowerCase()];
}

/** Guard error name -> the app-facing schedule refusal code. */
const GUARD_REFUSAL_BY_NAME: Readonly<Record<string, ScheduleRefusalCode>> = {
  NotConfigured: "guard_rule_missing",
  OverPerTxLimit: "amount_over_per_tx_limit",
  OverDailyLimit: "amount_over_per_tx_limit",
  AssetNotAllowed: "asset_not_allowed",
  TooManySchedules: "too_many_schedules",
  InvalidAmount: "invalid_amount",
  InvalidSchedule: "unsupported_repeat",
};

/**
 * Translate a guard/client failure into a typed schedule refusal. Unknown
 * errors are rethrown as the typed `GuardClientError` (still machine-readable)
 * so the refusal-code set stays exactly the documented one.
 */
export function scheduleRefusalFromGuard(error: unknown): ScheduleRefusal {
  const mapped = asGuardClientError(error);
  const code = GUARD_REFUSAL_BY_NAME[mapped.name];
  if (!code) throw mapped;
  return new ScheduleRefusal(code, `polaris_guard ${mapped.name}: ${mapped.message}`, {
    guardErrorName: mapped.name,
  });
}

/**
 * Address -> alias, using only own keys and a deterministic (sorted) order so
 * two aliases sharing one address always resolve the same way. Prototype keys
 * can never appear.
 */
export function reverseAliases(book: AliasBook): Map<string, string> {
  const out = new Map<string, string>();
  if (!book || typeof book !== "object") return out;
  for (const name of Object.keys(book).sort()) {
    const entry = book[name];
    if (entry && typeof entry.address === "string" && !out.has(entry.address)) {
      out.set(entry.address, name);
    }
  }
  return out;
}
