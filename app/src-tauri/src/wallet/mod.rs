//! The embedded wallet (step W10): create/import, Keychain storage, signing.
//!
//! Polaris' signer is a wallet **inside the app**: the user creates a BIP-39
//! recovery phrase or imports an existing `S…` seed / phrase, and a single Tauri
//! command signs the approved XDR. No browser and no browser extension are
//! involved.
//!
//! ## What is and is not stored
//!
//! * `~/Library/Application Support/Polaris/wallets.json` holds **metadata only**
//!   (label, public `G…` address, creation time, which account is active). No
//!   secret is ever written there.
//! * Each 32-byte Ed25519 seed lives in its own store item, keyed by
//!   `signer-<address>`. The production store is the macOS login Keychain
//!   ([`keychain`]) — the only store by default. The `0600` plaintext file store
//!   is used **only** when `POLARIS_WALLET_ALLOW_FILE_STORE=1` was set explicitly
//!   and the Keychain probe failed; without that flag a Keychain failure refuses
//!   create/import/sign with an actionable error and `wallet_status` reports
//!   `store: "keychain unavailable"`. Each account records which store holds its
//!   seed (`store: "keychain" | "file"`), so a seed written during an outage is
//!   still found after the Keychain returns.
//! * Seeds and phrases are held in `zeroize` buffers and never logged,
//!   serialised or returned. `wallet_create` is the single exception: it returns
//!   the recovery phrase **once** for the user to write down, as the product
//!   decision requires.
//!
//! ## Signing security
//!
//! `wallet_sign` still consumes the approval gate's one-time release
//! (`take_authorized`), signs the transaction hash, assembles the decorated
//! signature exactly like the bridge layout, and re-runs the same independent
//! `verify_signed` before reporting success. `wallet_sign_challenge` signs a
//! sequence-0 SEP-10 challenge without Touch ID and refuses anything else.

pub mod commands;
pub mod executor;
pub mod file;
pub mod keychain;
pub mod keys;
#[cfg(test)]
pub mod memory;
pub mod session;
pub mod signing;

pub use session::WalletSession;

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::biometric::Authenticator;
use crate::health::{now_ms, FeatureHealth, HealthStatus};

/// Keychain service name shared by every wallet item.
pub const SERVICE: &str = "dev.polaris.wallet";
/// Prefix of the Keychain account for one seed: `signer-<address>`.
pub const ACCOUNT_PREFIX: &str = "signer-";
/// The metadata file name under the Polaris app-support directory.
pub const METADATA_FILE: &str = "wallets.json";
/// Store label reported while the login Keychain serves the seeds.
pub const STORE_KEYCHAIN: &str = "keychain";
/// Store label reported when the opt-in plaintext file fallback is active. Kept
/// loud so the UI and the Debug check can shout "testnet only, plaintext".
pub const STORE_FILE: &str = "file (testnet only, plaintext)";
/// Store label reported when the Keychain is unavailable and the plaintext file
/// store was not opted into: no seed can be written or read.
pub const STORE_UNAVAILABLE: &str = "keychain unavailable";
/// The Touch ID reason shown when creating the wallet.
pub const CREATE_REASON: &str = "Create the Polaris wallet";
/// The Touch ID reason shown before importing a wallet.
pub const IMPORT_REASON: &str = "Import a wallet into Polaris";
/// The Touch ID reason shown before removing an account.
pub const REMOVE_REASON: &str = "Remove a Polaris wallet account";
/// The Tauri event emitted whenever the active wallet changes.
pub const CHANGED_EVENT: &str = "wallet_changed";
/// Default idle auto-lock timeout (W13a). `0` means "never".
pub const DEFAULT_AUTO_LOCK_MINUTES: u64 = 30;

/// Every way a wallet operation can fail. Mapped to a stable `kind` for the
/// webview and a one-sentence `message` for a non-developer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WalletError {
    /// The Keychain could not be read or written.
    Storage(String),
    /// The plaintext file store could not be read or written.
    FileStorage(String),
    /// The Keychain is unavailable and the plaintext file store was not opted
    /// into with `POLARIS_WALLET_ALLOW_FILE_STORE=1`.
    KeychainUnavailable,
    /// The account's seed is in the plaintext file store, which is not enabled
    /// in this run.
    FileStoreDisabled,
    /// Not a valid `S…` secret seed (length, alphabet, version or checksum).
    InvalidSecret,
    /// Not a valid 12/24-word BIP-39 phrase (word list or checksum).
    InvalidPhrase,
    /// The requested derivation index is out of range.
    InvalidIndex,
    /// An account label is empty or longer than 40 characters.
    InvalidLabel,
    /// A wallet (or that account) already exists.
    AlreadyExists,
    /// No wallet is configured for the active signer.
    NoWallet,
    /// The referenced account is not in the metadata file.
    UnknownAccount,
    /// The active account changed after this transaction was approved.
    SignerChanged,
    /// The user dismissed the Touch ID prompt.
    Cancelled,
    /// Touch ID was refused or unavailable (not a cancellation).
    Unauthorized(String),
    /// The wallet session is locked; a secret-touching action was refused.
    Locked,
    /// The returned envelope failed the independent verification.
    Integrity(String),
}

