//! Simulated demo bank ledger (BANK-SIM).
//!
//! The Stellar side of the on/off-ramp already exists (the anchor); this module
//! is OUR simulation of the customer's bank so the whole loop can be automated:
//! the app debits a demo TRY (or anchor-fiat) balance, drives the anchor deposit,
//! and credits the balance back on a withdrawal payout.
//!
//! Rules that matter:
//!
//! * **Demo only, no secrets.** The ledger is a plain JSON file under the app
//!   data directory (`bank.json`); it holds a holder name, a generated IBAN and
//!   amounts. It never holds a key, seed or credential.
//! * **Atomic writes.** Every mutation writes a temporary file and renames it
//!   over the ledger, so a crash can never leave a half-written `bank.json`.
//! * **Integer money.** Balances are stored in minor units (2 decimals) as
//!   `i64`; amounts are decimal strings on the wire. No floats anywhere.
//! * **Fail-closed / idempotent.** A debit that exceeds the balance is refused;
//!   a credit keyed by an anchor transaction id is applied at most once.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::health::{FeatureHealth, HealthStatus};

/// Event channel the UI subscribes to for a fresh account snapshot.
pub const BANK_CHANGED_EVENT: &str = "bank_changed";
/// Milestone tag for the Debug-panel check.
pub const MILESTONE: &str = "W14";
/// Balance a freshly reset demo account starts with.
pub const INITIAL_BALANCE_MINOR: i64 = 10_000_000;
/// Default demo currency; the webview switches it to the anchor's quoted fiat.
pub const DEFAULT_CURRENCY: &str = "TRY";
/// Default anchor home domain (SDF test anchor; the owner's latest decision).
pub const DEFAULT_ANCHOR_HOME_DOMAIN: &str = "testanchor.stellar.org";

/// How a ledger entry came to exist.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TxKind {
    /// A reservation: money left the bank toward the anchor.
    DepositToAnchor,
    /// The anchor paid local currency back into the bank.
    WithdrawalPayout,
    /// A seed top-up or a refund of a failed deposit.
    Topup,
}

/// Lifecycle of a ledger entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TxStatus {
    Pending,
    Completed,
    Refunded,
    Failed,
}

/// One ledger entry. `amount_try` keeps the contracted wire name; `currency`
/// says what unit it is actually in (the anchor's quoted fiat).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BankTransaction {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: TxKind,
    pub amount_try: String,
    pub currency: String,
    pub status: TxStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_tx_id: Option<String>,
    pub reference: String,
    pub ts: u64,
}

/// The account snapshot the UI renders.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankAccount {
    pub holder_name: String,
    pub iban: String,
    pub currency: String,
    pub balance_try: String,
    pub updated_at: u64,
}

/// The persisted ledger.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BankState {
    holder_name: String,
    iban: String,
    currency: String,
    balance_minor: i64,
    next_seq: u64,
    transactions: Vec<BankTransaction>,
}

impl BankState {
    fn fresh() -> Self {
        Self {
            holder_name: "Autonomy Demo Customer".to_string(),
            iban: generate_tr_iban(),
            currency: DEFAULT_CURRENCY.to_string(),
            balance_minor: INITIAL_BALANCE_MINOR,
            next_seq: 1,
            transactions: Vec::new(),
        }
    }

    fn account(&self, updated_at: u64) -> BankAccount {
        BankAccount {
            holder_name: self.holder_name.clone(),
            iban: self.iban.clone(),
            currency: self.currency.clone(),
            balance_try: format_minor(self.balance_minor),
            updated_at,
        }
    }
}

/// One mutation's result: the new entry and the account after it.
#[derive(Debug, Clone)]
pub(crate) struct BankMutation {
    tx: BankTransaction,
    account: BankAccount,
}

/// Wall-clock milliseconds since the Unix epoch.
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ---------- amount helpers ----------

