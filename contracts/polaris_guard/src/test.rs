//! Unit tests for the guard's rule engine and scheduler.
//!
//! The fixture always registers a real Stellar Asset Contract and drives money
//! through it, so allowance semantics, balances and `transfer_from` auth are
//! exercised for real rather than mocked away.
#![cfg(test)]
extern crate std;

use soroban_sdk::{
    testutils::{
        storage::Persistent as _, Address as _, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    Address, Env, Event as _, IntoVal, String, Symbol, Vec,
};

use crate::{
    DataKey, Error, Paid, PolarisGuard, PolarisGuardClient, Rule, ScheduleCancelled,
    ScheduleCreated, ScheduleRun, BUMP_THRESHOLD, BUMP_TO,
};

/// 1 USDC in raw units (7 decimals), so the numbers below read like the UI does.
const USDC: i128 = 10_000_000;
/// A fixed, non-zero wall clock: day-index maths needs a realistic timestamp.
const T0: u64 = 1_700_000_000;

struct Fx<'a> {
    guard: PolarisGuardClient<'a>,
    guard_id: Address,
    token: TokenClient<'a>,
    asset: Address,
    owner: Address,
    executor: Address,
    alice: Address,
    bob: Address,
}

/// Registers the guard plus a funded SAC, and grants the guard a standing
/// allowance over the owner's balance — the off-contract step the real deploy
/// documents in `contracts/DEPLOYED.md`.
fn setup(env: &Env) -> Fx<'_> {
    env.ledger().set_timestamp(T0);
    env.ledger().set_sequence_number(1_000);

    let guard_id = env.register(PolarisGuard, ());
    let guard = PolarisGuardClient::new(env, &guard_id);

    let issuer = Address::generate(env);
    let asset = env.register_stellar_asset_contract_v2(issuer).address();
    let token = TokenClient::new(env, &asset);

    let owner = Address::generate(env);
    StellarAssetClient::new(env, &asset).mint(&owner, &(10_000 * USDC));
    token.approve(&owner, &guard_id, &(10_000 * USDC), &500_000);

    Fx {
        guard,
        guard_id,
        token,
        asset,
        owner,
        executor: Address::generate(env),
        alice: Address::generate(env),
        bob: Address::generate(env),
    }
}

/// The standard demo policy: auto-approve 10, hard stop at 50 per payment and
/// 200 a day.
fn rule(env: &Env, asset: &Address, known_only: bool) -> Rule {
    Rule {
        auto_approve_limit: 10 * USDC,
        per_tx_limit: 50 * USDC,
        daily_limit: 200 * USDC,
        allowed_assets: Vec::from_array(env, [asset.clone()]),
        known_recipients_only: known_only,
    }
}

fn configure(fx: &Fx, env: &Env, known_only: bool) {
    fx.guard
        .set_rule(&fx.owner, &rule(env, &fx.asset, known_only));
    fx.guard.set_executor(&fx.owner, &fx.executor);
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

#[test]
fn rule_round_trips_and_rejects_inconsistent_limits() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);

    let good = rule(&env, &fx.asset, false);
    fx.guard.set_rule(&fx.owner, &good);
    assert_eq!(fx.guard.get_rule(&fx.owner), Some(good));

    // auto_approve above the hard per-tx cap would be silently unreachable.
    let mut bad = rule(&env, &fx.asset, false);
    bad.auto_approve_limit = 60 * USDC;
    assert_eq!(
        fx.guard.try_set_rule(&fx.owner, &bad),
        Err(Ok(Error::InvalidRule))
    );

    // per_tx above the daily cap, likewise.
    let mut bad = rule(&env, &fx.asset, false);
    bad.daily_limit = 10 * USDC;
    assert_eq!(
        fx.guard.try_set_rule(&fx.owner, &bad),
        Err(Ok(Error::InvalidRule))
    );

    // Non-positive hard caps.
    let mut bad = rule(&env, &fx.asset, false);
    bad.per_tx_limit = 0;
    assert_eq!(
        fx.guard.try_set_rule(&fx.owner, &bad),
        Err(Ok(Error::InvalidRule))
    );
}

#[test]
fn paying_without_a_rule_is_refused() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    assert_eq!(
        fx.guard
            .try_pay_owner(&fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NotConfigured))
    );
}

// ---------------------------------------------------------------------------
// Executor path
// ---------------------------------------------------------------------------

#[test]
fn executor_pays_within_the_auto_approve_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &(5 * USDC));

    assert_eq!(fx.token.balance(&fx.alice), 5 * USDC);
    assert_eq!(fx.guard.spent_today(&fx.owner), 5 * USDC);
}

#[test]
fn executor_over_auto_approve_needs_the_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // 25 USDC is inside both hard caps but outside the agent's mandate.
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &(25 * USDC)),
        Err(Ok(Error::NeedsOwnerApproval))
    );
    assert_eq!(fx.token.balance(&fx.alice), 0);
    assert_eq!(fx.guard.spent_today(&fx.owner), 0);

    // ...and the same payment goes through once the owner signs it.
    fx.guard
        .pay_owner(&fx.owner, &fx.alice, &fx.asset, &(25 * USDC));
    assert_eq!(fx.token.balance(&fx.alice), 25 * USDC);
}

