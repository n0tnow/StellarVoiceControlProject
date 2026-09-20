//! Local Ed25519 signing for the embedded wallet (step W10).
//!
//! The envelope assembly mirrors the bridge's parse-free layout exactly: a v1
//! transaction envelope is `[type][body][signature count][decorations…]`, so an
//! approved unsigned envelope (empty signature list) becomes
//! `[type][body][1][hint][00000040][signature]` and a SEP-10 challenge gains one
//! `DecoratedSignature` at the end. The hint is the last four bytes of the public
//! key. After assembling, the **same** independent verifiers the bridge uses
//! (`verify_signed` / `verify_challenge`) run before success is reported.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use ed25519_dalek::{Signer, SigningKey};

use super::{SignedTx, WalletError};
use crate::bridge::verify::{
    self, SIGNATURE_COUNT_ONE, SIGNATURE_LEN,
};

/// `hint(4) || signatureLen(4) || signature(64)`.
const DECORATION_LEN: usize = 4 + 4 + 64;

/// Signs an unsigned transaction owned by `public` and independently verifies the
/// result. Returns the signed envelope and the lowercase-hex transaction hash.
pub fn sign_transaction(
    unsigned_xdr: &str,
    seed: &[u8; 32],
    public: &[u8; 32],
    passphrase: &str,
) -> Result<SignedTx, WalletError> {
    let full = verify::decode_envelope(unsigned_xdr).map_err(integrity)?;
    let unsigned = verify::parse_unsigned(&full).map_err(integrity)?;
    if unsigned.source != *public {
        // The approved transaction was built for the account that was active at
        // approval time; a different active account now is a refusal, not a
        // generic integrity failure.
        return Err(WalletError::SignerChanged);
    }
    let hash = verify::tx_hash(unsigned.body, passphrase);
    let decorated = decorate(seed, &hash);
    let mut out = Vec::with_capacity(full.len() + DECORATION_LEN);
    out.extend_from_slice(&full[..full.len() - 4]);
    out.extend_from_slice(&SIGNATURE_COUNT_ONE);
    out.extend_from_slice(&decorated);
    let signed_xdr = BASE64.encode(out);

    let verified = verify::verify_signed(unsigned_xdr, &signed_xdr, public, passphrase)
        .map_err(integrity)?;
    Ok(SignedTx {
        signed_xdr,
        tx_hash: hex::encode(verified),
        signer_address: String::new(),
    })
}

/// Signs a SEP-10 challenge (sequence 0, already carrying the anchor's signature)
/// and independently verifies the 1 → 2 signature transition.
pub fn sign_challenge(
    challenge_xdr: &str,
    seed: &[u8; 32],
    public: &[u8; 32],
    passphrase: &str,
) -> Result<SignedTx, WalletError> {
    let full = verify::decode_envelope(challenge_xdr).map_err(integrity)?;
    let parsed = verify::parse_envelope(&full).map_err(integrity)?;
    if parsed.sequence != 0 {
        return Err(WalletError::Integrity(
            "the challenge sequence number is not 0".to_string(),
        ));
    }
    if parsed.source == *public {
        return Err(WalletError::Integrity(
            "the challenge source is the active wallet, so signing it would authorize an owner transaction"
                .to_string(),
        ));
    }
    if parsed.signatures.len() != 1 {
        return Err(WalletError::Integrity(
            "the challenge does not carry exactly the anchor's signature".to_string(),
        ));
    }
    let hash = verify::tx_hash(parsed.body, passphrase);
    let list_start = full.len() - (parsed.signatures.len() * DECORATION_LEN + 4);
    let mut out = Vec::with_capacity(full.len() + DECORATION_LEN);
    out.extend_from_slice(&full[..list_start]);
    out.extend_from_slice(&((parsed.signatures.len() as u32 + 1).to_be_bytes()));
    for signature in &parsed.signatures {
        out.extend_from_slice(&signature.hint);
        out.extend_from_slice(&SIGNATURE_LEN);
        out.extend_from_slice(&signature.signature);
    }
    out.extend_from_slice(&decorate(seed, &hash));
    let signed_xdr = BASE64.encode(out);

    let verified =
        verify::verify_challenge(challenge_xdr, &signed_xdr, public, passphrase).map_err(integrity)?;
    Ok(SignedTx {
        signed_xdr,
        tx_hash: hex::encode(verified),
        signer_address: String::new(),
    })
}

/// The `hint(4) || 00000040 || signature(64)` decoration for `hash`.
fn decorate(seed: &[u8; 32], hash: &[u8; 32]) -> [u8; DECORATION_LEN] {
    let key = SigningKey::from_bytes(seed);
    let signature = key.sign(hash);
    let verifying = key.verifying_key().to_bytes();
    let mut decoration = [0u8; DECORATION_LEN];
    decoration[..4].copy_from_slice(&verifying[28..32]);
    decoration[4..8].copy_from_slice(&SIGNATURE_LEN);
    decoration[8..].copy_from_slice(&signature.to_bytes());
    decoration
}

fn integrity(error: verify::VerifyError) -> WalletError {
    WalletError::Integrity(error.detail())
}
