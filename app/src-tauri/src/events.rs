//! The typed event stream from Rust to the UI.
//!
//! This is the Rust half of `PolarisEvent` (`docs/interfaces.md` §4). The wire
//! shape is `{ "type": "...", ... }` with snake_case type tags and camelCase
//! fields, so a TS consumer can switch on `event.type` directly. `tests` below
//! pin that shape — if a rename ever breaks the UI, the test fails first.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::types::{CaptureStatus, Intent, TxSummary};
use crate::wallet::WalletSession;

/// Channel name; `app/src/lib/polaris.ts` listens on the same string.
pub const POLARIS_EVENT_NAME: &str = "polaris-event";

/// Separate channel for cursor hover on the shell (step A5). Kept off
/// `POLARIS_EVENT_NAME` because it is high-frequency and shell-only: the rest of
/// the event stream is the voice/agent domain.
pub const NOTCH_HOVER_EVENT_NAME: &str = "notch_hover";

/// Payload of [`NOTCH_HOVER_EVENT_NAME`]; emitted only on an inside/outside
/// change (dwell timing lives in React).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchHover {
    pub inside: bool,
}

/// Separate channel for the raw cursor position (round-3 gaze fix). It is the
/// same global `mouseMoved` monitor's sample that hover uses, forwarded to the
/// webview so the gaze driver has a cursor stream without relying on DOM
/// pointer events, which a click-through overlay never receives. Deliberately
/// not on `POLARIS_EVENT_NAME`: it is shell-only and fires per move, gated in
/// `notch::hover` to the states that actually draw the face.
pub const NOTCH_CURSOR_EVENT_NAME: &str = "notch_cursor";

/// Payload of [`NOTCH_CURSOR_EVENT_NAME`]: the cursor in the webview's client
/// coordinates (CSS pixels from the viewport's top-left, `y` growing downward),
/// which Rust derives from the AppKit screen sample and the overlay window's
/// frame.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchCursor {
    pub x: f64,
    pub y: f64,
}

/// Separate channel for the hotkey-sourced shell mode (folded A6 prompt). Shell
/// state is a shell concern, so it stays off `POLARIS_EVENT_NAME`; the payload
/// is deliberately a boolean proposal the reducer resolves, not a command.
pub const NOTCH_HOTKEY_EVENT_NAME: &str = "notch_hotkey";

/// Payload of [`NOTCH_HOTKEY_EVENT_NAME`]. `prompt: true` proposes the `prompt`
/// state; `false` clears the proposal (second tap, Escape/click-away in the
/// webview, or the Rust watchdog's forced collapse).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchHotkey {
    pub prompt: bool,
}

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

/// Whether Polaris is currently producing audible speech (step A5).
///
/// This is driven by the actual blocking playback, not by the request: the
/// backend fires a playback-start callback the moment audio really begins (step
/// A9 — synthesis time is not "Speaking"), and the `speak` command emits `Idle`
/// only once playback has finished (or failed), so the notch can never be left
/// stuck showing "Speaking".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeechState {
    Speaking,
    Idle,
}

/// Everything the shell pushes to the UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PolarisEvent {
    Hotkey {
        state: HotkeyState,
    },
    /// Accessibility trust for the modifier-only Control+Option gesture (step
    /// A0 follow-up). `trusted: false` disables that gesture by design and
    /// leaves the Control+Option+Space shortcut as the only trigger.
    HotkeyPermission {
        trusted: bool,
    },
    /// Full capture snapshot on every transition (step A0). The UI's overlay is
    /// driven from this alone, so it must be emitted on *every* state change.
    CaptureStatus {
        status: CaptureStatus,
    },
    /// Raw "a WAV landed on disk" fact, emitted once per successful capture.
    /// Kept separate from `capture_status` so step A1 can subscribe to the
    /// artifact without re-deriving it from the lifecycle.
    AudioCaptured {
        path: String,
        duration_ms: u64,
    },
    Transcript {
        text: String,
        /// `final` is a Rust keyword; serde strips the `r#` and emits "final".
        r#final: bool,
        /// The language the audio was recognized as, as a BCP-47 tag (step A12),
        /// or `null` when the backend could not report it. It is measured from
        /// the audio and is the authoritative signal for the reply language and
        /// the TTS voice — never the model's own guess.
        language: Option<String>,
    },
    AgentStatus {
        stage: AgentStage,
    },
    /// Audible-playback lifecycle (step A5). The overlay keeps the expanded
    /// "Speaking" state up between these two events.
    SpeechStatus {
        state: SpeechState,
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
    /// Wallet session transitions (step W13a: login/logout/auto-lock). Carries
    /// the full `WalletSession` so the UI never has to poll.
    WalletSessionChanged(WalletSession),
    Error {
        message: String,
    },
}

