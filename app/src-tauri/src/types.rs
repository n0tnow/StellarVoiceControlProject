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

/// `CaptureState` — the push-to-talk lifecycle. `Ready` means a WAV is on disk
/// for step A1; it is never a send action.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureState {
    Idle,
    Recording,
    Ready,
    Error,
}

/// `CaptureRecording` — a finished capture on disk. `duration_ms` is derived
/// from the number of sample frames actually written, not from wall time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureRecording {
    pub path: String,
    pub duration_ms: u64,
}

/// `CaptureStatus` — the capture engine's snapshot, mirrored into the
/// `capture_status` event and the `capture_status` Tauri command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStatus {
    pub state: CaptureState,
    #[serde(default)]
    pub recording: Option<CaptureRecording>,
    /// Non-null iff `state == Error`.
    #[serde(default)]
    pub error: Option<String>,
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

    #[test]
    fn capture_status_matches_the_ts_shape() {
        let idle = CaptureStatus {
            state: CaptureState::Idle,
            recording: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&idle).unwrap(),
            r#"{"state":"idle","recording":null,"error":null}"#
        );

        let ready = CaptureStatus {
            state: CaptureState::Ready,
            recording: Some(CaptureRecording {
                path: "/tmp/polaris-1.wav".into(),
                duration_ms: 1420,
            }),
            error: None,
        };
        assert_eq!(
            serde_json::to_string(&ready).unwrap(),
            r#"{"state":"ready","recording":{"path":"/tmp/polaris-1.wav","durationMs":1420},"error":null}"#
        );

        let failed = CaptureStatus {
            state: CaptureState::Error,
            recording: None,
            error: Some("no default input device".into()),
        };
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"state":"error","recording":null,"error":"no default input device"}"#
        );
    }
}