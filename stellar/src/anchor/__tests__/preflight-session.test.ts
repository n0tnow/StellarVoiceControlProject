import { TransactionBuilder, type Transaction } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { assertAmount } from "../amount.ts";
import { describeXdr, configureAnchor, depositTry, withdrawTry } from "../chainTools.ts";
import { TESTNET_PASSPHRASE } from "../config.ts";
import { preflight } from "../preflight.ts";
import { AnchorSession } from "../session.ts";
import { runDepositFlow, runWithdrawFlow } from "../flows.ts";
import { EnvSigner } from "../testing.ts";
import type { Signer } from "../types.ts";
import { combine, CLIENT, fakeChain, fakeClock, fakeJwt, HOME, makeChallenge, makeCtx, SERVER, TOML_TEXT, USDC_ISSUER } from "./helpers.ts";

const ASSET = { code: "USDC", issuer: USDC_ISSUER };
const signer = new EnvSigner(CLIENT.secret());

function countingSigner(): Signer & { signed: string[] } {
  const signed: string[] = [];
  return {
    signed,
    publicKey: () => signer.publicKey(),
    signTransaction: async (x, o) => {
      signed.push(x);
      return signer.signTransaction(x, o);
    },
  };
}

describe("preflight (friendbot + trustline)", () => {
  it("funds a brand-new account, then adds the trustline through the signer", async () => {
    const chain = fakeChain({ account: CLIENT.publicKey() });
    const { fetch, calls } = combine(chain, {});
    const ctx = makeCtx(fetch);
    const s = countingSigner();
    const r = await preflight(ctx, s, ASSET);
    expect(r.actions).toEqual(["friendbot_funded", "trustline_created"]);
    expect(chain.state.friendbotCalls).toBe(1);
    expect(s.signed).toHaveLength(1);
    // What the signer was asked to sign is exactly a changeTrust for USDC.
    const tx = TransactionBuilder.fromXDR(s.signed[0]!, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.operations.map((o) => o.type)).toEqual(["changeTrust"]);
    expect(tx.source).toBe(CLIENT.publicKey());
    expect(ctx.explain.all().map((x) => x.step)).toEqual(["preflight.fund", "preflight.trustline"]);
    expect(calls.some((c) => c.url.startsWith("https://friendbot.example.test"))).toBe(true);
  });

  it("is idempotent: a ready account causes no writes and no signing", async () => {
    const chain = fakeChain({ account: CLIENT.publicKey(), exists: true, trustline: true });
    const { fetch } = combine(chain, {});
    const ctx = makeCtx(fetch);
    const s = countingSigner();
    const r = await preflight(ctx, s, ASSET);
    expect(r.actions).toEqual([]);
    expect(s.signed).toHaveLength(0);
    expect(chain.state.submitted).toHaveLength(0);
    expect(chain.state.friendbotCalls).toBe(0);
    expect(ctx.explain.all()[0]?.step).toBe("preflight.ready");
  });

  it("only adds the trustline when the account exists but does not trust the asset", async () => {
    const chain = fakeChain({ account: CLIENT.publicKey(), exists: true });
    const { fetch } = combine(chain, {});
    const r = await preflight(makeCtx(fetch), countingSigner(), ASSET);
    expect(r.actions).toEqual(["trustline_created"]);
    expect(chain.state.friendbotCalls).toBe(0);
  });

  it("will not fund a missing account off testnet", async () => {
    const chain = fakeChain({ account: CLIENT.publicKey() });
    const { fetch } = combine(chain, {});
    const ctx = makeCtx(fetch, { networkPassphrase: "Public Global Stellar Network ; September 2015" });
    await expect(preflight(ctx, countingSigner(), ASSET)).rejects.toThrow(/cannot be funded/);
    expect(chain.state.friendbotCalls).toBe(0);
  });
});

describe("assertAmount", () => {
  it("accepts decimal strings and rejects everything else", () => {
    for (const ok of ["1", "50", "0.5", "1.2345678"]) expect(() => assertAmount(ok)).not.toThrow();
    for (const bad of ["", "0", "-1", "1e3", "1.23456789", "abc", " 5", "5 "]) expect(() => assertAmount(bad)).toThrow(/decimal string/);
    expect(() => assertAmount(5 as unknown as string)).toThrow();
  });
});

