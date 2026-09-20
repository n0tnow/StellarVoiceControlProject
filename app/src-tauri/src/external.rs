//! Opens an allow-listed external link in the default browser.
//!
//! The one place the app hands a URL to the OS. The allow-list is a fixed set of
//! testnet explorer prefixes plus Circle's test USDC faucet, so a compromised
//! webview cannot make the shell open an arbitrary page or a non-http scheme.

use std::process::Command;

/// The only URL prefixes the shell will open.
const ALLOWED_PREFIXES: &[&str] = &[
    "https://stellar.expert/explorer/testnet/",
    // Circle's testnet USDC faucet, linked once the wallet trusts USDC.
    "https://faucet.circle.com/",
];

/// The longest URL accepted (an account or transaction link is well under this).
const MAX_URL_LEN: usize = 200;

/// Whether `url` is an explorer link the shell may open: an allow-listed prefix,
/// printable ASCII only (no whitespace or control characters), bounded length.
pub fn is_allowed(url: &str) -> bool {
    url.len() <= MAX_URL_LEN
        && url.bytes().all(|byte| byte.is_ascii_graphic())
        && ALLOWED_PREFIXES.iter().any(|prefix| url.starts_with(prefix))
}

/// Opens an allow-listed explorer link with the macOS `open` command.
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !is_allowed(&url) {
        return Err("that link is not an allowed explorer link".into());
    }
    Command::new("open")
        .arg("--")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open the link: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn testnet_explorer_links_are_allowed() {
        assert!(is_allowed("https://stellar.expert/explorer/testnet/tx/abc123"));
        assert!(is_allowed(
            "https://stellar.expert/explorer/testnet/account/GAJW5V7VXHIRTJBGNVYTGXJ6CLDM7IEIPAYD3XLKKTKJKPRBYOTAC25A"
        ));
    }

    #[test]
    fn the_circle_usdc_faucet_is_allowed() {
        assert!(is_allowed("https://faucet.circle.com/"));
    }

    #[test]
    fn everything_else_is_refused() {
        assert!(!is_allowed("http://stellar.expert/explorer/testnet/tx/abc"));
        assert!(!is_allowed("https://stellar.expert/explorer/public/tx/abc"));
        assert!(!is_allowed("https://evil.example/https://stellar.expert/explorer/testnet/"));
        assert!(!is_allowed("https://faucet.circle.com.evil.example/"));
        assert!(!is_allowed("http://faucet.circle.com/"));
        assert!(!is_allowed("file:///etc/passwd"));
        assert!(!is_allowed("https://stellar.expert/explorer/testnet/tx/a b"));
        assert!(!is_allowed("https://stellar.expert/explorer/testnet/tx/a\nb"));
        assert!(!is_allowed(&format!(
            "https://stellar.expert/explorer/testnet/{}",
            "a".repeat(300)
        )));
    }
}
