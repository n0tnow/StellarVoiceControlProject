//! The wallet **session** (step W13a): login / logout / idle auto-lock.
//!
//! Wallets exist on disk independently of a login. This module adds the state
//! machine the rest of the shell enforces in Rust (the webview is not trusted):
//!
//! * `none` — no wallet is stored;
//! * `locked` — wallets exist but nobody has logged in (always the state at
//!   launch);
//! * `unlocked` — the device owner authenticated with Touch ID just now.
//!
//! Creating or importing a wallet leaves it `unlocked` (the user just proved
//! presence for that action). `wallet_lock` (logout) clears the flag and drops
//! the pending approval that belonged to the previous session; an idle timer
//! locks automatically after `autoLockMinutes` without wallet activity.
//!
//! ## Fail-closed
//!
//! [`SessionStore::ensure_unlocked`] gates every secret-touching path
//! (`wallet_sign`, `wallet_sign_challenge`, `wallet_remove`, `wallet_select`,
//! `wallet_rename`). The approval gate and `stellar_config` are gated in their
//! own modules. No decrypted seed is ever held by this module: the seed store is
//! read per signature, so locking drops nothing secret beyond the gate entry.
//!
//! ## Testability
//!
//! The idle timer runs on an injected monotonic clock, so tests advance time
//! instead of sleeping. The production ticker lives in [`spawn_auto_lock`] and
//! is only ever started from `lib.rs`.

use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::commands::WalletCommandError;
use super::{ActiveWallet, AddressOutcome, CreateOutcome, SignedTx, WalletError, WalletService};
use crate::approval::ApprovalStore;
use crate::biometric::Authenticator;
use crate::events::{self, PolarisEvent};
use crate::health::now_ms;

/// The Touch ID reason shown when logging in.
pub const UNLOCK_REASON: &str = "Unlock the Autonomy wallet";

/// The three session states, mirrored in `@polaris/interfaces`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionState {
    /// No wallet is stored.
    None,
    /// Wallets exist, nobody is logged in.
    Locked,
    /// Logged in.
    Unlocked,
}

/// The `wallet_session` result, and the payload of `wallet_session_changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletSession {
    pub state: SessionState,
    /// The active account while unlocked; `null` when locked or empty.
    pub active: Option<ActiveWallet>,
    /// How many accounts the metadata file holds.
    pub count: usize,
    /// Wall-clock ms when the session was unlocked, or `null`.
    pub unlocked_at: Option<u64>,
    /// Idle auto-lock timeout in minutes; `0` means "never".
    pub auto_lock_minutes: u64,
}

struct Inner {
    unlocked: bool,
    unlocked_at: u64,
    last_activity: Instant,
    auto_lock_minutes: u64,
}

/// The managed session state. Cheap to clone via `Arc`; the timer and the
/// commands share one instance.
pub struct SessionStore {
    inner: Mutex<Inner>,
    clock: Arc<dyn Fn() -> Instant + Send + Sync>,
}

impl SessionStore {
    /// Builds a session whose persisted auto-lock timeout is `auto_lock_minutes`.
    pub fn new(auto_lock_minutes: u64) -> Self {
        Self::with_clock(auto_lock_minutes, Arc::new(Instant::now))
    }

    /// Builds a session on an injected monotonic clock. Only tests need this.
    pub fn with_clock(
        auto_lock_minutes: u64,
        clock: Arc<dyn Fn() -> Instant + Send + Sync>,
    ) -> Self {
        let now = clock();
        Self {
            inner: Mutex::new(Inner {
                unlocked: false,
                unlocked_at: 0,
                last_activity: now,
                auto_lock_minutes,
            }),
            clock,
        }
    }

    fn now(&self) -> Instant {
        (self.clock)()
    }

    fn lock_inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Locks the session after the idle timeout. Returns `true` only on the
    /// locked transition, so the caller emits the event exactly once.
    pub fn refresh_auto_lock(&self) -> bool {
        let now = self.now();
        let mut inner = self.lock_inner();
        if inner.unlocked && inner.auto_lock_minutes > 0 {
            let idle = now.saturating_duration_since(inner.last_activity);
            let timeout = Duration::from_secs(inner.auto_lock_minutes.saturating_mul(60));
            if idle >= timeout {
                inner.unlocked = false;
                inner.unlocked_at = 0;
                return true;
            }
        }
        false
    }

    /// Whether a wallet is currently logged in. Applies the idle timer first, so
    /// a stale unlock is never observed as valid.
    pub fn is_unlocked(&self) -> bool {
        self.refresh_auto_lock();
        self.lock_inner().unlocked
    }