#[test]
fn hard_caps_beat_needs_owner_approval() {
    // Over per_tx is unrecoverable, so the app must not be told "just ask the
    // user" for something the owner could not sign either.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &(60 * USDC)),
        Err(Ok(Error::OverPerTxLimit))
    );
}

#[test]
fn owner_path_still_respects_the_per_tx_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    assert_eq!(
        fx.guard
            .try_pay_owner(&fx.owner, &fx.alice, &fx.asset, &(51 * USDC)),
        Err(Ok(Error::OverPerTxLimit))
    );
    assert_eq!(fx.token.balance(&fx.alice), 0);
}

#[test]
fn disallowed_asset_is_rejected_for_the_agent_but_not_the_owner() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);

    let other_issuer = Address::generate(&env);
    let other = env
        .register_stellar_asset_contract_v2(other_issuer)
        .address();
    StellarAssetClient::new(&env, &other).mint(&fx.owner, &(100 * USDC));
    TokenClient::new(&env, &other).approve(&fx.owner, &fx.guard_id, &(100 * USDC), &500_000);

    configure(&fx, &env, false);

    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &other, &USDC),
        Err(Ok(Error::AssetNotAllowed))
    );
    // The allowlist is an agent guardrail; the owner is never locked out.
    fx.guard.pay_owner(&fx.owner, &fx.alice, &other, &USDC);
    assert_eq!(TokenClient::new(&env, &other).balance(&fx.alice), USDC);
}

#[test]
fn known_recipients_only_gates_unknown_addresses() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, true);

    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NeedsOwnerApproval))
    );

    let ada = String::from_str(&env, "ada");
    fx.guard.set_alias(&fx.owner, &ada, &fx.alice);
    assert_eq!(fx.guard.get_alias(&fx.owner, &ada), Some(fx.alice.clone()));
    assert!(fx.guard.is_known_recipient(&fx.owner, &fx.alice));

    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC);
    assert_eq!(fx.token.balance(&fx.alice), USDC);

    // Removing the alias closes the door again.
    fx.guard.remove_alias(&fx.owner, &ada);
    assert!(!fx.guard.is_known_recipient(&fx.owner, &fx.alice));
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NeedsOwnerApproval))
    );
}

#[test]
fn repointing_an_alias_un_marks_the_old_address() {
    // Regression: `set_alias` used to leave `Known(old)` behind when the alias
    // was re-pointed, so an owner moving "ada" to a new wallet left the old one
    // agent-payable forever — without ever approving that wallet again.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, true);

    let ada = String::from_str(&env, "ada");
    fx.guard.set_alias(&fx.owner, &ada, &fx.alice);
    assert!(fx.guard.is_known_recipient(&fx.owner, &fx.alice));

    // Move the alias to a new wallet. The old destination stops being known.
    fx.guard.set_alias(&fx.owner, &ada, &fx.bob);
    assert_eq!(fx.guard.get_alias(&fx.owner, &ada), Some(fx.bob.clone()));
    assert!(
        !fx.guard.is_known_recipient(&fx.owner, &fx.alice),
        "the abandoned wallet must not stay agent-payable"
    );
    assert!(fx.guard.is_known_recipient(&fx.owner, &fx.bob));

    // And the executor path now enforces the move, not just the predicate.
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NeedsOwnerApproval))
    );
    assert_eq!(fx.token.balance(&fx.alice), 0);
    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.bob, &fx.asset, &USDC);
    assert_eq!(fx.token.balance(&fx.bob), USDC);
}

#[test]
fn an_address_stays_known_while_another_alias_points_at_it() {
    // The refcount behind the fix: dropping one alias must not un-mark an
    // address another alias still resolves to (a case the old shared marker got
    // wrong in the other direction).
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, true);

    let ada = String::from_str(&env, "ada");
    let mom = String::from_str(&env, "mom");
    fx.guard.set_alias(&fx.owner, &ada, &fx.alice);
    fx.guard.set_alias(&fx.owner, &mom, &fx.alice);

    // Re-point one of the two aliases: alice is still known through the other.
    fx.guard.set_alias(&fx.owner, &ada, &fx.bob);
    assert!(fx.guard.is_known_recipient(&fx.owner, &fx.alice));
    assert!(fx.guard.is_known_recipient(&fx.owner, &fx.bob));

    // Removing the surviving alias finally un-marks her.
    fx.guard.remove_alias(&fx.owner, &mom);
    assert!(!fx.guard.is_known_recipient(&fx.owner, &fx.alice));
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NeedsOwnerApproval))
    );
}

#[test]
fn revoked_executor_cannot_pay() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC);

    fx.guard.revoke_executor(&fx.owner);
    assert_eq!(fx.guard.get_executor(&fx.owner), None);
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NoExecutor))
    );
}