/** A complete fake anchor + chain, so whole flows run offline. */
function fullWorld(opts: { startTrustline: boolean }) {
  const chain = fakeChain({ account: CLIENT.publicKey(), exists: true, trustline: opts.startTrustline, usdc: "0" });
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const orders: Record<string, { kind: string; status: string; amount: string }> = {};
  let seq = 0;
  const statusOf = (id: string): string => {
    const o = orders[id]!;
    if (o.kind === "deposit" && o.status === "pending_anchor") {
      if (!chain.state.trustline) return "pending_trust";
      chain.state.usdc = "1.0198045";
      o.status = "completed";
    }
    if (o.kind === "deposit" && o.status === "pending_trust" && chain.state.trustline) {
      chain.state.usdc = "1.0198045";
      o.status = "completed";
    }
    return o.status;
  };
  const world = combine(chain, {
    [`GET ${HOME}/.well-known/stellar.toml`]: TOML_TEXT,
    [`GET ${HOME}/auth`]: () => ({ transaction: makeChallenge(), network_passphrase: TESTNET_PASSPHRASE }),
    [`POST ${HOME}/auth`]: { token: fakeJwt({ sub: CLIENT.publicKey(), exp }) },
    [`GET ${HOME}/sep12/customer`]: { status: "ACCEPTED", id: "cus_1" },
    [`GET ${HOME}/sep38/price`]: (u: URL) =>
      u.searchParams.get("sell_asset")!.startsWith("iso4217")
        ? { total_price: "49.03", price: "48.78", sell_amount: "50.00", buy_amount: "1.0198045", fee: { total: "0.25", asset: "iso4217:TRY" } }
        : { total_price: "0.0206", price: "0.0205", sell_amount: "1", buy_amount: "48.54", fee: { total: "0.005", asset: `stellar:USDC:${USDC_ISSUER}` } },
    [`GET ${HOME}/sep6/deposit`]: () => {
      const id = `dep_${++seq}`;
      orders[id] = { kind: "deposit", status: "pending_user_transfer_start", amount: "50" };
      return { id, how: "Send TRY to IBAN X", instructions: { bank_account_number: { value: "TR00", description: "IBAN" } }, min_amount: 50, max_amount: 3000 };
    },
    [`POST ${HOME}/sep6/tx/dep_1/simulate-bank-transfer`]: () => {
      orders.dep_1!.status = "pending_anchor";
      return { ok: true };
    },
    [`GET ${HOME}/sep6/withdraw`]: () => {
      const id = `wd_${++seq}`;
      orders[id] = { kind: "withdrawal", status: "pending_user_transfer_start", amount: "1" };
      return { id, account_id: SERVER.publicKey(), memo_type: "id", memo: "4242", min_amount: 1 };
    },
    [`GET ${HOME}/sep6/transaction`]: (u: URL) => {
      const id = u.searchParams.get("id")!;
      const o = orders[id]!;
      // A withdrawal completes once our on-chain payment was submitted.
      if (o.kind === "withdrawal" && chain.state.submitted.length > 0 && o.status === "pending_user_transfer_start") o.status = "completed";
      return { transaction: { id, kind: o.kind, status: statusOf(id), amount_in: o.amount } };
    },
  });
  return { ...world, chain, orders };
}

function newSession(world: ReturnType<typeof fullWorld>, s: Signer = signer) {
  const clock = fakeClock();
  return new AnchorSession({
    signer: s,
    homeDomain: HOME,
    fetch: world.fetch,
    horizonUrl: "https://horizon.example.test",
    friendbotUrl: "https://friendbot.example.test",
    sleep: clock.sleep,
    now: clock.now,
  });
}