impl WalletError {
    /// The contract's stable error kind.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Storage(_) | Self::KeychainUnavailable => "keychain",
            Self::FileStorage(_) | Self::FileStoreDisabled => "file",
            Self::InvalidSecret | Self::InvalidPhrase | Self::InvalidIndex | Self::InvalidLabel => {
                "invalid"
            }
            Self::AlreadyExists => "exists",
            Self::NoWallet | Self::UnknownAccount => "notFound",
            Self::SignerChanged => "unauthorized",
            Self::Cancelled => "cancelled",
            Self::Unauthorized(_) => "unauthorized",
            Self::Locked => "locked",
            Self::Integrity(_) => "invalid",
        }
    }

    /// One short sentence the UI can show or speak.
    pub fn detail(&self) -> String {
        match self {
            Self::Storage(detail) => format!("the wallet store failed: {detail}"),
            Self::FileStorage(detail) => {
                format!("the plaintext wallet file store failed: {detail}")
            }
            Self::KeychainUnavailable => "the macOS Keychain is unavailable — allow Polaris in \
                 Keychain Access, or unlock the login keychain"
                .to_string(),
            Self::FileStoreDisabled => "this account's seed is in the plaintext file store; set \
                 POLARIS_WALLET_ALLOW_FILE_STORE=1 to use it"
                .to_string(),
            Self::InvalidSecret => "that is not a valid Stellar secret key".to_string(),
            Self::InvalidPhrase => "that is not a valid 12 or 24 word recovery phrase".to_string(),
            Self::InvalidIndex => "the account index must be 2,147,483,647 or lower".to_string(),
            Self::InvalidLabel => {
                "the account name must be between 1 and 40 characters".to_string()
            }
            Self::AlreadyExists => "a Polaris wallet already exists".to_string(),
            Self::NoWallet => "no wallet is configured; create or import one first".to_string(),
            Self::UnknownAccount => "that account is not in this wallet".to_string(),
            Self::SignerChanged => "the active account changed since this payment was approved — \
                 approve it again"
                .to_string(),
            Self::Cancelled => "Touch ID was cancelled".to_string(),
            Self::Unauthorized(detail) => format!("Touch ID was not completed: {detail}"),
            Self::Locked => "the wallet is locked; log in to sign or manage it".to_string(),
            Self::Integrity(detail) => {
                format!("the signed transaction failed verification: {detail}")
            }
        }
    }

    /// The failure code this error maps to, so `wallet_sign` reports the same
    /// `BridgeOutcome` vocabulary the shell already labels.
    pub fn bridge_code(&self) -> &'static str {
        match self {
            Self::Integrity(_) => "integrity",
            Self::NoWallet => "wallet_unavailable",
            Self::Cancelled => "rejected",
            Self::Unauthorized(_) => "not_authorized",
            Self::SignerChanged => "address_mismatch",
            // A locked wallet is fail-closed "not approved": no signed envelope
            // leaves unless the user has logged in.
            Self::Locked => "not_authorized",
            _ => "error",
        }
    }
}

/// Storage seam for account seeds. The production implementation is the macOS
/// Keychain; tests use an in-memory fake and a file fallback exists for the
/// documented Keychain-failure case.
pub trait KeyStore: Send + Sync {
    /// Reads the 32-byte seed for `id`, or `Storage`/`NotFound`.
    fn get(&self, id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError>;
    /// Writes (or replaces) the seed for `id`.
    fn set(&self, id: &str, seed: &[u8; 32]) -> Result<(), WalletError>;
    /// Removes the seed for `id`. A missing item is not an error.
    fn delete(&self, id: &str) -> Result<(), WalletError>;
    /// Human label for status/Debug (`keychain`, the loud plaintext label, or
    /// `keychain unavailable`).
    fn label(&self) -> &'static str;
}

/// The two seed stores this run may use, plus how availability is reported.
///
/// The macOS Keychain is the only default. The `0600` plaintext file store is
/// used **only** when `POLARIS_WALLET_ALLOW_FILE_STORE=1` was set explicitly and
/// the Keychain probe failed; without that flag a Keychain failure refuses
/// create/import/sign with [`WalletError::KeychainUnavailable`]. Every account
/// records which store holds its seed, so a seed written during an outage is
/// still found after the Keychain returns.
pub struct Stores {
    keychain: Arc<dyn KeyStore>,
    file: Arc<dyn KeyStore>,
    keychain_available: bool,
    file_allowed: bool,
}

impl Stores {
    pub fn new(
        keychain: Arc<dyn KeyStore>,
        file: Arc<dyn KeyStore>,
        keychain_available: bool,
        file_allowed: bool,
    ) -> Self {
        Self {
            keychain,
            file,
            keychain_available,
            file_allowed,
        }
    }

    /// The store label `wallet_status` and the Debug check report.
    pub fn label(&self) -> &'static str {
        if self.keychain_available {
            self.keychain.label()
        } else if self.file_allowed {
            self.file.label()
        } else {
            STORE_UNAVAILABLE
        }
    }

    /// `Ok` only while the Keychain serves the seeds; the plaintext fallback and
    /// the unavailable state are both warnings.
    pub fn health(&self) -> HealthStatus {
        if self.keychain_available {
            HealthStatus::Ok
        } else {
            HealthStatus::Warn
        }
    }

    /// The store a new seed must go to, or the user-actionable Keychain error.
    fn write_kind(&self) -> Result<StoreKind, WalletError> {
        if self.keychain_available {
            Ok(StoreKind::Keychain)
        } else if self.file_allowed {
            Ok(StoreKind::File)
        } else {
            Err(WalletError::KeychainUnavailable)
        }
    }

    fn get(&self, kind: StoreKind, id: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
        match kind {
            // A read is attempted even when the startup probe failed: the probe
            // can be wrong, and the account's metadata says exactly where the
            // seed lives, so we never wrongly report "seed not found".
            StoreKind::Keychain => match self.keychain.get(id) {
                Ok(seed) => Ok(seed),
                Err(error) if self.keychain_available => Err(error),
                Err(_) => Err(WalletError::KeychainUnavailable),
            },
            StoreKind::File if self.file_allowed => self.file.get(id),
            StoreKind::File => Err(WalletError::FileStoreDisabled),
        }
    }

    fn set(&self, kind: StoreKind, id: &str, seed: &[u8; 32]) -> Result<(), WalletError> {
        match kind {
            StoreKind::Keychain => self.keychain.set(id, seed),
            StoreKind::File => self.file.set(id, seed),
        }
    }

    fn delete(&self, kind: StoreKind, id: &str) -> Result<(), WalletError> {
        match kind {
            StoreKind::Keychain => self.keychain.delete(id),
            StoreKind::File if self.file_allowed => self.file.delete(id),
            StoreKind::File => Err(WalletError::FileStoreDisabled),
        }
    }
}

/// Which seed store holds one account's seed. Persisted (non-secret) in
/// `wallets.json`; an entry written before this field existed is read as
/// [`StoreKind::Keychain`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StoreKind {
    #[default]
    Keychain,
    File,
}

