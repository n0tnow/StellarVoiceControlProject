//! The wallet Tauri commands (step W10).
//!
//! The embedded wallet is the default signer: `wallet_sign` releases the approved
//! XDR through the approval gate's only exit (`take_authorized`) and signs it
//! locally, and `wallet_sign_challenge` signs a SEP-10 challenge without Touch
//! ID. Every command returns non-secret data only; `wallet_create` is the one
//! command that returns the recovery phrase, once, for the user to write down.
//!
//! Whenever the active wallet changes (create/import/select/rename/remove) a
//! `wallet_changed` event carries the fresh [`WalletStatus`] so the UI refreshes.

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use zeroize::Zeroize;

use super::{AddressOutcome, CreateOutcome, WalletError, WalletService, WalletStatus};
use crate::approval::ApprovalStore;
use crate::biometric::Authenticator;
use crate::bridge::commands::BridgeOutcome;
use crate::health::FeatureHealth;
use crate::stellar_config;
use std::sync::Arc;

/// The Rust Debug check id, matching `app/src/debug/checks/wallet.ts`.
pub const HEALTH_ID: &str = "w10.wallet";

/// The typed rejection shape every wallet command uses (`{ kind, message }`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletCommandError {
    pub kind: String,
    pub message: String,
}

impl From<WalletError> for WalletCommandError {
    fn from(error: WalletError) -> Self {
        Self {
            kind: error.kind().to_string(),
            message: error.detail(),
        }
    }
}

/// Broadcasts the fresh status so a wallet screen can refresh. The emit is
/// best-effort: a UI that is not listening must not fail the command.
fn emit_changed(app: &AppHandle, wallet: &WalletService) {
    let _ = app.emit(super::CHANGED_EVENT, wallet.status());
}

/// `wallet_status`: is a wallet configured, where is the seed stored, which
/// signer is active. Never prompts.
#[tauri::command]
pub fn wallet_status(wallet: State<'_, Arc<WalletService>>) -> WalletStatus {
    wallet.status()
}

/// `wallet_health`: the non-prompting Debug check.
#[tauri::command]
pub fn wallet_health(wallet: State<'_, Arc<WalletService>>) -> FeatureHealth {
    wallet.health()
}

/// `wallet_create`: generate and store a new 24-word wallet. Touch-ID gated,
/// refuses when one exists, and returns the phrase once.
#[tauri::command]
pub async fn wallet_create(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    authenticator: State<'_, Arc<dyn Authenticator>>,
    label: Option<String>,
) -> Result<CreateOutcome, WalletCommandError> {
    let wallet = Arc::clone(wallet.inner());
    let emit_handle = Arc::clone(&wallet);
    let authenticator = Arc::clone(authenticator.inner());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        wallet.create(authenticator.as_ref(), label.as_deref())
    })
    .await
    .map_err(join_error)?
    .map_err(WalletCommandError::from)?;
    emit_changed(&app, &emit_handle);
    Ok(outcome)
}

/// `wallet_import_preview`: derive the address for a `S…` secret or 12/24-word
/// phrase **without storing anything**. The input is wiped before returning.
#[tauri::command]
pub fn wallet_import_preview(
    wallet: State<'_, Arc<WalletService>>,
    secret_or_phrase: String,
    index: Option<u32>,
) -> Result<AddressOutcome, WalletCommandError> {
    let mut secret = secret_or_phrase;
    let result = wallet.import_preview(&secret, index).map_err(WalletCommandError::from);
    secret.zeroize();
    result
}

/// `wallet_import`: validate and store a `S…` secret or 12/24-word phrase.
/// Touch-ID gated; the input is wiped before returning.
#[tauri::command]
pub async fn wallet_import(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    authenticator: State<'_, Arc<dyn Authenticator>>,
    secret_or_phrase: String,
    index: Option<u32>,
    label: Option<String>,
) -> Result<AddressOutcome, WalletCommandError> {
    let wallet = Arc::clone(wallet.inner());
    let emit_handle = Arc::clone(&wallet);
    let authenticator = Arc::clone(authenticator.inner());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let mut secret = secret_or_phrase;
        let result = wallet.import(authenticator.as_ref(), &secret, index, label.as_deref());
        secret.zeroize();
        result
    })
    .await
    .map_err(join_error)?
    .map_err(WalletCommandError::from)?;
    emit_changed(&app, &emit_handle);
    Ok(outcome)
}

