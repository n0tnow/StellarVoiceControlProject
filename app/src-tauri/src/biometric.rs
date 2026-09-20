//! The macOS device-owner authentication used by the approval gate (step W3).
//!
//! Polaris is a wallet whose keys live in the app's embedded wallet, protected
//! by the OS keychain. The only thing the Touch ID prompt has to prove is that
//! **a human is present at this Mac right now** before the gate releases an
//! unsigned XDR to the signer. That is exactly the property `LAContext` with
//! [`LAPolicy::DeviceOwnerAuthentication`] provides: Touch ID first, and the
//! device password as the documented fallback when no biometrics are available
//! (lid closed, no finger enrolled, Touch ID locked out). The fallback is a
//! deliberate decision — a password is still a present-human proof, and refusing
//! it would lock the user out of their own wallet on a Mac without Touch ID.
//!
//! Threading. `evaluatePolicy` is asynchronous and its reply block runs on an
//! unspecified queue; this module bridges it to a blocking `mpsc` receive. The
//! callers ([`crate::approval::approval_authorize`]) run on the Tauri blocking
//! pool, so the async runtime is never blocked. The wait is bounded by
//! [`AUTH_TIMEOUT`], and a timeout invalidates the context so a late tap cannot
//! authorize a request the gate has already abandoned.
//!
//! Tests never touch the framework: they exercise a fake [`Authenticator`].

use std::sync::mpsc;
use std::sync::Arc;
use std::time::Duration;

#[cfg(target_os = "macos")]
use block2::RcBlock;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::Bool;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSError, NSString};
#[cfg(target_os = "macos")]
use objc2_local_authentication::{LABiometryType, LAContext, LAError, LAPolicy};

/// How long [`Authenticator::authenticate`] waits for the system prompt. Long
/// enough for a human to read and tap, short enough that an ignored prompt
/// cannot pin a blocking-pool thread forever.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(60);

/// The localized reason is rendered by macOS as `<app> is trying to <reason>.`;
/// anything past this many characters would be an unreadable wall of text.
pub const MAX_REASON_CHARS: usize = 120;

/// Reason used when the caller's reason is blank after sanitizing. The framework
/// rejects an empty reason, so a non-empty fallback is mandatory.
pub const DEFAULT_REASON: &str = "Approve this action";

/// The reason the Debug panel's self-test passes to the real prompt. The W3
/// debug contract requires the string to state plainly that no funds move.
pub const SELFTEST_REASON: &str = "Autonomy self-test — no funds are moved";

/// Why an authentication did not succeed. Kept close to how the UI wants to
/// talk about it: cancelled is the user's choice, the rest are failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthError {
    /// The user dismissed the prompt, or the system cancelled it.
    Cancelled,
    /// Credentials were rejected, or the framework failed for another reason.
    Failed(String),
    /// The policy cannot be evaluated here (no biometry, no passcode set,
    /// interaction not allowed…).
    Unavailable(String),
    /// The prompt did not answer within [`AUTH_TIMEOUT`].
    Timeout,
}

impl AuthError {
    /// Short, UI-safe copy.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Cancelled => "Cancelled",
            Self::Failed(_) => "Auth failed",
            Self::Unavailable(_) => "No Touch ID",
            Self::Timeout => "Auth timed out",
        }
    }

    /// Full terminal message; never contains secret material.
    pub fn detail(&self) -> String {
        match self {
            Self::Cancelled => "the approval prompt was cancelled".to_string(),
            Self::Failed(detail) => format!("the approval prompt failed: {detail}"),
            Self::Unavailable(detail) => {
                format!("the approval prompt is unavailable: {detail}")
            }
            Self::Timeout => format!(
                "the approval prompt did not answer within {} s",
                AUTH_TIMEOUT.as_secs()
            ),
        }
    }
}

/// A way to ask the device owner to approve an action.
///
/// The real implementation is [`SystemAuthenticator`]; tests supply a fake so no
/// test ever shows a prompt. Callers run this on a blocking thread.
pub trait Authenticator: Send + Sync {
    fn authenticate(&self, reason: &str) -> Result<(), AuthError>;
}

