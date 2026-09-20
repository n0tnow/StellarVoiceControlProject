//! Chain-lane network configuration for the shell (step W1).
//!
//! The voice lane and the chain lane were not joined: the agent produced an
//! `Intent` but the webview had no way to learn the owner's address or the
//! recipient aliases, so `app/src/lib/chain.ts` could never configure Owner B's
//! `sendPayment`. This command is that source of truth.
//!
//! Rules that matter:
//!
//! * **Allow-list only.** Exactly the seven variables below are read. Nothing
//!   else in the process environment is ever returned, so a secret that happens
//!   to be set (a provider key, a keeper secret) can never ride this command to
//!   the webview.
//! * **Validated.** The owner address and every alias must be a valid `G...`
//!   StrKey (base32 + version byte + CRC16-XModem checksum, so a single-character
//!   typo is caught here); an alias name must match the alias-book charset.
//!   Anything malformed is dropped, so a typo becomes "not configured"
//!   (fail-closed), never a wrong destination.
//! * **Testnet only.** Defaults are the public testnet endpoints; the app never
//!   signs or submits here — this is read-only configuration.

use std::collections::BTreeMap;

use serde::Serialize;

/// Testnet defaults, mirrored by `stellar/src/index.ts` and `.env.example`.
pub const DEFAULT_NETWORK: &str = "testnet";
pub const DEFAULT_RPC_URL: &str = "https://soroban-testnet.stellar.org";
pub const DEFAULT_HORIZON_URL: &str = "https://horizon-testnet.stellar.org";
pub const DEFAULT_NETWORK_PASSPHRASE: &str = "Test SDF Network ; September 2015";

/// The embedded in-app wallet is the default signer (step W10).
pub const SIGNER_EMBEDDED: &str = "embedded";
/// The optional Freighter browser bridge, kept as an advanced mode.
pub const SIGNER_FREIGHTER: &str = "freighter";

/// Resolves `POLARIS_SIGNER`: an explicit `freighter` opts back into the browser
/// bridge (advanced); everything else defaults to the in-app `embedded` wallet.
pub fn resolve_signer(explicit: Option<&str>) -> String {
    match explicit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) if value.eq_ignore_ascii_case(SIGNER_FREIGHTER) => SIGNER_FREIGHTER.to_string(),
        _ => SIGNER_EMBEDDED.to_string(),
    }
}

/// The non-secret chain configuration the webview is allowed to see.
/// Mirrors `StellarConfig` in `@polaris/interfaces` (field names byte-identical).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StellarConfig {
    pub network: String,
    pub rpc_url: String,
    pub horizon_url: String,
    pub network_passphrase: String,
    /// The sender (owner) wallet, or `None` when unset/invalid. When an embedded
    /// wallet is active this is that wallet's address, overriding
    /// `POLARIS_OWNER_ADDRESS`.
    pub owner_address: Option<String>,
    /// Which signer the shell should use: `embedded` or `freighter`.
    pub signer: String,
    /// Alias -> `G...` address, from `POLARIS_ALIASES` only (the committed
    /// `aliases.json` is merged on the TypeScript side, where it already lives).
    pub aliases: BTreeMap<String, String>,
    /// `GUARD_CONTRACT_ID`; a parameter, never a constant. `None` for an XLM
    /// direct payment, which needs no guard contract.
    pub guard_contract_id: Option<String>,
    /// `POLARIS_P2P_CONTRACT_ID`; the deployed `polaris_p2p_escrow` id, or `None`
    /// while the P2P milestone is unconfigured (the panel then stays disabled).
    pub p2p_contract_id: Option<String>,
}

/// Decodes RFC 4648 base32 (`A-Z2-7`) without padding, or `None` on a bad char.
fn base32_decode(input: &str) -> Option<Vec<u8>> {
    let mut value: u32 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(input.len() * 5 / 8);
    for byte in input.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'2'..=b'7' => byte - b'2' + 26,
            _ => return None,
        };
        value = (value << 5) | u32::from(digit);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((value >> bits) as u8);
        }
    }
    Some(out)
}

