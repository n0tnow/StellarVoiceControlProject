// W11b live proof — autonomous payments on the deployed `polaris_guard`.
//
//   npm run e2e:autopay
//
// Throwaway owner/executor/recipient accounts are generated in memory and funded
// by Friendbot (nothing secret is printed). The script then proves the on-chain
// contract, independent of the app and the Keychain:
//
//   approve allowance → set_rule (auto 10, per-tx 20, daily 100, native SAC)
//   → set_executor → set_alias(acc2) → pay_executor 1 XLM (unattended, SUCCESS)
//   → pay_executor 15 XLM (REJECTED, #105 NeedsOwnerApproval / #103)
//   → pay_owner 5 XLM (owner-signed path works)
//
// Testnet only. Every transaction hash and explorer link is printed.
import { Asset, Keypair, TransactionBuilder, rpc } from "@stellar/stellar-sdk";

import { buildApproveAllowance } from "../stellar/src/guard/allowance.ts";
import { createGuardClient } from "../stellar/src/guard/client.ts";
import { toRawUnits } from "../stellar/src/guard/amount.ts";
import { TESTNET_HOSTS } from "../stellar/src/live/config.ts";
import { fundWithFriendbot } from "../stellar/src/live/friendbot.ts";
import { submitSoroban } from "../stellar/src/live/submit.ts";

const EXPLORER = "https://stellar.expert/explorer/testnet/tx";
const GUARD_CONTRACT_ID =
  process.env.GUARD_CONTRACT_ID ?? "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";

function line(label, value) {
  process.stdout.write(`${label.padEnd(34)} ${value}\n`);
}

function link(hash) {
  return `${EXPLORER}/${hash}`;
}

function sign(xdr, keypair) {
  const tx = TransactionBuilder.fromXDR(xdr, TESTNET_HOSTS.networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
}

async function submit(server, xdr, keypair) {
  return submitSoroban(server, sign(xdr, keypair), {
    networkPassphrase: TESTNET_HOSTS.networkPassphrase,
    waitMs: 60_000,
  });
}

async function main() {
  const server = new rpc.Server(TESTNET_HOSTS.rpcUrl);
  const owner = Keypair.random();
  const executor = Keypair.random();
  const recipient = Keypair.random();

  line("network", TESTNET_HOSTS.networkPassphrase);
  line("guard contract", GUARD_CONTRACT_ID);
  line("owner (public)", owner.publicKey());
  line("executor (public)", executor.publicKey());
  line("recipient (public)", recipient.publicKey());

  for (const [label, kp] of [
    ["owner", owner],
    ["executor", executor],
    ["recipient", recipient],
  ]) {
    const res = await fundWithFriendbot(kp.publicKey());
    line(`friendbot ${label}`, res.alreadyFunded ? "already funded" : "funded");
  }

  const client = createGuardClient({
    contractId: GUARD_CONTRACT_ID,
    rpc: server,
    networkPassphrase: TESTNET_HOSTS.networkPassphrase,
    source: owner.publicKey(),
  });
  const assetContractId = Asset.native().contractId(TESTNET_HOSTS.networkPassphrase);
  line("native SAC", assetContractId);

  // 1) Allowance: the owner approves the guard as a SAC spender.
  const allowance = await buildApproveAllowance(server, {
    assetContractId,
    from: owner.publicKey(),
    spender: GUARD_CONTRACT_ID,
    amount: toRawUnits("200"),
    networkPassphrase: TESTNET_HOSTS.networkPassphrase,
    days: 30,
  });
  const approveRes = await submit(server, allowance.unsignedXdr, owner);
  line("approve", `${approveRes.status} ${link(approveRes.hash)}`);
  if (approveRes.status !== "SUCCESS") throw new Error(`approve failed: ${approveRes.resultXdrSummary}`);

  // 2) Rule: auto-approve 10 XLM/payment, per-tx 20, daily 100, saved contacts only.
  const rule = {
    auto_approve_limit: toRawUnits("10"),
    per_tx_limit: toRawUnits("20"),
    daily_limit: toRawUnits("100"),
    allowed_assets: [assetContractId],
    known_recipients_only: true,
  };
  const ruleRes = await submit(server, (await client.setRule(owner.publicKey(), rule)).unsignedXdr, owner);
  line("set_rule", `${ruleRes.status} ${link(ruleRes.hash)}`);
  if (ruleRes.status !== "SUCCESS") throw new Error(`set_rule failed: ${ruleRes.resultXdrSummary}`);

  // 3) Executor registration LAST: this arms unattended payments.
  const execRes = await submit(server, (await client.setExecutor(owner.publicKey(), executor.publicKey())).unsignedXdr, owner);
  line("set_executor (arms)", `${execRes.status} ${link(execRes.hash)}`);
  if (execRes.status !== "SUCCESS") throw new Error(`set_executor failed: ${execRes.resultXdrSummary}`);

  // 4) Alias book: acc2 -> recipient address.
  const aliasRes = await submit(server, (await client.setAlias(owner.publicKey(), "acc2", recipient.publicKey())).unsignedXdr, owner);
  line("set_alias acc2", `${aliasRes.status} ${link(aliasRes.hash)}`);
  if (aliasRes.status !== "SUCCESS") throw new Error(`set_alias failed: ${aliasRes.resultXdrSummary}`);

  // 5) Unattended payment: 1 XLM via pay_executor, signed by the executor.
  const payExec = await client.payExecutor(
    executor.publicKey(),
    owner.publicKey(),
    recipient.publicKey(),
    assetContractId,
    toRawUnits("1"),
  );
  const payExecRes = await submit(server, payExec.unsignedXdr, executor);
  line("pay_executor 1 XLM (auto)", `${payExecRes.status} ${link(payExecRes.hash)}`);
  if (payExecRes.status !== "SUCCESS") throw new Error(`pay_executor 1 failed: ${payExecRes.resultXdrSummary}`);

  // 6) Above the auto-approve limit: the contract must refuse.
  process.stdout.write("\n-- over-limit attempt (expected REJECTED) --\n");
  try {
    const over = await client.payExecutor(
      executor.publicKey(),
      owner.publicKey(),
      recipient.publicKey(),
      assetContractId,
      toRawUnits("15"),
    );
    const overRes = await submit(server, over.unsignedXdr, executor);
    line("pay_executor 15 XLM", `${overRes.status} ${overRes.error?.name ?? overRes.resultXdrSummary} ${link(overRes.hash)}`);
    if (overRes.status !== "FAILED") throw new Error("expected the 15 XLM pay_executor to be rejected");
  } catch (error) {
    const name = error?.name ?? "Error";
    const code = error?.code !== undefined ? `#${error.code} ` : "";
    line("pay_executor 15 XLM", `REJECTED ${code}${name}: ${error?.message ?? ""}`);
  }

  // 7) Owner path: pay_owner still works for the same payment.
  const payOwner = await client.payOwner(
    owner.publicKey(),
    recipient.publicKey(),
    assetContractId,
    toRawUnits("5"),
  );
  const payOwnerRes = await submit(server, payOwner.unsignedXdr, owner);
  line("pay_owner 5 XLM (owner)", `${payOwnerRes.status} ${link(payOwnerRes.hash)}`);
  if (payOwnerRes.status !== "SUCCESS") throw new Error(`pay_owner failed: ${payOwnerRes.resultXdrSummary}`);

  process.stdout.write("\ne2e:autopay OK — autonomous payment settled, over-limit refused.\n");
}

main().catch((error) => {
  process.stderr.write(`e2e:autopay failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