/// Parses a positive decimal amount with at most two decimals into minor units.
fn parse_minor(raw: &str) -> Result<i64, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("the amount is empty".to_string());
    }
    let (whole, frac) = match s.split_once('.') {
        Some((w, f)) => (w, f),
        None => (s, ""),
    };
    if whole.is_empty() || !whole.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("\"{raw}\" is not a valid amount"));
    }
    if frac.len() > 2 || !frac.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!("\"{raw}\" must have at most two decimals"));
    }
    // Testnet demo amounts: far below any overflow concern, but stay defensive.
    let whole: i64 = whole.parse().map_err(|_| format!("\"{raw}\" is too large"))?;
    let frac_padded = format!("{frac:0<2}");
    let cents: i64 = frac_padded.parse().map_err(|_| format!("\"{raw}\" is not a valid amount"))?;
    let minor = whole
        .checked_mul(100)
        .and_then(|v| v.checked_add(cents))
        .ok_or_else(|| format!("\"{raw}\" is too large"))?;
    if minor <= 0 {
        return Err("the amount must be greater than zero".to_string());
    }
    Ok(minor)
}

/// Formats minor units as a 2-decimal string (`12345` -> `"123.45"`).
fn format_minor(minor: i64) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let abs = minor.unsigned_abs();
    format!("{sign}{}.{:02}", abs / 100, abs % 100)
}

// ---------- IBAN (TR, mod-97) ----------

/// Converts a string of digits and A–Z letters into the digit sequence the
/// mod-97 check uses (A=10 … Z=35).
fn to_numeric(input: &str) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for ch in input.chars() {
        if ch.is_ascii_digit() {
            out.push(ch);
        } else if ch.is_ascii_alphabetic() {
            let value = ch.to_ascii_uppercase() as u32 - 'A' as u32 + 10;
            out.push_str(&value.to_string());
        }
    }
    out
}

/// Iterative mod-97, never building a huge integer.
fn mod97(numeric: &str) -> u32 {
    let mut rem: u32 = 0;
    for ch in numeric.chars() {
        let Some(digit) = ch.to_digit(10) else {
            continue;
        };
        rem = (rem * 10 + digit) % 97;
    }
    rem
}

/// Builds a Turkish IBAN from a 22-digit BBAN. `TR` + 2 check digits + 22 digits.
pub fn tr_iban(bban: &str) -> String {
    let rearranged = format!("{bban}TR00");
    let check = 98 - mod97(&to_numeric(&rearranged));
    format!("TR{check:02}{bban}")
}

/// True when `iban` is a well-formed Turkish IBAN whose mod-97 checksum is 1.
pub fn is_valid_tr_iban(iban: &str) -> bool {
    if iban.len() != 26 || !iban.starts_with("TR") {
        return false;
    }
    if !iban.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return false;
    }
    if !iban[2..].bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    // Validate by moving the first four characters to the end (ISO 13616).
    let rearranged = format!("{}{}", &iban[4..], &iban[..4]);
    mod97(&to_numeric(&rearranged)) == 1
}

/// Generates a fresh, checksum-valid demo IBAN (22 random digits).
fn generate_tr_iban() -> String {
    let mut bytes = [0u8; 22];
    if getrandom::fill(&mut bytes).is_err() {
        // Extremely unlikely; fall back to a clock-derived BBAN rather than panic.
        let seed = now_ms();
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = ((seed >> ((index % 8) * 8)) & 0xff) as u8;
        }
    }
    let bban: String = bytes.iter().map(|b| char::from(b'0' + (b % 10))).collect();
    tr_iban(&bban)
}

// ---------- store ----------

/// The managed ledger. One instance per app; tests construct their own with a
/// temporary path.
pub struct BankStore {
    path: PathBuf,
    inner: Mutex<BankState>,
}

