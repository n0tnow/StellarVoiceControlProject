import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../config.ts";
import { AnchorHttpError } from "../http.ts";
import { ensureCustomer, KycRequiredError } from "../sep12.ts";
import { getPrice, QuoteError } from "../sep38.ts";
import {
  buildWithdrawPayment,
  classifyStatus,
  explainStatus,
  getInfo,
  parseTransaction,
  pollTransaction,
  PollTimeoutError,
  startDeposit,
  startWithdraw,
} from "../sep6.ts";
import type { AnchorTransaction } from "../types.ts";
import { CLIENT, fakeFetch, HOME, jsonResponse, makeCtx, SERVER, TOKEN, TOML, USDC_ISSUER } from "./helpers.ts";

const TRY = "iso4217:TRY";
const USDC = `stellar:USDC:${USDC_ISSUER}`;

describe("SEP-38 quote", () => {
  const price = { total_price: "49.0290051", price: "48.785078", sell_amount: "100.00", buy_amount: "2.0396090", fee: { total: "0.50", asset: TRY } };

  it("requests /price with sell_asset/buy_asset and returns decimal strings", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${HOME}/sep38/price`]: price });
    const ctx = makeCtx(fetch);
    const q = await getPrice(ctx, TOML, { sellAsset: TRY, buyAsset: USDC, sellAmount: "100", deliveryMethod: "bank_account" }, "if you deposit 100 TRY, how much USDC would you get?");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("sell_asset")).toBe(TRY);
    expect(url.searchParams.get("buy_asset")).toBe(USDC);
    expect(url.searchParams.get("sell_amount")).toBe("100");
    expect(url.searchParams.get("sell_delivery_method")).toBe("bank_account");
    expect(url.searchParams.get("context")).toBe("sep6");
    expect(q).toMatchObject({ sellAmount: "100.00", buyAmount: "2.0396090", totalPrice: "49.0290051", feeTotal: "0.50", feeAsset: TRY });
    const rec = ctx.explain.all()[0]!;
    expect(rec.step).toBe("sep38.price");
    expect(rec.what).toContain("100.00 TRY would become about 2.0396090 USDC");
    expect(rec.what).toContain("fee is 0.50 TRY");
  });

  it("uses buy_delivery_method when buying the off-chain asset (withdraw direction)", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${HOME}/sep38/price`]: { ...price, sell_amount: "1", buy_amount: "48.54", total_price: "0.0206", price: "0.0205" } });
    await getPrice(makeCtx(fetch), TOML, { sellAsset: USDC, buyAsset: TRY, sellAmount: "1", deliveryMethod: "bank_account" }, "x");
    expect(new URL(calls[0]!.url).searchParams.get("buy_delivery_method")).toBe("bank_account");
  });

  it("validates its inputs and the response", async () => {
    const { fetch } = fakeFetch({ [`GET ${HOME}/sep38/price`]: { total_price: "1" } });
    const ctx = makeCtx(fetch);
    await expect(getPrice(ctx, TOML, { sellAsset: TRY, buyAsset: USDC }, "x")).rejects.toThrow(/exactly one/);
    await expect(getPrice(ctx, TOML, { sellAsset: TRY, buyAsset: USDC, sellAmount: "1", buyAmount: "1" }, "x")).rejects.toThrow(/exactly one/);
    await expect(getPrice(ctx, TOML, { sellAsset: TRY, buyAsset: USDC, sellAmount: "1" }, "x")).rejects.toThrow(QuoteError);
    await expect(getPrice(ctx, { ...TOML, quoteServer: undefined as never }, { sellAsset: TRY, buyAsset: USDC, sellAmount: "1" }, "x")).rejects.toThrow(/SEP-38/);
  });
});

describe("SEP-12 customer", () => {
  it("PUTs once when NEEDS_INFO and then confirms ACCEPTED", async () => {
    let accepted = false;
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: () => (accepted ? { id: "cus_1", status: "ACCEPTED" } : { status: "NEEDS_INFO", fields: { first_name: { optional: true } } }),
      [`PUT ${HOME}/sep12/customer`]: () => {
        accepted = true;
        return new Response(JSON.stringify({ id: "cus_1" }), { status: 202 });
      },
    });
    const ctx = makeCtx(fetch);
    const info = await ensureCustomer(ctx, TOML, TOKEN);
    expect(info.status).toBe("ACCEPTED");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(ctx.explain.all()[0]?.step).toBe("sep12.customer");
  });

  it("does not PUT when already accepted", async () => {
    const { fetch, calls } = fakeFetch({ [`GET ${HOME}/sep12/customer`]: { status: "ACCEPTED" } });
    await ensureCustomer(makeCtx(fetch), TOML, TOKEN);
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });

  it("surfaces required fields instead of inventing personal data", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: { status: "NEEDS_INFO", fields: { id_number: { optional: false }, nickname: { optional: true } } },
      [`PUT ${HOME}/sep12/customer`]: { id: "x" },
    });
    const err = await ensureCustomer(makeCtx(fetch), TOML, TOKEN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KycRequiredError);
    expect((err as KycRequiredError).missingFields).toEqual(["id_number"]);
  });
});