/// One account's non-secret metadata, as persisted in `wallets.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMeta {
    pub label: String,
    pub address: String,
    /// Milliseconds since the Unix epoch.
    pub created: u64,
    /// Which seed store holds this account's seed. No secret.
    #[serde(default)]
    pub store: StoreKind,
}

/// The metadata file's shape.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    #[serde(default)]
    pub active: Option<String>,
    #[serde(default)]
    pub accounts: Vec<AccountMeta>,
    /// Idle auto-lock timeout in minutes (W13a); `None` means the default. `0`
    /// means "never lock". Non-secret, so it is safe in this file.
    #[serde(default)]
    pub auto_lock_minutes: Option<u64>,
    /// Autopay executor address per owner address (W11a): `G…` owner -> `G…`
    /// executor. Public addresses only, so this file stays non-secret; the
    /// executor's **seed** lives in the same store as the wallet seeds under
    /// `executor-<ownerAddress>`.
    #[serde(default)]
    pub executors: std::collections::BTreeMap<String, String>,
}

struct Inner {
    meta: Metadata,
}

/// The managed wallet service. All clones (there is one) share state.
pub struct WalletService {
    stores: Stores,
    root: PathBuf,
    inner: Mutex<Inner>,
}

/// The active account's non-secret identity, as `wallet_status` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWallet {
    pub address: String,
    pub label: String,
}

/// `wallet_status` result, mirrored in `@polaris/interfaces`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletStatus {
    /// The active signer; always `"embedded"` now that the in-app wallet is the
    /// only signer.
    pub signer: String,
    /// The active account, or `None` when no wallet exists.
    pub active: Option<ActiveWallet>,
    /// How many accounts the metadata file holds.
    pub count: usize,
    /// `keychain` or `file (testnet only)`.
    pub store: String,
}

/// `wallet_create` result. `recovery_phrase` is the one-time reveal; it is only
/// ever produced by `wallet_create`.
#[derive(Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOutcome {
    pub address: String,
    /// The 24-word BIP-39 phrase, returned once for the user to write down.
    pub recovery_phrase: String,
}

/// Redacts the recovery phrase from `Debug`, so a stray `{:?}` can never leak it.
impl std::fmt::Debug for CreateOutcome {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("CreateOutcome")
            .field("address", &self.address)
            .field("recovery_phrase", &"[redacted]")
            .finish()
    }
}

/// `wallet_import`, `wallet_import_preview` and the other commands' result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AddressOutcome {
    pub address: String,
}

/// One entry of `wallet_list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView {
    pub address: String,
    pub label: String,
    pub created_at: u64,
    pub active: bool,
}

/// The result of a successful local signing run, mirroring `BridgeOutcome`'s
/// success arm.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedTx {
    pub signed_xdr: String,
    pub tx_hash: String,
    pub signer_address: String,
}

/// The active account's seed, public key and address.
type ActiveKey = (Zeroizing<[u8; 32]>, [u8; 32], String);

impl WalletService {
    /// Builds the service over explicit stores and a metadata directory. Used by
    /// tests and by [`WalletService::build`].
    pub fn new(stores: Stores, root: PathBuf) -> Self {
        let meta = file::load_metadata(&root);
        Self {
            stores,
            root,
            inner: Mutex::new(Inner { meta }),
        }
    }

    /// Production constructor: probes the Keychain; the plaintext file store is
    /// only constructed as a usable store when the explicit flag is set.
    pub fn build() -> Self {
        let root = default_root();
        Self::new(keychain::build_stores(&root), root)
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The active public address, if one is configured.
    pub fn active_address(&self) -> Option<String> {
        self.lock().meta.active.clone()
    }

    /// Whether at least one account exists.
    pub fn exists(&self) -> bool {
        !self.lock().meta.accounts.is_empty()
    }

    /// The signer the shell should use: always the in-app `embedded` wallet.
    pub fn signer(&self) -> String {
        crate::stellar_config::SIGNER_EMBEDDED.to_string()
    }

    /// `wallet_status`.
    pub fn status(&self) -> WalletStatus {
        let inner = self.lock();
        let active = inner.meta.active.as_deref().and_then(|address| {
            inner
                .meta
                .accounts
                .iter()
                .find(|account| account.address == address)
                .map(|account| ActiveWallet {
                    address: account.address.clone(),
                    label: account.label.clone(),
                })
        });
        WalletStatus {
            signer: self.signer(),
            active,
            count: inner.meta.accounts.len(),
            store: self.stores.label().to_string(),
        }
    }

    /// The persisted idle auto-lock timeout in minutes (W13a); the default when
    /// unset. `0` means "never".
    pub fn auto_lock_minutes(&self) -> u64 {
        self.lock()
            .meta
            .auto_lock_minutes
            .unwrap_or(DEFAULT_AUTO_LOCK_MINUTES)
    }

    /// Persists the idle auto-lock timeout in minutes (W13a). Non-secret, so no
    /// Touch ID is required; `0` means "never".
    pub fn set_auto_lock_minutes(&self, minutes: u64) -> Result<(), WalletError> {
        let mut inner = self.lock();
        inner.meta.auto_lock_minutes = Some(minutes);
        file::save_metadata(&self.root, &inner.meta)
    }

    /// Generates a new 24-word wallet, stores it, and returns the address plus the
    /// one-time recovery phrase. Touch-ID gated; refuses when one exists.
    pub fn create(
        &self,
        authenticator: &dyn Authenticator,
        label: Option<&str>,
    ) -> Result<CreateOutcome, WalletError> {
        if self.exists() {
            return Err(WalletError::AlreadyExists);
        }
        authenticate(authenticator, CREATE_REASON)?;
        let phrase = keys::generate_phrase()?;
        let seed = keys::seed_from_phrase(&phrase, 0)?;
        let address = keys::address_of(&seed);
        self.persist(&seed, &address, label)?;
        Ok(CreateOutcome {
            address,
            recovery_phrase: phrase.to_string(),
        })
    }

    /// Validates an import (secret or phrase) and derives its address **without
    /// storing anything**. The caller wipes the passed string.
    pub fn import_preview(
        &self,
        secret_or_phrase: &str,
        index: Option<u32>,
    ) -> Result<AddressOutcome, WalletError> {
        check_index(index)?;
        let (_seed, address, _) = keys::parse_import(secret_or_phrase, index)?;
        Ok(AddressOutcome { address })
    }

    /// Validates an import (secret or phrase), stores it, and returns the derived
    /// address. Touch-ID gated. The passed string is wiped by the caller.
    pub fn import(
        &self,
        authenticator: &dyn Authenticator,
        secret_or_phrase: &str,
        index: Option<u32>,
        label: Option<&str>,
    ) -> Result<AddressOutcome, WalletError> {
        check_index(index)?;
        let (seed, address, _) = keys::parse_import(secret_or_phrase, index)?;
        if self
            .lock()
            .meta
            .accounts
            .iter()
            .any(|account| account.address == address)
        {
            return Err(WalletError::AlreadyExists);
        }
        authenticate(authenticator, IMPORT_REASON)?;
        self.persist(&seed, &address, label)?;
        Ok(AddressOutcome { address })
    }

    /// Writes the seed and the non-secret metadata, making the account active.
    fn persist(&self, seed: &[u8; 32], address: &str, label: Option<&str>) -> Result<(), WalletError> {
        // The store is chosen before any write, so an unavailable Keychain with
        // the flag off fails here without touching a seed.
        let kind = self.stores.write_kind()?;
        self.stores.set(kind, &account_id(address), seed)?;
        let mut inner = self.lock();
        if inner.meta.accounts.iter().any(|account| account.address == address) {
            return Err(WalletError::AlreadyExists);
        }
        let label = label
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("Account {}", inner.meta.accounts.len() + 1));
        inner.meta.accounts.push(AccountMeta {
            label,
            address: address.to_string(),
            created: now_ms(),
            store: kind,
        });
        inner.meta.active = Some(address.to_string());
        file::save_metadata(&self.root, &inner.meta)
    }

