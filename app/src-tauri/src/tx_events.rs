//! Emitting the `tx_submitted` event from the webview (step W4b).
//!
//! The value-moving path ends in the webview (`app/src/lib/signing.ts`): after
//! the embedded wallet signs and `submitSignedTx` submits, the shell wants to
//! record the exact transaction hash and explorer link on the typed event
//! stream. The webview cannot emit a typed `polaris-event` itself — only Rust
//! can — so this module is the one narrow command that lets it.
//!
//! ## Why a command at all
//!
//! The alternative (have Rust submit) would move Horizon access into the shell
//! and duplicate the chain lane's hash-with-expected-XDR check. Instead, the
//! webview stays the submitter and Rust only re-validates the **shape** of the
//! two values before broadcasting them. This does *not* prove a submission
//! happened: any caller can emit a well-formed hash and its canonical link, so
//! the UI must treat `tx_submitted` as an app-reported claim (the Wallet panel
//! labels it "reported by the app"), not as independent evidence.
//!
//! ## Validation (fail-closed)
//!
//! * `hash` must be exactly 64 lowercase hex characters — a Stellar transaction
//!   hash is 32 bytes, lowercase in every explorer link.
//! * `explorerUrl` must be the canonical testnet transaction link for that exact
//!   hash: `https://stellar.expert/explorer/testnet/tx/<hash>`. Anything else
//!   (another network, another path, a different hash) is refused, so the link
//!   the user clicks always describes the hash the event reports.
//!
//! The command returns a typed [`TxEventError`] rather than a string so a caller
//! can match on `kind`, and it never panics.

use serde::Serialize;
use tauri::AppHandle;

use crate::events::{self, PolarisEvent};

/// The exact explorer prefix every accepted link must carry (testnet only).
pub const EXPLORER_PREFIX: &str = "https://stellar.expert/explorer/testnet/tx/";

/// How the command invites the hash: 32 bytes as lowercase hex.
const HASH_LEN: usize = 64;

/// Why a `tx_submitted_emit` call was refused. Nothing is emitted on any error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TxEventError {
    pub kind: TxEventErrorKind,
    pub message: String,
}

/// The contract's failure categories, mirroring the approval-gate style: a
/// stable machine-readable `kind` plus a human-readable `message`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TxEventErrorKind {
    /// The hash was not 64 lowercase hex characters.
    InvalidHash,
    /// The explorer URL was not the canonical testnet link for the hash.
    InvalidUrl,
}

/// True when `hash` is exactly 64 lowercase hex characters.
pub fn is_transaction_hash(hash: &str) -> bool {
    hash.len() == HASH_LEN
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// True when `url` is the canonical explorer link for `hash` (and nothing else).
pub fn is_explorer_url_for(url: &str, hash: &str) -> bool {
    url.strip_prefix(EXPLORER_PREFIX) == Some(hash)
}

/// Validates the pair without emitting. Extracted so the rules are unit-tested
/// without a running app handle.
pub fn validate(hash: &str, explorer_url: &str) -> Result<(), TxEventError> {
    if !is_transaction_hash(hash) {
        return Err(TxEventError {
            kind: TxEventErrorKind::InvalidHash,
            message: "the transaction hash must be 64 lowercase hex characters".to_string(),
        });
    }
    if !is_explorer_url_for(explorer_url, hash) {
        return Err(TxEventError {
            kind: TxEventErrorKind::InvalidUrl,
            message: format!(
                "the explorer URL must be {EXPLORER_PREFIX}{hash} (the link must describe that hash)"
            ),
        });
    }
    Ok(())
}

/// Emits the `tx_submitted` event after validating the pair's shape.
///
/// The webview calls this once submission succeeded, but the check is syntactic
/// only (see the module docs): a caller that invents a hash can still emit it.
/// The event is UI display input ("reported by the app"), not proof; the Debug
/// panel's tail records it as such. A refusal never emits and returns the typed
/// error so the caller can label it.
#[tauri::command]
pub fn tx_submitted_emit(
    app: AppHandle,
    hash: String,
    explorer_url: String,
) -> Result<(), TxEventError> {
    validate(&hash, &explorer_url)?;
    events::emit(
        &app,
        PolarisEvent::TxSubmitted {
            hash,
            explorer_url,
        },
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "2f38a676d5ed29dad5043f5f105fe78c7fb355a4dd1bfc56c5e90ae33df33a2a";
    const URL: &str = "https://stellar.expert/explorer/testnet/tx/2f38a676d5ed29dad5043f5f105fe78c7fb355a4dd1bfc56c5e90ae33df33a2a";

    #[test]
    fn a_valid_pair_passes() {
        assert_eq!(validate(HASH, URL), Ok(()));
    }

    #[test]
    fn a_hash_must_be_64_lowercase_hex() {
        assert!(is_transaction_hash(HASH));
        // Uppercase, wrong length, non-hex and a prefix are all refused.
        assert!(!is_transaction_hash(&HASH.to_uppercase()));
        assert!(!is_transaction_hash(&HASH[..63]));
        assert!(!is_transaction_hash(&format!("{HASH}0")));
        assert!(!is_transaction_hash(&"z".repeat(64)));
        assert!(!is_transaction_hash("0x2f38"));
        assert!(!is_transaction_hash(""));
    }

    #[test]
    fn an_invalid_hash_is_refused_before_the_url_is_checked() {
        let error = validate("nope", URL).unwrap_err();
        assert_eq!(error.kind, TxEventErrorKind::InvalidHash);
    }

    #[test]
    fn the_url_must_be_the_canonical_testnet_link_for_the_hash() {
        assert!(is_explorer_url_for(URL, HASH));
        // A different hash, another network, another path and a trailing slash
        // are all refused: the link must describe exactly the reported hash.
        assert!(!is_explorer_url_for(URL, &"a".repeat(64)));
        assert!(!is_explorer_url_for(
            &URL.replace("testnet", "public"),
            HASH
        ));
        assert!(!is_explorer_url_for(
            "https://stellar.expert/explorer/testnet/account/GABC",
            HASH
        ));
        assert!(!is_explorer_url_for(&format!("{URL}/"), HASH));
        assert!(!is_explorer_url_for("https://example.com/tx/x", HASH));
    }

    #[test]
    fn a_wrong_url_for_a_valid_hash_is_refused() {
        let other = "a".repeat(64);
        let error = validate(HASH, &format!("{EXPLORER_PREFIX}{other}")).unwrap_err();
        assert_eq!(error.kind, TxEventErrorKind::InvalidUrl);
    }

    #[test]
    fn the_error_serializes_as_kind_and_message() {
        let error = validate("nope", URL).unwrap_err();
        let json = serde_json::to_string(&error).unwrap();
        assert!(json.contains(r#""kind":"invalidHash""#), "{json}");
        assert!(json.contains(r#""message":"#), "{json}");
    }
}