impl BankStore {
    /// Loads the ledger from `path`, creating a fresh demo account when the file
    /// is missing or unreadable.
    pub fn load(path: PathBuf) -> Self {
        let state = match fs::read_to_string(&path) {
            Ok(contents) => serde_json::from_str::<BankState>(&contents).unwrap_or_else(|error| {
                eprintln!("polaris: ignoring an unreadable bank ledger ({}): {error}", path.display());
                BankState::fresh()
            }),
            Err(_) => BankState::fresh(),
        };
        let store = Self {
            path,
            inner: Mutex::new(state),
        };
        // Persist the freshly created ledger so the file exists immediately.
        if let Ok(state) = store.inner.lock() {
            let _ = store.persist(&state);
        }
        store
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, BankState>, String> {
        self.inner
            .lock()
            .map_err(|_| "the demo bank ledger is unavailable".to_string())
    }

    /// Writes the ledger atomically: temp file, then rename over the real one.
    fn persist(&self, state: &BankState) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("could not create the bank folder: {error}"))?;
        }
        let json = serde_json::to_string_pretty(state).map_err(|error| format!("could not encode the bank ledger: {error}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|error| format!("could not write the bank ledger: {error}"))?;
        fs::rename(&tmp, &self.path).map_err(|error| format!("could not save the bank ledger: {error}"))
    }

    /// The current account snapshot.
    pub fn account(&self) -> Result<BankAccount, String> {
        Ok(self.lock()?.account(now_ms()))
    }

    /// Newest-first history, capped at `limit`.
    pub fn history(&self, limit: usize) -> Result<Vec<BankTransaction>, String> {
        let state = self.lock()?;
        let mut out: Vec<BankTransaction> = state.transactions.iter().rev().take(limit).cloned().collect();
        out.shrink_to_fit();
        Ok(out)
    }

    fn push(state: &mut BankState, tx: BankTransaction) {
        state.transactions.push(tx);
        // Keep the demo file bounded; the UI only ever shows the last 50.
        let max = 500;
        if state.transactions.len() > max {
            let excess = state.transactions.len() - max;
            state.transactions.drain(0..excess);
        }
    }

    /// Reserves `amount` from the demo account (fails when the balance is short).
    pub(crate) fn debit(&self, amount: &str, reference: &str) -> Result<BankMutation, String> {
        let amount_minor = parse_minor(amount)?;
        let mut state = self.lock()?;
        if state.balance_minor < amount_minor {
            return Err(format!(
                "the demo bank has {} {} but the transfer needs {} {}",
                format_minor(state.balance_minor),
                state.currency,
                format_minor(amount_minor),
                state.currency
            ));
        }
        state.balance_minor -= amount_minor;
        let ts = now_ms();
        let tx = BankTransaction {
            id: format!("bank-{}", state.next_seq),
            kind: TxKind::DepositToAnchor,
            amount_try: format_minor(amount_minor),
            currency: state.currency.clone(),
            status: TxStatus::Pending,
            anchor_tx_id: None,
            reference: reference.to_string(),
            ts,
        };
        state.next_seq += 1;
        Self::push(&mut state, tx.clone());
        self.persist(&state)?;
        Ok(BankMutation {
            tx,
            account: state.account(ts),
        })
    }

    /// Credits a payout. With an `anchor_tx_id`, the same anchor transaction can
    /// only ever be credited once (idempotent).
    pub(crate) fn credit(&self, amount: &str, reference: &str, anchor_tx_id: Option<&str>) -> Result<BankMutation, String> {
        let amount_minor = parse_minor(amount)?;
        let mut state = self.lock()?;
        if let Some(anchor) = anchor_tx_id {
            if let Some(existing) = state
                .transactions
                .iter()
                .find(|tx| tx.anchor_tx_id.as_deref() == Some(anchor))
            {
                return Ok(BankMutation {
                    tx: existing.clone(),
                    account: state.account(now_ms()),
                });
            }
        }
        state.balance_minor = state
            .balance_minor
            .checked_add(amount_minor)
            .ok_or_else(|| "the demo bank balance overflowed".to_string())?;
        let ts = now_ms();
        let tx = BankTransaction {
            id: format!("bank-{}", state.next_seq),
            kind: TxKind::WithdrawalPayout,
            amount_try: format_minor(amount_minor),
            currency: state.currency.clone(),
            status: TxStatus::Completed,
            anchor_tx_id: anchor_tx_id.map(str::to_string),
            reference: reference.to_string(),
            ts,
        };
        state.next_seq += 1;
        Self::push(&mut state, tx.clone());
        self.persist(&state)?;
        Ok(BankMutation {
            tx,
            account: state.account(ts),
        })
    }

    /// Settles a pending deposit reservation (the anchor completed the deposit).
    pub(crate) fn settle(&self, reference: &str) -> Result<BankMutation, String> {
        let mut state = self.lock()?;
        let Some(index) = state
            .transactions
            .iter()
            .position(|tx| tx.reference == reference && tx.kind == TxKind::DepositToAnchor)
        else {
            return Err(format!("no deposit reservation with reference \"{reference}\""));
        };
        if state.transactions[index].status == TxStatus::Pending {
            state.transactions[index].status = TxStatus::Completed;
        }
        let ts = now_ms();
        let tx = state.transactions[index].clone();
        self.persist(&state)?;
        Ok(BankMutation {
            tx,
            account: state.account(ts),
        })
    }

    /// Reverses a pending deposit reservation. Idempotent by `reference`: a
    /// second call returns the refund entry without touching the balance.
    pub(crate) fn refund(&self, reference: &str) -> Result<BankMutation, String> {
        let refund_reference = format!("refund:{reference}");
        let mut state = self.lock()?;
        if let Some(existing) = state.transactions.iter().find(|tx| tx.reference == refund_reference) {
            return Ok(BankMutation {
                tx: existing.clone(),
                account: state.account(now_ms()),
            });
        }
        let Some(index) = state
            .transactions
            .iter()
            .position(|tx| tx.reference == reference && tx.kind == TxKind::DepositToAnchor)
        else {
            return Err(format!("no deposit reservation with reference \"{reference}\""));
        };
        if state.transactions[index].status != TxStatus::Pending {
            return Err("only a pending deposit reservation can be refunded".to_string());
        }
        let amount_minor = parse_minor(&state.transactions[index].amount_try)?;
        state.transactions[index].status = TxStatus::Refunded;
        state.balance_minor = state
            .balance_minor
            .checked_add(amount_minor)
            .ok_or_else(|| "the demo bank balance overflowed".to_string())?;
        let ts = now_ms();
        let tx = BankTransaction {
            id: format!("bank-{}", state.next_seq),
            kind: TxKind::Topup,
            amount_try: format_minor(amount_minor),
            currency: state.currency.clone(),
            status: TxStatus::Completed,
            anchor_tx_id: None,
            reference: refund_reference,
            ts,
        };
        state.next_seq += 1;
        Self::push(&mut state, tx.clone());
        self.persist(&state)?;
        Ok(BankMutation {
            tx,
            account: state.account(ts),
        })
    }

    /// Resets the demo account (clearly labelled demo helper; no Touch ID).
    pub fn reset(&self) -> Result<BankAccount, String> {
        let mut state = self.lock()?;
        *state = BankState::fresh();
        self.persist(&state)?;
        Ok(state.account(now_ms()))
    }

    /// Sets the ledger currency to the anchor's quoted fiat (e.g. `USD`).
    pub fn set_currency(&self, currency: &str) -> Result<BankAccount, String> {
        let code = currency.trim().to_ascii_uppercase();
        if code.len() < 2 || code.len() > 12 || !code.bytes().all(|b| b.is_ascii_uppercase()) {
            return Err(format!("\"{currency}\" is not a valid currency code"));
        }
        let mut state = self.lock()?;
        state.currency = code;
        self.persist(&state)?;
        Ok(state.account(now_ms()))
    }
}