/// `wallet_list`: every account's non-secret metadata.
#[tauri::command]
pub fn wallet_list(wallet: State<'_, Arc<WalletService>>) -> Vec<super::AccountView> {
    wallet.list()
}

/// `wallet_select`: make an existing account active.
#[tauri::command]
pub fn wallet_select(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    address: String,
) -> Result<AddressOutcome, WalletCommandError> {
    let outcome = wallet.select(&address).map_err(WalletCommandError::from)?;
    emit_changed(&app, &wallet);
    Ok(outcome)
}

/// `wallet_rename`: change an account's display label.
#[tauri::command]
pub fn wallet_rename(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    address: String,
    label: String,
) -> Result<AddressOutcome, WalletCommandError> {
    let outcome = wallet
        .rename(&address, &label)
        .map_err(WalletCommandError::from)?;
    emit_changed(&app, &wallet);
    Ok(outcome)
}

/// `wallet_remove`: delete an account's seed and metadata. Touch-ID gated.
#[tauri::command]
pub async fn wallet_remove(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    authenticator: State<'_, Arc<dyn Authenticator>>,
    address: String,
) -> Result<AddressOutcome, WalletCommandError> {
    let wallet = Arc::clone(wallet.inner());
    let emit_handle = Arc::clone(&wallet);
    let authenticator = Arc::clone(authenticator.inner());
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        wallet.remove(&address, authenticator.as_ref())
    })
    .await
    .map_err(join_error)?
    .map_err(WalletCommandError::from)?;
    emit_changed(&app, &emit_handle);
    Ok(outcome)
}

/// `wallet_sign`: signs the approved transaction locally. The id is consumed
/// from the gate exactly once, so Touch ID approval is still enforced upstream.
#[tauri::command]
pub fn wallet_sign(
    wallet: State<'_, Arc<WalletService>>,
    approvals: State<'_, ApprovalStore>,
    id: String,
) -> BridgeOutcome {
    let released = match approvals.take_authorized(&id) {
        Ok(payload) => payload,
        Err(error) => return outcome_fail("not_authorized", error.detail()),
    };
    let passphrase = stellar_config::read().network_passphrase;
    match wallet.sign(&released.unsigned_xdr, &passphrase) {
        Ok(signed) => outcome_ok(signed.signed_xdr, signed.signer_address, signed.tx_hash),
        Err(error) => outcome_fail(error.bridge_code(), error.detail()),
    }
}

/// `wallet_sign_challenge`: signs a SEP-10 challenge (sequence 0, no Touch ID).
/// Refuses any non-zero-sequence or owner-sourced envelope.
#[tauri::command]
pub fn wallet_sign_challenge(
    wallet: State<'_, Arc<WalletService>>,
    xdr: String,
) -> BridgeOutcome {
    let passphrase = stellar_config::read().network_passphrase;
    match wallet.sign_challenge(&xdr, &passphrase) {
        Ok(signed) => outcome_ok(signed.signed_xdr, signed.signer_address, signed.tx_hash),
        Err(error) => outcome_fail(error.bridge_code(), error.detail()),
    }
}

/// Maps a blocking-task join failure to the command error shape.
fn join_error(error: impl std::fmt::Display) -> WalletCommandError {
    WalletCommandError {
        kind: "keychain".to_string(),
        message: format!("the wallet task did not finish: {error}"),
    }
}

fn outcome_ok(signed_xdr: String, signer_address: String, tx_hash: String) -> BridgeOutcome {
    BridgeOutcome {
        ok: true,
        signed_xdr: Some(signed_xdr),
        signer_address: Some(signer_address),
        tx_hash: Some(tx_hash),
        code: None,
        message: None,
    }
}

fn outcome_fail(code: &str, message: String) -> BridgeOutcome {
    BridgeOutcome {
        ok: false,
        signed_xdr: None,
        signer_address: None,
        tx_hash: None,
        code: Some(code.to_string()),
        message: Some(message),
    }
}
