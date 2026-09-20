//! The autopay executor key and the strict `pay_executor` signer (step W11a).
//!
//! Autonomy is enforced **on-chain** by `polaris_guard`: the owner registers a
//! separate executor key with `set_executor`, and payments the rule allows are
//! then made by that key with `pay_executor` — no approval card, no Touch ID.
//! This module owns the executor key and is the one path that may sign without a
//! prompt, so it is deliberately narrow.
//!
//! ## The executor key
//!
//! `executor_create` generates one Ed25519 seed per active owner, stores it in
//! the same store as the wallet seeds under `executor-<ownerAddress>`, and
//! records only the derived public address in `wallets.json`. The seed is held in
//! a `zeroize` buffer and is never returned, logged or serialized.
//!
//! ## Why `executor_sign_pay` decodes the XDR
//!
//! A key that signs without a prompt must be impossible to point at anything but
//! one call. Rust therefore decodes the envelope with the audited `stellar-xdr`
//! crate and signs **only** when every one of these holds: a v1 envelope whose
//! source is the executor, exactly one operation, that operation is an
//! `invoke-contract` of the configured `GUARD_CONTRACT_ID` calling exactly
//! `pay_executor`, the `executor`/`owner` arguments match the registered key and
//! the active wallet, no auth entry asks for the owner, the sequence is positive,
//! and the amount is positive and within a **Rust-side hard cap** independent of
//! the on-chain rule. The signer also bounds what it can cost the executor whose
//! fees it pays: a capped `tx.fee`/Soroban `resource_fee`, finite time bounds no
//! further than a few minutes out, no memo, and an amount cap scaled by the
//! configured decimals of the asset actually being moved. Anything else is a
//! typed refusal, never a signature.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::Serialize;
use stellar_xdr::{
    AccountId, ContractId, Hash, HostFunction, Int128Parts, Limits, Memo, MuxedAccount,
    OperationBody, Preconditions, PublicKey, ReadXdr, ScAddress, ScVal, SorobanAuthorizedFunction,
    SorobanCredentials, TransactionEnvelope, TransactionExt, Uint256,
};
use tauri::State;
use zeroize::Zeroizing;

use super::commands::{join_error, WalletCommandError};
use super::session::SessionStore;
use super::{keys, StoreKind, WalletError, WalletService};
use crate::biometric::Authenticator;
use crate::bridge::strkey::decode_public_key;
use crate::health::{FeatureHealth, HealthStatus};

/// The Rust Debug check id, matching `app/src/debug/checks/executor.ts`.
pub const HEALTH_ID: &str = "w11.executor";
/// Debug panel title.
pub const TITLE: &str = "Autopay executor";
/// Store item prefix for one owner's executor seed: `executor-<ownerAddress>`.
pub const ITEM_PREFIX: &str = "executor-";
/// The Touch ID reason shown when creating the executor key.
pub const CREATE_REASON: &str = "Create the autopay executor key";
/// The only function `executor_sign_pay` may sign.
pub const PAY_EXECUTOR: &str = "pay_executor";
/// `POLARIS_AUTOPAY_HARD_CAP`: the Rust-side per-payment cap in whole units,
/// independent of (and a backstop to) the on-chain `auto_approve_limit`.
pub const ENV_HARD_CAP: &str = "POLARIS_AUTOPAY_HARD_CAP";
/// Default whole-unit cap when the env var is unset.
pub const DEFAULT_HARD_CAP_WHOLE: i128 = 100;
/// `POLARIS_AUTOPAY_MAX_FEE_STROOPS`: the inclusion-fee cap for a signed
/// payment. It can only be lowered by the env var, never raised.
pub const ENV_MAX_FEE: &str = "POLARIS_AUTOPAY_MAX_FEE_STROOPS";
/// Default inclusion-fee cap: 2 XLM (10^7 stroops each).
pub const DEFAULT_MAX_FEE_STROOPS: i64 = 20_000_000;
/// Cap on a Soroban transaction's `resource_fee` (1 XLM): the executor pays
/// this too, so it needs its own bound even though `tx.fee` is also capped.
pub const MAX_RESOURCE_FEE_STROOPS: i64 = 10_000_000;
/// How far in the future a signed transaction's `max_time` may sit. Short
/// enough that a compromised webview cannot park a long-lived authorization.
pub const TIME_BOUND_WINDOW_SECS: u64 = 300;
/// The largest asset `decimals` the cap scaling accepts (mirrors the SAC limit).
pub const MAX_ASSET_DECIMALS: u32 = 18;
/// The base64 input cap (matches the approval gate's `MAX_XDR_BYTES`): a real
/// Soroban envelope is a few KiB, so a larger blob is refused before decoding.
pub const MAX_INPUT_BYTES: usize = 16 * 1024;
/// Decode bounds for `stellar_xdr`: finite depth (no recursive `ScVal` stack
/// overflow) and a finite byte budget.
pub const MAX_DECODE_DEPTH: u32 = 32;
pub const MAX_DECODE_BYTES: usize = 64 * 1024;

/// `executor_status` result, mirrored in `@polaris/interfaces`. `funded` is
/// always `null` from Rust: funding a `G…` account needs a network read, which
/// the Debug check performs over Horizon.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorStatus {
    pub exists: bool,
    pub address: Option<String>,
    pub funded: Option<bool>,
}

/// `executor_create` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutorAddress {
    pub address: String,
}

/// Every way an executor signature can be refused. `code()` is the stable wire
/// value the webview branches on; `detail()` is one actionable sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutorError {
    /// The wallet session is locked.
    Locked,
    /// No executor key exists for the active owner.
    NoExecutor,
    /// The operation is not a `pay_executor` call.
    NotPayExecutor,
    /// The transaction source is not the executor.
    WrongSource,
    /// The invoked contract is not the configured guard.
    WrongContract,
    /// The decoded amount exceeds the configured whole-unit hard cap.
    OverHardCap { cap_raw: i128, decimals: u32 },
    /// The envelope does not have the one exact shape this signer accepts.
    Invalid(&'static str),
    /// A storage or signing failure.
    Error(String),
}

impl ExecutorError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Locked => "locked",
            Self::NoExecutor => "no_executor",
            Self::NotPayExecutor => "not_pay_executor",
            Self::WrongSource => "wrong_source",
            Self::WrongContract => "wrong_contract",
            Self::OverHardCap { .. } => "over_hard_cap",
            Self::Invalid(_) => "invalid",
            Self::Error(_) => "error",
        }
    }

    pub fn detail(&self) -> String {
        match self {
            Self::Locked => "the wallet is locked; log in before signing".to_string(),
            Self::NoExecutor => {
                "no autopay executor key exists for this wallet yet".to_string()
            }
            Self::NotPayExecutor => {
                "this transaction is not a pay_executor call, so it needs owner approval"
                    .to_string()
            }
            Self::WrongSource => {
                "the transaction is not sourced by this wallet's executor key".to_string()
            }
            Self::WrongContract => {
                "the transaction does not call the configured guard contract".to_string()
            }
            Self::OverHardCap { cap_raw, decimals } => format!(
                "the payment is over the autopay hard cap of {} whole units",
                cap_raw / 10i128.pow(*decimals)
            ),
            Self::Invalid(reason) => reason.to_string(),
            Self::Error(detail) => format!("the executor signature failed: {detail}"),
        }
    }
}