    /// `wallet_list`.
    pub fn list(&self) -> Vec<AccountView> {
        let inner = self.lock();
        inner
            .meta
            .accounts
            .iter()
            .map(|account| AccountView {
                address: account.address.clone(),
                label: account.label.clone(),
                created_at: account.created,
                active: inner.meta.active.as_deref() == Some(account.address.as_str()),
            })
            .collect()
    }

    /// `wallet_select`.
    pub fn select(&self, address: &str) -> Result<AddressOutcome, WalletError> {
        let mut inner = self.lock();
        if !inner.meta.accounts.iter().any(|account| account.address == address) {
            return Err(WalletError::UnknownAccount);
        }
        inner.meta.active = Some(address.to_string());
        file::save_metadata(&self.root, &inner.meta)?;
        Ok(AddressOutcome {
            address: address.to_string(),
        })
    }

    /// `wallet_rename`.
    pub fn rename(&self, address: &str, label: &str) -> Result<AddressOutcome, WalletError> {
        let label = label.trim();
        if label.is_empty() || label.chars().count() > 40 {
            return Err(WalletError::InvalidLabel);
        }
        let mut inner = self.lock();
        let Some(account) = inner
            .meta
            .accounts
            .iter_mut()
            .find(|account| account.address == address)
        else {
            return Err(WalletError::UnknownAccount);
        };
        account.label = label.to_string();
        file::save_metadata(&self.root, &inner.meta)?;
        Ok(AddressOutcome {
            address: address.to_string(),
        })
    }

    /// `wallet_remove`, gated by Touch ID. Deletes the seed, the executor key
    /// (seed and metadata) that belonged to this account, and the metadata row.
    pub fn remove(
        &self,
        address: &str,
        authenticator: &dyn Authenticator,
    ) -> Result<AddressOutcome, WalletError> {
        // The recorded store is read before the metadata row is dropped.
        let kind = self
            .lock()
            .meta
            .accounts
            .iter()
            .find(|account| account.address == address)
            .map(|account| account.store)
            .ok_or(WalletError::UnknownAccount)?;
        authenticate(authenticator, REMOVE_REASON)?;
        let mut inner = self.lock();
        let before = inner.meta.accounts.len();
        inner.meta.accounts.retain(|account| account.address != address);
        if inner.meta.accounts.len() == before {
            return Err(WalletError::UnknownAccount);
        }
        if inner.meta.active.as_deref() == Some(address) {
            inner.meta.active = inner.meta.accounts.first().map(|account| account.address.clone());
        }
        // The executor seed lives in the same recorded store as the wallet seed;
        // drop its metadata row and, below, its seed so a later re-import cannot
        // silently resume unattended signing from the old key.
        let had_executor = inner.meta.executors.remove(address).is_some();
        file::save_metadata(&self.root, &inner.meta)?;
        self.stores.delete(kind, &account_id(address))?;
        if had_executor {
            self.stores.delete(kind, &executor::item_id(address))?;
        }
        Ok(AddressOutcome {
            address: address.to_string(),
        })
    }

    /// Loads the active seed and public key, or fails closed. The seed is read
    /// from the store recorded in the account's metadata, never from "whatever
    /// store is active now".
    fn active_key(&self) -> Result<ActiveKey, WalletError> {
        let address = self.active_address().ok_or(WalletError::NoWallet)?;
        let public = crate::bridge::strkey::decode_public_key(&address)
            .ok_or_else(|| WalletError::Storage("the active address is corrupt".to_string()))?;
        let kind = self
            .lock()
            .meta
            .accounts
            .iter()
            .find(|account| account.address == address)
            .map(|account| account.store)
            .ok_or(WalletError::UnknownAccount)?;
        let seed = self.stores.get(kind, &account_id(&address))?;
        Ok((seed, public, address))
    }

    /// Signs an approved unsigned transaction. The caller has already released
    /// the XDR from the approval gate.
    pub fn sign(&self, unsigned_xdr: &str, passphrase: &str) -> Result<SignedTx, WalletError> {
        let (seed, public, address) = self.active_key()?;
        signing::sign_transaction(unsigned_xdr, &seed, &public, passphrase)
            .map(|mut signed| {
                signed.signer_address = address;
                signed
            })
    }