// ---------- Tauri commands ----------

/// The demo bank account snapshot.
#[tauri::command]
pub fn bank_account(store: State<'_, BankStore>) -> Result<BankAccount, String> {
    store.account()
}

/// Newest-first ledger history.
#[tauri::command]
pub fn bank_history(store: State<'_, BankStore>, limit: Option<usize>) -> Result<Vec<BankTransaction>, String> {
    store.history(limit.unwrap_or(50).min(500))
}

/// Reserves an amount from the demo bank. Fails when the balance is short.
#[tauri::command]
pub fn bank_debit(
    app: AppHandle,
    store: State<'_, BankStore>,
    amount_try: String,
    reference: String,
) -> Result<BankTransaction, String> {
    let result = store.debit(&amount_try, &reference)?;
    emit_account(&app, &result.account);
    Ok(result.tx)
}

/// Credits a payout, idempotent per `anchor_tx_id`.
#[tauri::command]
pub fn bank_credit(
    app: AppHandle,
    store: State<'_, BankStore>,
    amount_try: String,
    reference: String,
    anchor_tx_id: Option<String>,
) -> Result<BankTransaction, String> {
    let result = store.credit(&amount_try, &reference, anchor_tx_id.as_deref())?;
    emit_account(&app, &result.account);
    Ok(result.tx)
}

