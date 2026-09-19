//! The typed event stream from Rust to the UI.
//!
//! This is the Rust half of `PolarisEvent` (`docs/interfaces.md` §4). The wire
//! shape is `{ "type": "...", ... }` with snake_case type tags and camelCase
//! fields, so a TS consumer can switch on `event.type` directly. `tests` below
//! pin that shape — if a rename ever breaks the UI, the test fails first.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::types::{Intent, TxSummary};

/// Channel name; `app/src/lib/polaris.ts` listens on the same string.
pub const POLARIS_EVENT_NAME: &str = "polaris-event";

/// Press/release of the push-to-talk hotkey (step A0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyState {
    Down,
    Up,
}

/// Where the agent loop currently is (step A2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStage {
    Thinking,
    ToolCall,
    AwaitingApproval,
    Done,
}

/// Everything the shell pushes to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PolarisEvent {
    Hotkey {
        state: HotkeyState,
    },
    Transcript {
        text: String,
        /// `final` is a Rust keyword; serde strips the `r#` and emits "final".
        r#final: bool,
    },
    AgentStatus {
        stage: AgentStage,
    },
    ApprovalRequest {
        intent: Intent,
        summary: TxSummary,
        payload_hash: String,
    },
    ApprovalResult {
        payload_hash: String,
        approved: bool,
    },
    TxSubmitted {
        hash: String,
        explorer_url: String,
    },
    Error {
        message: String,
    },
}

impl PolarisEvent {
    /// The wire discriminant, handy for logging in the Rust terminal.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Hotkey { .. } => "hotkey",
            Self::Transcript { .. } => "transcript",
            Self::AgentStatus { .. } => "agent_status",
            Self::ApprovalRequest { .. } => "approval_request",
            Self::ApprovalResult { .. } => "approval_result",
            Self::TxSubmitted { .. } => "tx_submitted",
            Self::Error { .. } => "error",
        }
    }
}

/// Pushes one event to the webview. Failures are logged, never fatal: losing a
/// log line must not take down the shell.
pub fn emit(app: &AppHandle, event: PolarisEvent) {
    if let Err(error) = app.emit(POLARIS_EVENT_NAME, &event) {
        eprintln!("polaris: failed to emit {}: {error}", event.kind());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_tags_and_fields_match_the_ts_union() {
        let json = serde_json::to_string(&PolarisEvent::Hotkey {
            state: HotkeyState::Down,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"hotkey","state":"down"}"#);

        let json = serde_json::to_string(&PolarisEvent::Transcript {
            text: "hi".into(),
            r#final: true,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"transcript","text":"hi","final":true}"#);

        let json = serde_json::to_string(&PolarisEvent::TxSubmitted {
            hash: "abc".into(),
            explorer_url: "https://stellar.expert/x".into(),
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"tx_submitted","hash":"abc","explorerUrl":"https://stellar.expert/x"}"#
        );
    }

    #[test]
    fn approval_request_round_trips() {
        let event = PolarisEvent::ApprovalRequest {
            intent: Intent {
                kind: crate::types::IntentKind::Send,
                asset: "USDC".into(),
                amount: "10".into(),
                recipient: None,
                alias: Some("ada".into()),
                memo: None,
                source: None,
            },
            summary: TxSummary {
                title: "Send 10 USDC".into(),
                lines: vec!["alias: ada".into()],
                explorer_url: None,
                estimated_fee: "0.00001 XLM".into(),
            },
            payload_hash: "deadbeef".into(),
        };
        let json = serde_json::to_string(&event).unwrap();
        assert!(json.starts_with(r#"{"type":"approval_request""#));
        assert!(json.contains(r#""payloadHash":"deadbeef""#));
        assert_eq!(serde_json::from_str::<PolarisEvent>(&json).unwrap(), event);
    }
}