describe("SEP-6 deposit / withdraw requests", () => {
  it("info reports per-asset capability and narrates it", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/info`]: { deposit: { USDC: { enabled: true, min_amount: 0.5, max_amount: 300, fee_percent: 0.5 } }, withdraw: { USDC: { enabled: true } } },
    });
    const ctx = makeCtx(fetch);
    const info = await getInfo(ctx, TOML, "USDC");
    expect(info.deposit.USDC).toEqual({ enabled: true, minAmount: 0.5, maxAmount: 300, feePercent: 0.5 });
    expect(ctx.explain.all()[0]?.what).toContain("deposits and withdrawals");
  });

  it("deposit sends the bearer token and parses bank instructions", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep6/deposit`]: {
        id: "sep_1",
        how: "Send TRY to IBAN ...",
        instructions: { bank_account_number: { value: "TR05...", description: "IBAN" } },
        min_amount: 50,
        max_amount: 3000,
        fee_percent: 0.5,
        eta: 5,
      },
    });
    const ctx = makeCtx(fetch);
    const d = await startDeposit(ctx, TOML, TOKEN, { assetCode: "USDC", account: CLIENT.publicKey(), amount: "50", fiatCode: "TRY" });
    expect(d).toMatchObject({ id: "sep_1", minAmount: 50, maxAmount: 3000, feePercent: 0.5, eta: 5 });
    expect(d.instructions?.bank_account_number?.value).toBe("TR05...");
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get("asset_code")).toBe("USDC");
    expect(url.searchParams.get("amount")).toBe("50");
    expect(url.searchParams.get("account")).toBe(CLIENT.publicKey());
    expect(ctx.explain.all()[0]?.what).toContain("turn 50 TRY into USDC");
  });

  it("maps a 403 non_interactive_customer_info_needed to KycRequiredError", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/deposit`]: () => jsonResponse({ type: "non_interactive_customer_info_needed", fields: ["first_name", "tax_id"] }, 403),
    });
    const err = await startDeposit(makeCtx(fetch), TOML, TOKEN, { assetCode: "USDC", account: "G", amount: "50" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KycRequiredError);
    expect((err as KycRequiredError).missingFields).toEqual(["first_name", "tax_id"]);
  });

  it("keeps other anchor errors (e.g. minimum amount) readable", async () => {
    const { fetch } = fakeFetch({ [`GET ${HOME}/sep6/withdraw`]: () => jsonResponse({ error: "Minimum off-ramp is 1.0000000 USDC" }, 400) });
    const err = await startWithdraw(makeCtx(fetch), TOML, TOKEN, { assetCode: "USDC", account: "G", amount: "0.5" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnchorHttpError);
    expect((err as Error).message).toContain("Minimum off-ramp is 1.0000000 USDC");
  });

  it("withdraw returns the account + validated memo to pay", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/withdraw`]: { account_id: SERVER.publicKey(), memo_type: "id", memo: "523107803354", id: "sep_w1", min_amount: 1, fee_percent: 0.5 },
    });
    const ctx = makeCtx(fetch);
    const w = await startWithdraw(ctx, TOML, TOKEN, { assetCode: "USDC", account: CLIENT.publicKey(), amount: "1" });
    expect(w).toMatchObject({ id: "sep_w1", accountId: SERVER.publicKey(), memo: { type: "id", value: "523107803354" } });
    expect(ctx.explain.all()[0]?.what).toContain("with id memo 523107803354");
  });

  it("builds the withdrawal payment with the anchor's memo type (id) and asset", () => {
    const xdr = buildWithdrawPayment({
      sourceAccount: CLIENT.publicKey(),
      sequence: "100",
      networkPassphrase: TESTNET_PASSPHRASE,
      asset: { code: "USDC", issuer: USDC_ISSUER },
      amount: "1.0000000",
      destination: SERVER.publicKey(),
      memo: { type: "id", value: "523107803354" },
    });
    const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.sequence).toBe("101");
    expect(tx.memo.type).toBe("id");
    expect(String(tx.memo.value)).toBe("523107803354");
    const op = tx.operations[0]!;
    expect(op.type).toBe("payment");
    if (op.type === "payment") {
      expect(op.destination).toBe(SERVER.publicKey());
      expect(op.amount).toBe("1.0000000");
      expect(op.asset.code).toBe("USDC");
      expect(op.asset.issuer).toBe(USDC_ISSUER);
    }
    expect(() =>
      buildWithdrawPayment({
        sourceAccount: CLIENT.publicKey(),
        sequence: "1",
        networkPassphrase: TESTNET_PASSPHRASE,
        asset: { code: "USDC", issuer: USDC_ISSUER },
        amount: "1",
        destination: "not-a-key",
      }),
    ).toThrow(/plain G/);
  });
});