/// The typed `executor_sign_pay` outcome: `{ ok: true, signedXdr, txHash }` or
/// `{ ok: false, code, message }` (serde camelCase, matching the TS union).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signed_xdr: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tx_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

impl PayOutcome {
    pub fn ok(signed_xdr: String, tx_hash: String) -> Self {
        Self {
            ok: true,
            signed_xdr: Some(signed_xdr),
            tx_hash: Some(tx_hash),
            code: None,
            message: None,
        }
    }

    pub fn fail(error: &ExecutorError) -> Self {
        Self {
            ok: false,
            signed_xdr: None,
            tx_hash: None,
            code: Some(error.code().to_string()),
            message: Some(error.detail()),
        }
    }
}

/// The whole-unit hard cap; an unparseable or negative value falls back to
/// [`DEFAULT_HARD_CAP_WHOLE`] (fail-closed to the strict default). The raw cap
/// is this scaled by the moved asset's configured decimals in [`validate_pay`].
pub fn hard_cap_whole(explicit: Option<&str>) -> i128 {
    explicit
        .and_then(|value| value.trim().parse::<i128>().ok())
        .filter(|value| *value >= 0)
        .unwrap_or(DEFAULT_HARD_CAP_WHOLE)
}

/// Reads the whole-unit hard cap from the process environment.
pub fn read_hard_cap_whole() -> i128 {
    hard_cap_whole(crate::env::var(ENV_HARD_CAP).as_deref())
}

/// The inclusion-fee cap in stroops. Configurable **downward only**: a value
/// that is unset, unparseable or not below [`DEFAULT_MAX_FEE_STROOPS`] leaves
/// the default in place, so the env can never raise the cap.
pub fn max_fee_stroops(explicit: Option<&str>) -> i64 {
    explicit
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|value| *value > 0 && *value < DEFAULT_MAX_FEE_STROOPS)
        .unwrap_or(DEFAULT_MAX_FEE_STROOPS)
}

/// Reads the inclusion-fee cap from the process environment.
pub fn read_max_fee_stroops() -> i64 {
    max_fee_stroops(crate::env::var(ENV_MAX_FEE).as_deref())
}

/// The Rust-side caps a signed autopay is held to, independent of (and a
/// backstop to) the on-chain rule: a whole-unit amount cap, the per-asset
/// decimals needed to scale it, and an inclusion-fee cap in stroops.
#[derive(Clone, Copy)]
pub struct PayCaps<'a> {
    pub hard_cap_whole: i128,
    pub assets: &'a BTreeMap<String, u32>,
    pub max_fee_stroops: i64,
}

/// Seconds since the Unix epoch, for the time-bound window check. `0` only if
/// the system clock predates the epoch, which then refuses every finite bound.
fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// The store item id for one owner's executor seed.
pub fn item_id(owner: &str) -> String {
    format!("{ITEM_PREFIX}{owner}")
}

/// The executor address for `owner`, from the non-secret metadata.
pub fn executor_address(wallet: &WalletService, owner: &str) -> Option<String> {
    wallet.lock().meta.executors.get(owner).cloned()
}

/// `executor_status`: whether the active owner has an executor key, and its
/// public address. Never prompts and never reads a seed.
pub fn status(wallet: &WalletService) -> ExecutorStatus {
    let address = wallet
        .active_address()
        .and_then(|owner| executor_address(wallet, &owner));
    ExecutorStatus {
        exists: address.is_some(),
        address,
        funded: None,
    }
}

/// The store recorded for `owner`'s wallet seed. The executor seed lives in the
/// **same** store as its owner's wallet seed, so every read follows the recorded
/// kind exactly like `WalletService::active_key` (no silent fallback).
fn account_store_kind(wallet: &WalletService, owner: &str) -> Option<StoreKind> {
    wallet
        .lock()
        .meta
        .accounts
        .iter()
        .find(|account| account.address == owner)
        .map(|account| account.store)
}

/// Reads the executor seed from the owner's recorded store, exactly like the
/// wallet's own key lookup: a seed written during a Keychain outage is still
/// found in the plaintext file store after the Keychain returns, and a
/// Keychain-stored seed is never silently read from the file store.
fn read_seed(wallet: &WalletService, owner: &str) -> Result<Zeroizing<[u8; 32]>, WalletError> {
    let kind = account_store_kind(wallet, owner).ok_or(WalletError::UnknownAccount)?;
    wallet.stores.get(kind, &item_id(owner))
}

/// `executor_create`: an unlocked session plus Touch ID, generating and storing
/// one executor seed for the active owner. Idempotent: an existing executor
/// address is returned unchanged (regenerating would orphan the on-chain
/// registration). The idempotency re-check, the seed write and the metadata
/// insert all happen under the metadata lock, so two concurrent creates can
/// never leave the Keychain seed and `executors[owner]` naming different keys.
pub fn create(
    wallet: &WalletService,
    session: &SessionStore,
    authenticator: &dyn Authenticator,
) -> Result<ExecutorAddress, WalletError> {
    session.ensure_unlocked()?;
    let owner = wallet.active_address().ok_or(WalletError::NoWallet)?;
    if let Some(address) = executor_address(wallet, &owner) {
        return Ok(ExecutorAddress { address });
    }
    let kind = account_store_kind(wallet, &owner).ok_or(WalletError::UnknownAccount)?;
    authenticate(authenticator, CREATE_REASON)?;
    let mut seed = Zeroizing::new([0u8; 32]);
    getrandom::fill(seed.as_mut())
        .map_err(|error| WalletError::Storage(format!("the OS random source failed: {error}")))?;
    let address = keys::address_of(&seed);
    let mut inner = wallet.lock();
    // A concurrent create may have won while this one was prompting/generating:
    // return its address and never overwrite the seed that names it.
    if let Some(existing) = inner.meta.executors.get(&owner) {
        return Ok(ExecutorAddress {
            address: existing.clone(),
        });
    }
    wallet.stores.set(kind, &item_id(&owner), &seed)?;
    inner.meta.executors.insert(owner, address.clone());
    super::file::save_metadata(&wallet.root, &inner.meta)?;
    Ok(ExecutorAddress { address })
}