    /// Refuses a secret-touching action while locked. Fail-closed.
    pub fn ensure_unlocked(&self) -> Result<(), WalletError> {
        if self.is_unlocked() {
            Ok(())
        } else {
            Err(WalletError::Locked)
        }
    }

    /// Marks the session unlocked (login, or create/import) and resets activity.
    pub fn connect(&self) {
        let now = self.now();
        let mut inner = self.lock_inner();
        inner.unlocked = true;
        inner.unlocked_at = now_ms();
        inner.last_activity = now;
    }

    /// Clears the login without touching the stored wallets.
    pub fn disconnect(&self) {
        let mut inner = self.lock_inner();
        inner.unlocked = false;
        inner.unlocked_at = 0;
    }

    /// Counts wallet activity against the idle timer.
    pub fn touch(&self) {
        let now = self.now();
        let mut inner = self.lock_inner();
        inner.last_activity = now;
    }

    /// Updates the in-memory timeout (the store persists it separately).
    pub fn set_auto_lock_minutes(&self, minutes: u64) {
        self.lock_inner().auto_lock_minutes = minutes;
    }

    /// The current session snapshot. `active` is visible only while unlocked.
    pub fn snapshot(&self, wallet: &WalletService) -> WalletSession {
        self.refresh_auto_lock();
        let status = wallet.status();
        let inner = self.lock_inner();
        let auto_lock_minutes = inner.auto_lock_minutes;
        let (state, active, unlocked_at) = if inner.unlocked {
            (
                SessionState::Unlocked,
                status.active.clone(),
                Some(inner.unlocked_at),
            )
        } else if status.count > 0 {
            (SessionState::Locked, None, None)
        } else {
            (SessionState::None, None, None)
        };
        WalletSession {
            state,
            active,
            count: status.count,
            unlocked_at,
            auto_lock_minutes,
        }
    }

    /// Logs in with Touch ID. `address` picks an account (defaulting to the last
    /// active one). A cancelled or failed prompt leaves the session locked.
    pub fn unlock(
        &self,
        wallet: &WalletService,
        authenticator: &dyn Authenticator,
        address: Option<&str>,
    ) -> Result<(), WalletError> {
        let target = match address {
            Some(address) => address.to_string(),
            None => wallet.active_address().ok_or(WalletError::NoWallet)?,
        };
        if !wallet.list().iter().any(|account| account.address == target) {
            return Err(WalletError::UnknownAccount);
        }
        authenticate(authenticator, UNLOCK_REASON)?;
        if address.is_some() {
            wallet.select(&target)?;
        }
        self.connect();
        Ok(())
    }

    /// Gated `wallet_create`: a freshly created wallet is logged in, because the
    /// user just proved presence for the Touch-ID-gated creation.
    pub fn create(
        &self,
        wallet: &WalletService,
        authenticator: &dyn Authenticator,
        label: Option<&str>,
    ) -> Result<CreateOutcome, WalletError> {
        let outcome = wallet.create(authenticator, label)?;
        self.connect();
        Ok(outcome)
    }

    /// Gated `wallet_import`; like create, it leaves the wallet logged in.
    pub fn import(
        &self,
        wallet: &WalletService,
        authenticator: &dyn Authenticator,
        secret_or_phrase: &str,
        index: Option<u32>,
        label: Option<&str>,
    ) -> Result<AddressOutcome, WalletError> {
        let outcome = wallet.import(authenticator, secret_or_phrase, index, label)?;
        self.connect();
        Ok(outcome)
    }

    /// Gated `wallet_sign`: refuses while locked, counts the signature activity.
    pub fn sign(
        &self,
        wallet: &WalletService,
        unsigned_xdr: &str,
        passphrase: &str,
    ) -> Result<SignedTx, WalletError> {
        self.ensure_unlocked()?;
        let signed = wallet.sign(unsigned_xdr, passphrase)?;
        self.touch();
        Ok(signed)
    }

    /// Gated `wallet_sign_challenge`.
    pub fn sign_challenge(
        &self,
        wallet: &WalletService,
        xdr: &str,
        passphrase: &str,
    ) -> Result<SignedTx, WalletError> {
        self.ensure_unlocked()?;
        let signed = wallet.sign_challenge(xdr, passphrase)?;
        self.touch();
        Ok(signed)
    }

    /// Gated `wallet_select`.
    pub fn select(
        &self,
        wallet: &WalletService,
        address: &str,
    ) -> Result<AddressOutcome, WalletError> {
        self.ensure_unlocked()?;
        wallet.select(address)
    }