describe("SEP-6 status classification and narration", () => {
  it("classifies every SEP-6 status", () => {
    expect(classifyStatus("completed")).toBe("success");
    for (const s of ["refunded", "expired", "no_market", "too_small", "too_large", "error"]) expect(classifyStatus(s)).toBe("failed");
    expect(classifyStatus("pending_trust")).toBe("needs_trustline");
    expect(classifyStatus("pending_user")).toBe("needs_user");
    expect(classifyStatus("pending_user_transfer_start")).toBe("waiting_user_transfer");
    for (const s of ["pending_anchor", "pending_stellar", "pending_external", "pending_user_transfer_complete", "something_new"]) expect(classifyStatus(s)).toBe("in_progress");
  });

  it("explains pending_trust as the missing-trustline gotcha (anchor text never enters the narration)", () => {
    const e = explainStatus("deposit", { status: "pending_trust" });
    expect(e.what).toMatch(/HOLDING the deposit/);
    expect(e.why).toMatch(/trustline/);
  });

  it("parses a transaction record, sanitising text and dropping unknown fields", () => {
    const tx = parseTransaction({
      id: "a",
      kind: "withdrawal",
      status: "completed",
      amount_in: "1.0",
      amount_out: "48.54",
      amount_out_asset: TRY,
      withdraw_memo_type: "id",
      withdraw_memo: "4242",
      completed_at: null,
      message: "all\n good",
      extra: 1,
    });
    expect(tx).toMatchObject({ id: "a", kind: "withdrawal", status: "completed", amountIn: "1.0", amountOut: "48.54", withdrawMemoType: "id", withdrawMemo: "4242", completedAt: null });
    expect(tx.message).toBe("all good");
    expect("extra" in tx).toBe(false);
    expect("raw" in tx).toBe(false);
  });
});

describe("SEP-6 polling state machine", () => {
  /** Serves the given statuses in order (last one repeats). */
  function statusServer(statuses: string[]) {
    let i = 0;
    return fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: () => ({ transaction: { id: "t1", kind: "deposit", status: statuses[Math.min(i++, statuses.length - 1)], message: `m${i}` } }),
    });
  }

  it("walks pending states to completed, one explain record per CHANGE", async () => {
    const { fetch } = statusServer(["pending_user_transfer_start", "pending_user_transfer_start", "pending_anchor", "pending_stellar", "completed"]);
    const ctx = makeCtx(fetch);
    const r = await pollTransaction(ctx, TOML, TOKEN, "t1", { intervalMs: 1000 });
    expect(r.outcome).toBe("completed");
    expect(r.history).toEqual(["pending_user_transfer_start", "pending_anchor", "pending_stellar", "completed"]);
    expect(ctx.explain.all().map((x) => x.step)).toEqual([
      "sep6.status.pending_user_transfer_start",
      "sep6.status.pending_anchor",
      "sep6.status.pending_stellar",
      "sep6.status.completed",
    ]);
  });

  it("returns outcome 'failed' (no throw) for refunded / expired / error", async () => {
    for (const s of ["refunded", "expired", "error", "too_small"]) {
      const { fetch } = statusServer(["pending_anchor", s]);
      const r = await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1", { intervalMs: 10 });
      expect(r.outcome).toBe("failed");
      expect(r.tx.status).toBe(s);
    }
  });

  it("stops at requested statuses (e.g. to let the wallet pay a withdrawal)", async () => {
    const { fetch } = statusServer(["pending_user_transfer_start", "completed"]);
    const r = await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1", { stopAt: ["pending_user_transfer_start"] });
    expect(r.outcome).toBe("stopped");
    expect(r.tx.status).toBe("pending_user_transfer_start");
  });

  it("pending_trust WITHOUT a handler stops so the caller can decide", async () => {
    const { fetch } = statusServer(["pending_anchor", "pending_trust"]);
    const ctx = makeCtx(fetch);
    const r = await pollTransaction(ctx, TOML, TOKEN, "t1", { intervalMs: 10 });
    expect(r.outcome).toBe("stopped");
    expect(r.tx.status).toBe("pending_trust");
    expect(ctx.explain.all().at(-1)?.what).toMatch(/HOLDING the deposit/);
  });

  it("pending_trust WITH a handler repairs once, keeps polling, and completes", async () => {
    const { fetch } = statusServer(["pending_trust", "pending_trust", "pending_trust", "completed"]);
    let repaired = 0;
    const r = await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1", {
      intervalMs: 10,
      onPendingTrust: async () => {
        repaired++;
      },
    });
    expect(repaired).toBe(1); // not once per poll
    expect(r.outcome).toBe("completed");
    expect(r.history).toEqual(["pending_trust", "completed"]);
  });

  it("stops on pending_user (anchor needs input from us)", async () => {
    const { fetch } = statusServer(["pending_user"]);
    const r = await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1");
    expect(r.outcome).toBe("stopped");
  });

  it("times out with the last known transaction", async () => {
    const { fetch, calls } = statusServer(["pending_anchor"]);
    const err = (await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1", { intervalMs: 1000, timeoutMs: 5000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect((err.last as AnchorTransaction).status).toBe("pending_anchor");
    expect(calls.length).toBe(6); // t=0..5s inclusive at 1s steps
  });
});
