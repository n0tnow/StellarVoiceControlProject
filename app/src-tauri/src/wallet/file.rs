//! File-backed metadata and the opt-in plaintext seed store (W10).
//!
//! The metadata file (`wallets.json`) is non-secret and always lives here. The
//! `FileStore` is only used when the macOS Keychain is unavailable **and** the
//! explicit `POLARIS_WALLET_ALLOW_FILE_STORE=1` flag is set; it keeps each seed
//! in a `0600` file and reports itself as `file (testnet only, plaintext)` so the
//! user is never misled about the weaker storage.

use std::fs;
use std::path::{Path, PathBuf};

use zeroize::Zeroizing;

use super::{KeyStore, Metadata, WalletError, METADATA_FILE};

/// Directory holding the fallback seed files.
const SEED_DIR: &str = "seeds";

/// Reads `wallets.json`, or an empty default when it is missing or corrupt. A
/// corrupt file is logged, never fatal: the user can recreate their metadata.
pub fn load_metadata(root: &Path) -> Metadata {
    let path = root.join(METADATA_FILE);
    let Ok(contents) = fs::read_to_string(&path) else {
        return Metadata::default();
    };
    match serde_json::from_str(&contents) {
        Ok(meta) => meta,
        Err(error) => {
            eprintln!(
                "polaris: {} is not valid wallet metadata ({error}); ignoring it",
                path.display()
            );
            Metadata::default()
        }
    }
}

/// Writes `wallets.json` atomically with owner-only permissions.
pub fn save_metadata(root: &Path, meta: &Metadata) -> Result<(), WalletError> {
    let bytes = serde_json::to_vec_pretty(meta)
        .map_err(|error| WalletError::Storage(error.to_string()))?;
    atomic_write(&root.join(METADATA_FILE), &bytes)
}

/// Writes `bytes` to `path` via a temporary sibling and a rename, creating the
/// parent directory. `0600` on unix so a local file never leaks to other users.
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), WalletError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(storage)?;
    }
    let temp = path.with_extension("tmp");
    // Remove any leftover temp first so `mode(0o600)` applies at creation; the
    // temp file is then `0600` from the start, with no readable window.
    let _ = fs::remove_file(&temp);
    write_private(&temp, bytes).map_err(storage)?;
    set_private(&temp)?;
    fs::rename(&temp, path).map_err(storage)
}

/// Creates (or truncates) `path` with owner-only permissions on unix.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(bytes)
    }
    #[cfg(not(unix))]
    {
        fs::write(path, bytes)
    }
}

/// Restricts a file to the owner on unix; a no-op elsewhere.
fn set_private(path: &Path) -> Result<(), WalletError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(storage)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn storage(error: std::io::Error) -> WalletError {
    WalletError::FileStorage(error.to_string())
}

/// A `0600`-file seed store, usable only with the explicit opt-in flag when the
/// Keychain is unusable.
pub struct FileStore {
    root: PathBuf,
}

impl FileStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_for(&self, id: &str) -> PathBuf {
        self.root
            .join(SEED_DIR)
            .join(format!("{}.seed", sanitize(id)))
    }
}

impl KeyStore for FileStore {
    fn get(&self, id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
        let path = self.path_for(id);
        let bytes = match fs::read(&path) {
            // The buffer holds the seed, so it is wiped on drop.
            Ok(bytes) => Zeroizing::new(bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(WalletError::Storage("seed not found".to_string()));
            }
            Err(error) => return Err(storage(error)),
        };
        if bytes.len() != 32 {
            return Err(WalletError::Storage("seed file is corrupt".to_string()));
        }
        let mut seed = Zeroizing::new([0u8; 32]);
        seed.copy_from_slice(&bytes);
        Ok(seed)
    }

    fn set(&self, id: &str, seed: &[u8; 32]) -> Result<(), WalletError> {
        atomic_write(&self.path_for(id), seed)
    }

    fn delete(&self, id: &str) -> Result<(), WalletError> {
        match fs::remove_file(self.path_for(id)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(storage(error)),
        }
    }

    fn label(&self) -> &'static str {
        super::STORE_FILE
    }
}

/// Keeps a store id usable as a path segment. Store ids are already
/// `signer-<G…>`, so this only ever removes separators defensively.
fn sanitize(id: &str) -> String {
    id.chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallet::{AccountMeta, Metadata, StoreKind};

    #[test]
    fn metadata_round_trips_with_the_store_field() {
        let root = crate::env::temp_dir("file-meta");
        let meta = Metadata {
            active: Some("GAAA".to_string()),
            accounts: vec![AccountMeta {
                label: "Main".to_string(),
                address: "GAAA".to_string(),
                created: 7,
                store: StoreKind::File,
            }],
            auto_lock_minutes: None,
            executors: Default::default(),
        };
        save_metadata(&root, &meta).unwrap();
        assert_eq!(load_metadata(&root), meta);
    }

    #[test]
    fn atomic_write_leaves_an_owner_only_file() {
        let root = crate::env::temp_dir("file-perm");
        let path = root.join("secret.bin");
        atomic_write(&path, b"x").unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"x");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
    }

    #[test]
    fn file_store_round_trips_and_rejects_a_corrupt_seed() {
        let root = crate::env::temp_dir("file-store");
        let store = FileStore::new(root.clone());
        assert!(store.get("signer-x").is_err());
        store.set("signer-x", &[9u8; 32]).unwrap();
        assert_eq!(*store.get("signer-x").unwrap(), [9u8; 32]);
        store.delete("signer-x").unwrap();
        assert!(store.get("signer-x").is_err());
        // A short file is a corrupt store, not a seed.
        fs::write(store.path_for("signer-x"), b"short").unwrap();
        assert!(store.get("signer-x").is_err());
    }
}