describe("AnchorSession", () => {
  it("each step returns { data, explain } and implicit prerequisites narrate themselves", async () => {
    const world = fullWorld({ startTrustline: true });
    const session = newSession(world);
    const q = await session.quoteDeposit("50");
    expect(q.data.buyAmount).toBe("1.0198045");
    expect(q.explain.map((r) => r.step)).toEqual(["sep1.discover", "sep38.price"]);
    const d = await session.startDeposit("50");
    // login + KYC happened implicitly inside startDeposit and are narrated in ITS slice
    expect(d.explain.map((r) => r.step)).toEqual(["sep10.challenge", "sep10.verify", "sep10.sign", "sep10.token", "sep12.customer", "sep6.deposit"]);
    expect(d.data.id).toBe("dep_1");
    for (const r of [...q.explain, ...d.explain]) {
      expect(r.what.length).toBeGreaterThan(10);
      expect(r.why.length).toBeGreaterThan(10);
    }
  });

  it("caches discovery and the SEP-10 token across steps", async () => {
    const world = fullWorld({ startTrustline: true });
    const session = newSession(world);
    await session.startDeposit("50");
    await session.startDeposit("50");
    expect(world.calls.filter((c) => c.url.includes("stellar.toml"))).toHaveLength(1);
    expect(world.calls.filter((c) => c.method === "POST" && c.url.endsWith("/auth"))).toHaveLength(1);
  });

  it("rejects bad amounts before touching the network", async () => {
    const world = fullWorld({ startTrustline: true });
    const session = newSession(world);
    await expect(session.startDeposit("5e1")).rejects.toThrow(/decimal string/);
    await expect(session.quoteWithdraw("-1")).rejects.toThrow(/decimal string/);
    expect(world.calls).toHaveLength(0);
  });

  it("deposit flow: preflight -> quote -> deposit -> sandbox bank -> completed -> balance", async () => {
    const world = fullWorld({ startTrustline: false });
    const session = newSession(world);
    const r = await runDepositFlow(session, { amountFiat: "50", sandboxBank: true, poll: { intervalMs: 10 } });
    expect(r.preflight.actions).toEqual(["trustline_created"]);
    expect(r.poll.outcome).toBe("completed");
    expect(r.balanceBefore).toBe("0");
    expect(r.balanceAfter).toBe("1.0198045");
    const steps = r.explain.map((x) => x.step);
    expect(steps.indexOf("preflight.trustline")).toBeLessThan(steps.indexOf("sep6.deposit"));
    expect(steps).toContain("sandbox.bank");
    expect(steps.at(-1)).toBe("horizon.balance");
    // no pending_trust: preflight prevented it
    expect(steps).not.toContain("sep6.status.pending_trust");
  });

  it("recovers a deposit stuck in pending_trust by adding the trustline mid-poll", async () => {
    const world = fullWorld({ startTrustline: false });
    const session = newSession(world);
    // Skip preflight on purpose (the workshop mistake): deposit, pay, then poll.
    const dep = await session.startDeposit("50");
    await session.simulateBank(dep.data.id, "50");
    const r = await session.waitForTransaction(dep.data.id, { intervalMs: 10 });
    expect(r.data.history).toEqual(["pending_trust", "completed"]);
    expect(r.explain.map((x) => x.step)).toEqual(expect.arrayContaining(["sep6.status.pending_trust", "sep6.repair_trust", "preflight.trustline"]));
    expect(world.chain.state.trustline).toBe(true);
  });

  it("withdraw flow: pays the anchor account with its memo, then completes", async () => {
    const world = fullWorld({ startTrustline: true });
    world.chain.state.usdc = "2.0000000";
    const s = countingSigner();
    const session = newSession(world, s);
    const r = await runWithdrawFlow(session, { amountAsset: "1", poll: { intervalMs: 10 } });
    expect(r.poll.outcome).toBe("completed");
    expect(r.payment.hash).toBe("ab".repeat(32));
    expect(r.payment.explorerUrl).toContain("stellar.expert/explorer/testnet/tx/");
    // The one on-chain transaction we signed: payment of 1 USDC to the anchor, memo id 4242
    const payTx = s.signed.map((x) => TransactionBuilder.fromXDR(x, TESTNET_PASSPHRASE) as Transaction).find((t) => t.operations[0]?.type === "payment")!;
    expect(String(payTx.memo.value)).toBe("4242");
    expect(payTx.memo.type).toBe("id");
    const op = payTx.operations[0]!;
    if (op.type === "payment") {
      expect(op.destination).toBe(SERVER.publicKey());
      expect(op.amount).toBe("1.0000000");
    }
    expect(r.explain.map((x) => x.step)).toContain("withdraw.pay");
  });

  it("withdraw refuses when the balance is too low (no signing)", async () => {
    const world = fullWorld({ startTrustline: true });
    world.chain.state.usdc = "0.5000000";
    const s = countingSigner();
    const session = newSession(world, s);
    await session.startWithdraw("1");
    await expect(session.payWithdrawal("1")).rejects.toThrow(/not enough USDC/);
    expect(s.signed.filter((x) => (TransactionBuilder.fromXDR(x, TESTNET_PASSPHRASE) as Transaction).operations[0]?.type === "payment")).toHaveLength(0);
  });

  it("prepareWithdrawal returns the unsigned payment and an approval summary with the ISSUER", async () => {
    const world = fullWorld({ startTrustline: true });
    world.chain.state.usdc = "2.0000000";
    const s = countingSigner();
    const session = newSession(world, s);
    await session.startWithdraw("1");
    const prep = await session.prepareWithdrawal("1");
    // Only the SEP-10 login was signed before this point; no payment preview is signed.
    expect(s.signed.filter((x) => (TransactionBuilder.fromXDR(x, TESTNET_PASSPHRASE) as Transaction).operations[0]?.type === "payment")).toHaveLength(0);
    const tx = TransactionBuilder.fromXDR(prep.data.xdr, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.signatures).toHaveLength(0);
    const text = [prep.data.summary.title, ...prep.data.summary.lines].join("\n");
    expect(text).toContain(USDC_ISSUER);
    expect(text).toMatch(/Asset issuer/);
    expect(text).toMatch(/Withdrawal order wd_/);
  });
});

