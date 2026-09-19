import { scValToNative } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { toHex } from "../../guard/describe.ts";
import { schedulePayment } from "../schedulePayment.ts";
import {
  ADA,
  ASSET_SAC,
  DEFAULT_FIRST_RUN,
  GUARD_ID,
  GUARD_ID_2,
  OWNER,
  RULE,
  XLM_SAC,
  FakeGuardRpc,
  baseDraft,
  errSim,
  guardClient,
  invokedCall,
  makeDeps,
  refusalOf,
  schedule,
  scriptCreate,
  syncRefusal,
} from "./helpers.ts";

const deps = (rpc: FakeGuardRpc, over = {}) => makeDeps(rpc, over);

describe("schedulePayment — happy paths and decoded XDR", () => {
  it("builds an unsigned one-shot create_schedule with the documented arg order", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft());

    const call = invokedCall(res.unsignedXdr);
    expect(call.name).toBe("create_schedule");
    expect(call.contractId).toBe(GUARD_ID);
    expect(call.tx.source).toBe(OWNER);
    expect(call.tx.signatures).toHaveLength(0);
    expect(call.args.map((a) => scValToNative(a))).toEqual([
      OWNER,
      ADA,
      ASSET_SAC,
      500_000000n,
      BigInt(DEFAULT_FIRST_RUN),
      0n,
      1,
    ]);
  });

  it("decodes every summary field from the XDR", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft());

    expect(res.summary.title).toBe("Schedule 50 USDC to ada — one-shot (no repeat)");
    expect(res.summary.lines).toContain(`To ada (${ADA})`);
    expect(res.summary.lines).toContain("Per run: 50 USDC");
    expect(res.summary.lines).toContain(`Asset (SAC): ${ASSET_SAC}`);
    expect(res.summary.lines).toContain(
      "First run: 2026-09-20T15:00:00+03:00 (Europe/Istanbul) — 2026-09-20T12:00:00.000Z UTC",
    );
    expect(res.summary.lines).toContain("Repeat: one-shot (no repeat)");
    expect(res.summary.lines).toContain("Runs: 1");
    expect(res.summary.lines).toContain("Total: 50 USDC (1 × 50)");
    expect(res.summary.lines).toContain("Funding needed: 50 USDC (SAC allowance to the guard)");
    expect(res.summary.lines).toContain(`Network: ${TESTNET_PASSPHRASE}`);
    expect(res.summary.lines.some((l) => l.startsWith("Fee:"))).toBe(true);
    expect(res.summary.estimatedFee).toMatch(/XLM$/);
    expect(res.summary.lines).toContain("Approval: owner signature required");
  });

  it("payloadHash matches the built transaction hash", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft());
    expect(res.payloadHash).toBe(toHex(invokedCall(res.unsignedXdr).tx.hash()));
  });

  it("maps repeat week + runs 8 to interval_secs 604800 and total 400 USDC", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(
      baseDraft({ repeat: { every: "week" }, runs: 8 }),
    );
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[5]).toBe(604_800n);
    expect(args[6]).toBe(8);
    expect(res.summary.lines).toContain("Repeat: every week");
    expect(res.summary.lines).toContain("Runs: 8");
    expect(res.summary.lines).toContain("Total: 400 USDC (8 × 50)");
  });

  it("maps repeat day to interval_secs 86400", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "day" }, runs: 3 }));
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[5]).toBe(86_400n);
    expect(args[6]).toBe(3);
    expect(res.summary.lines).toContain("Repeat: every day");
  });

  it("maps a custom repeat to customSeconds", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(
      baseDraft({ repeat: { every: "custom", customSeconds: 3600 }, runs: 4 }),
    );
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[5]).toBe(3600n);
    expect(res.summary.lines).toContain("Repeat: every hour");
  });

  it("defaults recurring runs to 1 when omitted", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "day" } }));
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[6]).toBe(1);
  });

  it("parametrises the guard contract id", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc, { guard: guardClient(rpc, GUARD_ID_2) }))(baseDraft());
    expect(invokedCall(res.unsignedXdr).contractId).toBe(GUARD_ID_2);
  });

  it("passes the allowance pre-check when the allowance covers the total", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(
      deps(rpc, { getAllowance: async () => 10_000_000000n }),
    )(baseDraft({ repeat: { every: "week" }, runs: 8 }));
    expect(invokedCall(res.unsignedXdr).name).toBe("create_schedule");
  });

  it("accepts an allowance exactly equal to amount × runs (boundary)", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(
      deps(rpc, { getAllowance: async () => 4_000_000000n }),
    )(baseDraft({ repeat: { every: "week" }, runs: 8 }));
    expect(invokedCall(res.unsignedXdr).name).toBe("create_schedule");
  });

  it("refuses an allowance one raw unit short of amount × runs (boundary)", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc, { getAllowance: async () => 3_999_999999n }))(
        baseDraft({ repeat: { every: "week" }, runs: 8 }),
      ),
    );
    expect(err.code).toBe("allowance_insufficient");
    expect(err.details?.neededRaw).toBe(4_000_000000n);
    expect(err.details?.availableRaw).toBe(3_999_999999n);
  });

  it("refuses with not_configured when the allowance reader is missing", () => {
    const err = syncRefusal(() => {
      const d = makeDeps(new FakeGuardRpc()) as unknown as { getAllowance?: unknown };
      delete d.getAllowance;
      schedulePayment(d as never);
    });
    expect(err.code).toBe("not_configured");
    expect(err.message).toContain("SAC allowance is mandatory");
    expect(err.message).toContain("getAllowance");
  });

  it("schedules XLM when its SAC id is configured and allowed", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, allowed_assets: [GUARD_ID_2] } });
    const res = await schedulePayment(deps(rpc))(baseDraft({ asset: "XLM", amount: "5" }));
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[2]).toBe(GUARD_ID_2);
    expect(res.summary.lines).toContain("Per run: 5 XLM");
  });

  it("runs the mandatory allowance check for XLM too (no exemption)", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, allowed_assets: [XLM_SAC] } });
    const seen: string[] = [];
    const err = await refusalOf(() =>
      schedulePayment(
        deps(rpc, {
          getAllowance: async (sac: string) => {
            seen.push(sac);
            return 0n;
          },
        }),
      )(baseDraft({ asset: "XLM", amount: "5" })),
    );
    expect(err.code).toBe("allowance_insufficient");
    expect(seen).toEqual([XLM_SAC]);
  });

  it("refuses XLM when no SAC id is configured for it", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc, { guardAssetContracts: { USDC: ASSET_SAC } }))(baseDraft({ asset: "XLM" })),
    );
    expect(err.code).toBe("unsupported_asset");
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses XLM when the SAC id is not in allowed_assets", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, allowed_assets: [ASSET_SAC] } });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ asset: "XLM" })));
    expect(err.code).toBe("asset_not_allowed");
  });
});

