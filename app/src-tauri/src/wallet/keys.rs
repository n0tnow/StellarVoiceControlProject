//! Recovery-phrase and key derivation for the embedded wallet (step W10).
//!
//! * **Create** generates 256 bits of entropy from the OS CSPRNG and encodes it
//!   as a 24-word BIP-39 English recovery phrase. The phrase is shown once, then
//!   only the derived seed is kept (step W10's product decision).
//! * **Import** accepts either a 12/24-word BIP-39 phrase or a Stellar `S…`
//!   secret seed, so the same phrase can be restored in any Stellar wallet.
//! * Derivation is SEP-5: SLIP-0010 ed25519 on the path `m/44'/148'/index'`. The
//!   32-byte child key is the Ed25519 seed. No derivation crate is used: the
//!   hardened-only ed25519 derivation is a few lines of HMAC-SHA512.
//!
//! Secrets never leave this module: the phrase and the seed are returned as
//! [`zeroize::Zeroizing`] buffers so they are wiped on drop, and the public
//! helper [`parse_import`] only ever returns the derived seed and address.

use ed25519_dalek::SigningKey;
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroizing;

use super::WalletError;

/// Version byte for an Ed25519 secret seed StrKey (`S...`).
const SECRET_SEED_VERSION: u8 = 0x90;
/// Version byte for an Ed25519 public key StrKey (`G...`).
const PUBLIC_KEY_VERSION: u8 = 0x30;
/// The SEP-5 purpose/coin for Stellar: `m/44'/148'/index'`.
const SEP5_PATH: [u32; 2] = [44, 148];

type HmacSha512 = Hmac<Sha512>;

/// Generates a 24-word English BIP-39 recovery phrase from fresh OS entropy.
pub fn generate_phrase() -> Result<Zeroizing<String>, WalletError> {
    let mut entropy = Zeroizing::new([0u8; 32]);
    getrandom::fill(entropy.as_mut()).map_err(|error| {
        WalletError::Storage(format!("the OS random source failed: {error}"))
    })?;
    let mnemonic = bip39::Mnemonic::from_entropy(entropy.as_ref())
        .map_err(|_| WalletError::Storage("BIP-39 encoding failed".to_string()))?;
    Ok(Zeroizing::new(mnemonic.to_string()))
}

/// Derives the 32-byte Ed25519 seed for `m/44'/148'/index'` from a valid phrase.
pub fn seed_from_phrase(phrase: &str, index: u32) -> Result<Zeroizing<[u8; 32]>, WalletError> {
    let mnemonic = bip39::Mnemonic::parse(phrase.trim())
        .map_err(|_| WalletError::InvalidPhrase)?;
    // `to_entropy_array` reads the length without allocating a seed-equivalent
    // `Vec`; only 12-word (128-bit) and 24-word (256-bit) phrases are accepted.
    let (_, entropy_len) = mnemonic.to_entropy_array();
    if entropy_len != 16 && entropy_len != 32 {
        return Err(WalletError::InvalidPhrase);
    }
    let master = Zeroizing::new(mnemonic.to_seed(""));
    let child = slip10_ed25519(master.as_ref(), index);
    Ok(Zeroizing::new(child))
}

/// Validates a Stellar `S…` secret seed (base32 + CRC16-XModem) and returns its
/// 32 bytes.
pub fn seed_from_secret(secret: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
    let secret = secret.trim();
    if secret.len() != 56 {
        return Err(WalletError::InvalidSecret);
    }
    // The decoded bytes contain the seed, so the buffer is wiped on drop.
    let decoded = Zeroizing::new(base32_decode(secret).ok_or(WalletError::InvalidSecret)?);
    if decoded.len() != 35 || decoded[0] != SECRET_SEED_VERSION {
        return Err(WalletError::InvalidSecret);
    }
    let expected = crc16_xmodem(&decoded[..33]);
    if u16::from_le_bytes([decoded[33], decoded[34]]) != expected {
        return Err(WalletError::InvalidSecret);
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    seed.copy_from_slice(&decoded[1..33]);
    Ok(seed)
}

/// What [`parse_import`] accepted.
pub enum ImportSource {
    /// A BIP-39 recovery phrase.
    Phrase,
    /// A Stellar `S…` secret seed.
    Secret,
}

/// Parses either import form and derives the seed plus its public address. The
/// caller never sees the original string again; it is wiped by the command.
pub fn parse_import(
    input: &str,
    index: Option<u32>,
) -> Result<(Zeroizing<[u8; 32]>, String, ImportSource), WalletError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(WalletError::InvalidPhrase);
    }
    let (seed, source) = if trimmed.starts_with('S') && trimmed.len() == 56 {
        (seed_from_secret(trimmed)?, ImportSource::Secret)
    } else {
        (seed_from_phrase(trimmed, index.unwrap_or(0))?, ImportSource::Phrase)
    };
    let address = address_of(&seed);
    Ok((seed, address, source))
}

/// The `G…` public address for a 32-byte Ed25519 seed.
pub fn address_of(seed: &[u8; 32]) -> String {
    let key = SigningKey::from_bytes(seed);
    encode_public_key(&key.verifying_key().to_bytes())
}