/// The production authenticator, backed by `LocalAuthentication`.
pub struct SystemAuthenticator;

impl Authenticator for SystemAuthenticator {
    fn authenticate(&self, reason: &str) -> Result<(), AuthError> {
        evaluate(sanitize_reason(reason))
    }
}

/// The process-wide authenticator, managed as Tauri state.
pub fn system() -> Arc<dyn Authenticator> {
    Arc::new(SystemAuthenticator)
}

/// Collapses whitespace, neutralises control and bidi/zero-width characters,
/// and truncates `reason` to [`MAX_REASON_CHARS`]. A model-provided summary must
/// never be able to put a newline, an invisible bidi override or an unbounded
/// string into the system prompt.
pub fn sanitize_reason(reason: &str) -> String {
    let cleaned: String = reason
        .chars()
        .map(|character| {
            if is_unsafe_for_prompt(character) {
                ' '
            } else {
                character
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let truncated: String = collapsed.chars().take(MAX_REASON_CHARS).collect();
    if truncated.is_empty() {
        DEFAULT_REASON.to_string()
    } else {
        truncated
    }
}

/// Control characters plus the invisible formatting characters a hostile summary
/// could use to spoof the prompt: zero-width spaces/joiners, bidi marks,
/// embeddings, overrides and isolates, and the BOM.
fn is_unsafe_for_prompt(character: char) -> bool {
    character.is_control()
        || matches!(
            character,
            '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'
        )
}

/// Which biometry this Mac supports, if any. Used by the Debug panel's health
/// check; `TouchId` is the expected value on the target hardware.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BiometryKind {
    None,
    TouchId,
    FaceId,
    OpticId,
    Unknown,
}

impl BiometryKind {
    pub fn label(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::TouchId => "Touch ID",
            Self::FaceId => "Face ID",
            Self::OpticId => "Optic ID",
            Self::Unknown => "unknown",
        }
    }
}

/// The result of a non-prompting policy check (`canEvaluatePolicy`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PolicySupport {
    /// Whether [`LAPolicy::DeviceOwnerAuthentication`] can be evaluated at all.
    pub available: bool,
    /// The biometry reported by the context; only meaningful when `available`.
    pub biometry: BiometryKind,
    /// Human-readable explanation, from the framework on failure.
    pub detail: String,
}

/// Runs the real prompt. Blocking; the caller must be on a blocking thread.
#[cfg(target_os = "macos")]
fn evaluate(reason: String) -> Result<(), AuthError> {
    let (tx, rx) = mpsc::channel();
    // SAFETY: `LAContext` may be created and used from any thread and shows no
    // UI until `evaluatePolicy`. The context is kept alive across the receive
    // below (it is only dropped after the result resolves), and the reply block
    // only forwards the outcome over the channel. `RcBlock` keeps the block
    // alive for as long as the framework holds a reference, so no lifetime
    // assumption about an asynchronous call is required.
    let context: Retained<LAContext> = unsafe {
        let context = LAContext::new();
        let reason = NSString::from_str(&reason);
        let handler = RcBlock::new(move |success: Bool, error: *mut NSError| {
            let outcome = if success.as_bool() {
                Ok(())
            } else {
                Err(map_error(error))
            };
            let _ = tx.send(outcome);
        });
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &reason,
            &handler,
        );
        context
    };

    match rx.recv_timeout(AUTH_TIMEOUT) {
        Ok(result) => result,
        Err(_) => {
            // Dismiss the lingering prompt so it cannot be answered after the
            // gate has given up on it.
            unsafe { context.invalidate() };
            Err(AuthError::Timeout)
        }
    }
}

/// Off macOS the framework is absent; the gate must still compile and fail
/// closed.
#[cfg(not(target_os = "macos"))]
fn evaluate(_reason: String) -> Result<(), AuthError> {
    Err(AuthError::Unavailable(
        "LocalAuthentication is only available on macOS".to_string(),
    ))
}