#[test]
fn a_stranger_cannot_impersonate_the_executor() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let attacker = Address::generate(&env);
    assert_eq!(
        fx.guard
            .try_pay_executor(&attacker, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NotExecutor))
    );
}

#[test]
fn non_positive_amounts_are_rejected_everywhere() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    for bad in [0i128, -1i128] {
        assert_eq!(
            fx.guard
                .try_pay_owner(&fx.owner, &fx.alice, &fx.asset, &bad),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            fx.guard
                .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &bad),
            Err(Ok(Error::InvalidAmount))
        );
        assert_eq!(
            fx.guard
                .try_create_schedule(&fx.owner, &fx.alice, &fx.asset, &bad, &T0, &0, &1),
            Err(Ok(Error::InvalidAmount))
        );
    }
}

#[test]
fn missing_allowance_fails_cleanly() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // The user's off-contract kill switch: drop the SAC allowance to zero.
    fx.token.approve(&fx.owner, &fx.guard_id, &0, &500_000);

    // A typed error, not the SAC's raw code 9 — the guard checks the allowance
    // itself precisely so the app can tell "you revoked me" from a policy stop.
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::InsufficientAllowance))
    );
    assert_eq!(
        fx.guard
            .try_pay_owner(&fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::InsufficientAllowance))
    );
    // Nothing moved and the day counter did not drift.
    assert_eq!(fx.guard.spent_today(&fx.owner), 0);
    assert_eq!(fx.token.balance(&fx.alice), 0);
}

#[test]
fn guard_error_codes_cannot_be_confused_with_token_error_codes() {
    // Regression guard for the collision this suite originally caught: the SAC
    // raises AllowanceError = 9, which a client would happily decode into
    // whatever the guard numbered 9. Everything we define lives at 100+.
    //
    // The whole enum is listed explicitly rather than spot-checked: these
    // discriminants are permanent public ABI, so adding a variant should force a
    // deliberate edit here. A compile error when a variant is added or renamed is
    // the point.
    let all = [
        Error::NotConfigured,
        Error::InvalidAmount,
        Error::InvalidRule,
        Error::OverPerTxLimit,
        Error::OverDailyLimit,
        Error::NeedsOwnerApproval,
        Error::AssetNotAllowed,
        Error::NoExecutor,
        Error::NotExecutor,
        Error::ScheduleNotFound,
        Error::ScheduleNotDue,
        Error::ScheduleInactive,
        Error::InvalidSchedule,
        Error::NotScheduleOwner,
        Error::TooManySchedules,
        Error::Overflow,
        Error::InsufficientAllowance,
    ];
    assert_eq!(
        all.len(),
        17,
        "a variant was added without updating this test"
    );
    for e in all {
        assert!(
            (e as u32) >= 100,
            "{e:?} collides with the SAC's 1-13 error range"
        );
    }
    // And the codes are exactly the contiguous block DEPLOYED.md documents.
    assert_eq!(Error::NotConfigured as u32, 100);
    assert_eq!(Error::InsufficientAllowance as u32, 116);
}

// ---------------------------------------------------------------------------
// Daily window
// ---------------------------------------------------------------------------

#[test]
fn daily_limit_accumulates_and_rolls_over() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // 4 x 50 = 200 = exactly the daily limit.
    for _ in 0..4 {
        fx.guard
            .pay_owner(&fx.owner, &fx.alice, &fx.asset, &(50 * USDC));
    }
    assert_eq!(fx.guard.spent_today(&fx.owner), 200 * USDC);

    // The next unit is over budget, on both paths.
    assert_eq!(
        fx.guard
            .try_pay_owner(&fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::OverDailyLimit))
    );
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::OverDailyLimit))
    );

    // Cross a UTC-day boundary: the counter resets without anyone touching it.
    env.ledger().set_timestamp(T0 + 86_400);
    assert_eq!(fx.guard.spent_today(&fx.owner), 0);
    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &USDC);
    assert_eq!(fx.guard.spent_today(&fx.owner), USDC);
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

#[test]
fn schedule_is_not_due_before_its_time() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(5 * USDC),
        &(T0 + 100),
        &0,
        &1,
    );
    assert_eq!(fx.guard.list_due(&0, &10), (Vec::from_array(&env, []), 0));
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleNotDue))
    );
    assert_eq!(fx.token.balance(&fx.alice), 0);

    env.ledger().set_timestamp(T0 + 100);
    assert_eq!(fx.guard.list_due(&0, &10), (Vec::from_array(&env, [id]), 0));
    fx.guard.execute_schedule(&id);
    assert_eq!(fx.token.balance(&fx.alice), 5 * USDC);

    // One-shot: exhausted and de-indexed.
    let s = fx.guard.get_schedule(&id).unwrap();
    assert!(!s.active);
    assert_eq!(s.runs_left, 0);
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 0);
    assert_eq!(fx.guard.list_due(&0, &10), (Vec::from_array(&env, []), 0));
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleInactive))
    );
}

