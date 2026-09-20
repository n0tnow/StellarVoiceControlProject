//! macOS login-Keychain storage for wallet seeds (step W10).
//!
//! The task asked for a generic-password item (service `dev.polaris.wallet`,
//! account `signer-<address>`) because **data-protection / biometric ACLs need
//! entitlements an ad-hoc dev build does not have**. A plain login-Keychain item
//! needs none: the first time an ad-hoc-signed build reads an item created by a
//! previous build, macOS shows its standard "… wants to use your confidential
//! information … Always Allow / Deny" prompt. Denying it makes the probe fail,
//! which is the signal to fall back to the `0600` file store and report
//! `store: "file (testnet only)"` in status/Debug.
//!
//! The seed is the raw 32-byte item data. Nothing else is stored here.

use std::path::Path;
use std::sync::Arc;

use zeroize::Zeroizing;

use super::file::FileStore;
use super::{KeyStore, WalletError, SERVICE};

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
        match security_framework::passwords::get_generic_password(&self.service, id) {
            Ok(bytes) if bytes.len() == 32 => {
                let mut seed = Zeroizing::new([0u8; 32]);
                seed.copy_from_slice(&bytes);
                Ok(seed)
            }
            Ok(_) => Err(WalletError::Storage("the Keychain item has the wrong length".to_string())),
            Err(error) if error.code() == ERR_SEC_ITEM_NOT_FOUND => {
                Err(WalletError::Storage("seed not found".to_string()))
            }
            Err(error) => Err(WalletError::Storage(error.to_string())),
        }
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

/// Builds the production store: the Keychain on macOS when the probe succeeds,
/// otherwise the file fallback. The fallback is announced on stderr and reflected
/// in `wallet_status`'s `store` field, so it can never be silent.
pub fn build_store(root: &Path) -> Arc<dyn KeyStore> {
    #[cfg(target_os = "macos")]
    {
        let keychain = KeychainStore::new(SERVICE);
        match keychain.probe() {
            Ok(()) => return Arc::new(keychain),
            Err(error) => eprintln!(
                "polaris: the macOS Keychain is unavailable ({error}); \
                 storing the wallet seed in a 0600 file (testnet only)"
            ),
        }
    }
    let _ = SERVICE;
    Arc::new(FileStore::new(root.to_path_buf()))
}