/// `executor_sign_pay`: decode, validate and sign in one fail-closed step. No
/// Touch ID; the unlocked session is the only presence check.
pub fn sign_pay(
    wallet: &WalletService,
    session: &SessionStore,
    unsigned_xdr: &str,
    guard_contract_id: &str,
    caps: PayCaps<'_>,
    passphrase: &str,
) -> Result<super::SignedTx, ExecutorError> {
    session
        .ensure_unlocked()
        .map_err(|_| ExecutorError::Locked)?;
    let owner = wallet.active_address().ok_or(ExecutorError::NoExecutor)?;
    let address = executor_address(wallet, &owner).ok_or(ExecutorError::NoExecutor)?;
    let seed = read_seed(wallet, &owner).map_err(|_| ExecutorError::NoExecutor)?;
    let executor_public = decode_public_key(&address)
        .ok_or(ExecutorError::Error("the executor address is corrupt".to_string()))?;
    let owner_public = decode_public_key(&owner)
        .ok_or(ExecutorError::Error("the owner address is corrupt".to_string()))?;
    validate_pay(
        unsigned_xdr,
        &executor_public,
        &owner_public,
        guard_contract_id,
        caps,
    )?;
    super::signing::sign_transaction(unsigned_xdr, &seed, &executor_public, passphrase)
        .map(|mut signed| {
            signed.signer_address = address;
            signed
        })
        .map_err(|error| ExecutorError::Error(error.detail()))
}

/// The read-only half of `executor_sign_pay`: decodes `unsigned_xdr` and enforces
/// every shape rule. Split out so the adversarial tests can drive it without a
/// key or a session, and so a fuzz loop can call it with no side effects.
pub fn validate_pay(
    unsigned_xdr: &str,
    executor_public: &[u8; 32],
    owner_public: &[u8; 32],
    guard_contract_id: &str,
    caps: PayCaps<'_>,
) -> Result<(), ExecutorError> {
    // Bound the input before decoding: a real Soroban envelope is a few KiB, so
    // a larger blob is a hostile payload, not a payment.
    if unsigned_xdr.len() > MAX_INPUT_BYTES {
        return Err(ExecutorError::Invalid("the transaction is too large"));
    }
    // Finite decode limits: a crafted, valid-up-to-the-args envelope with a
    // deeply nested `ScVal` must fail as a typed error instead of recursing
    // until the stack aborts the process.
    let limits = Limits {
        depth: MAX_DECODE_DEPTH,
        len: MAX_DECODE_BYTES,
    };
    let decoded = TransactionEnvelope::from_xdr_base64(unsigned_xdr.trim(), limits)
        .map_err(|_| ExecutorError::Invalid("the transaction is not valid XDR"))?;
    let envelope = match decoded {
        TransactionEnvelope::Tx(v1) => v1,
        _ => return Err(ExecutorError::Invalid("only a plain v1 transaction may be signed")),
    };
    let tx = envelope.tx;

    // MAJOR-1: cost and preconditions. This signer pays the fee, so a
    // compromised webview must not be able to make it sign a maximal fee or an
    // open-ended authorization.
    if i64::from(tx.fee) > caps.max_fee_stroops {
        return Err(ExecutorError::Invalid("the transaction fee is over the autopay cap"));
    }
    if let TransactionExt::V1(data) = &tx.ext {
        if data.resource_fee > MAX_RESOURCE_FEE_STROOPS {
            return Err(ExecutorError::Invalid(
                "the Soroban resource fee is over the autopay cap",
            ));
        }
    }
    match &tx.cond {
        Preconditions::Time(bounds) => {
            let now = now_secs();
            let min_time = bounds.min_time.0;
            let max_time = bounds.max_time.0;
            if max_time == 0 {
                return Err(ExecutorError::Invalid("the transaction time bounds never expire"));
            }
            if min_time > now {
                return Err(ExecutorError::Invalid(
                    "the transaction time bounds start in the future",
                ));
            }
            if max_time > now.saturating_add(TIME_BOUND_WINDOW_SECS) {
                return Err(ExecutorError::Invalid(
                    "the transaction time bounds are too far in the future",
                ));
            }
        }
        // No time bounds, a V2 set (extra signers/min-seq surprises) or a ledger
        // bound is never what an unattended payment looks like.
        _ => {
            return Err(ExecutorError::Invalid(
                "the transaction must carry finite time bounds",
            ))
        }
    }
    if !matches!(tx.memo, Memo::None) {
        return Err(ExecutorError::Invalid("a memo is not allowed"));
    }

    let source = match &tx.source_account {
        MuxedAccount::Ed25519(Uint256(key)) => *key,
        // A muxed (M…) source is never the executor's plain G… key.
        _ => return Err(ExecutorError::WrongSource),
    };
    if source != *executor_public {
        return Err(ExecutorError::WrongSource);
    }
    if tx.seq_num.0 <= 0 {
        return Err(ExecutorError::Invalid("the transaction sequence number is not positive"));
    }
    if tx.operations.len() != 1 {
        return Err(ExecutorError::Invalid("exactly one operation is allowed"));
    }
    let operation = tx
        .operations
        .first()
        .ok_or(ExecutorError::Invalid("the operation is missing"))?;
    if operation.source_account.is_some() {
        return Err(ExecutorError::Invalid("an operation-level source account is not allowed"));
    }
    let invoke = match &operation.body {
        OperationBody::InvokeHostFunction(invoke) => invoke,
        _ => return Err(ExecutorError::Invalid("the only allowed operation is a contract call")),
    };
    let args = match &invoke.host_function {
        HostFunction::InvokeContract(args) => args,
        _ => return Err(ExecutorError::Invalid("the host function must invoke a contract")),
    };
    let expected_contract = decode_contract_id(guard_contract_id)
        .ok_or(ExecutorError::Invalid("the configured guard contract id is invalid"))?;
    if contract_hash(&args.contract_address) != Some(expected_contract) {
        return Err(ExecutorError::WrongContract);
    }
    if args.function_name.0.as_slice() != PAY_EXECUTOR.as_bytes() {
        return Err(ExecutorError::NotPayExecutor);
    }
    let values = args.args.as_slice();
    if values.len() != 5 {
        return Err(ExecutorError::Invalid("pay_executor expects exactly five arguments"));
    }
    if sc_key(&values[0]) != Some(*executor_public) {
        return Err(ExecutorError::Invalid("the executor argument is not this executor"));
    }
    if sc_key(&values[1]) != Some(*owner_public) {
        return Err(ExecutorError::Invalid("the owner argument is not the active wallet"));
    }
    // The recipient is free (the contract enforces `known_recipients_only`). The
    // asset must be one whose decimals the app has configured, so the whole-unit
    // cap is scaled correctly for the token actually moving.
    let asset_hash = match &values[3] {
        ScVal::Address(ScAddress::Contract(ContractId(Hash(bytes)))) => *bytes,
        _ => return Err(ExecutorError::Invalid("the payment asset is not a contract")),
    };
    let decimals = caps
        .assets
        .get(&hex::encode(asset_hash))
        .copied()
        .ok_or(ExecutorError::Invalid(
            "the payment asset is not in the configured decimals allow-list",
        ))?;
    if decimals > MAX_ASSET_DECIMALS {
        return Err(ExecutorError::Invalid("the configured asset decimals are invalid"));
    }
    let cap_raw = 10i128
        .checked_pow(decimals)
        .map(|scale| caps.hard_cap_whole.saturating_mul(scale))
        .ok_or(ExecutorError::Invalid("the configured asset decimals are invalid"))?;
    let amount = match &values[4] {
        ScVal::I128(Int128Parts { hi, lo }) => ((*hi as i128) << 64) | (*lo as i128),
        _ => return Err(ExecutorError::Invalid("the payment amount is not an i128")),
    };
    if amount <= 0 {
        return Err(ExecutorError::Invalid("the payment amount is not positive"));
    }
    if amount > cap_raw {
        return Err(ExecutorError::OverHardCap {
            cap_raw,
            decimals,
        });
    }
    for entry in invoke.auth.iter() {
        // MINOR-3: a no-prompt signer must never attach a signature for an auth
        // tree that is not exactly this operation. CAP-46-11 ignores unmatched
        // entries, but requiring the root invocation (and no sub-invocations)
        // keeps the signed authorization tree byte-equal to the operation.
        let matches_operation = matches!(
            &entry.root_invocation.function,
            SorobanAuthorizedFunction::ContractFn(call) if call == args
        ) && entry.root_invocation.sub_invocations.as_slice().is_empty();
        if !matches_operation {
            return Err(ExecutorError::Invalid(
                "an auth entry does not match this operation",
            ));
        }
        match &entry.credentials {
            SorobanCredentials::SourceAccount => {}
            SorobanCredentials::Address(credentials)
            | SorobanCredentials::AddressV2(credentials) => {
                if sc_key_from_address(&credentials.address) == Some(*owner_public) {
                    return Err(ExecutorError::Invalid("the transaction asks the owner to authorise"));
                }
            }
            // Delegated credentials carry a nested signature this signer cannot
            // reason about, so they are refused outright.
            SorobanCredentials::AddressWithDelegates(_) => {
                return Err(ExecutorError::Invalid("delegated contract auth is not allowed"));
            }
        }
    }
    Ok(())
}