#[test]
fn recurring_schedule_advances_and_cannot_run_twice_in_a_period() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let interval = 3_600u64;
    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(2 * USDC),
        &T0,
        &interval,
        &3,
    );

    // Run 1 — due immediately.
    fx.guard.execute_schedule(&id);
    let s = fx.guard.get_schedule(&id).unwrap();
    assert_eq!(s.runs_left, 2);
    assert_eq!(s.next_run_at, T0 + interval);
    assert!(s.active);

    // A greedy keeper calling again in the same period gets nothing.
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleNotDue))
    );
    env.ledger().set_timestamp(T0 + interval - 1);
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleNotDue))
    );
    assert_eq!(fx.token.balance(&fx.alice), 2 * USDC);

    // Run 2.
    env.ledger().set_timestamp(T0 + interval);
    fx.guard.execute_schedule(&id);
    assert_eq!(fx.guard.get_schedule(&id).unwrap().runs_left, 1);

    // Run 3 exhausts it.
    env.ledger().set_timestamp(T0 + 2 * interval);
    fx.guard.execute_schedule(&id);
    let s = fx.guard.get_schedule(&id).unwrap();
    assert!(!s.active);
    assert_eq!(s.runs_left, 0);
    assert_eq!(fx.token.balance(&fx.alice), 6 * USDC);
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 0);
}

#[test]
fn missed_runs_are_skipped_not_replayed() {
    // A keeper that wakes up 10 intervals late settles ONE payment and lands on
    // the next future slot — no backdated burst against the daily limit.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let interval = 3_600u64;
    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(2 * USDC),
        &T0,
        &interval,
        &50,
    );

    env.ledger().set_timestamp(T0 + 10 * interval + 5);
    fx.guard.execute_schedule(&id);

    let s = fx.guard.get_schedule(&id).unwrap();
    assert_eq!(
        fx.token.balance(&fx.alice),
        2 * USDC,
        "exactly one run settled"
    );
    assert_eq!(
        s.runs_left, 49,
        "one run consumed, the skipped slots are dropped"
    );
    assert_eq!(s.next_run_at, T0 + 11 * interval);
    assert!(s.next_run_at > env.ledger().timestamp());
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleNotDue))
    );
}

#[test]
fn schedule_execution_re_checks_the_daily_limit() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &(50 * USDC), &T0, &0, &1);

    // Burn the whole day's budget before the keeper gets there.
    for _ in 0..4 {
        fx.guard
            .pay_owner(&fx.owner, &fx.bob, &fx.asset, &(50 * USDC));
    }
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::OverDailyLimit))
    );
    assert_eq!(fx.token.balance(&fx.alice), 0);
    // Still active and still due — it runs tomorrow.
    assert!(fx.guard.get_schedule(&id).unwrap().active);

    env.ledger().set_timestamp(T0 + 86_400);
    fx.guard.execute_schedule(&id);
    assert_eq!(fx.token.balance(&fx.alice), 50 * USDC);
}

#[test]
fn schedule_execution_re_checks_the_asset_allowlist() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &(5 * USDC), &T0, &0, &1);

    // The owner changes their mind and drops the asset from the allowlist.
    let mut tightened = rule(&env, &fx.asset, false);
    tightened.allowed_assets = Vec::new(&env);
    fx.guard.set_rule(&fx.owner, &tightened);

    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::AssetNotAllowed))
    );
}

#[test]
fn schedule_ignores_the_auto_approve_limit() {
    // The owner authorised the amount when they created the schedule, so a run
    // far above `auto_approve_limit` (but inside the hard caps) must settle.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &(45 * USDC), &T0, &0, &1);
    fx.guard.execute_schedule(&id);
    assert_eq!(fx.token.balance(&fx.alice), 45 * USDC);
}

#[test]
fn execute_schedule_extends_the_index_and_id_counter_ttl() {
    // The keeper's write path must keep the two entries it depends on alive:
    // the owner's active-schedule index and the shared id counter. Both used to
    // be extended only by `create_schedule`/`deindex`, so a schedule that ran for
    // months without new creates could let them fall below the bump threshold
    // (Protocol 23 auto-restores them, but the keeper then pays restore rent).
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(2 * USDC),
        &T0,
        &3_600,
        &3,
    );

    let okey = DataKey::OwnerScheds(fx.owner.clone());
    let nkey = DataKey::NextSchedId;

    // `setup` pins the ledger at 1_000, so a freshly bumped entry lives until
    // 1_000 + BUMP_TO. Walk the ledger forward to just inside the bump window
    // (still live, so `get_ttl` is readable).
    let long_later = 1_000 + BUMP_TO - BUMP_THRESHOLD + 10;
    env.ledger().set_sequence_number(long_later);
    // The SAC allowance is *temporary* storage and has genuinely expired here
    // (the ledger outran its `live_until`); renew it like a keep-alive cron
    // would, so the run itself is what this test exercises.
    fx.token
        .approve(&fx.owner, &fx.guard_id, &(10_000 * USDC), &(long_later + 100_000));
    env.as_contract(&fx.guard_id, || {
        assert!(env.storage().persistent().get_ttl(&okey) <= BUMP_THRESHOLD);
        assert!(env.storage().persistent().get_ttl(&nkey) <= BUMP_THRESHOLD);
    });

    // One run — the schedule stays active, so the owner's index must survive it.
    fx.guard.execute_schedule(&id);
    assert!(fx.guard.get_schedule(&id).unwrap().active);

    env.as_contract(&fx.guard_id, || {
        assert!(env.storage().persistent().get_ttl(&okey) > BUMP_THRESHOLD);
        assert!(env.storage().persistent().get_ttl(&nkey) > BUMP_THRESHOLD);
    });
}

