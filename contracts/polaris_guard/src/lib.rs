//! Polaris guard — the on-chain rule engine for a voice-controlled Stellar wallet.
//!
//! # Why this contract exists
//!
//! The user keeps a normal `G...` account. They never hand a seed to the agent.
//! Instead they publish a [`Rule`] here ("auto-approve under 10 USDC, never more
//! than 50 per transaction, 200 a day, USDC only, known recipients only") and
//! register an **executor** key that the agent holds. The executor can move money
//! only inside that rule; anything larger is rejected on-chain with a typed error
//! and the desktop app falls back to the Touch ID / owner-signature path.
//!
//! Three actors, three entry points:
//!
//! | Caller | Function | Auth | Checks applied |
//! |---|---|---|---|
//! | Owner (Touch ID) | [`PolarisGuard::pay_owner`] | `owner.require_auth()` | hard caps only (`per_tx_limit`, `daily_limit`) |
//! | Agent executor | [`PolarisGuard::pay_executor`] | `executor.require_auth()` | hard caps **+** `auto_approve_limit`, `allowed_assets`, `known_recipients_only` |
//! | Keeper (anyone) | [`PolarisGuard::execute_schedule`] | none | hard caps **+** `allowed_assets`, and the schedule's own due-time state |
//!
//! The keeper is deliberately untrusted: it carries no authority at all, it only
//! pays the transaction fee for a payment the owner already authorised when they
//! created the schedule. Every parameter of that payment is fixed in contract
//! storage, so a malicious keeper can at worst call `execute_schedule` at the
//! moment it becomes due — which is exactly its job.
//!
//! # Moving the funds
//!
//! The guard never custodies anything. It settles through the SEP-41
//! `transfer_from(spender = this contract, from = owner, to, amount)` path, so the
//! owner must first `approve` this contract as a spender on the asset's SAC. That
//! allowance is the real ceiling: revoking it (`approve(..., 0, ...)`) disables the
//! guard instantly, without touching contract state. See `contracts/DEPLOYED.md`
//! for the exact CLI invocation and the `expiration_ledger` choice.
//!
//! # Rounding, units, time
//!
//! Amounts are raw token units — USDC on Stellar has 7 decimals, so 10 USDC is
//! `100_000_000`. The daily window is the UTC day derived from the ledger clock
//! (`env.ledger().timestamp() / 86400`); it resets on rollover rather than sliding.
#![no_std]
// `create_schedule` takes eight parameters because every one of them is part of
// the standing order the owner signs; bundling them into a struct would hide the
// ABI the app and the keeper both read. The lint has to be silenced crate-wide
// because `contractimpl`/`contractclient` re-emit the signature from macro
// expansion, where an attribute on the `impl` block does not reach.
#![allow(clippy::too_many_arguments)]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, symbol_short,
    token::TokenClient, Address, Env, String, Symbol, Vec,
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Length of the spending window. Day index = `timestamp / DAY_SECS` (UTC days).
const DAY_SECS: u64 = 86_400;

const DAY_IN_LEDGERS: u32 = 17_280;
/// Only extend a TTL once it drops below ~30 days...
const BUMP_THRESHOLD: u32 = 30 * DAY_IN_LEDGERS;
/// ...and then push it back out to ~120 days (the network's default maximum for
/// a fresh persistent entry).
const BUMP_TO: u32 = 120 * DAY_IN_LEDGERS;

/// Hard ceiling on `Rule.allowed_assets`.
///
/// Currently the *effective* limit is 1, enforced in [`validate_rule`]: the daily
/// counter is a single cross-asset total, and raw units are not comparable across
/// decimals, so a 2-decimal token and 7-decimal USDC on the same allowlist would
/// make `daily_limit` meaningless. This constant stays as the structural bound for
/// when `Spent(owner, asset)` lands.
const MAX_ALLOWED_ASSETS: u32 = 10;
/// Bounds `list_schedules` and the per-owner index entry size.
const MAX_ACTIVE_PER_OWNER: u32 = 25;
/// Bounds the global due-scan index. `list_due` never reads more than this.
const MAX_ACTIVE_GLOBAL: u32 = 200;

