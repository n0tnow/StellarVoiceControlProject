//! Webview → terminal logging (task F4).
//!
//! `console.*` in the webview never reaches the terminal Polaris is launched
//! from, so a failed payment surfaced only as a generic notch label ("Chain
//! error") with no cause — debugging took far too long. This module is the one
//! narrow command that lets the webview print a single line in the Rust
//! terminal, and (behind a flag) mirror it onto the typed `error` event so the
//! Debug panel's event tail shows the detail too.
//!
//! ## Redaction
//!
//! A log line is the last place a credential may leak, so the message is
//! best-effort scrubbed of anything key-shaped (`sk-…`, `gsk_…`, 56-char `S…`
//! Stellar seeds, long base64/hex blobs, `Bearer …`) before it is printed or
//! emitted. Public `G…` keys are not secrets and are preserved. The scrubber is
//! deliberately conservative (it over-redacts rather than under-redacts) and
//! pure, so it is unit-tested.

use tauri::AppHandle;

use crate::events::{self, PolarisEvent};

/// Placeholder written in place of anything that looks like a secret.
pub const REDACTED: &str = "[redacted]";

/// Hard ceiling on a logged message, so a runaway string cannot flood the log.
pub const MAX_MESSAGE_CHARS: usize = 400;

/// The exact terminal prefix, so the origin of a line is obvious.
pub const PREFIX: &str = "polaris: web";

/// The base64/hex alphabet (a superset of the Stellar base32 alphabet).
fn is_b64(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'+' || byte == b'/'
}

/// The Stellar base32 alphabet used by `G…`/`S…` keys.
fn is_base32(byte: u8) -> bool {
    byte.is_ascii_uppercase() || (b'2'..=b'7').contains(&byte)
}

/// True when the byte before `index` does not continue a word (regex `\b`).
fn word_boundary_before(bytes: &[u8], index: usize) -> bool {
    index == 0 || !bytes[index - 1].is_ascii_alphanumeric()
}

/// Case-insensitive ASCII match of `word` at `index`.
fn eq_ignore_case(bytes: &[u8], index: usize, word: &[u8]) -> bool {
    index + word.len() <= bytes.len() && bytes[index..index + word.len()].eq_ignore_ascii_case(word)
}

/// True when `index` begins a 56-char Stellar key with prefix `first`, not part
/// of a longer base32 run.
fn is_stellar_key(bytes: &[u8], index: usize, first: u8) -> bool {
    let end = index + 56;
    end <= bytes.len()
        && bytes[index] == first
        && bytes[index + 1..end].iter().all(|b| is_base32(*b))
        && bytes.get(end).map_or(true, |b| !is_base32(*b))
}

/// The length of a BIP-39-word-shaped token at `index` (3–8 ASCII lowercase
/// letters), or `None`.
fn lowercase_word_len(bytes: &[u8], index: usize) -> Option<usize> {
    let mut len = 0;
    while index + len < bytes.len() && bytes[index + len].is_ascii_lowercase() {
        len += 1;
        if len > 8 {
            return None;
        }
    }
    if (3..=8).contains(&len) {
        Some(len)
    } else {
        None
    }
}

/// The byte length of a run of 12+ space-separated lowercase words at `index`
/// (a BIP-39 recovery phrase, W10), or `None`. Deliberately over-redacts: any
/// 12-word lowercase run is scrubbed rather than risking a leaked phrase.
fn mnemonic_len(bytes: &[u8], index: usize) -> Option<usize> {
    if !word_boundary_before(bytes, index) {
        return None;
    }
    let mut at = index;
    let mut words = 0;
    loop {
        let word = lowercase_word_len(bytes, at)?;
        words += 1;
        let end = at + word;
        // The run ends unless a single space is followed by another word.
        if bytes.get(end) != Some(&b' ') || lowercase_word_len(bytes, end + 1).is_none() {
            return if words >= 12 { Some(end - index) } else { None };
        }
        at = end + 1;
    }
}

/// Length of a secret token starting at `index`, or `None`. `Bearer …` is
/// handled by the caller because its whitespace must be preserved.
fn secret_len(bytes: &[u8], index: usize) -> Option<usize> {
    let rest = &bytes[index..];
    if word_boundary_before(bytes, index) {
        // Provider keys: `gsk_…` (Groq), `sk-…` (OpenAI/Anthropic, incl. `sk-ant-…`).
        let prefix = if rest.starts_with(b"gsk_") {
            4
        } else if rest.starts_with(b"sk-") {
            3
        } else {
            0
        };
        if prefix > 0 {
            let mut len = prefix;
            while len < rest.len()
                && (rest[len].is_ascii_alphanumeric() || rest[len] == b'_' || rest[len] == b'-')
            {
                len += 1;
            }
            if len - prefix >= 8 {
                return Some(len);
            }
        }
    }

    // A Stellar seed (`S…`) is a secret; public keys are preserved by the caller.
    if is_stellar_key(bytes, index, b'S') {
        return Some(56);
    }

    // A long base64/hex run — the catch-all for opaque tokens (unsigned XDR,
    // signed envelope, raw hash). `=` padding is included.
    if is_b64(bytes[index]) {
        let mut len = 0;
        while index + len < bytes.len() && is_b64(bytes[index + len]) {
            len += 1;
        }
        let mut padded = len;
        while index + padded < bytes.len() && bytes[index + padded] == b'=' && padded - len < 2 {
            padded += 1;
        }
        if len >= 40 {
            return Some(padded);
        }
    }
    None
}

