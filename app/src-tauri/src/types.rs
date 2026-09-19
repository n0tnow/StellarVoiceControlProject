//! Rust mirrors of the TypeScript seam (`docs/interfaces.md` §1–2, `@polaris/interfaces`).
//!
//! These exist because the webview is the only place TypeScript runs: when the
//! shell has to *carry* an `Intent` or a decoded transaction summary across the
//! Tauri boundary (approval requests, signing), the shape has to exist on this
//! side too. Keep field names byte-identical to the TS definitions — the
//! approval card renders whatever arrives here.

use serde::{Deserialize, Serialize};

/// `IntentKind` — what the user asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentKind {
    Deposit,
    Swap,
    Send,
    GuardPolicy,
    RawTx,
}

/// A structured value-moving request produced from a voice transcript.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub kind: IntentKind,
    /// e.g. "USDC" (testnet)
    pub asset: String,
    /// Decimal string, never a float.
    pub amount: String,
    /// Address or alias.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recipient: Option<String>,
    /// Alias book entry, e.g. "ada".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memo: Option<String>,
    /// Voice transcript excerpt that produced it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// `ChainToolResult["summary"]` — what the approval card renders, decoded from
/// the unsigned XDR by Owner B's chain tools.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TxSummary {
    /// e.g. "Swap 500 USDC -> XLM"
    pub title: String,
    /// Decoded operation details.
    pub lines: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explorer_url: Option<String>,
    pub estimated_fee: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intent_serializes_to_the_ts_shape() {
        let intent = Intent {
            kind: IntentKind::Send,
            asset: "USDC".into(),
            amount: "10".into(),
            recipient: None,
            alias: Some("ada".into()),
            memo: None,
            source: Some("send 10 usdc to ada".into()),
        };
        let json = serde_json::to_string(&intent).unwrap();
        assert_eq!(
            json,
            r#"{"kind":"send","asset":"USDC","amount":"10","alias":"ada","source":"send 10 usdc to ada"}"#
        );
    }

    #[test]
    fn summary_uses_camel_case() {
        let summary = TxSummary {
            title: "Send 10 USDC".into(),
            lines: vec!["to ada".into()],
            explorer_url: Some("https://stellar.expert/".into()),
            estimated_fee: "0.00001 XLM".into(),
        };
        let json = serde_json::to_string(&summary).unwrap();
        assert!(json.contains(r#""explorerUrl":"https://stellar.expert/""#));
        assert!(json.contains(r#""estimatedFee":"0.00001 XLM""#));
    }
}