/// SLIP-0010 ed25519 derivation. Ed25519 supports hardened indices only, which
/// is exactly what the SEP-5 path uses.
fn slip10_ed25519(seed: &[u8], index: u32) -> [u8; 32] {
    let mut mac = HmacSha512::new_from_slice(b"ed25519 seed")
        .expect("HMAC accepts a key of any length");
    mac.update(seed);
    let master = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    let mut chain = [0u8; 32];
    key.copy_from_slice(&master[..32]);
    chain.copy_from_slice(&master[32..]);

    for level in SEP5_PATH.iter().chain(std::iter::once(&index)) {
        let hardened = level | 0x8000_0000;
        let mut mac = HmacSha512::new_from_slice(&chain)
            .expect("HMAC accepts a key of any length");
        mac.update(&[0u8]);
        mac.update(&key);
        mac.update(&hardened.to_be_bytes());
        let child = mac.finalize().into_bytes();
        key.copy_from_slice(&child[..32]);
        chain.copy_from_slice(&child[32..]);
    }
    key
}

/// Encodes a 32-byte public key as a `G…` StrKey.
fn encode_public_key(key: &[u8; 32]) -> String {
    let mut payload = Vec::with_capacity(35);
    payload.push(PUBLIC_KEY_VERSION);
    payload.extend_from_slice(key);
    payload.extend_from_slice(&crc16_xmodem(&payload).to_le_bytes());
    base32_encode(&payload)
}

/// Decodes RFC 4648 base32 (`A-Z2-7`) without padding.
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

/// RFC 4648 base32 (`A-Z2-7`) without padding.
fn base32_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let (mut buffer, mut bits) = (0u32, 0u32);
    for byte in data {
        buffer = (buffer << 8) | u32::from(*byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The published SEP-5 Test 1 vector: the 12-word mnemonic below derives to
    /// these accounts at `m/44'/148'/0'` and `m/44'/148'/1'`.
    const SEP5_MNEMONIC: &str = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
    const SEP5_ADDRESS: &str = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
    const SEP5_ADDRESS_1: &str = "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX";

    #[test]
    fn sep5_vector_matches_the_published_addresses() {
        let seed = seed_from_phrase(SEP5_MNEMONIC, 0).unwrap();
        assert_eq!(address_of(&seed), SEP5_ADDRESS);
        let seed1 = seed_from_phrase(SEP5_MNEMONIC, 1).unwrap();
        assert_eq!(address_of(&seed1), SEP5_ADDRESS_1);
    }

    #[test]
    fn generated_phrase_is_24_words_and_round_trips() {
        let phrase = generate_phrase().unwrap();
        assert_eq!(phrase.split_whitespace().count(), 24);
        let seed = seed_from_phrase(&phrase, 0).unwrap();
        assert_eq!(address_of(&seed), address_of(&seed_from_phrase(&phrase, 0).unwrap()));
    }

    #[test]
    fn secret_round_trip_matches_the_public_address() {
        let seed = seed_from_phrase(SEP5_MNEMONIC, 0).unwrap();
        let secret = encode_secret_for_test(&seed);
        assert_eq!(address_of(&seed_from_secret(&secret).unwrap()), SEP5_ADDRESS);
    }

    #[test]
    fn invalid_phrase_and_checksum_are_rejected() {
        assert!(matches!(
            seed_from_phrase("not a real phrase", 0),
            Err(WalletError::InvalidPhrase)
        ));
        // A word outside the BIP-39 list is rejected outright.
        let unknown = SEP5_MNEMONIC.replace("cave", "zzzz");
        assert!(matches!(seed_from_phrase(&unknown, 0), Err(WalletError::InvalidPhrase)));
        // Two valid words swapped keep the length but fail the BIP-39 checksum.
        let swapped = SEP5_MNEMONIC.replace("pass fit", "fit pass");
        assert!(matches!(seed_from_phrase(&swapped, 0), Err(WalletError::InvalidPhrase)));

        let mut secret = encode_secret_for_test(&seed_from_phrase(SEP5_MNEMONIC, 0).unwrap());
        let last = secret.pop().unwrap();
        secret.push(if last == 'A' { 'B' } else { 'A' });
        assert!(matches!(seed_from_secret(&secret), Err(WalletError::InvalidSecret)));
        assert!(matches!(seed_from_secret("not-a-secret"), Err(WalletError::InvalidSecret)));
    }

    #[test]
    fn parse_import_accepts_both_forms() {
        let (_, address, _) = parse_import(SEP5_MNEMONIC, None).unwrap();
        assert_eq!(address, SEP5_ADDRESS);
        let seed = seed_from_phrase(SEP5_MNEMONIC, 0).unwrap();
        let (_, address, _) = parse_import(&encode_secret_for_test(&seed), None).unwrap();
        assert_eq!(address, SEP5_ADDRESS);
    }

    /// Test-only `S…` encoder, mirroring [`encode_public_key`].
    fn encode_secret_for_test(seed: &[u8; 32]) -> String {
        let mut payload = Vec::with_capacity(35);
        payload.push(SECRET_SEED_VERSION);
        payload.extend_from_slice(seed);
        payload.extend_from_slice(&crc16_xmodem(&payload).to_le_bytes());
        base32_encode(&payload)
    }
}