/// Marks a pending deposit reservation completed.
#[tauri::command]
pub fn bank_settle(
    app: AppHandle,
    store: State<'_, BankStore>,
    reference: String,
) -> Result<BankTransaction, String> {
    let result = store.settle(&reference)?;
    emit_account(&app, &result.account);
    Ok(result.tx)
}

/// Reverses a pending deposit reservation (idempotent by reference).
#[tauri::command]
pub fn bank_refund(
    app: AppHandle,
    store: State<'_, BankStore>,
    reference: String,
) -> Result<BankTransaction, String> {
    let result = store.refund(&reference)?;
    emit_account(&app, &result.account);
    Ok(result.tx)
}

/// Resets the demo ledger. A clearly labelled demo helper; no Touch ID needed.
#[tauri::command]
pub fn bank_reset(app: AppHandle, store: State<'_, BankStore>) -> Result<BankAccount, String> {
    let account = store.reset()?;
    emit_account(&app, &account);
    Ok(account)
}

/// Points the demo ledger at the anchor's quoted fiat (e.g. `USD`).
#[tauri::command]
pub fn bank_set_currency(
    app: AppHandle,
    store: State<'_, BankStore>,
    currency: String,
) -> Result<BankAccount, String> {
    let account = store.set_currency(&currency)?;
    emit_account(&app, &account);
    Ok(account)
}

/// The active anchor scenario, read from the allow-listed environment. The
/// webview cannot read arbitrary env, so this is the one place it learns which
/// home domain the shell is configured for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BankAnchorConfig {
    pub home_domain: String,
    pub sandbox_bank: bool,
}

#[tauri::command]
pub fn bank_anchor_config() -> BankAnchorConfig {
    let home_domain = crate::env::var("POLARIS_ANCHOR_HOME_DOMAIN")
        .unwrap_or_else(|| DEFAULT_ANCHOR_HOME_DOMAIN.to_string());
    let sandbox_bank = crate::env::var("POLARIS_ANCHOR_SANDBOX_BANK")
        .map(|value| value == "1" || value.eq_ignore_ascii_case("true"))
        .unwrap_or(true);
    BankAnchorConfig {
        home_domain,
        sandbox_bank,
    }
}

/// Non-destructive Debug check: is the ledger readable and coherent?
#[tauri::command]
pub fn bank_health(store: State<'_, BankStore>) -> FeatureHealth {
    match store.account() {
        Ok(account) if is_valid_tr_iban(&account.iban) => FeatureHealth::new(
            "bank.ledger",
            "Demo bank ledger",
            MILESTONE,
            HealthStatus::Ok,
            format!(
                "{} holds {} {} · IBAN {}",
                account.holder_name, account.balance_try, account.currency, account.iban
            ),
        ),
        Ok(account) => FeatureHealth::new(
            "bank.ledger",
            "Demo bank ledger",
            MILESTONE,
            HealthStatus::Fail,
            format!("the ledger's IBAN {} fails its checksum; reset the demo bank", account.iban),
        ),
        Err(error) => FeatureHealth::new(
            "bank.ledger",
            "Demo bank ledger",
            MILESTONE,
            HealthStatus::Fail,
            error,
        ),
    }
}