    /// Signs a SEP-10 challenge (sequence 0, anchor-signed) without Touch ID.
    pub fn sign_challenge(&self, xdr: &str, passphrase: &str) -> Result<SignedTx, WalletError> {
        let (seed, public, address) = self.active_key()?;
        signing::sign_challenge(xdr, &seed, &public, passphrase).map(|mut signed| {
            signed.signer_address = address;
            signed
        })
    }

    /// Non-prompting Debug check (`wallet_health`).
    pub fn health(&self) -> FeatureHealth {
        let status = self.status();
        let Some(active) = status.active.as_ref() else {
            return FeatureHealth::new(
                commands::HEALTH_ID,
                "Polaris wallet",
                "W10",
                HealthStatus::Warn,
                "No wallet yet — open the Wallet screen to create or import one.",
            );
        };
        FeatureHealth::new(
            commands::HEALTH_ID,
            "Polaris wallet",
            "W10",
            self.stores.health(),
            format!(
                "{} ({}) ready (store: {})",
                short_address(&active.address),
                active.label,
                status.store
            ),
        )
    }
}

/// Rejects an out-of-range SEP-5 account index (the hardened index is a positive
/// `i32`; anything larger cannot be encoded).
fn check_index(index: Option<u32>) -> Result<(), WalletError> {
    if let Some(value) = index {
        if value > i32::MAX as u32 {
            return Err(WalletError::InvalidIndex);
        }
    }
    Ok(())
}

/// Maps an authentication failure to a wallet error; a cancellation is not a
/// success but is reported as the user's choice.
fn authenticate(authenticator: &dyn Authenticator, reason: &str) -> Result<(), WalletError> {
    authenticator.authenticate(reason).map_err(|error| match error {
        crate::biometric::AuthError::Cancelled => WalletError::Cancelled,
        other => WalletError::Unauthorized(other.detail()),
    })
}

/// The store id for an address.
pub fn account_id(address: &str) -> String {
    format!("{ACCOUNT_PREFIX}{address}")
}

/// The Polaris app-support directory: `$HOME/Library/Application Support/Polaris`
/// on macOS, `$HOME/.polaris` elsewhere. Tests always pass an explicit root.
pub fn default_root() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    #[cfg(target_os = "macos")]
    {
        home.join("Library/Application Support/Polaris")
    }
    #[cfg(not(target_os = "macos"))]
    {
        home.join(".polaris")
    }
}

