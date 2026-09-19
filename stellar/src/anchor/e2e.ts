/**
 * Live testnet end-to-end run against a SEP-6 anchor:
 *
 *   preflight -> SEP-38 quote -> SEP-6 deposit -> (sandbox) simulate bank ->
 *   completed -> Horizon balance -> SEP-6 withdraw round trip.
 *
 *   POLARIS_TEST_SECRET=S... npm run anchor:e2e -w @polaris/stellar -- --amount-try 50
 *
 * Without POLARIS_TEST_SECRET a throwaway key is generated in memory (never
 * printed, never saved). Testnet only. Keep amounts SMALL: the mock treasury is shared.
 *
 * Flags: --home-domain <d>  --amount-try <n>  --withdraw-usdc <n>  --skip-withdraw
 *        --deposit-only  --no-sandbox-bank  --json
 */
import { Keypair } from "@stellar/stellar-sdk";
import { DEFAULT_HOME_DOMAIN } from "./config.ts";
import { narrate } from "./explain.ts";
import { runDepositFlow, runWithdrawFlow } from "./flows.ts";
import { AnchorSession } from "./session.ts";
import { EnvSigner } from "./testSigner.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const homeDomain = arg("home-domain", process.env.POLARIS_ANCHOR_HOME_DOMAIN || DEFAULT_HOME_DOMAIN) as string;
  const amountTry = arg("amount-try", "50") as string;
  const withdrawUsdc = arg("withdraw-usdc", "1") as string;
  const json = flag("json");

  const signer = process.env.POLARIS_TEST_SECRET ? EnvSigner.fromEnv() : new EnvSigner(Keypair.random().secret());
  const session = new AnchorSession({ signer, homeDomain });
  if (!json) {
    session.explain.subscribe((r) => console.log(`  [${r.step}] ${narrate(r)}`));
  }
  console.log(`Anchor: ${homeDomain}  Account: ${await signer.publicKey()}`);

  console.log(`\n=== DEPOSIT ${amountTry} TRY -> USDC ===`);
  const dep = await runDepositFlow(session, { amountFiat: amountTry, sandboxBank: !flag("no-sandbox-bank") });
  const depTx = dep.poll.tx;
  console.log(
    `\nDeposit ${dep.deposit.id}: ${dep.poll.outcome} (${dep.poll.history.join(" -> ")})\n` +
      `  in: ${depTx.amountIn} ${depTx.amountInAsset}  out: ${depTx.amountOut} ${depTx.amountOutAsset}  fee: ${depTx.amountFee} ${depTx.amountFeeAsset}\n` +
      `  stellar tx: ${depTx.stellarTransactionId}\n` +
      `  USDC balance: ${dep.balanceBefore} -> ${dep.balanceAfter}`,
  );
  if (dep.poll.outcome !== "completed") throw new Error(`deposit did not complete: ${depTx.status}`);

  let wd;
  if (!flag("skip-withdraw") && !flag("deposit-only")) {
    console.log(`\n=== WITHDRAW ${withdrawUsdc} USDC -> TRY ===`);
    wd = await runWithdrawFlow(session, { amountAsset: withdrawUsdc });
    const t = wd.poll.tx;
    console.log(
      `\nWithdraw ${wd.withdraw.id}: ${wd.poll.outcome} (${wd.poll.history.join(" -> ")})\n` +
        `  pay ${wd.withdraw.accountId} memo=${wd.withdraw.memo?.value ?? "-"} (${wd.withdraw.memo?.type ?? "-"}) tx=${wd.payment.hash}\n` +
        `  in: ${t.amountIn} ${t.amountInAsset}  out: ${t.amountOut} ${t.amountOutAsset}  fee: ${t.amountFee} ${t.amountFeeAsset}\n` +
        `  USDC balance: ${wd.balanceBefore} -> ${wd.balanceAfter}`,
    );
    if (wd.poll.outcome !== "completed") throw new Error(`withdraw did not complete: ${t.status}`);
  }
  if (json) console.log(JSON.stringify({ deposit: dep, withdraw: wd }, null, 2));
  console.log("\nE2E OK");
}

main().catch((e: unknown) => {
  console.error("E2E FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
