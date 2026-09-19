/** Offline payment test kit: injected Account, deterministic clock, alias fixtures. */
import { Account } from "@stellar/stellar-sdk";
import type { ChainToolResult } from "@polaris/interfaces";
import { TESTNET_PASSPHRASE } from "../../anchor/config.ts";
import { defaultAssetRegistry } from "../assets.ts";
import { createSendPayment, PaymentRefusal, type PaymentDeps, type PaymentIntent } from "../sendPayment.ts";

export const OWNER = "GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E";
export const ADA = "GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO";
export const RAW_UNKNOWN = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const ALIASES = {
  ada: { address: ADA, network: "testnet" as const },
};

export const FIXED_NOW = new Date("2026-09-19T12:00:00.000Z");

export function makeDeps(overrides: Partial<PaymentDeps> = {}): PaymentDeps {
  return {
    ownerAddress: OWNER,
    aliases: ALIASES,
    loadAccount: async (address: string) => new Account(address, "1000"),
    networkPassphrase: TESTNET_PASSPHRASE,
    assets: defaultAssetRegistry(),
    now: () => new Date(FIXED_NOW),
    ...overrides,
  };
}

export const baseIntent: PaymentIntent = {
  kind: "send",
  asset: "USDC",
  amount: "10",
  recipient: "ada",
};

/** Captures a `PaymentRefusal`, asserting it was the failure mode. */
export async function refusalOf(fn: () => Promise<unknown>): Promise<PaymentRefusal> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof PaymentRefusal) return e;
    throw e;
  }
  throw new Error("expected a PaymentRefusal, but the call succeeded");
}

export async function runPayment(deps: PaymentDeps, intent: PaymentIntent): Promise<ChainToolResult> {
  return createSendPayment(deps)(intent);
}