const VIA_OWNER: Symbol = symbol_short!("owner");
const VIA_EXECUTOR: Symbol = symbol_short!("executor");
const VIA_SCHEDULE: Symbol = symbol_short!("schedule");

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/// Typed rejections. The desktop app switches on these: `NeedsOwnerApproval` is
/// the "ask the user for Touch ID" signal, everything else is a hard stop that
/// re-signing cannot fix.
///
/// # Why the codes start at 100
///
/// A Soroban contract error crosses the wire as a bare `u32` with no record of
/// which contract raised it, and a generated client decodes whatever it receives
/// into *this* enum. The Stellar Asset Contract uses codes 1–13 (`AllowanceError`
/// is 9, `BalanceError` 10, `TrustlineMissingError` 13), so a guard numbered from
/// 1 would report a missing allowance as a confident, wrong policy error. Keeping
/// the guard's range at 100+ makes the two families trivially separable: a code
/// below 100 that reaches the app came from the token, not from policy.
///
/// Discriminants are public ABI — never renumber them across an upgrade.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// The owner has not published a [`Rule`] yet; the guard refuses to move
    /// money it has no policy for.
    NotConfigured = 100,
    /// Amount is zero or negative.
    InvalidAmount = 101,
    /// The submitted [`Rule`] is internally inconsistent or too large.
    InvalidRule = 102,
    /// Hard cap: above the owner's own per-transaction ceiling. Not recoverable
    /// by asking the user — the rule itself has to change.
    OverPerTxLimit = 103,
    /// Hard cap: this payment would push today's total past `daily_limit`.
    OverDailyLimit = 104,
    /// Soft stop: inside the hard caps but outside what the agent may do alone
    /// (over `auto_approve_limit`, or an unknown recipient while
    /// `known_recipients_only` is set). The app re-submits via `pay_owner`.
    NeedsOwnerApproval = 105,
    /// The asset is not on the owner's `allowed_assets` list.
    AssetNotAllowed = 106,
    /// No executor is registered for this owner.
    NoExecutor = 107,
    /// An executor is registered, but it is not the caller.
    NotExecutor = 108,
    ScheduleNotFound = 109,
    /// `execute_schedule` was called before `next_run_at`.
    ScheduleNotDue = 110,
    /// The schedule was cancelled or has run out of runs.
    ScheduleInactive = 111,
    /// `runs == 0`, or a one-shot (`interval_secs == 0`) asking for many runs.
    InvalidSchedule = 112,
    /// Someone other than the schedule's owner tried to cancel it.
    NotScheduleOwner = 113,
    /// Per-owner or global active-schedule cap reached.
    TooManySchedules = 114,
    /// Checked arithmetic refused (i128 spend counter or u64 time advance).
    Overflow = 115,
    /// The owner's SEP-41 allowance for this guard no longer covers the payment
    /// — usually because they revoked it, or it expired. This is the user's
    /// off-contract kill switch reporting in.
    InsufficientAllowance = 116,
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// The owner's spending policy. One per owner address.
///
/// Invariants enforced by [`PolarisGuard::set_rule`]:
/// `0 <= auto_approve_limit <= per_tx_limit <= daily_limit`, both hard caps
/// strictly positive, and `allowed_assets.len() <= MAX_ALLOWED_ASSETS`.
///
/// `allowed_assets` is a strict allowlist for the agent and keeper paths: an
/// **empty list means the agent may pay nothing**. The owner's own `pay_owner`
/// path deliberately ignores it, so a misconfigured list can never lock the owner
/// out of their own guard.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Rule {
    /// Ceiling for unattended agent payments. `0` means "always ask me".
    pub auto_approve_limit: i128,
    /// Hard ceiling for a single payment on every path.
    pub per_tx_limit: i128,
    /// Hard ceiling for the sum of all guard payments in one UTC day.
    pub daily_limit: i128,
    /// SAC / SEP-41 addresses the agent and keeper may spend.
    pub allowed_assets: Vec<Address>,
    /// When set, the agent may only pay addresses in the owner's alias book.
    pub known_recipients_only: bool,
}