/// Replaces anything key-shaped with [`REDACTED`]. Safe on any string.
pub fn redact(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    while index < bytes.len() {
        // `Bearer <token>`: preserve the scheme and whitespace, drop the token.
        if word_boundary_before(bytes, index) && eq_ignore_case(bytes, index, b"Bearer") {
            let after = index + 6;
            if bytes.get(after).is_some_and(|b| b.is_ascii_whitespace()) {
                let mut ws = after;
                while ws < bytes.len() && bytes[ws].is_ascii_whitespace() {
                    ws += 1;
                }
                let mut end = ws;
                while end < bytes.len() && !bytes[end].is_ascii_whitespace() {
                    end += 1;
                }
                if end > ws {
                    out.push_str(&input[index..ws]);
                    out.push_str(REDACTED);
                    index = end;
                    continue;
                }
            }
        }

        // A public Stellar key is not a secret and must survive.
        if is_stellar_key(bytes, index, b'G') {
            out.push_str(&input[index..index + 56]);
            index += 56;
            continue;
        }

        // A BIP-39 recovery phrase (W10) is a secret even without a key shape.
        if let Some(len) = mnemonic_len(bytes, index) {
            out.push_str(REDACTED);
            index += len;
            continue;
        }

        if let Some(len) = secret_len(bytes, index) {
            out.push_str(REDACTED);
            index += len;
            continue;
        }

        let ch = input[index..].chars().next().expect("index is a char boundary");
        out.push(ch);
        index += ch.len_utf8();
    }
    out
}

/// Replaces control characters (including newlines) with spaces, so one log
/// message can never forge a second line.
pub fn sanitize(text: &str) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect()
}

/// Builds the exact terminal line: `polaris: web[<level>] <redacted message>`.
pub fn format_line(level: &str, message: &str) -> String {
    let level: String = sanitize(level).chars().take(16).collect();
    let message: String = sanitize(&redact(message))
        .chars()
        .take(MAX_MESSAGE_CHARS)
        .collect();
    format!("{PREFIX}[{}] {}", level.trim(), message.trim_end())
}

/// Prints one webview log line to the terminal. When `emit` is true the same
/// redacted detail is also pushed as an `error` event, which is what the Debug
/// panel's event tail renders. Never panics and never returns a value the caller
/// has to handle — logging must not become a second failure path.
#[tauri::command]
pub fn polaris_log(app: AppHandle, level: String, message: String, emit: Option<bool>) {
    println!("{}", format_line(&level, &message));
    if emit.unwrap_or(false) {
        let detail: String = sanitize(&redact(&message))
            .chars()
            .take(MAX_MESSAGE_CHARS)
            .collect();
        events::emit(&app, PolarisEvent::Error { message: detail });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_carries_the_prefix_and_level() {
        assert_eq!(format_line("error", "boom"), "polaris: web[error] boom");
    }

    #[test]
    fn provider_keys_are_redacted() {
        assert_eq!(redact("gsk_1234567890abcdef"), REDACTED);
        assert_eq!(redact("sk-proj-abcdefghijklmnop"), REDACTED);
        assert_eq!(redact("sk-ant-api03-abcdefghijklmnop"), REDACTED);
        // A short `sk-` fragment is not a key and is left alone.
        assert_eq!(redact("sk-1"), "sk-1");
    }

    #[test]
    fn stellar_seeds_are_redacted_and_public_keys_are_kept() {
        let seed = format!("S{}", "A".repeat(55));
        assert_eq!(redact(&seed), REDACTED);
        let public = format!("G{}", "A".repeat(55));
        assert_eq!(redact(&public), public);
    }

    #[test]
    fn bearer_tokens_are_redacted() {
        assert_eq!(
            redact("Authorization: Bearer abc.def.ghi"),
            "Authorization: Bearer [redacted]"
        );
    }

    #[test]
    fn long_base64_and_hex_blobs_are_redacted() {
        assert_eq!(redact(&"A".repeat(64)), REDACTED);
        assert_eq!(redact(&"abcdef0123456789".repeat(4)), REDACTED);
    }

    #[test]
    fn a_recovery_phrase_is_redacted() {
        let phrase = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
        assert_eq!(redact(&format!("seed: {phrase}")), "seed: [redacted]");
        // A short lowercase sentence is not a phrase and survives.
        let short = "recipient alice is not a known alias";
        assert_eq!(redact(short), short);
    }

    #[test]
    fn ordinary_text_is_untouched() {
        let text = "recipient alice is not a known alias (amount 5 USDC)";
        assert_eq!(redact(text), text);
    }

    #[test]
    fn a_message_is_hard_truncated() {
        let line = format_line("info", &"ab ".repeat(400));
        assert_eq!(
            line.chars().count(),
            PREFIX.chars().count() + "[info] ".chars().count() + MAX_MESSAGE_CHARS
        );
    }

    #[test]
    fn control_characters_cannot_forge_a_line() {
        assert_eq!(format_line("warn", "a\nb"), "polaris: web[warn] a b");
    }
}
