import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { TESTNET_PASSPHRASE } from "../config.ts";
import { ExplainLog } from "../explain.ts";
import { AnchorHttpError } from "../http.ts";
import { ensureCustomer, ensureTransactionCustomer, KycRequiredError } from "../sep12.ts";
import { getPrice, QuoteError } from "../sep38.ts";
import {
  anchorOwnedLink,
  buildWithdrawPayment,
  classifyStatus,
  composeTimeoutMessage,
  explainStatus,
  getInfo,
  MAX_POLL_TIMEOUT_MESSAGE,
  parseTransaction,
  pollTransaction,
  PollTimeoutError,
  quoteAnchorText,
  startDeposit,
  startWithdraw,
  TR_MOCK_PAYOUT_HINT,
} from "../sep6.ts";
import type { AnchorToml, AnchorTransaction } from "../types.ts";
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

  it("auto-fills ONLY the requested fields it was given (SDF demo KYC)", async () => {
    let accepted = false;
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: () =>
        accepted
          ? { id: "c", status: "ACCEPTED" }
          : { status: "NEEDS_INFO", fields: { first_name: { optional: false }, last_name: { optional: false }, email_address: { optional: false }, nickname: { optional: true } } },
      [`PUT ${HOME}/sep12/customer`]: (_u: URL, init: RequestInit) => {
        // The optional `nickname` is never sent, and only the demo values are.
        expect(JSON.parse(String(init.body))).toEqual({ account: TOKEN.account, first_name: "Demo", last_name: "User", email_address: "demo@polaris.invalid" });
        accepted = true;
        return new Response(JSON.stringify({ id: "c" }), { status: 202 });
      },
    });
    const info = await ensureCustomer(makeCtx(fetch), TOML, TOKEN, { first_name: "Demo", last_name: "User", email_address: "demo@polaris.invalid" });
    expect(info.status).toBe("ACCEPTED");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
  });

  it("submits per-transaction KYC with transaction_id and resumes (SDF test anchor)", async () => {
    let accepted = false;
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: () =>
        accepted ? { status: "ACCEPTED" } : { status: "NEEDS_INFO", fields: { address: { optional: false }, id_number: { optional: false }, nickname: { optional: true } } },
      [`PUT ${HOME}/sep12/customer`]: (_u: URL, init: RequestInit) => {
        expect(JSON.parse(String(init.body))).toEqual({ account: TOKEN.account, transaction_id: "tx1", address: "1 Test Street", id_number: "TEST-0000001" });
        accepted = true;
        return new Response(JSON.stringify({ id: "c" }), { status: 202 });
      },
    });
    const ctx = makeCtx(fetch);
    const info = await ensureTransactionCustomer(ctx, TOML, TOKEN, "tx1", { address: "1 Test Street", id_number: "TEST-0000001" });
    expect(info.status).toBe("ACCEPTED");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls[0]!.url).toContain("transaction_id=tx1");
    expect(ctx.explain.all()[0]?.step).toBe("sep12.transaction");
  });

  it("stops per-transaction KYC when a requested field is not supplied", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: { status: "NEEDS_INFO", fields: { id_number: { optional: false }, tax_id: { optional: false } } },
      [`PUT ${HOME}/sep12/customer`]: { id: "x" },
    });
    const err = await ensureTransactionCustomer(makeCtx(fetch), TOML, TOKEN, "tx1", { id_number: "TEST-0000001" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KycRequiredError);
    expect((err as KycRequiredError).missingFields).toEqual(["tax_id"]);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("refuses when a requested field has no supplied value (never invents the rest)", async () => {
    const { fetch, calls } = fakeFetch({
      [`GET ${HOME}/sep12/customer`]: { status: "NEEDS_INFO", fields: { first_name: { optional: false }, id_number: { optional: false } } },
      [`PUT ${HOME}/sep12/customer`]: { id: "x" },
    });
    const err = await ensureCustomer(makeCtx(fetch), TOML, TOKEN, { first_name: "Demo" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KycRequiredError);
    expect((err as KycRequiredError).missingFields).toEqual(["id_number"]);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
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

  it("tolerates a deferred payout account (the anchor returns only {id} at first)", async () => {
    const { fetch } = fakeFetch({ [`GET ${HOME}/sep6/withdraw`]: { id: "sep_w2" } });
    const w = await startWithdraw(makeCtx(fetch), TOML, TOKEN, { assetCode: "USDC", account: CLIENT.publicKey(), amount: "1" });
    expect(w.id).toBe("sep_w2");
    expect(w.accountId).toBeUndefined();
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
    for (const s of ["pending_anchor", "pending_stellar", "pending_external", "pending_user_transfer_complete", "incomplete", "something_new"]) expect(classifyStatus(s)).toBe("in_progress");
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

  it("runs the per-transaction KYC handler once, then resumes polling to completed", async () => {
    const statuses = ["pending_customer_info_update", "pending_anchor", "completed"];
    let i = 0;
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: () => ({ transaction: { id: "t1", kind: "deposit", status: statuses[Math.min(i++, statuses.length - 1)] } }),
    });
    let handled = 0;
    const r = await pollTransaction(makeCtx(fetch), TOML, TOKEN, "t1", {
      intervalMs: 10,
      onCustomerInfoRequired: async () => {
        handled++;
      },
    });
    expect(handled).toBe(1);
    expect(r.outcome).toBe("completed");
    expect(r.history).toEqual(["pending_customer_info_update", "pending_anchor", "completed"]);
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

  it("narrates and reports the anchor's last message + more_info_url when a deposit is stuck (live 2026-09-20 regression)", async () => {
    const stuckMessage = "TRY received; paying USDC on Stellar.";
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: {
        transaction: {
          id: "sep_stuck",
          kind: "deposit",
          status: "pending_anchor",
          message: stuckMessage,
          more_info_url: `https://${HOME}/sep6/tx/sep_stuck`,
        },
      },
    });
    const ctx = makeCtx(fetch);
    const err = (await pollTransaction(ctx, TOML, TOKEN, "sep_stuck", { intervalMs: 1000, timeoutMs: 5000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain('still "pending_anchor"');
    expect(err.message).toContain(stuckMessage);
    expect(err.message).toContain(`https://${HOME}/sep6/tx/sep_stuck`);
    const rec = ctx.explain.all().at(-1)!;
    expect(rec.step).toBe("sep6.timeout");
    expect(rec.anchorSaid).toBe(stuckMessage);
    expect(rec.what).not.toContain(stuckMessage); // anchor text never enters the narration
    expect(rec.what).not.toContain("testanchor.stellar.org"); // the TR hint is TR-only
  });

  it("adds the TR-mock payout hint to the timeout narration and error (TR domain only)", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: { transaction: { id: "sep_tr", kind: "deposit", status: "pending_anchor" } },
    });
    const ctx = makeCtx(fetch);
    const trToml = { ...TOML, homeDomain: "tr-mock-anchor.fly.dev" };
    const err = (await pollTransaction(ctx, trToml, TOKEN, "sep_tr", { intervalMs: 1000, timeoutMs: 5000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).toContain("anchor:check");
    expect(err.message).toContain("testanchor.stellar.org");
    const rec = ctx.explain.all().at(-1)!;
    expect(rec.step).toBe("sep6.timeout");
    expect(rec.what).toContain("TR mock anchor accepted the order but has not paid out");
    expect(rec.what).toContain("anchor:check");
    expect(rec.why).not.toContain("testanchor.stellar.org");
  });
});

describe("SEP-6 timeout link host restriction (B1), quoting (N2) and message cap (N1)", () => {
  const TR_HOME = "tr-mock-anchor.fly.dev";
  const TR_TOML: AnchorToml = {
    ...TOML,
    homeDomain: TR_HOME,
    webAuthEndpoint: `https://${TR_HOME}/auth`,
    transferServer: `https://${TR_HOME}/sep6`,
  };

  it.each<[string, unknown, string | undefined]>([
    ["off-host https link", "https://attacker.example/x", undefined],
    ["suffix look-alike host", "https://tr-mock-anchor.fly.dev.evil.com/x", undefined],
    ["userinfo host trick", "https://tr-mock-anchor.fly.dev@evil.com/", undefined],
    ["plain http", "http://tr-mock-anchor.fly.dev/x", undefined],
    ["uppercase host", "https://TR-MOCK-ANCHOR.FLY.DEV/x", "https://tr-mock-anchor.fly.dev/x"],
    ["protocol-relative", "//tr-mock-anchor.fly.dev/x", undefined],
    ["javascript: scheme", "javascript:alert(1)", undefined],
    ["ip literal", "https://93.184.216.34/x", undefined],
    ["over-long URL", `https://${TR_HOME}/${"a".repeat(400)}`, undefined],
    ["control characters", `https://${TR_HOME}/\u0000x`, undefined],
    ["non-string", 42, undefined],
  ])("anchorOwnedLink refuses/accepts: %s", (_name, input, expected) => {
    expect(anchorOwnedLink(input, TR_TOML)).toBe(expected);
  });

  it("accepts a host declared by a toml endpoint, not only the home domain", () => {
    const toml: AnchorToml = { ...TOML, homeDomain: "anchor.example.test", webAuthEndpoint: "https://auth.example.test/auth" };
    expect(anchorOwnedLink("https://auth.example.test/session", toml)).toBe("https://auth.example.test/session");
    expect(anchorOwnedLink("https://other.example.test/session", toml)).toBeUndefined();
  });

  it("N6: ExplainLog.record only accepts an anchor-owned link at the boundary", () => {
    const log = new ExplainLog();
    const owned = anchorOwnedLink(`https://${HOME}/session`, TOML);
    expect(owned).toBeDefined();
    const rec = log.record("sep6.link", "A link was attached.", "It is on the anchor's own host.", { link: owned });
    expect(rec.link).toBe(`https://${HOME}/session`);
    // A plain https string is not an AnchorOwnedLink: the boundary rejects it at compile time.
    // @ts-expect-error link must be produced by anchorOwnedLink (branded AnchorOwnedLink)
    log.record("sep6.link", "Unchecked link.", "This must not compile.", { link: "https://evil.example/x" });
  });

  it("quotes and escapes an anchor message so embedded double quotes cannot break the quoting", () => {
    expect(quoteAnchorText('a "b" c')).toBe('"a \\"b\\" c"');
  });

  it("composeTimeoutMessage caps the text and drops the link when it does not fit", () => {
    const base = 'order x is still "pending_anchor" after 180s';
    const said = "x".repeat(200);
    const link = ` (order details: https://${TR_HOME}/${"a".repeat(250)})`;
    const out = composeTimeoutMessage(base, said, link, ` ${TR_MOCK_PAYOUT_HINT}`);
    expect(out.length).toBeLessThanOrEqual(MAX_POLL_TIMEOUT_MESSAGE);
    expect(out).not.toContain("order details");
    const small = composeTimeoutMessage(base, said, " (order details: https://x.test)", "");
    expect(small).toContain("order details");
    expect(small.length).toBeLessThanOrEqual(MAX_POLL_TIMEOUT_MESSAGE);
  });

  it("omits an off-host more_info_url and says it was withheld", async () => {
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: {
        transaction: {
          id: "sep_off",
          kind: "deposit",
          status: "pending_anchor",
          message: "TRY received",
          more_info_url: `https://${TR_HOME}/sep6/tx/sep_off`,
        },
      },
    });
    const ctx = makeCtx(fetch);
    const err = (await pollTransaction(ctx, TOML, TOKEN, "sep_off", { intervalMs: 1000, timeoutMs: 3000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err).toBeInstanceOf(PollTimeoutError);
    expect(err.message).not.toContain(TR_HOME);
    expect(err.message).toContain("(link withheld: not on the anchor's host)");
    const rec = ctx.explain.all().at(-1)!;
    expect(rec.step).toBe("sep6.timeout");
    expect(rec.link).toBeUndefined();
    expect(rec.what).toContain("link withheld: not on the anchor's host");
  });

  it("includes an on-host more_info_url in the error and the explain record", async () => {
    const url = `https://${HOME}/sep6/tx/sep_on`;
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: {
        transaction: { id: "sep_on", kind: "deposit", status: "pending_anchor", more_info_url: url },
      },
    });
    const ctx = makeCtx(fetch);
    const err = (await pollTransaction(ctx, TOML, TOKEN, "sep_on", { intervalMs: 1000, timeoutMs: 3000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err.message).toContain(url);
    const rec = ctx.explain.all().at(-1)!;
    expect(rec.link).toBe(url);
  });

  it("escapes embedded double quotes in the reported anchor message", async () => {
    const message = 'He said "send USDC" now';
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: {
        transaction: { id: "sep_q", kind: "deposit", status: "pending_anchor", message },
      },
    });
    const ctx = makeCtx(fetch);
    const err = (await pollTransaction(ctx, TOML, TOKEN, "sep_q", { intervalMs: 1000, timeoutMs: 3000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err.message).toContain('\\"send USDC\\"');
    expect(err.message).not.toContain('"send USDC"');
    expect(ctx.explain.all().at(-1)?.anchorSaid).toBe(message);
  });

  it("caps the composed error at MAX and keeps an over-long link only in the explain record", async () => {
    const id = "t".repeat(80);
    const longMessage = "m".repeat(200);
    const longUrl = `https://${HOME}/sep6/tx/${"a".repeat(240)}`;
    const { fetch } = fakeFetch({
      [`GET ${HOME}/sep6/transaction`]: {
        transaction: { id, kind: "deposit", status: "pending_anchor", message: longMessage, more_info_url: longUrl },
      },
    });
    const ctx = makeCtx(fetch);
    const err = (await pollTransaction(ctx, TOML, TOKEN, id, { intervalMs: 1000, timeoutMs: 3000 }).catch((e: unknown) => e)) as PollTimeoutError;
    expect(err.message.length).toBeLessThanOrEqual(MAX_POLL_TIMEOUT_MESSAGE);
    expect(err.message).not.toContain(longUrl);
    expect(ctx.explain.all().at(-1)?.link).toBe(longUrl);
  });
});