describe("schedulePayment — warnings", () => {
  it("always warns about F-03 and the keeper dependency", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft());
    expect(res.warnings).toHaveLength(2);
    expect(res.warnings[0]).toContain("F-03");
    expect(res.warnings[0]).toContain("known_recipients_only");
    expect(res.warnings[1]).toContain("keeper");
  });

  it("warns when the local first run is ambiguous (DST overlap)", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const draft = baseDraft({
      firstRun: { localDate: "2026-10-25", localTime: "02:30", timeZone: "Europe/Berlin" },
    });
    const res = await schedulePayment(deps(rpc))(draft);
    expect(res.warnings.some((w) => w.toLowerCase().includes("ambiguous"))).toBe(true);
    const args = invokedCall(res.unsignedXdr).args.map((a) => scValToNative(a));
    expect(args[4]).toBe(BigInt(Date.UTC(2026, 9, 25, 0, 30, 0) / 1000));
  });

  it("warns when a single run meets or exceeds the daily limit", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, daily_limit: 40_000000n, per_tx_limit: 500_000000n } });
    const res = await schedulePayment(deps(rpc))(baseDraft({ amount: "50" }));
    expect(res.warnings.some((w) => w.includes("daily limit"))).toBe(true);
  });

  it("does not add the daily warning for a small amount", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const res = await schedulePayment(deps(rpc))(baseDraft({ amount: "5" }));
    expect(res.warnings.some((w) => w.includes("daily limit"))).toBe(false);
  });
});

