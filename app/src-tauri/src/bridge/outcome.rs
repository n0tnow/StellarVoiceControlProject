//! The signing-result shape shared with the webview (steps W4b/W10).
//!
//! `wallet_sign` and `wallet_sign_challenge` (the embedded wallet) return this
//! `BridgeOutcome` on the wire. It is the vocabulary the shell already labels, so
//! a successful local signing run reports the signed envelope, the signer's
//! address and the transaction hash, and every failure carries a short machine
//! `code` plus a human `message`.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_xdr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signer_address: Option<String>,
    /// The Stellar transaction hash (lowercase hex) Rust itself computed. This is
    /// what appears on stellar.expert.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}
