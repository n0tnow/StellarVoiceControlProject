/**
 * Asset registry for payments. Only the pinned testnet assets may be moved:
 * USDC (issuer from the anchor's `KNOWN_ISSUERS` pin) and native XLM. An
 * agent-supplied look-alike asset code is refused here.
 */
import { Asset } from "@stellar/stellar-sdk";
import { KNOWN_ISSUERS } from "../anchor/config.ts";

/** The pinned testnet USDC issuer (anchor config, docs/contracts DEPLOYED.md). */
export const TESTNET_USDC_ISSUER = KNOWN_ISSUERS["tr-mock-anchor.fly.dev"]?.USDC ?? "";

export interface AssetSpec {
  code: string;
  /** Undefined for the native asset. */
  issuer?: string;
  native: boolean;
}

export interface AssetRegistry {
  /** Resolve an asset code (case-insensitive) to a pinned spec, or undefined when not allowed. */
  get(code: string): AssetSpec | undefined;
}

/** USDC + XLM only. Codes are matched case-insensitively after trimming. */
export function defaultAssetRegistry(): AssetRegistry {
  const table: Record<string, AssetSpec> = {
    XLM: { code: "XLM", native: true },
    USDC: { code: "USDC", issuer: TESTNET_USDC_ISSUER, native: false },
  };
  return { get: (code) => table[code.trim().toUpperCase()] };
}

export function toSdkAsset(spec: AssetSpec): Asset {
  if (spec.native) return Asset.native();
  if (!spec.issuer) throw new Error(`asset ${spec.code} has no issuer`);
  return new Asset(spec.code, spec.issuer);
}