#[test]
fn cancel_stops_a_schedule() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(2 * USDC),
        &T0,
        &3_600,
        &10,
    );
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 1);

    // Someone else's cancel is refused.
    let stranger = Address::generate(&env);
    assert_eq!(
        fx.guard.try_cancel_schedule(&stranger, &id),
        Err(Ok(Error::NotScheduleOwner))
    );

    fx.guard.cancel_schedule(&fx.owner, &id);
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 0);
    assert_eq!(fx.guard.list_due(&0, &10), (Vec::from_array(&env, []), 0));
    assert_eq!(
        fx.guard.try_execute_schedule(&id),
        Err(Ok(Error::ScheduleInactive))
    );
    // Cancelling twice is an error, not a silent no-op.
    assert_eq!(
        fx.guard.try_cancel_schedule(&fx.owner, &id),
        Err(Ok(Error::ScheduleInactive))
    );
}

#[test]
fn schedule_parameters_are_validated() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // runs == 0
    assert_eq!(
        fx.guard
            .try_create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &60, &0),
        Err(Ok(Error::InvalidSchedule))
    );
    // one-shot asking for many runs
    assert_eq!(
        fx.guard
            .try_create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &0, &5),
        Err(Ok(Error::InvalidSchedule))
    );
    // amount over the hard cap is refused up front
    assert_eq!(
        fx.guard
            .try_create_schedule(&fx.owner, &fx.alice, &fx.asset, &(99 * USDC), &T0, &0, &1),
        Err(Ok(Error::OverPerTxLimit))
    );
}

#[test]
fn unknown_schedule_id_is_reported() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    assert_eq!(fx.guard.get_schedule(&999), None);
    assert_eq!(
        fx.guard.try_execute_schedule(&999),
        Err(Ok(Error::ScheduleNotFound))
    );
    // Cancel reports the same thing rather than NotScheduleOwner, so the app can
    // distinguish "no such schedule" from "not yours".
    assert_eq!(
        fx.guard.try_cancel_schedule(&fx.owner, &999),
        Err(Ok(Error::ScheduleNotFound))
    );
}

// ---------------------------------------------------------------------------
// Real authorization (no blanket mock)
// ---------------------------------------------------------------------------

#[test]
fn executor_payment_requires_exactly_the_executor_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let amount = 5 * USDC;
    // Narrow the mock to one specific invocation by the executor only.
    env.mock_auths(&[MockAuth {
        address: &fx.executor,
        invoke: &MockAuthInvoke {
            contract: &fx.guard_id,
            fn_name: "pay_executor",
            args: (
                fx.executor.clone(),
                fx.owner.clone(),
                fx.alice.clone(),
                fx.asset.clone(),
                amount,
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);
    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &amount);

    // Assert the host really demanded the executor's signature for this call.
    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths.first().unwrap().0, fx.executor);
}

#[test]
fn keeper_needs_no_authorization_at_all() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);
    let id = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &(5 * USDC), &T0, &0, &1);

    // Nothing is authorised from here on: any `require_auth` would now fail.
    env.mock_auths(&[]);
    fx.guard.execute_schedule(&id);

    assert_eq!(fx.token.balance(&fx.alice), 5 * USDC);
    assert!(
        env.auths().is_empty(),
        "execute_schedule must consume no auth"
    );
}

#[test]
fn owner_functions_reject_a_foreign_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    let policy = rule(&env, &fx.asset, false);

    let attacker = Address::generate(&env);
    // The attacker signs their own call; the contract auths `owner`, so it fails.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &fx.guard_id,
            fn_name: "set_rule",
            args: (fx.owner.clone(), policy.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(fx.guard.try_set_rule(&fx.owner, &policy).is_err());
    assert_eq!(fx.guard.get_rule(&fx.owner), None);
}

