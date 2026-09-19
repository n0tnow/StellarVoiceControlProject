//! Polaris guard — on-chain spending policy + alias book.
//!
//! Skeleton status (Milestone 2 / early Milestone 3): storage layout, owner auth
//! and the per-transaction limit are in place and tested. TODO(B) for the rest:
//!
//! * daily / rolling spending counter (needs ledger timestamps),
//! * typed errors via `contracterror` instead of `assert!`,
//! * guarded payment that calls the SEP-41 token contract,
//! * alias management for the voice layer ("send 10 USDC to ada").
#![no_std]

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, String};

/// Persistent storage keys. Aliases deliberately use their own variant so the
/// alias book can grow without touching the policy entry.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Limit,
    Alias(String),
}

#[contract]
pub struct PolarisGuard;

#[contractimpl]
impl PolarisGuard {
    /// One-time setup. Stores the owner address that must sign every policy change.
    pub fn init(env: Env, owner: Address) {
        if env.storage().persistent().has(&DataKey::Owner) {
            panic!("already initialized");
        }
        env.storage().persistent().set(&DataKey::Owner, &owner);
    }

    /// The address allowed to change policy or alias entries.
    pub fn owner(env: Env) -> Address {
        env.storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("not initialized")
    }

    /// Per-transaction spending limit, in the asset's smallest unit.
    /// Requires the owner's authorization.
    pub fn set_limit(env: Env, limit: i128) {
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();
        assert!(limit > 0, "limit must be positive");
        env.storage().persistent().set(&DataKey::Limit, &limit);
    }

    /// Current per-transaction limit (0 when unset).
    pub fn limit(env: Env) -> i128 {
        env.storage().persistent().get(&DataKey::Limit).unwrap_or(0)
    }

    /// Registers a spoken alias ("ada") to an address. Requires owner auth.
    pub fn set_alias(env: Env, alias: String, address: Address) {
        let owner: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Owner)
            .expect("not initialized");
        owner.require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Alias(alias), &address);
    }

    /// Resolves a spoken alias; `None` when unknown, so the app can ask again
    /// instead of sending funds to the wrong place.
    pub fn resolve_alias(env: Env, alias: String) -> Option<Address> {
        env.storage().persistent().get(&DataKey::Alias(alias))
    }

    /// Skeleton policy check: a single amount against the per-transaction limit.
    /// TODO(B): add the rolling daily counter and call the token contract.
    pub fn check_amount(env: Env, amount: i128) -> bool {
        let limit: i128 = env.storage().persistent().get(&DataKey::Limit).unwrap_or(0);
        amount > 0 && (limit == 0 || amount <= limit)
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    fn setup(env: &Env) -> (PolarisGuardClient<'_>, Address) {
        let contract_id = env.register(PolarisGuard, ());
        let client = PolarisGuardClient::new(env, &contract_id);
        let owner = Address::generate(env);
        client.init(&owner);
        (client, owner)
    }

    #[test]
    fn owner_is_stored() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, owner) = setup(&env);
        assert_eq!(client.owner(), owner);
    }

    #[test]
    fn limit_gates_amounts() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _owner) = setup(&env);
        assert!(client.check_amount(&10)); // no limit set -> only positivity
        client.set_limit(&1_000_000);
        assert_eq!(client.limit(), 1_000_000);
        assert!(client.check_amount(&1_000_000));
        assert!(!client.check_amount(&1_000_001));
        assert!(!client.check_amount(&0));
    }

    #[test]
    fn alias_resolves() {
        let env = Env::default();
        env.mock_all_auths();
        let (client, _owner) = setup(&env);
        let target = Address::generate(&env);
        let alias = String::from_str(&env, "ada");
        assert_eq!(client.resolve_alias(&alias), None);
        client.set_alias(&alias, &target);
        assert_eq!(client.resolve_alias(&alias), Some(target));
    }
}
