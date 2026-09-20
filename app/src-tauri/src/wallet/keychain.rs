//! macOS login-Keychain storage for wallet seeds (step W10).
//!
//! The task asked for a generic-password item (service `dev.polaris.wallet`,
//! account `signer-<address>`) because **data-protection / biometric ACLs need
//! entitlements an ad-hoc dev build does not have**. A plain login-Keychain item
//! needs none: the first time an ad-hoc-signed build reads an item created by a
//! previous build, macOS shows its standard "… wants to use your confidential
//! information … Always Allow / Deny" prompt. Denying it makes the probe fail.
//!
//! A failed probe is **not** a silent fallback: the file store is only usable
//! when `POLARIS_WALLET_ALLOW_FILE_STORE=1` was set explicitly. Without the flag
//! the store is reported as `keychain unavailable` and create/import/sign refuse
//! with an actionable error.
//!
//! The seed is the raw 32-byte item data. Nothing else is stored here.

use std::path::Path;
use std::sync::Arc;

use zeroize::Zeroizing;

use super::file::FileStore;
use super::{KeyStore, Stores, WalletError, SERVICE};

/// `errSecItemNotFound` from `Security/SecBase.h`.
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;

/// Generic-password Keychain store.
#[cfg(target_os = "macos")]
pub struct KeychainStore {
    service: String,
}

#[cfg(target_os = "macos")]
impl KeychainStore {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    /// Round-trips a throwaway item to learn whether this build can use the
    /// Keychain at all. Creating and deleting its own item does not prompt; a
    /// read after an ad-hoc signature change can, which is the documented
    /// "Always Allow" case.
    pub fn probe(&self) -> Result<(), String> {
        use security_framework::passwords::{
            delete_generic_password, get_generic_password, set_generic_password,
        };
        let probe = [0u8; 32];
        set_generic_password(&self.service, "probe", &probe).map_err(|error| error.to_string())?;
        let read = get_generic_password(&self.service, "probe").map_err(|error| error.to_string())?;
        let _ = delete_generic_password(&self.service, "probe");
        if read.len() != 32 {
            return Err("the probe item read back the wrong length".to_string());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
impl KeyStore for KeychainStore {
    fn get(&self, id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
        let bytes = match security_framework::passwords::get_generic_password(&self.service, id) {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {
                return Err(WalletError::Storage("seed not found".to_string()));
            }
            Err(error) => return Err(WalletError::Storage(error.to_string())),
        };
        if bytes.len() != 32 {
            return Err(WalletError::Storage(
                "the Keychain item has the wrong length".to_string(),
            ));
        }
        let mut seed = Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(&bytes);
        Ok(seed)
    }

    fn set(&self, id: &str, seed: &[u8; 32]) -> Result<(), WalletError> {
        security_framework::passwords::set_generic_password(&self.service, id, seed)
            .map_err(|error| WalletError::Storage(error.to_string()))
    }

    fn delete(&self, id: &str) -> Result<(), WalletError> {
        match security_framework::passwords::delete_generic_password(&self.service, id) {
            Ok(()) => Ok(()),
            // Deleting a missing item is a no-op for our callers.
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => Ok(()),
            Err(error) => Err(WalletError::Storage(error.to_string())),
        }
    }

    fn label(&self) -> &'static str {
        super::STORE_KEYCHAIN
    }
}

/// `POLARIS_WALLET_ALLOW_FILE_STORE=1` explicitly opts into the plaintext
/// `0600` file store when the Keychain probe fails. Any other value means the
/// Keychain is the only store.
pub fn file_store_allowed() -> bool {
    parse_file_store_flag(crate::env::var("POLARIS_WALLET_ALLOW_FILE_STORE").as_deref())
}

/// The flag's exact rule: only the trimmed string `1` opts in.
fn parse_file_store_flag(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

/// Builds the production stores: the macOS Keychain when the probe succeeds. A
/// failed probe leaves the plaintext file store usable only when the explicit
/// flag is set (and then it is announced on stderr); otherwise the store reports
/// `keychain unavailable` and every write refuses.
pub fn build_stores(root: &Path) -> Stores {
    let _ = SERVICE;
    let file_allowed = file_store_allowed();
    let file = Arc::new(FileStore::new(root.to_path_buf()));
    let (keychain, available): (Arc<dyn KeyStore>, bool) = {
        #[cfg(target_os = "macos")]
        {
            let keychain = KeychainStore::new(SERVICE);
            let available = match keychain.probe() {
                Ok(()) => true,
                Err(error) => {
                    if file_allowed {
                        eprintln!(
                            "polaris: the macOS Keychain is unavailable ({error}); \
                             POLARIS_WALLET_ALLOW_FILE_STORE=1 is set, so seeds are stored \
                             in a 0600 file (testnet only, plaintext)"
                        );
                    } else {
                        eprintln!(
                            "polaris: the macOS Keychain is unavailable ({error}); \
                             allow Polaris in Keychain Access or unlock the login keychain. \
                             The wallet stays locked until it is available."
                        );
                    }
                    false
                }
            };
            (Arc::new(keychain), available)
        }
        #[cfg(not(target_os = "macos"))]
        {
            // No Keychain off macOS: the plaintext store is the only option, and
            // only with the explicit flag.
            (Arc::new(UnavailableStore), false)
        }
    };
    Stores::new(keychain, file, available, file_allowed)
}

/// A [`KeyStore`] for platforms without a Keychain (and tests); every operation
/// fails closed. It exists so [`build_stores`] compiles off macOS.
#[cfg(not(target_os = "macos"))]
pub struct UnavailableStore;

#[cfg(not(target_os = "macos"))]
impl KeyStore for UnavailableStore {
    fn get(&self, _id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
        Err(WalletError::Storage("no Keychain on this platform".to_string()))
    }
    fn set(&self, _id: &str, _seed: &[u8; 32]) -> Result<(), WalletError> {
        Err(WalletError::Storage("no Keychain on this platform".to_string()))
    }
    fn delete(&self, _id: &str) -> Result<(), WalletError> {
        Err(WalletError::Storage("no Keychain on this platform".to_string()))
    }
    fn label(&self) -> &'static str {
        super::STORE_KEYCHAIN
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_exact_flag_value_one_opts_into_the_file_store() {
        assert!(parse_file_store_flag(Some("1")));
        assert!(parse_file_store_flag(Some(" 1 ")));
        assert!(!parse_file_store_flag(Some("0")));
        assert!(!parse_file_store_flag(Some("true")));
        assert!(!parse_file_store_flag(Some("")));
        assert!(!parse_file_store_flag(None));
    }
}