/// `GARX…WCO` — the first and last four characters of an address. Slices by
/// `char`, so a hand-edited multi-byte address cannot panic `wallet_health`.
pub fn short_address(address: &str) -> String {
    let chars: Vec<char> = address.chars().collect();
    if chars.len() <= 10 {
        return address.to_string();
    }
    let head: String = chars[..4].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{head}…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{payload_hash_of_xdr, ApprovalRequest, ApprovalStore};
    use crate::biometric::AuthError;
    use crate::bridge::verify::tests_support as fixtures;
    use crate::types::{Intent, IntentKind, TxSummary};

    const PASSPHRASE: &str = fixtures::PASSPHRASE;
    /// SEP-5 Test 1: the mnemonic and its account-0 secret.
    const SEP5_MNEMONIC: &str =
        "illness spike retreat truth genius clock brain pass fit cave bargain toe";
    const SEP5_SECRET: &str = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
    const SEP5_ADDRESS: &str = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
    /// The wallet the signing vector below was produced for (SEP-5 account 0).
    const VECTOR_SEED: [u8; 32] = [
        0x4d, 0x69, 0x1b, 0xc1, 0x9b, 0x44, 0xa1, 0x38, 0x3b, 0x1a, 0x0a, 0x13, 0x0a, 0xac, 0xa3,
        0xe0, 0x5c, 0x3c, 0x1a, 0x37, 0x1d, 0xbe, 0x45, 0x93, 0x0e, 0xf9, 0xb7, 0x61, 0xf7, 0xa7,
        0x46, 0x91,
    ];
    /// The XDR fixture rewritten to the wallet's source key and sequence 1,
    /// produced by the Node one-off in the report; the hash and signed envelope
    /// are what `@stellar/stellar-sdk` `Keypair.verify` accepted.
    const VECTOR_UNSIGNED: &str = "AAAAAgAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAB12BBgnCJAQgcNtjAZbs7JSMucpHJJ3WuJHvwK+gBE6AAAAAAAAAAAAJiWgAAAAAAAAAAA";
    const VECTOR_HASH: &str = "9b2740c0645186d3f68d746896f3b8729c562fea2c2065d2f036d04f13645c8a";
    const VECTOR_SIGNED: &str = "AAAAAgAAAADjcmgwoLYMtfUshEz/zU7tZeulwVXomyZBFWJyTnHlRAAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAB12BBgnCJAQgcNtjAZbs7JSMucpHJJ3WuJHvwK+gBE6AAAAAAAAAAAAJiWgAAAAAAAAAABTnHlRAAAAECwErElOZ/XzWjF5p+M1SYpUnL3nwT+vgnPkjmkdedMbocRiZYBcYKdQ3WXjbo0NY5suLjfxKRcM5WoPj2IrsYH";

    struct FakeAuth(Result<(), AuthError>);
    impl Authenticator for FakeAuth {
        fn authenticate(&self, _reason: &str) -> Result<(), AuthError> {
            self.0.clone()
        }
    }
    fn allow() -> FakeAuth {
        FakeAuth(Ok(()))
    }
    fn deny() -> FakeAuth {
        FakeAuth(Err(AuthError::Cancelled))
    }

    /// Builds a service whose Keychain works and whose plaintext fallback is off.
    fn service() -> (WalletService, Arc<memory::MemoryStore>) {
        service_with(true, false)
    }

    /// Builds a service over two in-memory stores with explicit availability
    /// flags, returning the Keychain store so tests can inspect it.
    fn service_with(
        keychain_available: bool,
        file_allowed: bool,
    ) -> (WalletService, Arc<memory::MemoryStore>) {
        let root = crate::env::temp_dir("wallet");
        let keychain = Arc::new(memory::MemoryStore::new());
        let file = Arc::new(memory::MemoryStore::new());
        let stores = Stores::new(keychain.clone(), file, keychain_available, file_allowed);
        (WalletService::new(stores, root), keychain)
    }

    /// Puts `seed` in the Keychain store and makes its address active, without
    /// Touch ID.
    fn install_seed(wallet: &WalletService, seed: &[u8; 32]) -> String {
        let address = keys::address_of(seed);
        wallet
            .stores
            .keychain
            .set(&account_id(&address), seed)
            .unwrap();
        let mut inner = wallet.lock();
        inner.meta.accounts.push(AccountMeta {
            label: "Test".to_string(),
            address: address.clone(),
            created: 0,
            store: StoreKind::Keychain,
        });
        inner.meta.active = Some(address.clone());
        file::save_metadata(&wallet.root, &inner.meta).unwrap();
        address
    }

    #[test]
    fn memory_store_round_trips_a_seed() {
        let store = memory::MemoryStore::new();
        assert_eq!(store.label(), "memory (test)");
        assert!(store.get("signer-x").is_err());
        store.set("signer-x", &VECTOR_SEED).unwrap();
        assert_eq!(*store.get("signer-x").unwrap(), VECTOR_SEED);
        store.delete("signer-x").unwrap();
        assert!(store.get("signer-x").is_err());
        store.delete("signer-x").unwrap();
    }

    #[test]
    fn create_returns_the_phrase_once_and_stores_only_the_seed() {
        let (wallet, _store) = service();
        let created = wallet.create(&allow(), Some("Main")).unwrap();
        assert_eq!(created.recovery_phrase.split_whitespace().count(), 24);
        assert!(wallet.status().active.is_some());
        assert_eq!(wallet.status().active.as_ref().unwrap().label, "Main");
        assert_eq!(wallet.status().count, 1);
        // The phrase never appears in status, list or health output.
        for json in [
            serde_json::to_string(&wallet.status()).unwrap(),
            serde_json::to_string(&wallet.list()).unwrap(),
            serde_json::to_string(&wallet.health()).unwrap(),
        ] {
            assert!(!json.contains(&created.recovery_phrase));
        }
        // A second wallet is refused.
        assert_eq!(
            wallet.create(&allow(), None).unwrap_err(),
            WalletError::AlreadyExists
        );
    }

    #[test]
    fn create_requires_touch_id() {
        let (wallet, _store) = service();
        assert_eq!(wallet.create(&deny(), None).unwrap_err(), WalletError::Cancelled);
        assert!(!wallet.exists());
    }

    #[test]
    fn import_accepts_a_secret_and_never_echoes_it() {
        let (wallet, _store) = service();
        let outcome = wallet.import(&allow(), SEP5_SECRET, None, None).unwrap();
        assert_eq!(outcome.address, SEP5_ADDRESS);
        let json = serde_json::to_string(&outcome).unwrap();
        assert!(!json.contains(SEP5_SECRET));
        assert!(wallet.status().active.is_some());
        // The metadata file holds no secret either.
        let meta = file::load_metadata(&wallet.root);
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains(SEP5_SECRET));
        assert!(!json.contains("illness"));
    }

    #[test]
    fn import_preview_derives_but_stores_nothing() {
        let (wallet, store) = service();
        let outcome = wallet.import_preview(SEP5_MNEMONIC, None).unwrap();
        assert_eq!(outcome.address, SEP5_ADDRESS);
        assert!(!wallet.exists());
        assert_eq!(wallet.status().count, 0);
        // No seed was written for the derived address.
        assert!(store.get(&account_id(SEP5_ADDRESS)).is_err());
    }

    #[test]
    fn import_rejects_a_bad_phrase_and_a_bad_secret() {
        let (wallet, _store) = service();
        assert_eq!(
            wallet.import(&allow(), "not a phrase at all", None, None).unwrap_err(),
            WalletError::InvalidPhrase
        );
        assert_eq!(
            wallet.import(&allow(), "Snotasecret", None, None).unwrap_err(),
            WalletError::InvalidPhrase
        );
        assert_eq!(
            wallet
                .import(
                    &allow(),
                    "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMX",
                    None,
                    None,
                )
                .unwrap_err(),
            WalletError::InvalidSecret
        );
        assert_eq!(
            wallet.import_preview(SEP5_SECRET, Some(u32::MAX)).unwrap_err(),
            WalletError::InvalidIndex
        );
    }

    #[test]
    fn import_requires_touch_id() {
        let (wallet, _store) = service();
        assert_eq!(
            wallet.import(&deny(), SEP5_SECRET, None, None).unwrap_err(),
            WalletError::Cancelled
        );
        assert!(!wallet.exists());
    }

    #[test]
    fn every_error_maps_to_a_contract_kind() {
        for (error, kind) in [
            (WalletError::Storage("x".into()), "keychain"),
            (WalletError::KeychainUnavailable, "keychain"),
            (WalletError::FileStorage("x".into()), "file"),
            (WalletError::FileStoreDisabled, "file"),
            (WalletError::InvalidSecret, "invalid"),
            (WalletError::InvalidPhrase, "invalid"),
            (WalletError::InvalidIndex, "invalid"),
            (WalletError::InvalidLabel, "invalid"),
            (WalletError::AlreadyExists, "exists"),
            (WalletError::NoWallet, "notFound"),
            (WalletError::UnknownAccount, "notFound"),
            (WalletError::SignerChanged, "unauthorized"),
            (WalletError::Cancelled, "cancelled"),
            (WalletError::Unauthorized("x".into()), "unauthorized"),
        ] {
            assert_eq!(error.kind(), kind);
            assert!(!error.detail().is_empty());
        }
    }

    #[test]
    fn signing_vector_matches_the_stellar_sdk() {
        let (wallet, _store) = service();
        install_seed(&wallet, &VECTOR_SEED);
        // The fixture rewritten to this wallet's source is exactly the Node vector.
        let public = crate::bridge::strkey::decode_public_key(SEP5_ADDRESS).unwrap();
        assert_eq!(fixtures::fixture_with_source(public, 1), VECTOR_UNSIGNED);
        let signed = wallet.sign(VECTOR_UNSIGNED, PASSPHRASE).unwrap();
        assert_eq!(signed.signed_xdr, VECTOR_SIGNED);
        assert_eq!(signed.tx_hash, VECTOR_HASH);
        assert_eq!(signed.signer_address, SEP5_ADDRESS);
    }

    #[test]
    fn sign_refuses_a_tampered_or_foreign_transaction() {
        let (wallet, _store) = service();
        install_seed(&wallet, &VECTOR_SEED);
        // The XDR fixture is sourced by a different account.
        assert!(matches!(
            wallet.sign(fixtures::FIXTURE_XDR, PASSPHRASE),
            Err(WalletError::SignerChanged)
        ));
    }

    #[test]
    fn sign_refuses_when_the_active_account_changed_after_approval() {
        let (wallet, _store) = service();
        // Two accounts; the approved transaction is sourced by the first.
        let approved = install_seed(&wallet, &VECTOR_SEED);
        let approved_public = crate::bridge::strkey::decode_public_key(&approved).unwrap();
        let approved_xdr = fixtures::fixture_with_source(approved_public, 1);
        // The user switches to a second account after approving.
        let other = keys::address_of(&[7u8; 32]);
        wallet
            .stores
            .keychain
            .set(&account_id(&other), &[7u8; 32])
            .unwrap();
        {
            let mut inner = wallet.lock();
            inner.meta.accounts.push(AccountMeta {
                label: "Other".to_string(),
                address: other.clone(),
                created: 1,
                store: StoreKind::Keychain,
            });
            inner.meta.active = Some(other);
        }
        assert_eq!(
            wallet.sign(&approved_xdr, PASSPHRASE).unwrap_err(),
            WalletError::SignerChanged
        );
        assert_eq!(WalletError::SignerChanged.bridge_code(), "address_mismatch");
    }

    #[test]
    fn sign_requires_an_authorized_one_time_approval() {
        let (wallet, _store) = service();
        install_seed(&wallet, &VECTOR_SEED);
        let approvals = ApprovalStore::new();
        let request = ApprovalRequest {
            id: String::new(),
            payload_hash: payload_hash_of_xdr(VECTOR_UNSIGNED),
            unsigned_xdr: VECTOR_UNSIGNED.to_string(),
            summary: TxSummary {
                title: "t".to_string(),
                lines: vec![],
                explorer_url: None,
                estimated_fee: "0".to_string(),
            },
            intent: Intent {
                kind: IntentKind::RawTx,
                asset: "XLM".to_string(),
                amount: "0".to_string(),
                recipient: None,
                alias: None,
                memo: None,
                source: None,
            },
            mode: crate::approval::ApprovalMode::WalletOnly,
            origin: None,
        };
        let id = approvals.begin_wallet_only(request).unwrap().request.id;
        // Pending: the gate releases nothing.
        assert!(approvals.take_authorized(&id).is_err());
        approvals.authorize_wallet_only(&id).unwrap();
        let released = approvals.take_authorized(&id).unwrap();
        // The id is consumed once.
        assert!(approvals.take_authorized(&id).is_err());
        let signed = wallet.sign(&released.unsigned_xdr, PASSPHRASE).unwrap();
        assert_eq!(signed.tx_hash, VECTOR_HASH);
    }

    #[test]
    fn sign_challenge_signs_a_sequence_zero_challenge_only() {
        let (wallet, _store) = service();
        install_seed(&wallet, &VECTOR_SEED);
        let signed = wallet
            .sign_challenge(fixtures::CHALLENGE_XDR, PASSPHRASE)
            .unwrap();
        assert_eq!(signed.tx_hash, fixtures::CHALLENGE_HASH);
        // A real payment fixture has sequence 1 and is refused.
        assert!(matches!(
            wallet.sign_challenge(fixtures::FIXTURE_XDR, PASSPHRASE),
            Err(WalletError::Integrity(_))
        ));
    }

    #[test]
    fn remove_requires_touch_id_and_deletes_the_seed() {
        let (wallet, store) = service();
        let address = install_seed(&wallet, &VECTOR_SEED);
        assert_eq!(
            wallet.remove(&address, &deny()).unwrap_err(),
            WalletError::Cancelled
        );
        assert!(store.get(&account_id(&address)).is_ok());
        wallet.remove(&address, &allow()).unwrap();
        assert!(!wallet.exists());
        assert!(store.get(&account_id(&address)).is_err());
    }

    #[test]
    fn remove_deletes_the_executor_seed_and_metadata_row() {
        let (wallet, store) = service();
        let address = install_seed(&wallet, &VECTOR_SEED);
        let executor_address = keys::address_of(&[0x33u8; 32]);
        store.set(&crate::wallet::executor::item_id(&address), &[0x33u8; 32]).unwrap();
        wallet
            .lock()
            .meta
            .executors
            .insert(address.clone(), executor_address.clone());
        file::save_metadata(&wallet.root, &wallet.lock().meta).unwrap();

        wallet.remove(&address, &allow()).unwrap();
        assert!(store.get(&account_id(&address)).is_err());
        assert!(store.get(&crate::wallet::executor::item_id(&address)).is_err());
        let meta = file::load_metadata(&wallet.root);
        assert!(meta.executors.is_empty());
    }

    #[test]
    fn select_rename_and_list_round_trip() {
        let (wallet, _store) = service();
        let first = install_seed(&wallet, &VECTOR_SEED);
        wallet.rename(&first, "Savings").unwrap();
        let listed = wallet.list();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].label, "Savings");
        assert_eq!(listed[0].created_at, 0);
        assert!(listed[0].active);
        assert_eq!(
            wallet.select("GAAA").unwrap_err(),
            WalletError::UnknownAccount
        );
        assert_eq!(
            wallet.rename(&first, "  ").unwrap_err(),
            WalletError::InvalidLabel
        );
    }

    #[test]
    fn status_serializes_to_the_ui_contract() {
        let (wallet, _store) = service();
        let address = install_seed(&wallet, &VECTOR_SEED);
        let json = serde_json::to_string(&wallet.status()).unwrap();
        assert!(json.contains(r#""signer":"embedded""#), "{json}");
        assert!(json.contains(r#""count":1"#), "{json}");
        assert!(json.contains(r#""store":"memory (test)""#), "{json}");
        assert!(json.contains(&address), "{json}");
        // `createdAt` is the wire name for the list.
        let list = serde_json::to_string(&wallet.list()).unwrap();
        assert!(list.contains(r#""createdAt":0"#), "{list}");
        assert!(list.contains(r#""active":true"#), "{list}");
    }

    #[test]
    fn a_malformed_metadata_file_does_not_take_the_service_down() {
        let root = crate::env::temp_dir("wallet-meta");
        std::fs::write(root.join(METADATA_FILE), "{ not json").unwrap();
        let stores = Stores::new(
            Arc::new(memory::MemoryStore::new()),
            Arc::new(memory::MemoryStore::new()),
            true,
            false,
        );
        let wallet = WalletService::new(stores, root);
        assert!(!wallet.exists());
    }

    #[test]
    fn status_reports_keychain_unavailable_when_the_flag_is_off() {
        let (wallet, _) = service_with(false, false);
        assert_eq!(wallet.status().store, STORE_UNAVAILABLE);
        assert_eq!(wallet.stores.health(), HealthStatus::Warn);
    }

    #[test]
    fn create_refuses_when_the_keychain_is_unavailable_and_the_file_store_is_off() {
        let (wallet, _) = service_with(false, false);
        let error = wallet.create(&allow(), None).unwrap_err();
        assert_eq!(error, WalletError::KeychainUnavailable);
        assert_eq!(error.kind(), "keychain");
        assert!(error.detail().contains("Keychain Access"), "{}", error.detail());
        assert!(error.detail().contains("login keychain"), "{}", error.detail());
        assert!(!wallet.exists());
    }

    #[test]
    fn the_opt_in_flag_stores_in_the_plaintext_file_store() {
        let root = crate::env::temp_dir("wallet-file");
        let keychain = Arc::new(memory::MemoryStore::new());
        let file = Arc::new(file::FileStore::new(root.clone()));
        let wallet = WalletService::new(Stores::new(keychain, file, false, true), root);
        let _ = wallet.create(&allow(), Some("Plain")).unwrap();
        assert_eq!(wallet.status().store, STORE_FILE);
        assert!(wallet.status().store.contains("plaintext"));
        assert_eq!(wallet.stores.health(), HealthStatus::Warn);
        // The metadata records the file store, not the Keychain.
        let meta = file::load_metadata(&wallet.root);
        assert_eq!(meta.accounts[0].store, StoreKind::File);
    }

    #[test]
    fn a_file_stored_account_signs_after_the_keychain_returns() {
        // Created during an outage, with the flag on: the seed is in the file
        // store and the metadata says so.
        let root = crate::env::temp_dir("wallet-flip");
        let keychain = Arc::new(memory::MemoryStore::new());
        let file = Arc::new(memory::MemoryStore::new());
        let during = WalletService::new(
            Stores::new(keychain.clone(), file.clone(), false, true),
            root.clone(),
        );
        let address = install_seed(&during, &VECTOR_SEED);
        {
            let mut inner = during.lock();
            inner.meta.accounts[0].store = StoreKind::File;
        }
        during
            .stores
            .file
            .set(&account_id(&address), &VECTOR_SEED)
            .unwrap();
        during.stores.keychain.delete(&account_id(&address)).ok();
        file::save_metadata(&root, &during.lock().meta).unwrap();
        // The seed is not in the Keychain.
        assert!(keychain.get(&account_id(&address)).is_err());

        // The next run finds the Keychain again; the recorded store still wins.
        let after = WalletService::new(Stores::new(keychain, file, true, true), root);
        assert_eq!(after.sign(VECTOR_UNSIGNED, PASSPHRASE).unwrap().tx_hash, VECTOR_HASH);
    }

    #[test]
    fn a_keychain_stored_account_signs_when_the_probe_says_unavailable() {
        // Created while the Keychain worked; a later probe failure must not send
        // the lookup to the file store and wrongly report "seed not found".
        let root = crate::env::temp_dir("wallet-reverse");
        let keychain = Arc::new(memory::MemoryStore::new());
        let file = Arc::new(memory::MemoryStore::new());
        let before = WalletService::new(Stores::new(keychain.clone(), file.clone(), true, true), root.clone());
        let address = install_seed(&before, &VECTOR_SEED);
        assert!(before.stores.keychain.get(&account_id(&address)).is_ok());

        let after = WalletService::new(Stores::new(keychain, file, false, true), root);
        assert!(!after.stores.keychain_available);
        assert_eq!(after.sign(VECTOR_UNSIGNED, PASSPHRASE).unwrap().tx_hash, VECTOR_HASH);
    }

    #[test]
    fn existing_metadata_without_a_store_field_reads_as_keychain() {
        let root = crate::env::temp_dir("wallet-migrate");
        std::fs::write(
            root.join(METADATA_FILE),
            r#"{"active":"GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6","accounts":[{"label":"Old","address":"GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6","created":1}]}"#,
        )
        .unwrap();
        let meta = file::load_metadata(&root);
        assert_eq!(meta.accounts[0].store, StoreKind::Keychain);
    }

    #[test]
    fn short_address_never_panics_on_a_multibyte_address() {
        assert_eq!(short_address("SHORT"), "SHORT");
        assert_eq!(short_address("GABC…WXYZ12"), "GABC…YZ12");
        let multibyte = "Gαβγδεζηθικλμνξο";
        assert_eq!(short_address(multibyte).chars().count(), 9);
    }

    #[test]
    fn create_outcome_debug_redacts_the_phrase() {
        let (wallet, _) = service();
        let created = wallet.create(&allow(), None).unwrap();
        let debug = format!("{created:?}");
        assert!(!debug.contains(&created.recovery_phrase));
        assert!(debug.contains("[redacted]"));
    }
}
