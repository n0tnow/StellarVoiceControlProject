//! Shared signing helpers (steps W4b/W5a, since repurposed).
//!
//! This module no longer contains a browser bridge: signing happens in the
//! embedded wallet (`wallet_sign`, `wallet_sign_challenge`), which owns the key
//! inside the app. What remains here is the security-relevant, dependency-free
//! surface those paths rely on:
//!
//! * [`outcome`] — the wire result shape (`BridgeOutcome`) the wallet commands
//!   return and the shell labels.
//! * [`verify`] — XDR envelope/signature verification (tx hash, signature list,
//!   SEP-10 challenge checks) used by the wallet and the approval gate.
//! * [`strkey`] — `G...` public-key decoding without a StrKey crate.
//!
//! Both decoders are deliberately small so the security-relevant surface stays
//! auditable.

pub mod outcome;
pub mod strkey;
pub mod verify;