/// CRC16-XModem (poly `0x1021`, init 0), the checksum Stellar StrKeys use.
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for byte in data {
        crc ^= u16::from(*byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// A Stellar ed25519 public-key StrKey: 56 base32 chars, version byte `0x30`,
/// and a valid CRC16-XModem checksum (m-6). Shape-only validation would accept a
/// single-character typo that keeps the charset, deferring the failure to a
/// Horizon `loadAccount`; the checksum catches it here (fail-closed).
///
/// `pub(crate)` because the bridge (W4b) uses the same validation for the owner
/// address in its health check.
pub(crate) fn is_public_key(value: &str) -> bool {
    if value.len() != 56 {
        return false;
    }
    let Some(decoded) = base32_decode(value) else {
        return false;
    };
    // 1 version byte + 32 data bytes + 2 checksum bytes.
    if decoded.len() != 35 || decoded[0] != 0x30 {
        return false;
    }
    let expected = crc16_xmodem(&decoded[..33]);
    let actual = u16::from_le_bytes([decoded[33], decoded[34]]);
    expected == actual
}

/// The alias-name charset from `stellar/src/payments/aliases.ts` (C3):
/// `[a-z][a-z0-9_-]{0,31}`. `pub(crate)` so the contacts store reuses the same
/// charset instead of duplicating it (W10b).
pub(crate) fn is_alias_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 32 {
        return false;
    }
    let mut chars = name.chars();
    matches!(chars.next(), Some(first) if first.is_ascii_lowercase())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

/// Parses the `alias=G...,alias=G...` env format, dropping malformed entries.
///
/// Dropping (rather than failing the whole command) keeps the remaining book
/// usable and makes a typo fail closed: the alias is simply not resolvable and
/// the payment is refused, never sent to a wrong address.
pub fn parse_aliases(raw: &str) -> BTreeMap<String, String> {
    let mut aliases = BTreeMap::new();
    for pair in raw.split(',') {
        let pair = pair.trim();
        if pair.is_empty() {
            continue;
        }
        let Some((name, address)) = pair.split_once('=') else {
            eprintln!("polaris: ignoring a malformed POLARIS_ALIASES entry (expected alias=G...)");
            continue;
        };
        let (name, address) = (name.trim(), address.trim());
        if !is_alias_name(name) {
            eprintln!("polaris: ignoring a POLARIS_ALIASES entry with an invalid alias name");
            continue;
        }
        if !is_public_key(address) {
            eprintln!("polaris: ignoring POLARIS_ALIASES entry {name:?}: address is not a G... strkey");
            continue;
        }
        aliases.insert(name.to_string(), address.to_string());
    }
    aliases
}

/// Builds the config from an injected environment lookup, so the allow-list and
/// validation are testable without touching the real process environment.
///
/// `wallet_address` is the active embedded-wallet address, if any. When present
/// it becomes `ownerAddress` (overriding `POLARIS_OWNER_ADDRESS`) and makes
/// `embedded` the default signer.
fn from_lookup(
    lookup: impl Fn(&str) -> Option<String>,
    wallet_address: Option<String>,
) -> StellarConfig {
    let signer = resolve_signer(lookup("POLARIS_SIGNER").as_deref());
    let env_owner = lookup("POLARIS_OWNER_ADDRESS").filter(|value| is_public_key(value));
    // The embedded wallet is the owner **only** when it is also the signer: with
    // `POLARIS_SIGNER=freighter` the owner must stay the env owner, or signing
    // would go to the browser bridge for a transaction sourced by the embedded G…
    let wallet_owner = if signer == SIGNER_EMBEDDED {
        wallet_address.filter(|value| is_public_key(value))
    } else {
        None
    };
    let owner = wallet_owner.or(env_owner);
    StellarConfig {
        network: lookup("STELLAR_NETWORK").unwrap_or_else(|| DEFAULT_NETWORK.to_string()),
        rpc_url: lookup("STELLAR_RPC_URL").unwrap_or_else(|| DEFAULT_RPC_URL.to_string()),
        horizon_url: lookup("STELLAR_HORIZON_URL")
            .unwrap_or_else(|| DEFAULT_HORIZON_URL.to_string()),
        network_passphrase: lookup("STELLAR_NETWORK_PASSPHRASE")
            .unwrap_or_else(|| DEFAULT_NETWORK_PASSPHRASE.to_string()),
        owner_address: owner,
        signer,
        aliases: lookup("POLARIS_ALIASES")
            .map(|raw| parse_aliases(&raw))
            .unwrap_or_default(),
        guard_contract_id: lookup("GUARD_CONTRACT_ID"),
        p2p_contract_id: lookup("POLARIS_P2P_CONTRACT_ID"),
    }
}

/// Reads the configuration from the process environment (`.env` already loaded
/// by `env.rs`). Only the allow-listed variables above are consulted.
pub fn read() -> StellarConfig {
    from_lookup(crate::env::var, None)
}

/// Like [`read`], but the active embedded-wallet address overrides the env owner.
pub fn read_with_wallet(active: Option<String>) -> StellarConfig {
    from_lookup(crate::env::var, active)
}

/// Applies the W13a session rule: while the wallet session is locked, the owner
/// address is withheld even when `POLARIS_OWNER_ADDRESS` is set, so every chain
/// tool refuses to build a transaction until the user logs in. Non-secret, but
/// the address is the sending identity and is only meaningful once unlocked.
pub fn with_locked_owner(mut config: StellarConfig, unlocked: bool) -> StellarConfig {
    if !unlocked {
        config.owner_address = None;
    }
    config
}

/// Overlays the saved contacts under the env aliases (W10b). Precedence is
/// **committed `aliases.json` < contacts < `POLARIS_ALIASES`**: the committed
/// book is merged on the TypeScript side, contacts fill it here, and an env pair
/// wins last. A malformed contact (bad nickname or address) is dropped, so a
/// bad entry is "not resolvable" (fail-closed), never a wrong destination.
pub fn aliases_with_contacts(
    env_aliases: BTreeMap<String, String>,
    contacts: &[crate::contacts::Contact],
) -> BTreeMap<String, String> {
    let mut merged: BTreeMap<String, String> = contacts
        .iter()
        .filter(|contact| is_alias_name(&contact.nickname) && is_public_key(&contact.address))
        .map(|contact| (contact.nickname.clone(), contact.address.clone()))
        .collect();
    merged.extend(env_aliases);
    merged
}

/// The webview's entry point: non-secret chain configuration for the shell. The
/// embedded wallet's active address (when one exists) is the owner, and the
/// saved contacts (W10b) are merged under the env aliases so the voice lane can
/// resolve a freshly added "rumuz" on the next turn.
#[tauri::command]
pub fn stellar_config(
    app: tauri::AppHandle,
    wallet: tauri::State<'_, std::sync::Arc<crate::wallet::WalletService>>,
    session: tauri::State<'_, std::sync::Arc<crate::wallet::session::SessionStore>>,
) -> StellarConfig {
    let mut config = with_locked_owner(
        read_with_wallet(wallet.active_address()),
        session.is_unlocked(),
    );
    let contacts = crate::contacts::load_for_app(&app);
    config.aliases = aliases_with_contacts(std::mem::take(&mut config.aliases), &contacts);
    config
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    const OWNER: &str = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A";
    const ACC2: &str = "GB25QEDATQREAQQHBW3DAGLOZ3EURS44URZETXLLREPPYCX2ABCORNLV";

    fn from_pairs(pairs: &[(&str, &str)]) -> StellarConfig {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        from_lookup(|name| map.get(name).cloned(), None)
    }

    fn from_pairs_with_wallet(pairs: &[(&str, &str)], wallet: Option<&str>) -> StellarConfig {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        from_lookup(|name| map.get(name).cloned(), wallet.map(str::to_string))
    }

    #[test]
    fn defaults_are_public_testnet_endpoints() {
        let config = from_pairs(&[]);
        assert_eq!(config.network, "testnet");
        assert_eq!(config.rpc_url, "https://soroban-testnet.stellar.org");
        assert_eq!(config.horizon_url, "https://horizon-testnet.stellar.org");
        assert_eq!(config.network_passphrase, "Test SDF Network ; September 2015");
        assert_eq!(config.owner_address, None);
        assert_eq!(config.signer, "embedded");
        assert!(config.aliases.is_empty());
        assert_eq!(config.guard_contract_id, None);
        assert_eq!(config.p2p_contract_id, None);
    }

    #[test]
    fn reads_the_allow_listed_values() {
        let config = from_pairs(&[
            ("STELLAR_NETWORK", "testnet"),
            ("STELLAR_RPC_URL", "https://rpc.example"),
            ("STELLAR_HORIZON_URL", "https://horizon.example"),
            ("STELLAR_NETWORK_PASSPHRASE", "Test SDF Network ; September 2015"),
            ("POLARIS_OWNER_ADDRESS", OWNER),
            ("POLARIS_ALIASES", &format!("acc2={ACC2}")),
            ("GUARD_CONTRACT_ID", "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D"),
            ("POLARIS_P2P_CONTRACT_ID", "CBPTP2PZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZ"),
        ]);
        assert_eq!(config.rpc_url, "https://rpc.example");
        assert_eq!(config.horizon_url, "https://horizon.example");
        assert_eq!(config.owner_address.as_deref(), Some(OWNER));
        assert_eq!(config.aliases.get("acc2").map(String::as_str), Some(ACC2));
        assert_eq!(
            config.guard_contract_id.as_deref(),
            Some("CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D")
        );
        assert_eq!(
            config.p2p_contract_id.as_deref(),
            Some("CBPTP2PZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZPZZ")
        );
    }

    #[test]
    fn never_returns_env_vars_outside_the_allow_list() {
        // A secret that happens to be in the process environment must not appear
        // in the serialized config. The lookup is injected so this is asserted
        // without mutating the real environment.
        let config = from_pairs(&[
            ("POLARIS_OWNER_ADDRESS", OWNER),
            ("GROQ_API_KEY", "gsk-super-secret"),
            ("KEEPER_SECRET", "S-super-secret"),
            ("OPENCODE_API_KEY", "sk-super-secret"),
        ]);
        let value: serde_json::Value = serde_json::to_value(&config).unwrap();
        let mut keys: Vec<&str> = value
            .as_object()
            .expect("the config serializes to an object")
            .keys()
            .map(String::as_str)
            .collect();
        keys.sort_unstable();
        // The exact wire key set: nine allow-listed fields, nothing else.
        assert_eq!(
            keys,
            [
                "aliases",
                "guardContractId",
                "horizonUrl",
                "network",
                "networkPassphrase",
                "ownerAddress",
                "p2pContractId",
                "rpcUrl",
                "signer",
            ]
        );
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("secret"));
        assert!(json.contains(OWNER));
    }

    #[test]
    fn an_embedded_wallet_address_overrides_the_env_owner_and_defaults_to_embedded() {
        let config = from_pairs_with_wallet(
            &[("POLARIS_OWNER_ADDRESS", ACC2), ("POLARIS_SIGNER", "")],
            Some(OWNER),
        );
        assert_eq!(config.owner_address.as_deref(), Some(OWNER));
        assert_eq!(config.signer, "embedded");
        // An explicit freighter setting wins, and the embedded address must NOT
        // become the owner: signing goes to the browser bridge else every
        // payment would fail on a source mismatch.
        let explicit = from_pairs_with_wallet(&[("POLARIS_SIGNER", "freighter")], Some(OWNER));
        assert_eq!(explicit.signer, "freighter");
        assert_eq!(explicit.owner_address, None);
        // With freighter and an env owner, the env owner is used.
        let with_env = from_pairs_with_wallet(
            &[("POLARIS_SIGNER", "freighter"), ("POLARIS_OWNER_ADDRESS", ACC2)],
            Some(OWNER),
        );
        assert_eq!(with_env.signer, "freighter");
        assert_eq!(with_env.owner_address.as_deref(), Some(ACC2));
        // No wallet still defaults to the embedded signer.
        assert_eq!(from_pairs_with_wallet(&[], None).signer, "embedded");
    }

    #[test]
    fn rejects_a_shape_valid_address_with_a_bad_checksum() {
        // Last character changed: still 56 base32 chars with a leading `G`, but
        // the CRC16-XModem checksum no longer matches (m-6).
        let mutated = "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25B";
        assert!(!is_public_key(mutated));
        assert_eq!(
            from_pairs(&[("POLARIS_OWNER_ADDRESS", mutated)]).owner_address,
            None
        );
        // The real fixtures have valid StrKeys.
        assert!(is_public_key(OWNER));
        assert!(is_public_key(ACC2));
    }

    #[test]
    fn a_malformed_owner_address_becomes_unset_fail_closed() {
        for bad in ["", "not-an-address", "GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25"] {
            assert_eq!(from_pairs(&[("POLARIS_OWNER_ADDRESS", bad)]).owner_address, None);
        }
    }

    #[test]
    fn parses_valid_aliases_and_drops_malformed_ones() {
        let raw = format!(
            "acc2={ACC2},,9bad={ACC2},ok_alias={ACC2},missing_address=,UPPER={ACC2},no_named_pair"
        );
        let aliases = parse_aliases(&raw);
        assert_eq!(aliases.len(), 2);
        assert_eq!(aliases.get("acc2").map(String::as_str), Some(ACC2));
        assert_eq!(aliases.get("ok_alias").map(String::as_str), Some(ACC2));
    }

    #[test]
    fn contacts_merge_below_env_aliases_and_drop_malformed_entries() {
        use crate::contacts::Contact;
        let env = parse_aliases(&format!("acc2={ACC2},ada={OWNER}"));
        let contacts = vec![
            Contact { nickname: "ali".into(), address: ACC2.into() },
            // Env wins over a contact with the same nickname.
            Contact { nickname: "ada".into(), address: ACC2.into() },
            // Dropped, not written into the alias table.
            Contact { nickname: "bad name".into(), address: ACC2.into() },
            Contact { nickname: "typo".into(), address: "Gbad".into() },
        ];
        let merged = aliases_with_contacts(env, &contacts);
        assert_eq!(merged.get("ali").map(String::as_str), Some(ACC2));
        assert_eq!(merged.get("acc2").map(String::as_str), Some(ACC2));
        // `ada` keeps the env address, not the contact's.
        assert_eq!(merged.get("ada").map(String::as_str), Some(OWNER));
        assert!(!merged.contains_key("bad name"));
        assert!(!merged.contains_key("typo"));
    }

    #[test]
    fn serializes_to_the_ts_camel_case_shape() {
        let config = from_pairs(&[
            ("POLARIS_OWNER_ADDRESS", OWNER),
            ("POLARIS_ALIASES", &format!("acc2={ACC2}")),
        ]);
        let json = serde_json::to_string(&config).unwrap();
        assert!(json.contains(r#""networkPassphrase":"Test SDF Network ; September 2015""#));
        assert!(json.contains(r#""rpcUrl":"https://soroban-testnet.stellar.org""#));
        assert!(json.contains(r#""horizonUrl":"https://horizon-testnet.stellar.org""#));
        assert!(json.contains(r#""ownerAddress":"GAJW"#));
        assert!(json.contains(r#""aliases":{"acc2":"GB25"#));
        assert!(json.contains(r#""guardContractId":null"#));
        assert!(json.contains(r#""p2pContractId":null"#));
    }

    #[test]
    fn a_locked_session_withholds_the_owner_address() {
        let with_env = from_pairs_with_wallet(&[("POLARIS_OWNER_ADDRESS", OWNER)], None);
        assert_eq!(with_env.owner_address.as_deref(), Some(OWNER));
        // Locked: even an env-provided owner is withheld (fail-closed).
        assert_eq!(with_locked_owner(with_env.clone(), false).owner_address, None);
        // Unlocked: unchanged.
        assert_eq!(
            with_locked_owner(with_env, true).owner_address.as_deref(),
            Some(OWNER)
        );
        // A locked session with a wallet-derived owner is withheld too.
        let with_wallet = from_pairs_with_wallet(&[], Some(OWNER));
        assert_eq!(
            with_locked_owner(with_wallet, false).owner_address,
            None
        );
    }

    #[test]
    fn alias_name_charset_matches_the_alias_book() {
        assert!(is_alias_name("acc2"));
        assert!(is_alias_name("a"));
        assert!(is_alias_name("my-alias_1"));
        assert!(!is_alias_name(""));
        assert!(!is_alias_name("1acc"));
        assert!(!is_alias_name("Acc2"));
        assert!(!is_alias_name("a".repeat(33).as_str()));
    }
}