#[test]
fn owner_payment_requires_the_owner_signature() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let amount = 3 * USDC;
    env.mock_auths(&[MockAuth {
        address: &fx.owner,
        invoke: &MockAuthInvoke {
            contract: &fx.guard_id,
            fn_name: "pay_owner",
            args: (fx.owner.clone(), fx.alice.clone(), fx.asset.clone(), amount).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    fx.guard.pay_owner(&fx.owner, &fx.alice, &fx.asset, &amount);

    let auths = env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths.first().unwrap().0, fx.owner);
}

// ---------------------------------------------------------------------------
// One asset per rule (until per-asset daily budgets land)
// ---------------------------------------------------------------------------

#[test]
fn rule_rejects_more_than_one_allowed_asset() {
    // `daily_limit` is enforced against a single cross-asset counter, and raw
    // units are not comparable across decimals, so two assets on one allowlist
    // would silently make the budget meaningless. Refuse the configuration.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);

    let second = env
        .register_stellar_asset_contract_v2(Address::generate(&env))
        .address();

    let mut two = rule(&env, &fx.asset, false);
    two.allowed_assets = Vec::from_array(&env, [fx.asset.clone(), second]);
    assert_eq!(
        fx.guard.try_set_rule(&fx.owner, &two),
        Err(Ok(Error::InvalidRule))
    );

    // Zero (deny-all for the agent) and one are both fine.
    let mut none = rule(&env, &fx.asset, false);
    none.allowed_assets = Vec::new(&env);
    fx.guard.set_rule(&fx.owner, &none);
    fx.guard.set_rule(&fx.owner, &rule(&env, &fx.asset, false));
}

// ---------------------------------------------------------------------------
// Schedule caps — per owner only, never global
// ---------------------------------------------------------------------------

#[test]
fn schedule_cap_is_per_owner_and_does_not_block_other_owners() {
    // The regression this encodes: a global cap let a handful of funded accounts
    // fill a shared list and permanently block everyone else's create_schedule,
    // with no admin and no upgrade path to recover.
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // Fill owner A's allowance of active schedules with far-future one-shots.
    for _ in 0..25 {
        fx.guard.create_schedule(
            &fx.owner,
            &fx.alice,
            &fx.asset,
            &USDC,
            &(T0 + 10_000_000),
            &0,
            &1,
        );
    }
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 25);
    assert_eq!(
        fx.guard.try_create_schedule(
            &fx.owner,
            &fx.alice,
            &fx.asset,
            &USDC,
            &(T0 + 10_000_000),
            &0,
            &1
        ),
        Err(Ok(Error::TooManySchedules))
    );

    // A completely unrelated owner is unaffected.
    let owner_b = Address::generate(&env);
    StellarAssetClient::new(&env, &fx.asset).mint(&owner_b, &(100 * USDC));
    fx.token
        .approve(&owner_b, &fx.guard_id, &(100 * USDC), &500_000);
    fx.guard.set_rule(&owner_b, &rule(&env, &fx.asset, false));
    let b_id = fx
        .guard
        .create_schedule(&owner_b, &fx.bob, &fx.asset, &(2 * USDC), &T0, &0, &1);
    assert_eq!(fx.guard.list_schedules(&owner_b).len(), 1);

    // ...and B's schedule still runs while A is at its cap.
    fx.guard.execute_schedule(&b_id);
    assert_eq!(fx.token.balance(&fx.bob), 2 * USDC);

    // Cancelling one of A's frees exactly one slot.
    let freed = fx.guard.list_schedules(&fx.owner).first().unwrap().id;
    fx.guard.cancel_schedule(&fx.owner, &freed);
    fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &USDC,
        &(T0 + 10_000_000),
        &0,
        &1,
    );
    assert_eq!(fx.guard.list_schedules(&fx.owner).len(), 25);
}

// ---------------------------------------------------------------------------
// Multi-tenancy — nothing leaks between two owners
// ---------------------------------------------------------------------------