    /// Gated `wallet_rename`.
    pub fn rename(
        &self,
        wallet: &WalletService,
        address: &str,
        label: &str,
    ) -> Result<AddressOutcome, WalletError> {
        self.ensure_unlocked()?;
        wallet.rename(address, label)
    }

    /// Gated `wallet_remove`.
    pub fn remove(
        &self,
        wallet: &WalletService,
        address: &str,
        authenticator: &dyn Authenticator,
    ) -> Result<AddressOutcome, WalletError> {
        self.ensure_unlocked()?;
        wallet.remove(address, authenticator)
    }
}

/// Maps an authentication failure to a wallet error (a cancellation is the
/// user's choice, not a success).
fn authenticate(authenticator: &dyn Authenticator, reason: &str) -> Result<(), WalletError> {
    authenticator.authenticate(reason).map_err(|error| match error {
        crate::biometric::AuthError::Cancelled => WalletError::Cancelled,
        other => WalletError::Unauthorized(other.detail()),
    })
}

/// Emits `wallet_session_changed` on the shared event channel.
fn emit_session(app: &AppHandle, session: &WalletSession) {
    events::emit(app, PolarisEvent::WalletSessionChanged(session.clone()));
}

/// `wallet_session`: the current session state, active account, count and
/// auto-lock timeout. Never prompts.
#[tauri::command]
pub fn wallet_session(
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
) -> WalletSession {
    session.snapshot(wallet.inner().as_ref())
}

/// `wallet_unlock`: Touch-ID-gated login. Picks `address` or the last active
/// account; a cancelled prompt stays locked.
#[tauri::command]
pub async fn wallet_unlock(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
    authenticator: State<'_, Arc<dyn Authenticator>>,
    address: Option<String>,
) -> Result<WalletSession, WalletCommandError> {
    let wallet = Arc::clone(wallet.inner());
    let session = Arc::clone(session.inner());
    let authenticator = Arc::clone(authenticator.inner());
    let task_wallet = Arc::clone(&wallet);
    let task_session = Arc::clone(&session);
    tauri::async_runtime::spawn_blocking(move || {
        task_session.unlock(
            task_wallet.as_ref(),
            authenticator.as_ref(),
            address.as_deref(),
        )
    })
    .await
    .map_err(super::commands::join_error)?
    .map_err(WalletCommandError::from)?;

    let snapshot = session.snapshot(wallet.as_ref());
    emit_session(&app, &snapshot);
    Ok(snapshot)
}

/// `wallet_lock`: logout. No Touch ID, and it also rejects the pending approval
/// that belonged to the previous session so it cannot be consumed later.
#[tauri::command]
pub fn wallet_lock(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
    approvals: State<'_, ApprovalStore>,
) -> WalletSession {
    session.disconnect();
    for payload_hash in approvals.invalidate_for_lock() {
        events::emit(
            &app,
            PolarisEvent::ApprovalResult {
                payload_hash,
                approved: false,
            },
        );
    }
    let snapshot = session.snapshot(wallet.inner().as_ref());
    emit_session(&app, &snapshot);
    snapshot
}

/// `wallet_set_auto_lock`: persists the idle timeout (`0` = never) and reports
/// the refreshed session. Not value-moving, so no Touch ID is required.
#[tauri::command]
pub fn wallet_set_auto_lock(
    app: AppHandle,
    wallet: State<'_, Arc<WalletService>>,
    session: State<'_, Arc<SessionStore>>,
    minutes: u64,
) -> Result<WalletSession, WalletCommandError> {
    wallet
        .set_auto_lock_minutes(minutes)
        .map_err(WalletCommandError::from)?;
    session.set_auto_lock_minutes(minutes);
    let snapshot = session.snapshot(wallet.inner().as_ref());
    emit_session(&app, &snapshot);
    Ok(snapshot)
}