/// A standing payment order the owner authorised once, at creation time.
///
/// `next_run_at` is a unix timestamp in seconds; `interval_secs == 0` marks a
/// one-shot. After a successful run the schedule is always left with
/// `next_run_at` **strictly in the future** — see [`PolarisGuard::execute_schedule`]
/// for the missed-run semantics.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Schedule {
    pub id: u32,
    pub owner: Address,
    pub to: Address,
    pub asset: Address,
    pub amount: i128,
    pub next_run_at: u64,
    /// `0` = one-shot.
    pub interval_secs: u64,
    pub runs_left: u32,
    pub active: bool,
}

/// Rolling daily counter. Stored as a pair so a new day costs no extra entry:
/// reading it with a different `day` simply means "today's total is zero".
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DaySpend {
    pub day: u64,
    pub amount: i128,
}

/// Persistent storage schema. Everything is keyed by owner so one deployed guard
/// can serve many wallets; `Known` is the reverse index of `Alias`, needed
/// because `known_recipients_only` asks "is this *address* known?" and the alias
/// book is keyed by the spoken name.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Rule(Address),
    Executor(Address),
    /// (owner, spoken alias) -> recipient
    Alias(Address, String),
    /// (owner, recipient) -> () — membership marker for `known_recipients_only`
    Known(Address, Address),
    Spent(Address),
    Schedule(u32),
    /// Active schedule ids of one owner (bounded by `MAX_ACTIVE_PER_OWNER`).
    OwnerScheds(Address),
    /// Active schedule ids across all owners (bounded by `MAX_ACTIVE_GLOBAL`).
    ActiveScheds,
    NextSchedId,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/// Emitted after a settled payment, whichever path produced it.
#[contractevent]
pub struct Paid {
    #[topic]
    pub owner: Address,
    #[topic]
    pub to: Address,
    pub asset: Address,
    pub amount: i128,
    /// `owner` | `executor` | `schedule`
    pub via: Symbol,
}

#[contractevent]
pub struct ScheduleCreated {
    #[topic]
    pub owner: Address,
    #[topic]
    pub id: u32,
    pub to: Address,
    pub asset: Address,
    pub amount: i128,
    pub next_run_at: u64,
    pub interval_secs: u64,
    pub runs: u32,
}

/// Emitted after a schedule run settles. Carries the post-run state so an
/// indexer can follow a schedule without re-reading storage.
#[contractevent]
pub struct ScheduleRun {
    #[topic]
    pub owner: Address,
    #[topic]
    pub id: u32,
    pub amount: i128,
    pub next_run_at: u64,
    pub runs_left: u32,
    pub active: bool,
}

#[contractevent]
pub struct ScheduleCancelled {
    #[topic]
    pub owner: Address,
    #[topic]
    pub id: u32,
}

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

#[contract]
pub struct PolarisGuard;

#[contractimpl]
impl PolarisGuard {
    // -- owner: policy ------------------------------------------------------

    /// Publishes or replaces the owner's spending policy.
    ///
    /// Replacing a rule does **not** reset today's spend counter: lowering the
    /// daily limit takes effect against money already spent today.
    pub fn set_rule(env: Env, owner: Address, rule: Rule) -> Result<(), Error> {
        owner.require_auth();
        validate_rule(&rule)?;
        let key = DataKey::Rule(owner);
        env.storage().persistent().set(&key, &rule);
        bump(&env, &key);
        Ok(())
    }

    pub fn get_rule(env: Env, owner: Address) -> Option<Rule> {
        env.storage().persistent().get(&DataKey::Rule(owner))
    }

    /// Registers the agent key that may call [`PolarisGuard::pay_executor`].
    /// One executor per owner; calling again replaces it.
    pub fn set_executor(env: Env, owner: Address, executor: Address) {
        owner.require_auth();
        let key = DataKey::Executor(owner);
        env.storage().persistent().set(&key, &executor);
        bump(&env, &key);
    }