#[test]
fn two_owners_are_fully_isolated() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);

    let a = fx.owner.clone();
    let b = Address::generate(&env);
    let exec_b = Address::generate(&env);
    StellarAssetClient::new(&env, &fx.asset).mint(&b, &(1_000 * USDC));
    fx.token
        .approve(&b, &fx.guard_id, &(1_000 * USDC), &500_000);

    // Different rules.
    configure(&fx, &env, false); // A: auto 10 / per-tx 50 / daily 200
    let mut rule_b = rule(&env, &fx.asset, false);
    rule_b.auto_approve_limit = USDC;
    rule_b.per_tx_limit = 2 * USDC;
    rule_b.daily_limit = 4 * USDC;
    fx.guard.set_rule(&b, &rule_b);
    fx.guard.set_executor(&b, &exec_b);

    assert_eq!(fx.guard.get_rule(&a).unwrap().per_tx_limit, 50 * USDC);
    assert_eq!(fx.guard.get_rule(&b).unwrap().per_tx_limit, 2 * USDC);

    // Executors are bound to their own owner in BOTH directions.
    assert_eq!(fx.guard.get_executor(&a), Some(fx.executor.clone()));
    assert_eq!(fx.guard.get_executor(&b), Some(exec_b.clone()));
    assert_eq!(
        fx.guard
            .try_pay_executor(&fx.executor, &b, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NotExecutor)),
        "A's agent must not be able to spend B's money"
    );
    assert_eq!(
        fx.guard
            .try_pay_executor(&exec_b, &a, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::NotExecutor)),
        "B's agent must not be able to spend A's money"
    );

    // B's tighter rule binds B without touching A.
    assert_eq!(
        fx.guard
            .try_pay_executor(&exec_b, &b, &fx.alice, &fx.asset, &(3 * USDC)),
        Err(Ok(Error::OverPerTxLimit))
    );
    fx.guard
        .pay_executor(&fx.executor, &a, &fx.alice, &fx.asset, &(3 * USDC));

    // Spend counters are per owner.
    assert_eq!(fx.guard.spent_today(&a), 3 * USDC);
    assert_eq!(fx.guard.spent_today(&b), 0);
    fx.guard
        .pay_executor(&exec_b, &b, &fx.alice, &fx.asset, &USDC);
    assert_eq!(fx.guard.spent_today(&a), 3 * USDC);
    assert_eq!(fx.guard.spent_today(&b), USDC);

    // Exhausting B's daily budget leaves A free to keep paying.
    fx.guard.pay_owner(&b, &fx.alice, &fx.asset, &(2 * USDC));
    fx.guard.pay_owner(&b, &fx.alice, &fx.asset, &USDC);
    assert_eq!(fx.guard.spent_today(&b), 4 * USDC);
    assert_eq!(
        fx.guard.try_pay_owner(&b, &fx.alice, &fx.asset, &USDC),
        Err(Ok(Error::OverDailyLimit))
    );
    fx.guard.pay_owner(&a, &fx.alice, &fx.asset, &(10 * USDC));

    // Alias books are separate.
    let ada = String::from_str(&env, "ada");
    fx.guard.set_alias(&a, &ada, &fx.alice);
    assert_eq!(fx.guard.get_alias(&a, &ada), Some(fx.alice.clone()));
    assert_eq!(fx.guard.get_alias(&b, &ada), None);
    assert!(fx.guard.is_known_recipient(&a, &fx.alice));
    assert!(!fx.guard.is_known_recipient(&b, &fx.alice));

    // Schedules are listed per owner, and only their owner may cancel them.
    let a_id = fx
        .guard
        .create_schedule(&a, &fx.alice, &fx.asset, &USDC, &(T0 + 500), &0, &1);
    let b_id = fx
        .guard
        .create_schedule(&b, &fx.bob, &fx.asset, &USDC, &(T0 + 500), &0, &1);
    assert_eq!(fx.guard.list_schedules(&a).len(), 1);
    assert_eq!(fx.guard.list_schedules(&b).len(), 1);
    assert_eq!(fx.guard.list_schedules(&a).first().unwrap().id, a_id);
    assert_eq!(
        fx.guard.try_cancel_schedule(&a, &b_id),
        Err(Ok(Error::NotScheduleOwner))
    );
    assert_eq!(
        fx.guard.try_cancel_schedule(&b, &a_id),
        Err(Ok(Error::NotScheduleOwner))
    );

    // A revoking its executor does not disarm B's.
    fx.guard.revoke_executor(&a);
    assert_eq!(fx.guard.get_executor(&a), None);
    assert_eq!(fx.guard.get_executor(&b), Some(exec_b));
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

#[test]
fn list_due_paginates_and_bounds_its_scan() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // Empty id space: nothing to scan, and the cursor says "done".
    assert_eq!(fx.guard.next_schedule_id(), 1);
    assert_eq!(fx.guard.list_due(&0, &10), (Vec::from_array(&env, []), 0));

    // Ten due schedules, ids 1..=10.
    for _ in 0..10 {
        fx.guard
            .create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &0, &1);
    }
    assert_eq!(fx.guard.next_schedule_id(), 11);

    // A window of 4 returns the first four and a cursor pointing at id 5.
    let (page1, c1) = fx.guard.list_due(&0, &4);
    assert_eq!(page1, Vec::from_array(&env, [1, 2, 3, 4]));
    assert_eq!(c1, 5);

    let (page2, c2) = fx.guard.list_due(&c1, &4);
    assert_eq!(page2, Vec::from_array(&env, [5, 6, 7, 8]));
    assert_eq!(c2, 9);

    // The last page ends the sweep: cursor 0.
    let (page3, c3) = fx.guard.list_due(&c2, &4);
    assert_eq!(page3, Vec::from_array(&env, [9, 10]));
    assert_eq!(c3, 0);

    // A zero limit scans nothing; a cursor past the end is immediately done.
    assert_eq!(fx.guard.list_due(&0, &0), (Vec::from_array(&env, []), 0));
    assert_eq!(fx.guard.list_due(&99, &10), (Vec::from_array(&env, []), 0));

    // An oversized limit is clamped to MAX_DUE_SCAN rather than rejected, and
    // still terminates because the scan stops at the end of the id space.
    let (all, cursor) = fx.guard.list_due(&0, &10_000);
    assert_eq!(all.len(), 10);
    assert_eq!(cursor, 0);
}