describe("ChainTool wiring (depositTry)", () => {
  it("returns the trustline XDR (decoded summary) when the account still needs it", async () => {
    const world = fullWorld({ startTrustline: false });
    configureAnchor(newSession(world));
    const res = await depositTry({ kind: "deposit", asset: "TRY", amount: "50" });
    const tx = TransactionBuilder.fromXDR(res.unsignedXdr, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.operations[0]?.type).toBe("changeTrust");
    expect(tx.signatures).toHaveLength(0);
    expect(res.summary.title).toMatch(/Allow USDC/);
    expect(res.summary.lines.join("\n")).toMatch(/50\.00 TRY/);
    expect(res.summary.lines.join("\n")).toMatch(/Trust asset USDC/);
    expect(res.summary.lines.join("\n")).toMatch(/pending_trust/);
    expect(res.summary.estimatedFee).toBe("0.0000100 XLM");
  });

  it("returns the (unsigned, validated) SEP-10 challenge when nothing else is needed", async () => {
    const world = fullWorld({ startTrustline: true });
    const session = newSession(world);
    configureAnchor(session);
    const res = await depositTry({ kind: "deposit", asset: "USDC", amount: "50" });
    expect(res.summary.title).toMatch(/Sign in to anchor\.example\.test/);
    expect(res.summary.lines.join("\n")).toMatch(/authentication only/);
    // Second phase: signer signs, finishLogin completes, deposit proceeds.
    const signed = await signer.signTransaction(res.unsignedXdr);
    const tok = await session.finishLogin(signed);
    expect(tok.data.account).toBe(CLIENT.publicKey());
    const d = await session.startDeposit("50");
    expect(d.data.id).toBe("dep_1");
  });

  it("withdrawTry returns the unsigned payment with the issuer and memo in the approval card", async () => {
    const world = fullWorld({ startTrustline: true });
    world.chain.state.usdc = "2.0000000";
    configureAnchor(newSession(world));
    const res = await withdrawTry({ kind: "withdraw", asset: "USDC", amount: "1" });
    const tx = TransactionBuilder.fromXDR(res.unsignedXdr, TESTNET_PASSPHRASE) as Transaction;
    expect(tx.signatures).toHaveLength(0);
    expect(tx.operations[0]?.type).toBe("payment");
    expect(tx.memo.type).toBe("id");
    const text = [res.summary.title, ...res.summary.lines].join("\n");
    expect(text).toMatch(/Cash out 1 USDC/);
    expect(text).toContain(USDC_ISSUER); // issuer, not just the code
    expect(text).toMatch(/Asset issuer/);
    expect(text).toMatch(/Memo \(id\): 4242/);
    expect(res.summary.estimatedFee).toMatch(/XLM$/);
  });

  it("rejects intents that are not deposits, and bad amounts", async () => {
    configureAnchor(newSession(fullWorld({ startTrustline: true })));
    await expect(depositTry({ kind: "send", asset: "USDC", amount: "1" })).rejects.toThrow(/"deposit" intent/);
    await expect(depositTry({ kind: "deposit", asset: "TRY", amount: "0" })).rejects.toThrow(/decimal string/);
    await expect(withdrawTry({ kind: "deposit", asset: "USDC", amount: "1" })).rejects.toThrow(/"withdraw" intent/);
  });

  it("describeXdr decodes from XDR, not from prose", () => {
    const xdr = makeChallenge();
    const d = describeXdr(xdr, TESTNET_PASSPHRASE);
    expect(d.lines[0]).toMatch(/Login proof entry/);
    expect(d.feeXlm).toMatch(/^0\.0/);
  });
});
