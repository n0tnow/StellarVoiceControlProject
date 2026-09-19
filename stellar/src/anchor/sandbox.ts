/**
 * SANDBOX-ONLY helper. The mock anchor has no real bank, so it exposes a
 * proprietary endpoint that "plays the bank": `POST <TRANSFER_SERVER>/tx/<id>/simulate-bank-transfer`.
 * This is NOT a standard SEP endpoint and will not exist on a real anchor (nor,
 * per the organizers, necessarily on the mock later). It is used only by the
 * demo/e2e flows, only when explicitly enabled, and is isolated in this file.
 */
import { requestJson } from "./http.ts";
import type { AnchorContext, AnchorToml } from "./types.ts";

export async function simulateBankTransfer(
  ctx: AnchorContext,
  toml: AnchorToml,
  id: string,
  amountFiat: string,
  fiatCode = "",
): Promise<void> {
  await requestJson(ctx, `${toml.transferServer}/tx/${encodeURIComponent(id)}/simulate-bank-transfer`, {
    method: "POST",
    json: { amount: amountFiat },
  });
  ctx.explain.record(
    "sandbox.bank",
    `Sandbox: pretended to be the bank and told the test anchor that ${amountFiat}${fiatCode ? ` ${fiatCode}` : " of local currency"} arrived for order ${id}.`,
    "This test anchor has no real bank, so we trigger the step a real bank transfer would normally trigger by itself.",
  );
}
