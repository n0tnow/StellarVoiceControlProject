//! In-memory [`KeyStore`] for tests (step W10).
//!
//! No test ever touches the real Keychain or shows a prompt: the wallet tests
//! build a [`MemoryStore`] and pass it to [`super::WalletService::new`]. It is
//! also a small, obvious reference for what a store must do.

use std::collections::HashMap;
use std::sync::Mutex;

use zeroize::Zeroizing;

use super::{KeyStore, WalletError};

/// A process-local seed store. Cloning shares the map.
#[derive(Default)]
pub struct MemoryStore {
    items: Mutex<HashMap<String, [u8; 32]>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }
}

impl KeyStore for MemoryStore {
    fn get(&self, id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
        let items = self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        match items.get(id) {
            Some(seed) => Ok(Zeroizing::new(*seed)),
            None => Err(WalletError::Storage("seed not found".to_string())),
        }
    }

    fn set(&self, id: &str, seed: &[u8; 32]) -> Result<(), WalletError> {
        let mut items = self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        items.insert(id.to_string(), *seed);
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), WalletError> {
        let mut items = self.items.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        items.remove(id);
        Ok(())
    }

    fn label(&self) -> &'static str {
        "memory (test)"
    }
}