fn emit_account(app: &AppHandle, account: &BankAccount) {
    if let Err(error) = app.emit(BANK_CHANGED_EVENT, account) {
        eprintln!("polaris: failed to emit bank_changed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::temp_dir;

    fn store(label: &str) -> (BankStore, PathBuf) {
        let path = temp_dir(label).join("bank.json");
        (BankStore::load(path.clone()), path)
    }

    #[test]
    fn generates_a_checksum_valid_turkish_iban() {
        let store = BankStore::load(temp_dir("bank-iban").join("bank.json"));
        let account = store.account().unwrap();
        assert!(account.iban.starts_with("TR"));
        assert_eq!(account.iban.len(), 26);
        assert!(is_valid_tr_iban(&account.iban), "generated IBAN must pass mod-97: {}", account.iban);
    }

    #[test]
    fn computes_and_validates_the_known_example_iban() {
        // The canonical TR IBAN example (TR33 0006 1005 1978 6457 8413 26).
        assert_eq!(tr_iban("0006100519786457841326"), "TR330006100519786457841326");
        assert!(is_valid_tr_iban("TR330006100519786457841326"));
        // A single changed digit must fail.
        assert!(!is_valid_tr_iban("TR330006100519786457841327"));
        assert!(!is_valid_tr_iban("TR33000610051978645784132"));
        assert!(!is_valid_tr_iban("XX330006100519786457841326"));
    }

    #[test]
    fn seeds_a_hundred_thousand_and_writes_atomically() {
        let (store, path) = store("bank-atomic");
        assert_eq!(store.account().unwrap().balance_try, "100000.00");
        let result = store.debit("50", "dep-1").unwrap();
        assert_eq!(result.account.balance_try, "99950.00");
        assert_eq!(result.tx.status, TxStatus::Pending);

        // The real file parses back to the same balance, and no temp file is left.
        let on_disk: BankState = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(on_disk.balance_minor, 9_995_000);
        assert!(!path.with_extension("json.tmp").exists());
    }

    #[test]
    fn refuses_a_debit_beyond_the_balance_and_leaves_it_unchanged() {
        let (store, _) = store("bank-insufficient");
        let error = store.debit("100001", "dep-too-big").unwrap_err();
        assert!(error.contains("needs"), "{error}");
        assert_eq!(store.account().unwrap().balance_try, "100000.00");
        assert!(store.history(10).unwrap().is_empty());
    }

    #[test]
    fn credits_an_anchor_payout_exactly_once() {
        let (store, _) = store("bank-credit-idempotent");
        let first = store.credit("20", "wd-1", Some("anchor-hash-1")).unwrap();
        let second = store.credit("20", "wd-1", Some("anchor-hash-1")).unwrap();
        assert_eq!(first.tx.id, second.tx.id);
        assert_eq!(store.account().unwrap().balance_try, "100020.00");
        assert_eq!(store.history(10).unwrap().len(), 1);
    }

    #[test]
    fn refunds_a_pending_reservation_once() {
        let (store, _) = store("bank-refund");
        store.debit("500", "dep-refund").unwrap();
        let refund = store.refund("dep-refund").unwrap();
        assert_eq!(refund.tx.kind, TxKind::Topup);
        assert_eq!(store.account().unwrap().balance_try, "100000.00");
        // Idempotent: the second refund returns the same entry and no new balance.
        let again = store.refund("dep-refund").unwrap();
        assert_eq!(again.tx.id, refund.tx.id);
        assert_eq!(store.account().unwrap().balance_try, "100000.00");
    }

    #[test]
    fn settle_is_idempotent_and_keeps_the_money_out() {
        let (store, _) = store("bank-settle");
        store.debit("50", "dep-settle").unwrap();
        let settled = store.settle("dep-settle").unwrap();
        assert_eq!(settled.tx.status, TxStatus::Completed);
        let again = store.settle("dep-settle").unwrap();
        assert_eq!(again.tx.status, TxStatus::Completed);
        assert_eq!(store.account().unwrap().balance_try, "99950.00");
        // A settled reservation can no longer be refunded.
        assert!(store.refund("dep-settle").is_err());
    }

    #[test]
    fn reloading_the_file_preserves_the_ledger() {
        let path = temp_dir("bank-reload").join("bank.json");
        {
            let store = BankStore::load(path.clone());
            store.debit("75.25", "dep-reload").unwrap();
        }
        let reloaded = BankStore::load(path);
        assert_eq!(reloaded.account().unwrap().balance_try, "99924.75");
        assert_eq!(reloaded.history(10).unwrap().len(), 1);
    }

    #[test]
    fn parses_amounts_strictly() {
        assert_eq!(parse_minor("50").unwrap(), 5000);
        assert_eq!(parse_minor("50.5").unwrap(), 5050);
        assert_eq!(parse_minor(" 12.34 ").unwrap(), 1234);
        assert!(parse_minor("0").is_err());
        assert!(parse_minor("-1").is_err());
        assert!(parse_minor("1.234").is_err());
        assert!(parse_minor("abc").is_err());
    }
}