#[test]
fn list_due_skips_holes_and_undue_schedules() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let due1 = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &0, &1);
    let cancelled = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &0, &1);
    let later = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &USDC,
        &(T0 + 10_000),
        &0,
        &1,
    );
    let due2 = fx
        .guard
        .create_schedule(&fx.owner, &fx.alice, &fx.asset, &USDC, &T0, &0, &1);

    fx.guard.cancel_schedule(&fx.owner, &cancelled);

    // The cancelled id leaves a hole; the not-yet-due one is simply skipped.
    assert_eq!(
        fx.guard.list_due(&0, &10),
        (Vec::from_array(&env, [due1, due2]), 0)
    );
    // The hole still occupies an id, so the scan window walks over it.
    let (page, cursor) = fx.guard.list_due(&0, &2);
    assert_eq!(page, Vec::from_array(&env, [due1]));
    assert_eq!(cursor, 3);

    // Running a one-shot turns it into another hole.
    fx.guard.execute_schedule(&due1);
    assert_eq!(
        fx.guard.list_due(&0, &10),
        (Vec::from_array(&env, [due2]), 0)
    );

    // Once `later` comes due it appears without anything being re-indexed.
    env.ledger().set_timestamp(T0 + 10_000);
    assert_eq!(
        fx.guard.list_due(&0, &10),
        (Vec::from_array(&env, [later, due2]), 0)
    );
}

// ---------------------------------------------------------------------------
// Events — these are the keeper/UI ABI
// ---------------------------------------------------------------------------

/// Events published by the guard itself in the most recent invocation, with the
/// token's own events filtered out.
fn guard_events(env: &Env, guard_id: &Address) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
    env.events()
        .all()
        .filter_by_contract(guard_id)
        .events()
        .to_vec()
}

#[test]
fn paid_event_is_emitted_with_the_right_shape() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    fx.guard
        .pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &(5 * USDC));
    let expected = Paid {
        owner: fx.owner.clone(),
        to: fx.alice.clone(),
        asset: fx.asset.clone(),
        amount: 5 * USDC,
        via: Symbol::new(&env, "executor"),
    };
    assert_eq!(
        guard_events(&env, &fx.guard_id),
        std::vec![expected.to_xdr(&env, &fx.guard_id)]
    );

    // The owner path reports a different `via`, so the UI can tell them apart.
    fx.guard
        .pay_owner(&fx.owner, &fx.alice, &fx.asset, &(5 * USDC));
    let expected = Paid {
        owner: fx.owner.clone(),
        to: fx.alice.clone(),
        asset: fx.asset.clone(),
        amount: 5 * USDC,
        via: Symbol::new(&env, "owner"),
    };
    assert_eq!(
        guard_events(&env, &fx.guard_id),
        std::vec![expected.to_xdr(&env, &fx.guard_id)]
    );
}

#[test]
fn no_event_is_emitted_when_a_payment_is_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    let _ = fx
        .guard
        .try_pay_executor(&fx.executor, &fx.owner, &fx.alice, &fx.asset, &(25 * USDC));
    assert!(
        guard_events(&env, &fx.guard_id).is_empty(),
        "a rejected payment must not look like a settled one"
    );
}

#[test]
fn schedule_lifecycle_events_are_emitted() {
    let env = Env::default();
    env.mock_all_auths();
    let fx = setup(&env);
    configure(&fx, &env, false);

    // created
    let id = fx.guard.create_schedule(
        &fx.owner,
        &fx.alice,
        &fx.asset,
        &(2 * USDC),
        &T0,
        &3_600,
        &2,
    );
    let expected = ScheduleCreated {
        owner: fx.owner.clone(),
        id,
        to: fx.alice.clone(),
        asset: fx.asset.clone(),
        amount: 2 * USDC,
        next_run_at: T0,
        interval_secs: 3_600,
        runs: 2,
    };
    assert_eq!(
        guard_events(&env, &fx.guard_id),
        std::vec![expected.to_xdr(&env, &fx.guard_id)]
    );

    // run — Paid and ScheduleRun, in that order
    fx.guard.execute_schedule(&id);
    let paid = Paid {
        owner: fx.owner.clone(),
        to: fx.alice.clone(),
        asset: fx.asset.clone(),
        amount: 2 * USDC,
        via: Symbol::new(&env, "schedule"),
    };
    let run = ScheduleRun {
        owner: fx.owner.clone(),
        id,
        amount: 2 * USDC,
        next_run_at: T0 + 3_600,
        runs_left: 1,
        active: true,
    };
    assert_eq!(
        guard_events(&env, &fx.guard_id),
        std::vec![
            paid.to_xdr(&env, &fx.guard_id),
            run.to_xdr(&env, &fx.guard_id)
        ]
    );

    // cancelled
    fx.guard.cancel_schedule(&fx.owner, &id);
    let cancelled = ScheduleCancelled {
        owner: fx.owner.clone(),
        id,
    };
    assert_eq!(
        guard_events(&env, &fx.guard_id),
        std::vec![cancelled.to_xdr(&env, &fx.guard_id)]
    );
}