describe("schedulePayment — draft validation matrix", () => {
  it("refuses a null draft", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(null));
    expect(err.code).toBe("invalid_intent");
    expect(rpc.simulated).toHaveLength(0);
  });

  it("refuses a non-object draft", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(42));
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses an unsupported asset", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ asset: "PGUSD" })));
    expect(err.code).toBe("unsupported_asset");
  });

  it("refuses a non-string asset", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ asset: 7 })));
    expect(err.code).toBe("unsupported_asset");
  });

  it("refuses a zero amount", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: "0" })));
    expect(err.code).toBe("invalid_amount");
  });

  it("refuses an amount with 8 fraction digits", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: "1.12345678" })));
    expect(err.code).toBe("invalid_amount");
  });

  it("refuses a non-string amount", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: 50 })));
    expect(err.code).toBe("invalid_amount");
  });

  it("refuses a raw address as recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(baseDraft({ recipient: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" })),
    );
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses the prototype key 'constructor' as recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ recipient: "constructor" })));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses the prototype key '__proto__' as recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ recipient: "__proto__" })));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses an empty recipient", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ recipient: "  " })));
    expect(err.code).toBe("unknown_recipient");
  });

  it("refuses a monthly repeat with unsupported_repeat", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "month" } })));
    expect(err.code).toBe("unsupported_repeat");
    expect(err.message).toContain("monthly");
  });

  it("refuses an 'end of month' repeat", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "end_of_month" } })),
    );
    expect(err.code).toBe("unsupported_repeat");
  });

  it("refuses a one-shot asking for many runs", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ runs: 5 })));
    expect(err.code).toBe("unsupported_repeat");
  });

  it("refuses a custom repeat without customSeconds", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "custom" } })),
    );
    expect(err.code).toBe("unsupported_repeat");
  });

  it("refuses runs = 0", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(baseDraft({ repeat: { every: "day" }, runs: 0 })),
    );
    expect(err.code).toBe("invalid_intent");
  });

  it("refuses an invalid timezone", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(
        baseDraft({ firstRun: { localDate: "2026-09-20", localTime: "15:00", timeZone: "Nope/Nope" } }),
      ),
    );
    expect(err.code).toBe("invalid_time");
  });

  it("refuses a non-existent (DST gap) local time", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(
        baseDraft({ firstRun: { localDate: "2026-03-29", localTime: "02:30", timeZone: "Europe/Berlin" } }),
      ),
    );
    expect(err.code).toBe("time_does_not_exist");
  });

  it("refuses a first run in the past", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc))(
        baseDraft({ firstRun: { localDate: "2026-09-18", localTime: "15:00", timeZone: "Europe/Istanbul" } }),
      ),
    );
    expect(err.code).toBe("time_in_past");
  });

  it("refuses a malformed firstRun", async () => {
    const rpc = new FakeGuardRpc();
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ firstRun: "tomorrow" })));
    expect(err.code).toBe("invalid_time");
  });
});

describe("schedulePayment — guard pre-checks and their order", () => {
  it("refuses with guard_rule_missing when the owner has no rule", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: null });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft()));
    expect(err.code).toBe("guard_rule_missing");
  });

  it("refuses a disallowed asset before the per-tx check", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, allowed_assets: [GUARD_ID_2], per_tx_limit: 40_000000n } });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: "50" })));
    expect(err.code).toBe("asset_not_allowed");
  });

  it("refuses above per_tx_limit", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: { ...RULE, per_tx_limit: 40_000000n } });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: "50" })));
    expect(err.code).toBe("amount_over_per_tx_limit");
  });

  it("refuses when the owner already has 25 active schedules", async () => {
    const rpc = new FakeGuardRpc();
    const many = Array.from({ length: 25 }, (_, i) => schedule({ id: i + 1 }));
    scriptCreate(rpc, { schedules: many });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft()));
    expect(err.code).toBe("too_many_schedules");
    expect(err.details?.activeCount).toBe(25);
  });

  it("refuses an insufficient allowance, carrying the needed raw amount", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc);
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc, { getAllowance: async () => 100_000000n }))(
        baseDraft({ repeat: { every: "week" }, runs: 8 }),
      ),
    );
    expect(err.code).toBe("allowance_insufficient");
    expect(err.details?.neededRaw).toBe(4_000_000000n);
    expect(err.details?.availableRaw).toBe(100_000000n);
  });

  it("orders rule-missing before too-many-schedules", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { rule: null, schedules: Array.from({ length: 25 }, (_, i) => schedule({ id: i })) });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft()));
    expect(err.code).toBe("guard_rule_missing");
  });

  it("orders per-tx-limit before too-many-schedules", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, {
      rule: { ...RULE, per_tx_limit: 40_000000n },
      schedules: Array.from({ length: 25 }, (_, i) => schedule({ id: i })),
    });
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft({ amount: "50" })));
    expect(err.code).toBe("amount_over_per_tx_limit");
  });

  it("orders too-many-schedules before allowance", async () => {
    const rpc = new FakeGuardRpc();
    scriptCreate(rpc, { schedules: Array.from({ length: 25 }, (_, i) => schedule({ id: i })) });
    const err = await refusalOf(() =>
      schedulePayment(deps(rpc, { getAllowance: async () => 0n }))(baseDraft()),
    );
    expect(err.code).toBe("too_many_schedules");
  });

  it("maps a NotConfigured simulation failure to guard_rule_missing", async () => {
    const rpc = new FakeGuardRpc();
    rpc.sims = [errSim("HostError: Error(Contract, #100)")];
    const err = await refusalOf(() => schedulePayment(deps(rpc))(baseDraft()));
    expect(err.code).toBe("guard_rule_missing");
  });

  it("refuses with not_configured when the guard client is missing", () => {
    const err = syncRefusal(() =>
      schedulePayment({
        ownerAddress: OWNER,
        aliases: {},
        assets: { get: () => undefined },
      } as never),
    );
    expect(err.code).toBe("not_configured");
  });

  it("refuses with not_configured for a null deps object", () => {
    const err = syncRefusal(() => schedulePayment(null as never));
    expect(err.code).toBe("not_configured");
  });
});