impl PolarisEvent {
    /// The wire discriminant, handy for logging in the Rust terminal.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Hotkey { .. } => "hotkey",
            Self::HotkeyPermission { .. } => "hotkey_permission",
            Self::CaptureStatus { .. } => "capture_status",
            Self::AudioCaptured { .. } => "audio_captured",
            Self::Transcript { .. } => "transcript",
            Self::AgentStatus { .. } => "agent_status",
            Self::SpeechStatus { .. } => "speech_status",
            Self::ApprovalRequest { .. } => "approval_request",
            Self::ApprovalResult { .. } => "approval_result",
            Self::TxSubmitted { .. } => "tx_submitted",
            Self::WalletSessionChanged(_) => "wallet_session_changed",
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

/// Pushes a cursor hover change to the shell. Same failure policy as [`emit`]:
/// a lost hover edge must never be fatal.
pub fn emit_notch_hover(app: &AppHandle, inside: bool) {
    if let Err(error) = app.emit(NOTCH_HOVER_EVENT_NAME, &NotchHover { inside }) {
        eprintln!("polaris: failed to emit notch_hover: {error}");
    }
}

/// Pushes one cursor sample to the shell for the gaze driver. Same failure
/// policy as [`emit`]: a lost sample must never be fatal.
pub fn emit_notch_cursor(app: &AppHandle, x: f64, y: f64) {
    if let Err(error) = app.emit(NOTCH_CURSOR_EVENT_NAME, &NotchCursor { x, y }) {
        eprintln!("polaris: failed to emit notch_cursor: {error}");
    }
}

/// Pushes a hotkey-sourced shell proposal. Same failure policy as [`emit`].
pub fn emit_notch_hotkey(app: &AppHandle, prompt: bool) {
    if let Err(error) = app.emit(NOTCH_HOTKEY_EVENT_NAME, &NotchHotkey { prompt }) {
        eprintln!("polaris: failed to emit notch_hotkey: {error}");
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
            language: Some("en".into()),
        })
        .unwrap();
        // Step A12: the detected language rides the transcript event. The
        // webview relies on the exact key, so it is pinned here.
        assert_eq!(
            json,
            r#"{"type":"transcript","text":"hi","final":true,"language":"en"}"#
        );

        // Unknown language is explicit `null`, never a missing/ambiguous field.
        let json = serde_json::to_string(&PolarisEvent::Transcript {
            text: "hi".into(),
            r#final: true,
            language: None,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"transcript","text":"hi","final":true,"language":null}"#
        );

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
    fn hotkey_permission_matches_the_ts_union() {
        let json = serde_json::to_string(&PolarisEvent::HotkeyPermission { trusted: false }).unwrap();
        assert_eq!(json, r#"{"type":"hotkey_permission","trusted":false}"#);
    }

    #[test]
    fn speech_status_matches_the_ts_union() {
        // The overlay switches on `state`; both values must round-trip.
        let json = serde_json::to_string(&PolarisEvent::SpeechStatus {
            state: SpeechState::Speaking,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"speech_status","state":"speaking"}"#);

        let json = serde_json::to_string(&PolarisEvent::SpeechStatus {
            state: SpeechState::Idle,
        })
        .unwrap();
        assert_eq!(json, r#"{"type":"speech_status","state":"idle"}"#);
    }

    #[test]
    fn capture_events_match_the_ts_union() {
        let json = serde_json::to_string(&PolarisEvent::CaptureStatus {
            status: crate::types::CaptureStatus {
                state: crate::types::CaptureState::Recording,
                recording: None,
                error: None,
                label: None,
            },
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"capture_status","status":{"state":"recording","recording":null,"error":null,"label":null}}"#
        );

        // Step A1 transitions ride the same event with no new variant.
        let json = serde_json::to_string(&PolarisEvent::CaptureStatus {
            status: crate::types::CaptureStatus {
                state: crate::types::CaptureState::Transcribing,
                recording: None,
                error: None,
                label: None,
            },
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"capture_status","status":{"state":"transcribing","recording":null,"error":null,"label":null}}"#
        );

        let json = serde_json::to_string(&PolarisEvent::AudioCaptured {
            path: "/tmp/polaris-1.wav".into(),
            duration_ms: 1420,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"audio_captured","path":"/tmp/polaris-1.wav","durationMs":1420}"#
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

    #[test]
    fn hover_event_matches_the_ts_shape() {
        let json = serde_json::to_string(&NotchHover { inside: true }).unwrap();
        assert_eq!(json, r#"{"inside":true}"#);
    }

    #[test]
    fn cursor_event_matches_the_ts_shape() {
        let json = serde_json::to_string(&NotchCursor { x: 12.5, y: -3.0 }).unwrap();
        assert_eq!(json, r#"{"x":12.5,"y":-3.0}"#);
    }

    #[test]
    fn hotkey_event_matches_the_ts_shape() {
        let json = serde_json::to_string(&NotchHotkey { prompt: true }).unwrap();
        assert_eq!(json, r#"{"prompt":true}"#);
        let json = serde_json::to_string(&NotchHotkey { prompt: false }).unwrap();
        assert_eq!(json, r#"{"prompt":false}"#);
    }

    #[test]
    fn wallet_session_event_matches_the_ts_union() {
        let session = crate::wallet::WalletSession {
            state: crate::wallet::session::SessionState::Unlocked,
            active: Some(crate::wallet::ActiveWallet {
                address: "GABC".into(),
                label: "Main".into(),
            }),
            count: 1,
            unlocked_at: Some(1_700_000_000_000),
            auto_lock_minutes: 30,
        };
        let json = serde_json::to_string(&PolarisEvent::WalletSessionChanged(session.clone())).unwrap();
        assert_eq!(PolarisEvent::WalletSessionChanged(session).kind(), "wallet_session_changed");
        assert!(json.starts_with(r#"{"type":"wallet_session_changed","#), "{json}");
        assert!(json.contains(r#""autoLockMinutes":30"#), "{json}");
        assert!(json.contains(r#""unlockedAt":1700000000000"#), "{json}");
    }
}