/// The Ed25519 key behind an `ScAddress`, or `None` for a contract/other address.
fn sc_key_from_address(address: &ScAddress) -> Option<[u8; 32]> {
    match address {
        ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(key)))) => {
            Some(*key)
        }
        _ => None,
    }
}

/// The Ed25519 key behind an `ScVal`, when it is a plain account address.
fn sc_key(value: &ScVal) -> Option<[u8; 32]> {
    match value {
        ScVal::Address(address) => sc_key_from_address(address),
        _ => None,
    }
}

/// The contract hash behind an `ScAddress::Contract`, or `None`.
fn contract_hash(address: &ScAddress) -> Option<[u8; 32]> {
    match address {
        ScAddress::Contract(ContractId(Hash(bytes))) => Some(*bytes),
        _ => None,
    }
}

/// Decodes a `C…` contract StrKey (`base32(0x10 || hash(32) || crc16)`) to its
/// 32-byte hash, or `None` on a bad length, alphabet, version or checksum. Kept
/// local and self-contained like `bridge::strkey`, so the guard id is validated
/// fail-closed before it is compared against a transaction.
pub fn decode_contract_id(value: &str) -> Option<[u8; 32]> {
    const CONTRACT_VERSION: u8 = 0x10;
    if value.len() != 56 {
        return None;
    }
    let decoded = base32_decode(value)?;
    if decoded.len() != 35 || decoded[0] != CONTRACT_VERSION {
        return None;
    }
    if crc16_xmodem(&decoded[..33]) != u16::from_le_bytes([decoded[33], decoded[34]]) {
        return None;
    }
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&decoded[1..33]);
    Some(hash)
}

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

/// Maps an authentication failure to a wallet error; a cancelled prompt is the
/// user's choice, not a success.
fn authenticate(
    authenticator: &dyn Authenticator,
    reason: &str,
) -> Result<(), WalletError> {
    authenticator
        .authenticate(reason)
        .map_err(|error| match error {
            crate::biometric::AuthError::Cancelled => WalletError::Cancelled,
            other => WalletError::Unauthorized(other.detail()),
        })
}

/// The non-prompting Debug check (`executor_health`).
pub fn health(wallet: &WalletService) -> FeatureHealth {
    let Some(owner) = wallet.active_address() else {
        return FeatureHealth::new(
            HEALTH_ID,
            TITLE,
            "W11",
            HealthStatus::Warn,
            "No wallet yet — create or import one before enabling autopay.",
        );
    };
    match executor_address(wallet, &owner) {
        Some(address) => FeatureHealth::new(
            HEALTH_ID,
            TITLE,
            "W11",
            HealthStatus::Ok,
            format!(
                "executor key {} ready for {} (funding is checked over Horizon)",
                super::short_address(&address),
                super::short_address(&owner)
            ),
        ),
        None => FeatureHealth::new(
            HEALTH_ID,
            TITLE,
            "W11",
            HealthStatus::Warn,
            "No autopay executor key yet — create one to enable automatic payments.",
        ),
    }
}

/// `executor_status`: whether the active owner has an executor key and its
/// public address. Never prompts.
#[tauri::command]
pub fn executor_status(wallet: State<'_, Arc<WalletService>>) -> ExecutorStatus {
    status(wallet.inner())
}

/// `executor_create`: Touch-ID-gated creation of the executor key for the active
/// owner. Runs the prompt on the blocking pool.
#[tauri::command]
pub async fn executor_create(
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
    authenticator: State<'_, Arc<dyn Authenticator>>,
) -> Result<ExecutorAddress, WalletCommandError> {
    let wallet = Arc::clone(wallet.inner());
    let session = Arc::clone(session.inner());
    let authenticator = Arc::clone(authenticator.inner());
    tauri::async_runtime::spawn_blocking(move || {
        create(&wallet, &session, authenticator.as_ref())
    })
    .await
    .map_err(join_error)?
    .map_err(WalletCommandError::from)
}

/// `executor_sign_pay`: the no-Touch-ID signature, valid only for a guard
/// `pay_executor` call. The guard id, asset decimals and passphrase come from
/// `stellar_config`; the fee and amount caps are Rust-side backstops.
#[tauri::command]
pub fn executor_sign_pay(
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
    xdr: String,
) -> PayOutcome {
    let config = crate::stellar_config::read();
    let Some(guard) = config.guard_contract_id.as_deref() else {
        return PayOutcome::fail(&ExecutorError::Invalid(
            "the guard contract is not configured",
        ));
    };
    let assets = crate::stellar_config::asset_decimals();
    let caps = PayCaps {
        hard_cap_whole: read_hard_cap_whole(),
        assets: &assets,
        max_fee_stroops: read_max_fee_stroops(),
    };
    match sign_pay(
        wallet.inner(),
        session.inner(),
        &xdr,
        guard,
        caps,
        &config.network_passphrase,
    ) {
        Ok(signed) => PayOutcome::ok(signed.signed_xdr, signed.tx_hash),
        Err(error) => PayOutcome::fail(&error),
    }
}

