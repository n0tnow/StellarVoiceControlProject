/** Anchor client defaults. Testnet only — mainnet is an explicit non-goal. */
export const DEFAULT_HOME_DOMAIN = "tr-mock-anchor.fly.dev";
/** SDF's public test anchor: a second SEP-6 provider for development/tests. */
export const SDF_TEST_ANCHOR_HOME_DOMAIN = "testanchor.stellar.org";
export const DEFAULT_ASSET_CODE = "USDC";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_HORIZON_URL = "https://horizon-testnet.stellar.org";
export const TESTNET_FRIENDBOT_URL = "https://friendbot.stellar.org";

/**
 * Issuers this wallet trusts per anchor home domain (pinned). An anchor whose
 * stellar.toml names a different issuer for the asset is refused, so a hostile or
 * hijacked toml cannot swap in a look-alike "USDC". Domains not listed here are
 * unpinned (the toml's issuer is used, and the narration says so).
 */
export const KNOWN_ISSUERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "tr-mock-anchor.fly.dev": { USDC: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
};