/// Maps a framework `NSError` to our error taxonomy. Takes the raw pointer so it
/// can be unit-identified without constructing an `NSError`.
#[cfg(target_os = "macos")]
fn map_error(error: *mut NSError) -> AuthError {
    if error.is_null() {
        return AuthError::Failed("the system reported a failure without an error".to_string());
    }
    // SAFETY: the framework guarantees the error out-parameter is either null or
    // a valid `NSError` for the duration of the reply block.
    let error = unsafe { &*error };
    let code = error.code();
    if code == LAError::UserCancel.0
        || code == LAError::SystemCancel.0
        || code == LAError::AppCancel.0
    {
        AuthError::Cancelled
    } else if code == LAError::BiometryNotAvailable.0
        || code == LAError::BiometryNotEnrolled.0
        || code == LAError::BiometryLockout.0
        || code == LAError::PasscodeNotSet.0
        || code == LAError::NotInteractive.0
    {
        AuthError::Unavailable(format!("{} (code {code})", error.localizedDescription()))
    } else {
        AuthError::Failed(format!(
            "{} ({}, code {code})",
            error.localizedDescription(),
            error.domain()
        ))
    }
}

/// Whether the device-owner policy can be evaluated, **without** showing a
/// prompt. Safe to call at any time and from any thread; this is what the Debug
/// panel's health check uses.
#[cfg(target_os = "macos")]
pub fn policy_support() -> PolicySupport {
    // SAFETY: `LAContext` may be created and queried from any thread, and
    // neither `canEvaluatePolicy` nor `biometryType` shows UI.
    unsafe {
        let context = LAContext::new();
        match context.canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication) {
            Ok(()) => {
                let raw = context.biometryType();
                let biometry = if raw == LABiometryType::TouchID {
                    BiometryKind::TouchId
                } else if raw == LABiometryType::FaceID {
                    BiometryKind::FaceId
                } else if raw == LABiometryType::OpticID {
                    BiometryKind::OpticId
                } else if raw == LABiometryType::None {
                    BiometryKind::None
                } else {
                    BiometryKind::Unknown
                };
                PolicySupport {
                    available: true,
                    biometry,
                    detail: "the device-owner policy can be evaluated".to_string(),
                }
            }
            Err(error) => PolicySupport {
                available: false,
                biometry: BiometryKind::None,
                detail: format!(
                    "{} ({}, code {})",
                    error.localizedDescription(),
                    error.domain(),
                    error.code()
                ),
            },
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn policy_support() -> PolicySupport {
    PolicySupport {
        available: false,
        biometry: BiometryKind::None,
        detail: "LocalAuthentication is only available on macOS".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_reason_falls_back_to_the_default() {
        assert_eq!(sanitize_reason(""), DEFAULT_REASON);
        assert_eq!(sanitize_reason("   \n\t "), DEFAULT_REASON);
    }

    #[test]
    fn control_characters_and_whitespace_are_collapsed() {
        assert_eq!(
            sanitize_reason("Approve\n\tpayment   of 10 XLM"),
            "Approve payment of 10 XLM"
        );
    }

    #[test]
    fn bidi_and_zero_width_characters_are_stripped() {
        // A right-to-left override (U+202E) plus a zero-width space (U+200B)
        // must not survive into the system prompt.
        assert_eq!(
            sanitize_reason("Approve\u{202E} payment\u{200B} of 10 XLM"),
            "Approve payment of 10 XLM"
        );
        assert_eq!(sanitize_reason("\u{200B}\u{2066}\u{FEFF}"), DEFAULT_REASON);
    }

    #[test]
    fn long_reasons_are_truncated_to_the_cap() {
        let long = "a".repeat(MAX_REASON_CHARS + 50);
        assert_eq!(sanitize_reason(&long).chars().count(), MAX_REASON_CHARS);
    }

    #[test]
    fn error_labels_and_details_are_non_empty() {
        for error in [
            AuthError::Cancelled,
            AuthError::Failed("boom".into()),
            AuthError::Unavailable("none".into()),
            AuthError::Timeout,
        ] {
            assert!(!error.label().is_empty());
            assert!(!error.detail().is_empty());
        }
    }
}