/// `executor_health`: the non-prompting Debug check.
#[tauri::command]
pub fn executor_health(wallet: State<'_, Arc<WalletService>>) -> FeatureHealth {
    health(wallet.inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::biometric::AuthError;
    use crate::wallet::{memory, session::SessionStore, AccountMeta, KeyStore, Stores};
    use stellar_xdr::{
        InvokeContractArgs, LedgerFootprint, PreconditionsV2, ScMap, ScMapEntry, ScString, ScVec,
        SorobanAddressCredentials, SorobanAuthorizationEntry, SorobanAuthorizedInvocation,
        SorobanResources, SorobanTransactionData, SorobanTransactionDataExt, StringM, TimeBounds,
        TimePoint, VecM, WriteXdr,
    };

    /// The asset SAC hash the fixtures move (hex of the 32-byte contract id).
    const ASSET_HEX: &str =
        "0909090909090909090909090909090909090909090909090909090909090909";

    /// Fixtures generated with `@stellar/stellar-sdk` 17.1.0 by a Node one-off
    /// (see `backlog/w11a-executor-rust.md`): `new Account(source, seq)` with
    /// `seq="0"` (the SDK adds 1) or `seq="-1"` for sequence 0, then
    /// `new Contract(id).call(method, ...args)` and `setTimeout(300)`.
    const EXECUTOR_SEED: [u8; 32] = [0x11; 32];
    const EXECUTOR_ADDRESS: &str = "GDIEVMRSOQV3JKZ2CNUL2RQV4TTNAISKW4NAC25PQUQKGMWJO6DTOAE7";
    const OWNER: &str = "GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E";
    const GUARD: &str = "CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D";
    const CAP: i128 = 1_000_000_000; // 100 whole units at 7 decimals.

    const PAY: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAA==";
    const EXACT_CAP: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAAO5rKAAAAAAAAAAAAAAAAAA==";
    const OVER_CAP: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAAO5rKAQAAAAAAAAAAAAAAAA==";
    const OWNER_MISMATCH: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAI3tVok61TTo62sAe57GyNXKhOQajucXlopWPdTDOXEsAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAA==";
    const WRONG_CONTRACT: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAABBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAA==";
    const FN_SET_RULE: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAIc2V0X3J1bGUAAAACAAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAAEAAAAAQAAAAAAAAAAAAAAAA==";
    const FN_SET_EXECUTOR: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMc2V0X2V4ZWN1dG9yAAAAAgAAABIAAAAAAAAAAJYTU0+O/SKdT5I7Z5x7y1+YounEDUqiPnx5H0fU3drTAAAAEgAAAAAAAAAA0EqyMnQrtKs6E2i9RhXk5tAiSrcaAWuvhSCjMsl3hzcAAAAAAAAAAAAAAAA=";
    const FN_REVOKE: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAPcmV2b2tlX2V4ZWN1dG9yAAAAAAEAAAASAAAAAAAAAACWE1NPjv0inU+SO2ece8tfmKLpxA1Koj58eR9H1N3a0wAAAAAAAAAAAAAAAA==";
    const SOURCE_NOT_EXECUTOR: &str = "AAAAAgAAAACWE1NPjv0inU+SO2ece8tfmKLpxA1Koj58eR9H1N3a0wAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAA==";
    const SEQ_ZERO: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAA==";
    const TWO_OPS: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAMgAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAIAAAAAAAAAGAAAAAAAAAAB4rkVPbIF2jC6XZ5dtjUblE+JuxgwZQ7Q7NKWVD8sTxEAAAAMcGF5X2V4ZWN1dG9yAAAABQAAABIAAAAAAAAAANBKsjJ0K7SrOhNovUYV5ObQIkq3GgFrr4UgozLJd4c3AAAAEgAAAAAAAAAAlhNTT479Ip1PkjtnnHvLX5ii6cQNSqI+fHkfR9Td2tMAAAASAAAAAAAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAABIAAAABCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkAAAAKAAAAAAAAAAAAAAAABfXhAAAAAAAAAAAAAAAAAQAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAAAAAAAAAAJiWgAAAAAAAAAAA";
    const NON_INVOKE: &str = "AAAAAgAAAADQSrIydCu0qzoTaL1GFeTm0CJKtxoBa6+FIKMyyXeHNwAAAGQAAAAAAAAAAQAAAAEAAAAAAAAAAAAAAABqr2pyAAAAAAAAAAEAAAAAAAAAAQAAAAAje1WiTrVNOjrawB7nsbI1cqE5BqO5xeWilY91MM5cSwAAAAAAAAAAAJiWgAAAAAAAAAAA";

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

    fn wallet() -> WalletService {
        let stores = Stores::new(
            std::sync::Arc::new(memory::MemoryStore::new()),
            std::sync::Arc::new(memory::MemoryStore::new()),
            true,
            false,
        );
        WalletService::new(stores, crate::env::temp_dir("wallet-executor"))
    }

    fn executor_public() -> [u8; 32] {
        decode_public_key(EXECUTOR_ADDRESS).unwrap()
    }

    fn owner_public() -> [u8; 32] {
        decode_public_key(OWNER).unwrap()
    }

    /// Makes `OWNER` the active account and installs `EXECUTOR_SEED` for it,
    /// without Touch ID, as `executor_create` would.
    fn installed() -> WalletService {
        let wallet = wallet();
        wallet
            .stores
            .keychain
            .set(&item_id(OWNER), &EXECUTOR_SEED)
            .unwrap();
        {
            let mut inner = wallet.lock();
            install_account(&mut inner.meta, OWNER, StoreKind::Keychain);
            inner
                .meta
                .executors
                .insert(OWNER.to_string(), EXECUTOR_ADDRESS.to_string());
        }
        wallet
    }

    /// Adds the active account row the executor lookups key on.
    fn install_account(meta: &mut crate::wallet::Metadata, address: &str, store: StoreKind) {
        meta.accounts.push(AccountMeta {
            label: "Owner".to_string(),
            address: address.to_string(),
            created: 0,
            store,
        });
        meta.active = Some(address.to_string());
    }

    /// The configured asset-decimal allow-list for the fixture asset.
    fn assets() -> BTreeMap<String, u32> {
        let mut map = BTreeMap::new();
        map.insert(ASSET_HEX.to_string(), 7);
        map
    }

    /// A time window the signer accepts (min in the past, max a minute out).
    fn valid_cond() -> Preconditions {
        Preconditions::Time(TimeBounds {
            min_time: TimePoint(0),
            max_time: TimePoint(now_secs() + 60),
        })
    }

    /// Decodes a fixture with unbounded limits (test-only), mutates it, and
    /// re-encodes it. Static fixtures carry a fixed `max_time`, so every test
    /// that reaches the precondition check rewrites the window to "now".
    fn rewrite(base: &str, mutate: impl FnOnce(&mut stellar_xdr::Transaction)) -> String {
        let mut envelope = TransactionEnvelope::from_xdr_base64(base, Limits::none()).unwrap();
        let TransactionEnvelope::Tx(v1) = &mut envelope else {
            panic!("the fixture is a v1 envelope");
        };
        mutate(&mut v1.tx);
        envelope.to_xdr_base64(Limits::none()).unwrap()
    }

    fn fresh_pay() -> String {
        rewrite(PAY, |tx| tx.cond = valid_cond())
    }

    /// A `SorobanTransactionData` extension carrying `resource_fee`.
    fn soroban_ext(resource_fee: i64) -> TransactionExt {
        TransactionExt::V1(SorobanTransactionData {
            ext: SorobanTransactionDataExt::V0,
            resources: SorobanResources {
                footprint: LedgerFootprint {
                    read_only: VecM::default(),
                    read_write: VecM::default(),
                },
                instructions: 0,
                disk_read_bytes: 0,
                write_bytes: 0,
            },
            resource_fee,
        })
    }

    /// Overwrites one `pay_executor` argument.
    fn set_arg(tx: &mut stellar_xdr::Transaction, index: usize, value: ScVal) {
        let operation = tx.operations.iter_mut().next().expect("one operation");
        let OperationBody::InvokeHostFunction(invoke) = &mut operation.body else {
            panic!("the operation invokes a contract");
        };
        let HostFunction::InvokeContract(args) = &mut invoke.host_function else {
            panic!("the host function invokes a contract");
        };
        let mut values: Vec<ScVal> = args.args.as_slice().to_vec();
        values[index] = value;
        args.args = VecM::try_from(values).unwrap();
    }

    fn nest_vec(depth: usize) -> ScVal {
        let mut value = ScVal::U32(0);
        for _ in 0..depth {
            value = ScVal::Vec(Some(ScVec(VecM::try_from(vec![value]).unwrap())));
        }
        value
    }

    fn nest_map(depth: usize) -> ScVal {
        let mut value = ScVal::U32(0);
        for _ in 0..depth {
            value = ScVal::Map(Some(ScMap(
                VecM::try_from(vec![ScMapEntry {
                    key: ScVal::U32(0),
                    val: value,
                }])
                .unwrap(),
            )));
        }
        value
    }

    /// The `pay_executor` invocation args from the happy fixture.
    fn pay_invoke_args() -> InvokeContractArgs {
        let envelope = TransactionEnvelope::from_xdr_base64(PAY, Limits::none()).unwrap();
        let TransactionEnvelope::Tx(v1) = envelope else {
            panic!("the fixture is a v1 envelope");
        };
        let OperationBody::InvokeHostFunction(invoke) = &v1.tx.operations.first().unwrap().body
        else {
            panic!("the fixture invokes a contract");
        };
        let HostFunction::InvokeContract(args) = &invoke.host_function else {
            panic!("the fixture invokes a contract");
        };
        args.clone()
    }

    fn matching_root() -> SorobanAuthorizedInvocation {
        SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(pay_invoke_args()),
            sub_invocations: VecM::default(),
        }
    }

    /// Re-encodes the happy fixture with one contract-auth entry.
    fn fixture_with_auth(
        credentials: SorobanCredentials,
        root_invocation: SorobanAuthorizedInvocation,
    ) -> String {
        rewrite(PAY, |tx| {
            let operation = tx.operations.iter_mut().next().expect("one operation");
            let OperationBody::InvokeHostFunction(invoke) = &mut operation.body else {
                panic!("the fixture invokes a contract");
            };
            invoke.auth = VecM::try_from(vec![SorobanAuthorizationEntry {
                credentials,
                root_invocation,
            }])
            .unwrap();
        })
    }

    /// The signer's strict check against the fixture parameters.
    fn check(xdr: &str) -> Result<(), ExecutorError> {
        let assets = assets();
        validate_pay(
            xdr,
            &executor_public(),
            &owner_public(),
            GUARD,
            PayCaps {
                hard_cap_whole: hard_cap_whole(None),
                assets: &assets,
                max_fee_stroops: max_fee_stroops(None),
            },
        )
    }

    /// `check` over a fixture whose time window is rewritten to "now". A blob
    /// that is not an envelope at all is passed through unchanged.
    fn validate(xdr: &str) -> Result<(), ExecutorError> {
        match TransactionEnvelope::from_xdr_base64(xdr, Limits::none()) {
            Ok(_) => check(&rewrite(xdr, |tx| tx.cond = valid_cond())),
            Err(_) => check(xdr),
        }
    }

    #[test]
    fn caps_fall_back_closed_and_the_fee_env_only_lowers() {
        assert_eq!(hard_cap_whole(None), 100);
        assert_eq!(hard_cap_whole(Some("100")), 100);
        assert_eq!(hard_cap_whole(Some(" 1 ")), 1);
        assert_eq!(hard_cap_whole(Some("0")), 0);
        assert_eq!(hard_cap_whole(Some("-5")), 100);
        assert_eq!(hard_cap_whole(Some("nonsense")), 100);

        assert_eq!(max_fee_stroops(None), DEFAULT_MAX_FEE_STROOPS);
        assert_eq!(max_fee_stroops(Some("1000")), 1000);
        // Equal to or above the default is not "downward": the default stands.
        assert_eq!(
            max_fee_stroops(Some(&DEFAULT_MAX_FEE_STROOPS.to_string())),
            DEFAULT_MAX_FEE_STROOPS
        );
        assert_eq!(
            max_fee_stroops(Some("999999999")),
            DEFAULT_MAX_FEE_STROOPS
        );
        assert_eq!(max_fee_stroops(Some("-1")), DEFAULT_MAX_FEE_STROOPS);
        assert_eq!(max_fee_stroops(Some("nonsense")), DEFAULT_MAX_FEE_STROOPS);
    }

    #[test]
    fn decode_contract_id_accepts_the_deployed_guard_and_rejects_typos() {
        assert!(decode_contract_id(GUARD).is_some());
        let mutated = format!("{}B", &GUARD[..55]);
        assert!(decode_contract_id(&mutated).is_none());
        assert!(decode_contract_id("").is_none());
        // A `G…` address is not a contract id.
        assert!(decode_contract_id(OWNER).is_none());
    }

    #[test]
    fn accepts_the_one_pay_executor_shape() {
        validate(PAY).unwrap();
        // The amount exactly at the hard cap is still allowed.
        validate(EXACT_CAP).unwrap();
    }

    #[test]
    fn refuses_every_other_transaction_shape() {
        assert_eq!(
            validate(OVER_CAP),
            Err(ExecutorError::OverHardCap {
                cap_raw: CAP,
                decimals: 7
            })
        );
        assert!(matches!(validate(OWNER_MISMATCH), Err(ExecutorError::Invalid(_))));
        assert_eq!(validate(WRONG_CONTRACT), Err(ExecutorError::WrongContract));
        assert_eq!(validate(FN_SET_RULE), Err(ExecutorError::NotPayExecutor));
        assert_eq!(validate(FN_SET_EXECUTOR), Err(ExecutorError::NotPayExecutor));
        assert_eq!(validate(FN_REVOKE), Err(ExecutorError::NotPayExecutor));
        assert_eq!(validate(SOURCE_NOT_EXECUTOR), Err(ExecutorError::WrongSource));
        assert!(matches!(validate(SEQ_ZERO), Err(ExecutorError::Invalid(_))));
        assert!(matches!(validate(TWO_OPS), Err(ExecutorError::Invalid(_))));
        assert!(matches!(validate(NON_INVOKE), Err(ExecutorError::Invalid(_))));
        assert!(matches!(validate("not base64 !!!"), Err(ExecutorError::Invalid(_))));
        assert!(matches!(validate(""), Err(ExecutorError::Invalid(_))));
    }

    #[test]
    fn signs_and_independently_verifies_the_executor_payment() {
        let wallet = installed();
        let session = SessionStore::new(0);
        session.connect();
        let fresh = fresh_pay();
        let assets = assets();
        let signed = sign_pay(
            &wallet,
            &session,
            &fresh,
            GUARD,
            PayCaps {
                hard_cap_whole: hard_cap_whole(None),
                assets: &assets,
                max_fee_stroops: max_fee_stroops(None),
            },
            "Test SDF Network ; September 2015",
        )
        .unwrap();
        assert_eq!(signed.signer_address, EXECUTOR_ADDRESS);
        // The same independent verifier the wallet uses accepts the signature.
        let verified = crate::bridge::verify::verify_signed(
            &fresh,
            &signed.signed_xdr,
            &executor_public(),
            "Test SDF Network ; September 2015",
        )
        .unwrap();
        assert_eq!(hex::encode(verified), signed.tx_hash);
    }

    #[test]
    fn a_locked_session_signs_nothing() {
        let wallet = installed();
        let session = SessionStore::new(0);
        let assets = assets();
        assert_eq!(
            sign_pay(
                &wallet,
                &session,
                &fresh_pay(),
                GUARD,
                PayCaps {
                    hard_cap_whole: hard_cap_whole(None),
                    assets: &assets,
                    max_fee_stroops: max_fee_stroops(None),
                },
                "p",
            )
            .unwrap_err(),
            ExecutorError::Locked
        );
    }

    #[test]
    fn create_requires_unlock_touch_id_and_stores_only_metadata_plus_seed() {
        let wallet = wallet();
        {
            let mut inner = wallet.lock();
            install_account(&mut inner.meta, OWNER, StoreKind::Keychain);
        }
        let session = SessionStore::new(0);
        // Locked: refused before any prompt.
        assert_eq!(
            create(&wallet, &session, &allow()).unwrap_err(),
            WalletError::Locked
        );
        session.connect();
        // A denied prompt stores nothing.
        assert_eq!(
            create(&wallet, &session, &deny()).unwrap_err(),
            WalletError::Cancelled
        );
        assert!(!status(&wallet).exists);
        let created = create(&wallet, &session, &allow()).unwrap();
        assert_eq!(status(&wallet).address.as_deref(), Some(created.address.as_str()));
        // The seed is in the same store as the wallet seeds.
        assert!(wallet.stores.keychain.get(&item_id(OWNER)).is_ok());
        // Idempotent: a second call returns the same address without a prompt.
        assert_eq!(create(&wallet, &session, &deny()).unwrap(), created);
        // No secret is written to the metadata.
        let meta = super::super::file::load_metadata(&wallet.root);
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains(&created.address));
        assert!(!json.contains("1111111111111111"));
    }

    #[test]
    fn status_reports_no_executor_without_a_wallet() {
        let status = status(&wallet());
        assert!(!status.exists);
        assert_eq!(status.address, None);
        assert_eq!(status.funded, None);
    }

    #[test]
    fn refuses_a_transaction_that_asks_the_owner_to_authorise() {
        let owner_entry = SorobanCredentials::Address(SorobanAddressCredentials {
            address: ScAddress::Account(AccountId(PublicKey::PublicKeyTypeEd25519(Uint256(
                owner_public(),
            )))),
            nonce: 0,
            signature_expiration_ledger: 0,
            signature: ScVal::Void,
        });
        assert!(matches!(
            validate(&fixture_with_auth(owner_entry, matching_root())),
            Err(ExecutorError::Invalid(_))
        ));

        // The executor's own auth (the tx source) is the expected entry.
        validate(&fixture_with_auth(
            SorobanCredentials::SourceAccount,
            matching_root(),
        ))
        .unwrap();
    }

    #[test]
    fn refuses_an_auth_tree_that_is_not_exactly_the_operation() {
        // A root invocation with a sub-invocation is not this one call.
        let mut with_sub = matching_root();
        with_sub.sub_invocations = VecM::try_from(vec![matching_root()]).unwrap();
        assert!(matches!(
            validate(&fixture_with_auth(
                SorobanCredentials::SourceAccount,
                with_sub
            )),
            Err(ExecutorError::Invalid(_))
        ));

        // A root invocation with the same contract/function but different args
        // is not this operation.
        let mut wrong_args = pay_invoke_args();
        wrong_args.args = VecM::try_from(vec![ScVal::U32(7)]).unwrap();
        let wrong_root = SorobanAuthorizedInvocation {
            function: SorobanAuthorizedFunction::ContractFn(wrong_args),
            sub_invocations: VecM::default(),
        };
        assert!(matches!(
            validate(&fixture_with_auth(
                SorobanCredentials::SourceAccount,
                wrong_root
            )),
            Err(ExecutorError::Invalid(_))
        ));
    }

    #[test]
    fn validate_never_panics_on_mutations_and_hostile_shapes() {
        use base64::Engine as _;
        let engine = base64::engine::general_purpose::STANDARD;
        let base = crate::bridge::verify::decode_envelope(PAY).unwrap();
        let mut state = 0x2545_F491_4F6C_DD1Du64;
        let mut rng = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        for cut in 0..=base.len().min(128) {
            let _ = check(&engine.encode(&base[..cut]));
        }
        for _ in 0..1500 {
            let len = (rng() % 400) as usize;
            let garbage: Vec<u8> = (0..len).map(|_| rng() as u8).collect();
            let _ = check(&engine.encode(&garbage));
        }
        // Structured hostile shapes: deep nesting and a huge string, each within
        // and beyond the input cap, must be typed refusals (no panic/overflow).
        for deep in [64usize, 256] {
            for value in [nest_vec(deep), nest_map(deep)] {
                let xdr = rewrite(PAY, |tx| {
                    tx.cond = valid_cond();
                    set_arg(tx, 2, value.clone());
                });
                assert!(matches!(check(&xdr), Err(ExecutorError::Invalid(_))));
            }
        }
        let huge = ScVal::String(ScString(
            StringM::try_from("A".repeat(100_000)).unwrap(),
        ));
        let xdr = rewrite(PAY, |tx| {
            tx.cond = valid_cond();
            set_arg(tx, 2, huge.clone());
        });
        assert!(matches!(check(&xdr), Err(ExecutorError::Invalid(_))));
    }

    #[test]
    fn caps_the_fee_resource_fee_preconditions_and_memo() {
        // Fee: the exact cap is accepted, one stroop over and the maximal u32
        // are refused.
        let at_fee = rewrite(PAY, |tx| {
            tx.cond = valid_cond();
            tx.fee = DEFAULT_MAX_FEE_STROOPS as u32;
        });
        assert!(check(&at_fee).is_ok());
        for fee in [DEFAULT_MAX_FEE_STROOPS as u32 + 1, u32::MAX] {
            let over = rewrite(PAY, |tx| {
                tx.cond = valid_cond();
                tx.fee = fee;
            });
            assert!(matches!(check(&over), Err(ExecutorError::Invalid(_))));
        }

        // Soroban resource fee: exact cap accepted, over refused.
        let at_resource = rewrite(PAY, |tx| {
            tx.cond = valid_cond();
            tx.ext = soroban_ext(MAX_RESOURCE_FEE_STROOPS);
        });
        assert!(check(&at_resource).is_ok());
        for resource_fee in [MAX_RESOURCE_FEE_STROOPS + 1, i64::from(u32::MAX) * 1000] {
            let over = rewrite(PAY, |tx| {
                tx.cond = valid_cond();
                tx.ext = soroban_ext(resource_fee);
            });
            assert!(matches!(check(&over), Err(ExecutorError::Invalid(_))));
        }

        // Preconditions: missing, never-expiring, far-future and future-min are
        // refused; the exact window boundary is accepted.
        let missing = rewrite(PAY, |tx| tx.cond = Preconditions::None);
        assert!(matches!(check(&missing), Err(ExecutorError::Invalid(_))));
        let never = rewrite(PAY, |tx| {
            tx.cond = Preconditions::Time(TimeBounds {
                min_time: TimePoint(0),
                max_time: TimePoint(0),
            });
        });
        assert!(matches!(check(&never), Err(ExecutorError::Invalid(_))));
        let far = rewrite(PAY, |tx| {
            tx.cond = Preconditions::Time(TimeBounds {
                min_time: TimePoint(0),
                max_time: TimePoint(now_secs() + 3600),
            });
        });
        assert!(matches!(check(&far), Err(ExecutorError::Invalid(_))));
        let future_min = rewrite(PAY, |tx| {
            tx.cond = Preconditions::Time(TimeBounds {
                min_time: TimePoint(now_secs() + 1000),
                max_time: TimePoint(now_secs() + 1100),
            });
        });
        assert!(matches!(check(&future_min), Err(ExecutorError::Invalid(_))));
        // V2 preconditions (ledger bounds/extra signers) are never accepted.
        let v2 = rewrite(PAY, |tx| tx.cond = Preconditions::V2(PreconditionsV2::default()));
        assert!(matches!(check(&v2), Err(ExecutorError::Invalid(_))));
        let at_window = rewrite(PAY, |tx| {
            tx.cond = Preconditions::Time(TimeBounds {
                min_time: TimePoint(0),
                max_time: TimePoint(now_secs() + TIME_BOUND_WINDOW_SECS),
            });
        });
        assert!(check(&at_window).is_ok());

        // A memo (any kind) is refused.
        for memo in [Memo::Id(1), Memo::Text(StringM::try_from("hi").unwrap())] {
            let with_memo = rewrite(PAY, |tx| {
                tx.cond = valid_cond();
                tx.memo = memo.clone();
            });
            assert!(matches!(check(&with_memo), Err(ExecutorError::Invalid(_))));
        }
    }

    #[test]
    fn refuses_an_asset_that_is_not_in_the_decimals_allow_list() {
        // An empty allow-list refuses the payment rather than assuming decimals.
        let xdr = fresh_pay();
        let empty = BTreeMap::new();
        assert!(matches!(
            validate_pay(
                &xdr,
                &executor_public(),
                &owner_public(),
                GUARD,
                PayCaps {
                    hard_cap_whole: hard_cap_whole(None),
                    assets: &empty,
                    max_fee_stroops: max_fee_stroops(None),
                },
            ),
            Err(ExecutorError::Invalid(_))
        ));
        // A zero-decimal cap is tighter: the same amount is over it.
        let mut small = BTreeMap::new();
        small.insert(ASSET_HEX.to_string(), 0);
        assert!(matches!(
            validate_pay(
                &xdr,
                &executor_public(),
                &owner_public(),
                GUARD,
                PayCaps {
                    hard_cap_whole: hard_cap_whole(None),
                    assets: &small,
                    max_fee_stroops: max_fee_stroops(None),
                },
            ),
            Err(ExecutorError::OverHardCap { decimals: 0, .. })
        ));
    }

    #[test]
    fn decode_bounds_never_overflow_a_small_stack() {
        // Building/encoding thousands of levels is itself recursive, so it runs
        // on a large stack; the **validation** then runs on a small one.
        let (within_cap, deep, huge) = std::thread::Builder::new()
            .stack_size(64 * 1024 * 1024)
            .spawn(|| {
                (
                    // Fits the input cap but nests far past the depth limit.
                    rewrite(PAY, |tx| {
                        tx.cond = valid_cond();
                        set_arg(tx, 2, nest_vec(100));
                    }),
                    rewrite(PAY, |tx| {
                        tx.cond = valid_cond();
                        set_arg(tx, 2, nest_vec(3000));
                    }),
                    rewrite(PAY, |tx| {
                        tx.cond = valid_cond();
                        set_arg(
                            tx,
                            2,
                            ScVal::String(ScString(
                                StringM::try_from("A".repeat(200_000)).unwrap(),
                            )),
                        );
                    }),
                )
            })
            .expect("the builder thread starts")
            .join()
            .expect("the payloads are built without overflowing");

        let handle = std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(move || {
                for xdr in [within_cap, deep, huge] {
                    assert!(matches!(check(&xdr), Err(ExecutorError::Invalid(_))));
                }
            })
            .expect("the bounded decode must not overflow the thread");
        handle.join().unwrap();
    }

    #[test]
    fn concurrent_creates_leave_one_consistent_executor() {
        let wallet = Arc::new(wallet());
        {
            let mut inner = wallet.lock();
            install_account(&mut inner.meta, OWNER, StoreKind::Keychain);
        }
        let session = Arc::new(SessionStore::new(0));
        session.connect();
        let auth = Arc::new(allow());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let wallet = Arc::clone(&wallet);
            let session = Arc::clone(&session);
            let auth = Arc::clone(&auth);
            handles.push(std::thread::spawn(move || {
                create(&wallet, &session, auth.as_ref()).unwrap().address
            }));
        }
        let addresses: Vec<String> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert!(addresses.iter().all(|address| *address == addresses[0]));

        let stored = wallet.stores.keychain.get(&item_id(OWNER)).unwrap();
        assert_eq!(keys::address_of(&stored), addresses[0]);
        let meta = wallet.lock().meta.clone();
        assert_eq!(meta.executors.len(), 1);
        assert_eq!(meta.executors.get(OWNER), Some(&addresses[0]));
    }

    #[test]
    fn read_seed_follows_the_recorded_store_kind() {
        let root = crate::env::temp_dir("executor-store");
        let keychain = Arc::new(memory::MemoryStore::new());
        let file = Arc::new(memory::MemoryStore::new());
        let wallet = WalletService::new(
            Stores::new(keychain.clone(), file.clone(), true, true),
            root,
        );
        {
            let mut inner = wallet.lock();
            install_account(&mut inner.meta, OWNER, StoreKind::File);
        }
        // The seed is in the file store the account records.
        file.set(&item_id(OWNER), &[0x44u8; 32]).unwrap();
        assert_eq!(*read_seed(&wallet, OWNER).unwrap(), [0x44u8; 32]);
        // A Keychain seed is never a silent fallback for a file-stored account.
        keychain.set(&item_id(OWNER), &[0x55u8; 32]).unwrap();
        assert_eq!(*read_seed(&wallet, OWNER).unwrap(), [0x44u8; 32]);
    }
}