/// Spawns the production idle timer. Each tick applies the timeout; on the
/// locked transition it rejects the previous session's pending approval and
/// announces the new state. Started once from `lib.rs`; tests drive the clock
/// directly and never spawn this.
pub fn spawn_auto_lock(
    app: AppHandle,
    wallet: Arc<WalletService>,
    session: Arc<SessionStore>,
    approvals: ApprovalStore,
) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(1));
        if session.refresh_auto_lock() {
            for payload_hash in approvals.invalidate_for_lock() {
                events::emit(
                    &app,
                    PolarisEvent::ApprovalResult {
                        payload_hash,
                        approved: false,
                    },
                );
            }
            emit_session(&app, &session.snapshot(&wallet));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approval::{payload_hash_of_xdr, ApprovalRequest};
    use crate::biometric::AuthError;
    use crate::bridge::verify::tests_support as fixtures;
    use crate::types::{Intent, IntentKind, TxSummary};

    const PASSPHRASE: &str = fixtures::PASSPHRASE;
    const SEP5_SECRET: &str = "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN";
    const SEP5_ADDRESS: &str = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
    const SEP5_MNEMONIC: &str =
        "illness spike retreat truth genius clock brain pass fit cave bargain toe";

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

    fn service() -> WalletService {
        let root = crate::env::temp_dir("wallet-session");
        let stores = crate::wallet::Stores::new(
            Arc::new(crate::wallet::memory::MemoryStore::new()),
            Arc::new(crate::wallet::memory::MemoryStore::new()),
            true,
            false,
        );
        WalletService::new(stores, root)
    }

    /// A service with one known account, no session attached.
    fn seeded() -> WalletService {
        let wallet = service();
        wallet.import(&allow(), SEP5_SECRET, None, None).unwrap();
        wallet
    }

    fn unsigned_for(address: &str) -> String {
        let public = crate::bridge::strkey::decode_public_key(address).unwrap();
        fixtures::fixture_with_source(public, 1)
    }

    fn clock() -> (Arc<Mutex<Instant>>, Arc<dyn Fn() -> Instant + Send + Sync>) {
        let handle = Arc::new(Mutex::new(Instant::now()));
        let read = Arc::clone(&handle);
        (
            handle,
            Arc::new(move || *read.lock().unwrap()),
        )
    }

    fn advance(handle: &Arc<Mutex<Instant>>, seconds: u64) {
        *handle.lock().unwrap() += Duration::from_secs(seconds);
    }

    #[test]
    fn launch_state_is_none_then_locked_and_never_unlocked() {
        let session = SessionStore::new(30);
        let empty = service();
        assert_eq!(session.snapshot(&empty).state, SessionState::None);
        assert_eq!(session.snapshot(&empty).auto_lock_minutes, 30);

        let wallet = seeded();
        let snapshot = session.snapshot(&wallet);
        assert_eq!(snapshot.state, SessionState::Locked);
        assert_eq!(snapshot.count, 1);
        assert_eq!(snapshot.active, None);
        assert_eq!(snapshot.unlocked_at, None);
    }

    #[test]
    fn unlock_needs_an_authorised_prompt() {
        let wallet = seeded();
        let session = SessionStore::new(30);
        assert_eq!(
            session.unlock(&wallet, &deny(), None).unwrap_err(),
            WalletError::Cancelled
        );
        assert_eq!(session.snapshot(&wallet).state, SessionState::Locked);
        // A failed prompt is not a login either.
        assert!(session.unlock(&wallet, &allow(), Some("GAAA")).is_err());
        assert_eq!(session.snapshot(&wallet).state, SessionState::Locked);
        session.unlock(&wallet, &allow(), None).unwrap();
        let snapshot = session.snapshot(&wallet);
        assert_eq!(snapshot.state, SessionState::Unlocked);
        assert_eq!(snapshot.active.unwrap().address, SEP5_ADDRESS);
        assert!(snapshot.unlocked_at.is_some());
    }

    #[test]
    fn unlock_can_pick_a_specific_account() {
        let wallet = seeded();
        // The same phrase at a second derivation index is another account.
        let second = wallet
            .import(&allow(), SEP5_MNEMONIC, Some(1), None)
            .unwrap();
        let session = SessionStore::new(30);
        session.unlock(&wallet, &allow(), Some(&second.address)).unwrap();
        assert_eq!(session.snapshot(&wallet).active.unwrap().address, second.address);
    }

    #[test]
    fn create_and_import_leave_the_session_unlocked() {
        let wallet = service();
        let session = SessionStore::new(30);
        assert_eq!(session.snapshot(&wallet).state, SessionState::None);
        session.create(&wallet, &allow(), Some("Main")).unwrap();
        assert_eq!(session.snapshot(&wallet).state, SessionState::Unlocked);
        // A restart starts locked again.
        assert_eq!(
            SessionStore::new(30).snapshot(&wallet).state,
            SessionState::Locked
        );

        let imported = service();
        let import_session = SessionStore::new(30);
        import_session
            .import(&imported, &allow(), SEP5_SECRET, None, None)
            .unwrap();
        assert_eq!(import_session.snapshot(&imported).state, SessionState::Unlocked);
    }

    #[test]
    fn lock_refuses_every_secret_touching_path() {
        let wallet = seeded();
        let session = SessionStore::new(30);
        session.connect();
        assert!(session.is_unlocked());
        session.disconnect();

        assert_eq!(session.ensure_unlocked().unwrap_err(), WalletError::Locked);
        assert_eq!(session.snapshot(&wallet).state, SessionState::Locked);
        assert_eq!(session.snapshot(&wallet).active, None);
        let xdr = unsigned_for(SEP5_ADDRESS);
        assert_eq!(
            session.sign(&wallet, &xdr, PASSPHRASE).unwrap_err(),
            WalletError::Locked
        );
        assert_eq!(
            session.sign_challenge(&wallet, &xdr, PASSPHRASE).unwrap_err(),
            WalletError::Locked
        );
        assert_eq!(
            session.select(&wallet, SEP5_ADDRESS).unwrap_err(),
            WalletError::Locked
        );
        assert_eq!(
            session.rename(&wallet, SEP5_ADDRESS, "x").unwrap_err(),
            WalletError::Locked
        );
        assert_eq!(
            session.remove(&wallet, SEP5_ADDRESS, &allow()).unwrap_err(),
            WalletError::Locked
        );
    }

    #[test]
    fn unlocked_wallet_signs_and_select_rename_work() {
        let wallet = seeded();
        let session = SessionStore::new(30);
        session.connect();
        let xdr = unsigned_for(SEP5_ADDRESS);
        assert!(session.sign(&wallet, &xdr, PASSPHRASE).is_ok());
        session.rename(&wallet, SEP5_ADDRESS, "Main").unwrap();
        assert_eq!(wallet.list()[0].label, "Main");
    }

    #[test]
    fn auto_lock_fires_after_the_idle_timeout() {
        let wallet = seeded();
        let (handle, clock) = clock();
        let session = SessionStore::with_clock(30, clock);
        session.connect();
        assert!(session.is_unlocked());
        advance(&handle, 29 * 60);
        assert!(session.is_unlocked());
        advance(&handle, 60);
        assert!(!session.is_unlocked());
        assert_eq!(session.snapshot(&wallet).state, SessionState::Locked);
    }

    #[test]
    fn zero_minutes_never_auto_locks() {
        let (handle, clock) = clock();
        let session = SessionStore::with_clock(0, clock);
        session.connect();
        advance(&handle, 10 * 365 * 24 * 60 * 60);
        assert!(session.is_unlocked());
    }

    #[test]
    fn activity_resets_the_timer() {
        let wallet = seeded();
        let (handle, clock) = clock();
        let session = SessionStore::with_clock(30, clock);
        session.connect();
        let xdr = unsigned_for(SEP5_ADDRESS);
        advance(&handle, 29 * 60);
        session.sign(&wallet, &xdr, PASSPHRASE).unwrap();
        advance(&handle, 29 * 60);
        assert!(session.is_unlocked());
        advance(&handle, 2 * 60);
        assert!(!session.is_unlocked());
    }

    #[test]
    fn locking_rejects_the_previous_sessions_pending_approval() {
        let approvals = ApprovalStore::new();
        let request = ApprovalRequest {
            id: String::new(),
            payload_hash: payload_hash_of_xdr(fixtures::CHALLENGE_XDR),
            unsigned_xdr: fixtures::CHALLENGE_XDR.to_string(),
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
        approvals.authorize_wallet_only(&id).unwrap();

        let session = SessionStore::new(30);
        session.connect();
        session.disconnect();
        let rejected = approvals.invalidate_for_lock();
        assert_eq!(rejected.len(), 1);
        assert!(approvals.take_authorized(&id).is_err());
    }

    #[test]
    fn session_serializes_to_the_contract_fields() {
        let wallet = seeded();
        let session = SessionStore::new(15);
        session.connect();
        let json = serde_json::to_string(&session.snapshot(&wallet)).unwrap();
        assert!(json.contains(r#""state":"unlocked""#), "{json}");
        assert!(json.contains(r#""autoLockMinutes":15"#), "{json}");
        assert!(json.contains(r#""unlockedAt":"#), "{json}");
        assert!(json.contains(SEP5_ADDRESS), "{json}");

        let event = serde_json::to_string(&PolarisEvent::WalletSessionChanged(
            session.snapshot(&wallet),
        ))
        .unwrap();
        assert!(event.starts_with(r#"{"type":"wallet_session_changed","#), "{event}");

        // No secret leaves on the event.
        assert!(!event.contains(SEP5_SECRET));
        assert!(!event.contains("illness"));
    }
}