    /// Removes the executor. Takes effect immediately — the agent's next call
    /// fails with [`Error::NoExecutor`]. (Revoking the SAC allowance is the other
    /// half of a full kill switch; that one lives on the token, not here.)
    pub fn revoke_executor(env: Env, owner: Address) {
        owner.require_auth();
        env.storage().persistent().remove(&DataKey::Executor(owner));
    }

    pub fn get_executor(env: Env, owner: Address) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Executor(owner))
    }

    // -- owner: alias book --------------------------------------------------

    /// Maps a spoken name ("ada") to an address, and marks that address as a
    /// known recipient for `known_recipients_only`.
    pub fn set_alias(env: Env, owner: Address, alias: String, address: Address) {
        owner.require_auth();
        let akey = DataKey::Alias(owner.clone(), alias);
        env.storage().persistent().set(&akey, &address);
        bump(&env, &akey);
        let kkey = DataKey::Known(owner, address);
        env.storage().persistent().set(&kkey, &());
        bump(&env, &kkey);
    }

    /// Drops an alias and un-marks its recipient.
    ///
    /// Caveat: if two aliases point at the same address, removing either one
    /// removes the shared `Known` marker. Re-add the surviving alias to restore
    /// it. (Kept simple on purpose — the reverse index holds no count.)
    pub fn remove_alias(env: Env, owner: Address, alias: String) {
        owner.require_auth();
        let akey = DataKey::Alias(owner.clone(), alias);
        if let Some(addr) = env.storage().persistent().get::<_, Address>(&akey) {
            env.storage().persistent().remove(&akey);
            env.storage()
                .persistent()
                .remove(&DataKey::Known(owner, addr));
        }
    }

    /// Resolves a spoken alias. `None` lets the app ask again instead of
    /// guessing a destination.
    pub fn get_alias(env: Env, owner: Address, alias: String) -> Option<Address> {
        env.storage()
            .persistent()
            .get(&DataKey::Alias(owner, alias))
    }

    /// Whether `to` is in the owner's alias book (the `known_recipients_only`
    /// predicate, exposed so the app can warn before it tries).
    pub fn is_known_recipient(env: Env, owner: Address, to: Address) -> bool {
        env.storage().persistent().has(&DataKey::Known(owner, to))
    }

    // -- payments -----------------------------------------------------------

    /// The Touch ID path: the owner signs, so only the hard caps apply.
    /// `auto_approve_limit`, `allowed_assets` and `known_recipients_only` are
    /// agent-facing guardrails and are deliberately skipped here.
    pub fn pay_owner(
        env: Env,
        owner: Address,
        to: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        owner.require_auth();
        let rule = load_rule(&env, &owner)?;
        check_hard_caps(&env, &owner, &rule, amount)?;
        // Effects before the interaction: the counter is committed first, so a
        // failing transfer rolls the whole invocation back rather than leaving a
        // stale debit behind.
        record_spend(&env, &owner, amount)?;
        settle(&env, &owner, &to, &asset, amount)?;
        Paid {
            owner,
            to,
            asset,
            amount,
            via: VIA_OWNER,
        }
        .publish(&env);
        Ok(())
    }

    /// The agent path. Succeeds only inside the full rule; every other outcome
    /// is a typed error the app can act on — [`Error::NeedsOwnerApproval`] means
    /// "re-submit this through `pay_owner` after a Touch ID prompt".
    pub fn pay_executor(
        env: Env,
        executor: Address,
        owner: Address,
        to: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), Error> {
        executor.require_auth();
        let ekey = DataKey::Executor(owner.clone());
        let registered: Address = env
            .storage()
            .persistent()
            .get(&ekey)
            .ok_or(Error::NoExecutor)?;
        if registered != executor {
            return Err(Error::NotExecutor);
        }
        // Keep the registration alive for an agent that pays daily: this is a
        // write path, so the entry is already in the read-write footprint.
        bump(&env, &ekey);
        let rule = load_rule(&env, &owner)?;

        // Hard caps first: they are unrecoverable, so reporting them beats
        // telling the user to approve something the rule forbids outright.
        check_asset(&rule, &asset)?;
        check_hard_caps(&env, &owner, &rule, amount)?;

        if amount > rule.auto_approve_limit {
            return Err(Error::NeedsOwnerApproval);
        }
        if rule.known_recipients_only
            && !env
                .storage()
                .persistent()
                .has(&DataKey::Known(owner.clone(), to.clone()))
        {
            return Err(Error::NeedsOwnerApproval);
        }

        record_spend(&env, &owner, amount)?;
        settle(&env, &owner, &to, &asset, amount)?;
        Paid {
            owner,
            to,
            asset,
            amount,
            via: VIA_EXECUTOR,
        }
        .publish(&env);
        Ok(())
    }

    /// Today's committed spend for this owner, in raw token units. Resets to `0`
    /// on UTC-day rollover.
    ///
    /// Note this sums **all assets** together — the MVP treats the daily limit as
    /// a single budget, which only reads correctly when `allowed_assets` holds
    /// one stablecoin. Per-asset budgets are a deliberate follow-up.
    pub fn spent_today(env: Env, owner: Address) -> i128 {
        read_spend(&env, &owner)
    }

    // -- schedules ----------------------------------------------------------

    /// Creates a standing order. The owner's signature here **is** the approval
    /// for every future run, which is why `execute_schedule` skips
    /// `auto_approve_limit`.
    ///
    /// `first_run_at` may be in the past — the schedule is then immediately due.
    /// `interval_secs == 0` means one-shot and requires `runs == 1`.
    /// The amount/asset are validated against the rule now *and* again at every
    /// run, so tightening the rule later disables the schedule's payments.
    pub fn create_schedule(
        env: Env,
        owner: Address,
        to: Address,
        asset: Address,
        amount: i128,
        first_run_at: u64,
        interval_secs: u64,
        runs: u32,
    ) -> Result<u32, Error> {
        owner.require_auth();
        if amount <= 0 {
            return Err(Error::InvalidAmount);
        }
        if runs == 0 || (interval_secs == 0 && runs != 1) {
            return Err(Error::InvalidSchedule);
        }
        let rule = load_rule(&env, &owner)?;
        check_asset(&rule, &asset)?;
        if amount > rule.per_tx_limit {
            return Err(Error::OverPerTxLimit);
        }

        let mut owned: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerScheds(owner.clone()))
            .unwrap_or(Vec::new(&env));
        let mut active: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveScheds)
            .unwrap_or(Vec::new(&env));
        if owned.len() >= MAX_ACTIVE_PER_OWNER || active.len() >= MAX_ACTIVE_GLOBAL {
            return Err(Error::TooManySchedules);
        }

        let id: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::NextSchedId)
            .unwrap_or(1u32);
        let next_id = id.checked_add(1).ok_or(Error::Overflow)?;
        env.storage()
            .persistent()
            .set(&DataKey::NextSchedId, &next_id);
        bump(&env, &DataKey::NextSchedId);

        let schedule = Schedule {
            id,
            owner: owner.clone(),
            to: to.clone(),
            asset: asset.clone(),
            amount,
            next_run_at: first_run_at,
            interval_secs,
            runs_left: runs,
            active: true,
        };
        let skey = DataKey::Schedule(id);
        env.storage().persistent().set(&skey, &schedule);
        bump(&env, &skey);

        owned.push_back(id);
        active.push_back(id);
        let okey = DataKey::OwnerScheds(owner.clone());
        env.storage().persistent().set(&okey, &owned);
        bump(&env, &okey);
        env.storage()
            .persistent()
            .set(&DataKey::ActiveScheds, &active);
        bump(&env, &DataKey::ActiveScheds);

        ScheduleCreated {
            owner,
            id,
            to,
            asset,
            amount,
            next_run_at: first_run_at,
            interval_secs,
            runs,
        }
        .publish(&env);
        Ok(id)
    }

    /// Cancels a schedule. Non-idempotent on purpose: cancelling an
    /// already-inactive schedule reports [`Error::ScheduleInactive`] so the app
    /// never silently "cancels" something that already fired.
    pub fn cancel_schedule(env: Env, owner: Address, id: u32) -> Result<(), Error> {
        owner.require_auth();
        let mut schedule = load_schedule(&env, id)?;
        if schedule.owner != owner {
            return Err(Error::NotScheduleOwner);
        }
        if !schedule.active {
            return Err(Error::ScheduleInactive);
        }
        schedule.active = false;
        let skey = DataKey::Schedule(id);
        env.storage().persistent().set(&skey, &schedule);
        bump(&env, &skey);
        deindex(&env, &owner, id);
        ScheduleCancelled { owner, id }.publish(&env);
        Ok(())
    }

    /// Runs one due schedule. **No authorization required** — the keeper is an
    /// untrusted fee payer, every parameter comes from contract storage, and the
    /// owner pre-authorised the payment when they created the schedule.
    ///
    /// Exactly one run per call. The rule is re-evaluated at execution time
    /// (hard caps + `allowed_assets`), so the owner can defuse a schedule by
    /// tightening their rule or revoking the SAC allowance.
    ///
    /// ## Missed runs: skip, never catch up
    ///
    /// If the keeper is offline for several intervals, the skipped slots are
    /// **dropped**, not replayed: `next_run_at` jumps to the first slot strictly
    /// after `now`, computed in O(1) as
    /// `next_run_at + (elapsed / interval + 1) * interval`. Consequences:
    ///
    /// * a single call can never settle more than one payment,
    /// * two calls in the same interval are impossible — after a run
    ///   `next_run_at > now`, so the second gets [`Error::ScheduleNotDue`],
    /// * a keeper that wakes up a month late cannot drain the daily limit with a
    ///   burst of backdated runs,
    /// * `runs_left` is decremented once per *executed* run, so a schedule of
    ///   "12 monthly payments" still makes 12 payments — it just finishes later
    ///   in wall-clock time than originally planned.
    pub fn execute_schedule(env: Env, id: u32) -> Result<(), Error> {
        let mut schedule = load_schedule(&env, id)?;
        if !schedule.active {
            return Err(Error::ScheduleInactive);
        }
        let now = env.ledger().timestamp();
        if now < schedule.next_run_at {
            return Err(Error::ScheduleNotDue);
        }

        let owner = schedule.owner.clone();
        let rule = load_rule(&env, &owner)?;
        // Defensive: `create_schedule` rejects these, but a stored amount is
        // read back as untrusted input after any future migration.
        check_asset(&rule, &schedule.asset)?;
        check_hard_caps(&env, &owner, &rule, schedule.amount)?;

        // --- effects ---
        record_spend(&env, &owner, schedule.amount)?;
        // An active schedule always has `runs_left >= 1`; `checked_sub` keeps that
        // an error rather than a panic if a future migration breaks the invariant.
        schedule.runs_left = schedule.runs_left.checked_sub(1).ok_or(Error::Overflow)?;
        if schedule.interval_secs == 0 || schedule.runs_left == 0 {
            schedule.active = false;
        } else {
            let elapsed = now - schedule.next_run_at;
            let skipped = elapsed / schedule.interval_secs;
            let advance = skipped
                .checked_add(1)
                .and_then(|n| n.checked_mul(schedule.interval_secs))
                .ok_or(Error::Overflow)?;
            schedule.next_run_at = schedule
                .next_run_at
                .checked_add(advance)
                .ok_or(Error::Overflow)?;
        }
        let skey = DataKey::Schedule(id);
        env.storage().persistent().set(&skey, &schedule);
        bump(&env, &skey);
        if !schedule.active {
            deindex(&env, &owner, id);
        }

        // --- interaction ---
        settle(&env, &owner, &schedule.to, &schedule.asset, schedule.amount)?;
        Paid {
            owner: owner.clone(),
            to: schedule.to.clone(),
            asset: schedule.asset.clone(),
            amount: schedule.amount,
            via: VIA_SCHEDULE,
        }
        .publish(&env);
        ScheduleRun {
            owner,
            id,
            amount: schedule.amount,
            next_run_at: schedule.next_run_at,
            runs_left: schedule.runs_left,
            active: schedule.active,
        }
        .publish(&env);
        Ok(())
    }

    pub fn get_schedule(env: Env, id: u32) -> Option<Schedule> {
        env.storage().persistent().get(&DataKey::Schedule(id))
    }

    /// The owner's **active** schedules. Cancelled and exhausted ones leave the
    /// index but stay readable by id through [`PolarisGuard::get_schedule`].
    pub fn list_schedules(env: Env, owner: Address) -> Vec<Schedule> {
        let ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::OwnerScheds(owner))
            .unwrap_or(Vec::new(&env));
        let mut out = Vec::new(&env);
        for id in ids.iter() {
            if let Some(s) = env
                .storage()
                .persistent()
                .get::<_, Schedule>(&DataKey::Schedule(id))
            {
                out.push_back(s);
            }
        }
        out
    }

    /// Ids the keeper should call right now, oldest-registered first. Read-only
    /// and bounded twice over: the scanned index is capped at
    /// `MAX_ACTIVE_GLOBAL`, and `limit` caps the result.
    pub fn list_due(env: Env, limit: u32) -> Vec<u32> {
        let mut out = Vec::new(&env);
        if limit == 0 {
            return out;
        }
        let now = env.ledger().timestamp();
        let ids: Vec<u32> = env
            .storage()
            .persistent()
            .get(&DataKey::ActiveScheds)
            .unwrap_or(Vec::new(&env));
        for id in ids.iter() {
            if out.len() >= limit {
                break;
            }
            if let Some(s) = env
                .storage()
                .persistent()
                .get::<_, Schedule>(&DataKey::Schedule(id))
            {
                if s.active && s.next_run_at <= now {
                    out.push_back(id);
                }
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn bump(env: &Env, key: &DataKey) {
    env.storage()
        .persistent()
        .extend_ttl(key, BUMP_THRESHOLD, BUMP_TO);
}

fn validate_rule(rule: &Rule) -> Result<(), Error> {
    if rule.per_tx_limit <= 0 || rule.daily_limit <= 0 || rule.auto_approve_limit < 0 {
        return Err(Error::InvalidRule);
    }
    // A rule where the agent's ceiling exceeds a hard cap is always a mistake:
    // the hard cap would silently win and the user's mental model would be wrong.
    if rule.auto_approve_limit > rule.per_tx_limit || rule.per_tx_limit > rule.daily_limit {
        return Err(Error::InvalidRule);
    }
    if rule.allowed_assets.len() > MAX_ALLOWED_ASSETS {
        return Err(Error::InvalidRule);
    }
    // At most ONE asset, for now. `daily_limit` is enforced against a single
    // cross-asset counter (`DataKey::Spent(owner)`), and raw units are not
    // comparable across decimals — pairing a 2-decimal token with 7-decimal USDC
    // would make the daily budget meaningless (200 raw units of the former would
    // consume the same budget as 0.00002 USDC). Refusing the configuration is
    // more honest than accounting for it wrongly. Lift this together with a
    // per-asset `Spent(owner, asset)` counter, not before.
    if rule.allowed_assets.len() > 1 {
        return Err(Error::InvalidRule);
    }
    Ok(())
}

fn load_rule(env: &Env, owner: &Address) -> Result<Rule, Error> {
    let key = DataKey::Rule(owner.clone());
    let rule = env
        .storage()
        .persistent()
        .get(&key)
        .ok_or(Error::NotConfigured)?;
    // Only the payment paths reach this helper, and all of them already write, so
    // the entry is in the read-write footprint and bumping here is free of the
    // "read-only call became a write" trap. Without it the hottest *read* entry
    // in the contract would be the one that archives, making the untrusted keeper
    // pay restore rent on `execute_schedule`.
    bump(env, &key);
    Ok(rule)
}

fn load_schedule(env: &Env, id: u32) -> Result<Schedule, Error> {
    env.storage()
        .persistent()
        .get(&DataKey::Schedule(id))
        .ok_or(Error::ScheduleNotFound)
}

fn check_asset(rule: &Rule, asset: &Address) -> Result<(), Error> {
    if rule.allowed_assets.contains(asset) {
        Ok(())
    } else {
        Err(Error::AssetNotAllowed)
    }
}

/// The two caps that bind on every path, owner included.
fn check_hard_caps(env: &Env, owner: &Address, rule: &Rule, amount: i128) -> Result<(), Error> {
    if amount <= 0 {
        return Err(Error::InvalidAmount);
    }
    if amount > rule.per_tx_limit {
        return Err(Error::OverPerTxLimit);
    }
    let total = read_spend(env, owner)
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    if total > rule.daily_limit {
        return Err(Error::OverDailyLimit);
    }
    Ok(())
}

fn today(env: &Env) -> u64 {
    env.ledger().timestamp() / DAY_SECS
}

fn read_spend(env: &Env, owner: &Address) -> i128 {
    match env
        .storage()
        .persistent()
        .get::<_, DaySpend>(&DataKey::Spent(owner.clone()))
    {
        // A stale entry from an earlier day reads as zero — that *is* the reset.
        Some(s) if s.day == today(env) => s.amount,
        _ => 0,
    }
}

fn record_spend(env: &Env, owner: &Address, amount: i128) -> Result<(), Error> {
    let amount = read_spend(env, owner)
        .checked_add(amount)
        .ok_or(Error::Overflow)?;
    let key = DataKey::Spent(owner.clone());
    env.storage().persistent().set(
        &key,
        &DaySpend {
            day: today(env),
            amount,
        },
    );
    bump(env, &key);
    Ok(())
}

/// Drops a schedule id from both indexes once it stops being active.
fn deindex(env: &Env, owner: &Address, id: u32) {
    let okey = DataKey::OwnerScheds(owner.clone());
    if let Some(mut owned) = env.storage().persistent().get::<_, Vec<u32>>(&okey) {
        if let Some(i) = owned.first_index_of(id) {
            owned.remove(i);
            env.storage().persistent().set(&okey, &owned);
            bump(env, &okey);
        }
    }
    if let Some(mut active) = env
        .storage()
        .persistent()
        .get::<_, Vec<u32>>(&DataKey::ActiveScheds)
    {
        if let Some(i) = active.first_index_of(id) {
            active.remove(i);
            env.storage()
                .persistent()
                .set(&DataKey::ActiveScheds, &active);
            bump(env, &DataKey::ActiveScheds);
        }
    }
}

/// Moves the money. The guard is the SEP-41 *spender*; the owner's standing
/// `approve` on the asset's SAC is what makes this possible, and revoking it is
/// the user's off-contract kill switch.
///
/// The guard calls the token directly, so the host treats that direct call as
/// the spender's authorization — no `authorize_as_current_contract` needed.
///
/// The allowance is checked here rather than left to the token so the app gets
/// [`Error::InsufficientAllowance`] instead of the SAC's opaque numeric error
/// (see the [`Error`] docs on code ranges). A short check-then-act window exists
/// between the read and the transfer, but it is harmless: the only way the
/// allowance shrinks in between is the owner's own action, and the transfer then
/// fails and rolls the invocation back anyway.
fn settle(
    env: &Env,
    owner: &Address,
    to: &Address,
    asset: &Address,
    amount: i128,
) -> Result<(), Error> {
    let token = TokenClient::new(env, asset);
    let spender = env.current_contract_address();
    if token.allowance(owner, &spender) < amount {
        return Err(Error::InsufficientAllowance);
    }
    token.transfer_from(&spender, owner, to, &amount);
    Ok(())
}

mod test;
