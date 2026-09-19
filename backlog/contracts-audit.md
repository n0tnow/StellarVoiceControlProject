# Report: contracts-audit
- Date: 2026-09-19
- Worker/Agent: opencode-go/deepseek-v4.1-flash (L2)
- Branch/Worktree: audit/contracts-deepseek
- PR: none

## Verdict (3-6 lines)
**yes-with-caveats.** The on-chain part is functionally complete for a testnet demo: 38/38 unit tests pass, `cargo clippy -- -D warnings` is clean on both lib and `--all-targets`, and the local build of the current `lib.rs` reproduces the exact wasm sha256 (`c4f65e65…`, 23,787 bytes, 19 exported functions) recorded in `contracts/DEPLOYED.md`. The rule engine and scheduler have no Critical or High findings: auth, limits, alias refcounting and replay all hold under review, and the keeper's ABI (`list_due(cursor,limit)`, `get_schedule`, `execute_schedule`) matches the contract exactly. The caveats are product/liveness, not fund-safety: there is no global pause, no upgrade path, failed/refused schedules are retried indefinitely with no auto-deactivation, and schedule runs deliberately skip `known_recipients_only`. None of these blocks a supervised testnet demo.

## 1. Inventory (tables)

### Public contract functions (all in `contracts/polaris_guard/src/lib.rs`)
| Function | Args | Returns | Auth (`require_auth`) | Line |
|---|---|---|---|---|
| `set_rule` | `owner: Address, rule: Rule` | `Result<(), Error>` | `owner` | 326–333 |
| `get_rule` | `owner: Address` | `Option<Rule>` | none (read) | 335–337 |
| `set_executor` | `owner: Address, executor: Address` | `()` | `owner` | 341–346 |
| `revoke_executor` | `owner: Address` | `()` | `owner` | 351–354 |
| `get_executor` | `owner: Address` | `Option<Address>` | none (read) | 356–358 |
| `set_alias` | `owner: Address, alias: String, address: Address` | `()` | `owner` | 369–382 |
| `remove_alias` | `owner: Address, alias: String` | `()` | `owner` | 386–393 |
| `get_alias` | `owner: Address, alias: String` | `Option<Address>` | none (read) | 397–401 |
| `is_known_recipient` | `owner: Address, to: Address` | `bool` | none (read) | 405–407 |
| `pay_owner` | `owner, to, asset: Address, amount: i128` | `Result<(), Error>` | `owner` | 414–438 |
| `pay_executor` | `executor, owner, to, asset: Address, amount: i128` | `Result<(), Error>` | `executor` | 443–494 |
| `spent_today` | `owner: Address` | `i128` | none (read) | 502–504 |
| `create_schedule` | `owner, to, asset: Address, amount: i128, first_run_at: u64, interval_secs: u64, runs: u32` | `Result<u32, Error>` | `owner` | 516–593 |
| `cancel_schedule` | `owner: Address, id: u32` | `Result<(), Error>` | `owner` | 598–614 |
| `execute_schedule` | `id: u32` | `Result<(), Error>` | **none (by design)** | 639–714 |
| `get_schedule` | `id: u32` | `Option<Schedule>` | none (read) | 716–718 |
| `list_schedules` | `owner: Address` | `Vec<Schedule>` | none (read) | 722–739 |
| `next_schedule_id` | `()` | `u32` | none (read) | 743–748 |
| `list_due` | `cursor: u32, limit: u32` | `(Vec<u32>, u32)` | none (read) | 780–810 |

19 exported functions confirmed by `stellar contract build` (see §7).

### Storage keys (`enum DataKey`, lib.rs:231–256)
| Key | Kind | Written by | TTL policy |
|---|---|---|---|
| `Rule(Address)` | persistent | `set_rule`; TTL-bumped in `load_rule` | `bump()` 817–821; threshold 30·17280, extend-to 120·17280 (60–65) |
| `Executor(Address)` | persistent | `set_executor`; bumped in `pay_executor` | same |
| `Alias(Address, String)` | persistent | `set_alias`, removed by `remove_alias` | same |
| `Known(Address, Address)` | persistent | `ref_known` (on alias add); removed by `unref_known` | same (see F-04) |
| `KnownRefs(Address, Address)` | persistent | `ref_known`/`unref_known` | same |
| `Spent(Address)` | persistent | `record_spend` | same |
| `Schedule(u32)` | persistent | `create_schedule`/`cancel_schedule`/`execute_schedule` | same |
| `OwnerScheds(Address)` | persistent | `create_schedule`/`deindex`/active `execute_schedule` | same |
| `NextSchedId` | persistent | `create_schedule`; TTL-bumped by `execute_schedule` | same |

No temporary storage is used by the guard. All keys are `persistent`.

### Events (lib.rs:263–309)
| Event | Topics | Data | Emitted at |
|---|---|---|---|
| `Paid` | `owner`, `to` | `asset`, `amount`, `via` (`owner`/`executor`/`schedule`) | 429, 485, 696 |
| `ScheduleCreated` | `owner`, `id` | `to`, `asset`, `amount`, `next_run_at`, `interval_secs`, `runs` | 581 |
| `ScheduleRun` | `owner`, `id` | `amount`, `next_run_at`, `runs_left`, `active` | 704 |
| `ScheduleCancelled` | `owner`, `id` | — | 612 |

### Errors (`Error`, lib.rs:105–148): 17 variants, codes 100–116
`NotConfigured`=100, `InvalidAmount`=101, `InvalidRule`=102, `OverPerTxLimit`=103, `OverDailyLimit`=104, `NeedsOwnerApproval`=105, `AssetNotAllowed`=106, `NoExecutor`=107, `NotExecutor`=108, `ScheduleNotFound`=109, `ScheduleNotDue`=110, `ScheduleInactive`=111, `InvalidSchedule`=112, `NotScheduleOwner`=113, `TooManySchedules`=114, `Overflow`=115, `InsufficientAllowance`=116.

## 2. Build & test results (real command output summarised, counts)

Ran exactly the prescribed commands (with the shared target dir). Final lines:

```
test result: ok. 38 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.71s
```

`cargo clippy --manifest-path contracts/Cargo.toml -- -D warnings`:
```
Finished `dev` profile [unoptimized + debuginfo] target(s) in 14.99s
```
`cargo clippy --manifest-path contracts/Cargo.toml --all-targets -- -D warnings`:
```
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.59s
```
- Tests: **38 passed / 0 failed / 0 ignored** (plus 0 doc-tests).
- Clippy: **0 warnings** with `-D warnings`, for both lib and `--all-targets` (cleaner than the required `-D warnings`).
- No command failed or hung.
- `contracts/polaris_guard/test_snapshots/test/` holds 37 snapshots; the 38th test (`guard_error_codes_cannot_be_confused_with_token_error_codes`, test.rs:419) needs no ledger snapshot.

## 3. Findings

| ID | Severity | file:line | Description | Evidence | Suggested fix |
|---|---|---|---|---|---|
| F-01 | Medium | lib.rs:351–354, 598–614, 639 | No pause / emergency stop. `revoke_executor` does not stop schedules (schedules never touch the executor). To stop schedules the owner must cancel each one, or revoke the SAC allowance — which also disables `pay_owner`. | No global/per-owner pause flag in `DataKey` (231–256); `revoke_executor` only removes `Executor`; `execute_schedule` checks no pause. | Add an owner-controlled `paused` flag (per owner) checked in all three payment paths; document the kill-switch matrix. |
| F-02 | Medium | lib.rs:769–779, 780–810; stellar/src/keeper/keeper.ts:105, 153–185 | Global id space is never reused; any funded account can repeatedly create/cancel 25 schedules to grow `next_schedule_id`, raising every keeper's `list_due` sweep cost (cross-tenant griefing). | Full sweep = `ceil(next_schedule_id/limit)` read-only simulations (lib.rs:771–779; DEPLOYED.md:244–249). Cancel/exhaust leave holes. | Accepted tradeoff per review B1. Mitigate by remembering the lowest still-active id in the keeper, or a due-time-ordered index. Document as known. |
| F-03 | Low | lib.rs:651–654 | `execute_schedule` re-checks only hard caps + `allowed_assets`; it does **not** re-check `known_recipients_only`. Removing/re-pointing an alias does not stop an already-created schedule paying that address. | `execute_schedule` calls `check_asset` + `check_hard_caps` then `settle`; no `DataKey::Known` read. Intentional because `to` is owner-authored at create time. | Document explicitly; add a `Known` check + test only if alias removal is meant to stop schedules. |
| F-04 | Low | lib.rs:842–857, 369–382 | `Known` TTL can diverge from `KnownRefs`: when `refs > 1`, `unref_known` bumps only `KnownRefs`; the same-address `set_alias` branch (377) bumps neither. A long-untouched but still-aliased recipient's `Known` entry can archive independently, making it temporarily unknown (restore bill under Protocol 23). | lib.rs:848–856 (`else` bumps only `rkey`); lib.rs:377 (`Some(_) => {}`). | Bump both `Known` and `KnownRefs` on every alias touch. |
| F-05 | Low | lib.rs:1003–1006, 147 | The allowance pre-check catches only a revoked/undersized allowance (#116). An insufficient **balance** with sufficient allowance surfaces as the token's `#10 BalanceError`, not a guard-typed error, so the "typed error" contract is partial. | `settle` reads `allowance` only, then calls `transfer_from`; no balance read. | Document that token codes < 100 mean infrastructure/token state; the keeper already routes by range (errors.ts:142). |
| F-06 | Low | lib.rs:414–438, 994–1008 | `pay_owner` forwards an unvalidated `asset` address. A non-SEP-41 / malicious contract can make `Paid`/`spent_today` lie about value movement. Bounded because the owner signs, but the agent proposes parameters. | Documented (DEPLOYED.md:197–214; backlog/guard-rules-schedule.md M4). | Enforce client-side: resolve `asset` from the owner's allowlist; never pass an agent-supplied address. No contract change. |
| F-07 | Info | lib.rs:716, 743, 780 | Unauthenticated reads expose all schedule data and the global id count: `get_schedule(id)` returns `owner/to/asset/amount` for any id; `next_schedule_id`/`list_due` enumerate all tenants' due work. | No auth on these functions (by design). | Acceptable for a public testnet demo; note the privacy implication for mainnet. |
| F-08 | Info | lib.rs:868–870 vs 878–880 | `validate_rule`'s `allowed_assets.len() > MAX_ALLOWED_ASSETS (10)` check is unreachable: the `> 1` check below always fires first. `MAX_ALLOWED_ASSETS` is effectively dead documentation. | Both branches return `InvalidRule`; order 868 then 878. | Keep for when per-asset budgets lift the `> 1` restriction; merge comments to say so. |
| F-09 | Info | contracts/scripts/demo.sh:81 | Comment names `expiration_ledger` while the actual flag is `--live_until_ledger` (line 96). | `demo.sh:81` vs `demo.sh:96`; `DEPLOYED.md:140` has it right. | Fix the comment. |
| F-10 | Info | stellar/src/keeper/README.md:146 | Log example shows `{"name":"AllowanceMissing","code":5}`, but `TOKEN_ERRORS` maps code 5 → `SacAuthentication` and code 9 → `SacAllowanceError`. | errors.ts:102, 106. | Fix the example to `code 9`. |
| F-11 | Info | lib.rs (no `upgrade` entrypoint) | No upgrade path: a fix requires a new contract ID and every owner re-publishing rule + allowance. | DEPLOYED.md:25–28; backlog Unfinished. | Deliberate for the milestone. If upgradeability is wanted, add it before users configure rules, with a storage schema version. |
| F-12 | Low | lib.rs:639–714; stellar/src/keeper/errors.ts:199–206 | A schedule whose run can never succeed (allowance permanently revoked, rule tightened, payee trustline missing) stays `active` forever and is re-simulated on a capped backoff (max 1 h) indefinitely. No on-chain failure counter / auto-deactivation. | Contract never marks a schedule failed; keeper BACKOFF `allowance_missing`/`rule_violated` max 60 min. | Owner can cancel manually (exists). Optionally add a `fail_count`/expiry; low priority — simulation failures cost no fee. |

No Critical or High findings were identified.

## 4. Security checklist (PASS/FAIL/UNVERIFIED per item from step 3)

| # | Check | Result | Evidence / note |
|---|---|---|---|
| 1 | Every state-changing fn auths the right actor | **PASS** | `set_rule` 327, `set_executor` 342, `revoke_executor` 352, `set_alias` 370, `remove_alias` 387, `pay_owner` 421, `pay_executor` 451, `create_schedule` 526, `cancel_schedule` 599; `execute_schedule` auth-free by design (639). |
| 2 | No function callable by anyone that should not be | **PASS** | Only unauth write is `execute_schedule`, constrained to stored, due, active schedules (`to`/`amount`/`asset` from storage, 649–695). |
| 3 | Integer overflow/underflow/division, i128, negative/zero | **PASS** | `checked_add`/`checked_mul`/`checked_sub` 555, 660, 667–673, 924, 950; `amount <= 0` rejected 527, 917; `interval_secs == 0` handled 661; `now - next_run_at` is safe because `now < next_run_at` is rejected first (645–647). |
| 4 | Spending limits / daily caps bypass (split, alias, window, rollover) | **PASS** | One per-owner `Spent` counter (942–962); per-tx + daily on all paths (`check_hard_caps` 916–930); schedule re-checks 654; stale day reads as 0 (943) and test `daily_limit_accumulates_and_rolls_over`. |
| 5 | `known_recipients_only` + `set_alias` cannot pay unapproved destination | **PASS** | Refcounted `Known` (369–382, 824–857); tests `repointing_an_alias_un_marks_the_old_address`, `an_address_stays_known_while_another_alias_points_at_it`; only owner can add aliases (370). See F-03 for schedules (intended). |
| 6 | Schedule executes twice for one period (replay) | **PASS** | Due check 645–647; state advanced before settle 660–674; tests `recurring_schedule_advances_and_cannot_run_twice_in_a_period`, `missed_runs_are_skipped_not_replayed`. |
| 7 | `execute`/`trigger` front-run or griefed | **PASS** | Front-running a due schedule is benign (same single payment). Effects-before-interaction; shared `NextSchedId` contention is a bounded rent bump (687–692). |
| 8 | Token transfer fails mid-run | **PASS** | Effects are committed before `settle` but the whole host invocation rolls back on a token error (Soroban atomicity); schedule remains active/due (656–695). Retry policy is F-12. |
| 9 | Failed runs retried forever | **FAIL (design)** | No max-failure deactivation; keeper backoff caps at 1 h (errors.ts:203–206) and loops forever. Severity Low (simulation failures spend no fee). |
| 10a | Owner can always cancel | **PASS** | `cancel_schedule` owner-auth + ownership check (599–606); test `cancel_stops_a_schedule`. |
| 10b | Anyone else can cancel | **PASS** | `NotScheduleOwner` (602); test 773–778; cross-tenant test 1135–1142. |
| 10c | Global pause / emergency stop | **FAIL (missing)** | F-01. |
| 11 | Storage TTL/rent cannot silently break an active rule/schedule | **PASS (with note)** | All keys use `bump()` (817–821) with threshold/extend-to 60–65; active-run path extends `OwnerScheds` + `NextSchedId` (678–692; test `execute_schedule_extends_the_index_and_id_counter_ttl`). `Known` asymmetry is F-04. On-chain Protocol-23 auto-restore is **UNVERIFIED** (no network in this task). |
| 12 | Unbounded list / per-call loop (DoS / budget) | **PASS** | `list_due` scans ≤ `MAX_DUE_SCAN=100` (784–794); `list_schedules` bounded by `MAX_ACTIVE_PER_OWNER=25` (546); payment paths do not loop over user-length input. |
| 13 | No upgrade path — implications | **PASS as documented** | No `upgrade`; deployed ID final, fixes need redeploy + owner reconfiguration (DEPLOYED.md:25–28). Info F-11. |
| 14a | Cross-contract reentrancy | **PASS** | Only external call is `settle` after all state effects (656–695); a reentrant `execute_schedule` sees advanced `next_run_at`/`active=false` and is rejected. |
| 14b | Cross-contract return-value handling | **PARTIAL** | `transfer_from` return ignored (1006); `Paid` is not proof of movement for a lying token — documented for `pay_owner` (F-06). |
| 15 | Panics vs typed errors on user input | **PASS** | No `unwrap()/expect()/panic!/unreachable!` in non-test `lib.rs`; arithmetic uses `checked_*` → `Error::Overflow`; storage misses use `.ok_or(...)`. |

## 5. Spec vs implementation

Sources compared: `backlog/guard-rules-schedule.md`, `backlog/keeper.md`, `notes.md`, `sprints.md`, `docs/reports/` (the two research reports only mention the guard conceptually), `contracts/DEPLOYED.md`.

### (a) Promised and implemented
- Multi-tenant rule engine: `auto_approve_limit` / `per_tx_limit` / `daily_limit` / `allowed_assets` / `known_recipients_only`, validated on write (`validate_rule` 859–882).
- Three payment paths with the documented powers: owner (hard caps only), executor (full rule), schedule (hard caps + asset, no `auto_approve_limit`).
- Alias book: `set_alias` / `remove_alias` / `get_alias` / `is_known_recipient`, with the G1 refcount fix.
- Scheduler: create / cancel / execute / get / list / list_due / next_schedule_id, with skip-don't-catch-up semantics.
- Rolling UTC-day `DaySpend` counter, stale reads as zero.
- SEP-41 `transfer_from(spender=guard)` settlement, no custody; allowance as the off-chain kill switch.
- Typed error block starting at 100; `#[contractevent]` events for every settlement and schedule transition.
- TTL bumps on write; checked arithmetic; checks-effects-interactions ordering.
- Per-owner cap of 25 active schedules and paginated `list_due` (scan-bounded), i.e. the review B1/M1 redesign.
- Error-code table, `DEPLOYED.md`, `scripts/demo.sh` + `demo.env`.

### (b) Promised but MISSING or partial
- **Per-asset daily budgets** `Spent(owner, asset)`: deferred; until then `set_rule` rejects >1 asset (878–880).
- **Per-day transaction-count / velocity cap** (review M2): deferred; `daily_limit` remains the only count proxy (`DEPLOYED.md:180–195`).
- **Explicit pause / emergency stop** (Raven checklist): deferred — F-01.
- **Upgrade path**: deliberately absent — F-11.
- **`ScheduleRun.next_run_at` is stale on the final run** (review m5): deferred; `active:false` disambiguates.
- **Fuzz / property tests**: none.
- **README / `docs/architecture.md` still describe the skeleton** (per backlog/guard-rules-schedule.md); out of this worker's scope. `sprints.md:79` still shows the old one-line guard description unchecked.

### (c) Implemented but undocumented (outside code comments)
- `KnownRefs` refcount storage key is described in `lib.rs` comments but not in the `DEPLOYED.md` storage/ABI prose.
- `MAX_ALLOWED_ASSETS = 10` check is dead code while the `>1` rule holds (F-08).
- `settle`'s extra allowance read (cost + rationale) is only in code comments / DEPLOYED.md; not in the ABI brief.
- `execute_schedule` silently skipping `known_recipients_only` is implied ("hard caps + allowed_assets") but not stated as a product promise.

## 6. Missing tests (concrete cases)

1. **`known_recipients_only=true` + `create_schedule` to an unknown recipient.** Input: rule with `known=true`, no alias for `alice`; `create_schedule(owner, alice, asset, 1, T0, 0, 1)`. Current expected result: succeeds (schedule ignores the known check); then `execute_schedule` settles. No test documents this deliberate behaviour (F-03).
2. **`create_schedule` with an asset not in `allowed_assets`.** Input: rule allows only `A`; `create_schedule(owner, alice, B, 1, T0, 0, 1)` → expect `Err(AssetNotAllowed)` (only executor/execute paths are tested today).
3. **Foreign signature on `set_executor` / `revoke_executor` / `set_alias` / `remove_alias` / `cancel_schedule`.** Only `set_rule` is covered by `owner_functions_reject_a_foreign_signature` (test.rs:899). Add `mock_auths` per function → expect auth failure and unchanged state.
4. **Insufficient owner balance with sufficient allowance during a schedule run.** Input: allowance ≥ amount, balance < amount; `execute_schedule` → SAC `#10 BalanceError`, no `Paid`, schedule still active and due.
5. **i128 overflow on the daily counter.** Input: rule `daily_limit` near `i128::MAX`, spend counter near max, then one more payment → expect `Err(Overflow)` (#115), not panic.
6. **u64 overflow on schedule advance.** Input: `first_run_at` near `u64::MAX` with a small interval, then `execute_schedule` → expect `Err(Overflow)` (#115).
7. **`list_due` clamp with >100 ids.** Input: create 150 one-shot schedules; `list_due(0, 200)` → returns ≤100 ids and `next_cursor == 101` (existing test uses only 10 ids).
8. **Rule removed after schedule creation.** Input: create schedule, then there is no way to remove a rule, but a `NotConfigured` path exists if `Rule` is absent; assert `execute_schedule` → `Err(NotConfigured)` for a schedule whose owner never had a rule (currently impossible to create, so this is defensive).
9. **Allowance exactly equal to amount.** Input: approve exactly the payment amount; `pay_executor` → succeeds (boundary of the `<` check at lib.rs:1003).
10. **`set_alias` idempotence + refcount.** Input: `set_alias(owner,"ada",X)` twice, then `remove_alias("ada")` → `is_known_recipient(owner,X) == false` (guards the refcount against an accidental double increment).
11. **`revoke_executor` does not stop schedules.** Input: register executor, create due schedule, revoke executor, then keeper `execute_schedule` → still settles (documents the kill-switch boundary).

## 7. Deployment & keeper-ABI consistency

### DEPLOYED.md vs current `lib.rs`
| Item | DEPLOYED.md | Audit result |
|---|---|---|
| Contract ID | `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` (line 11) | Matches `scripts/demo.env:5` — **consistent**. |
| Wasm size | 23,787 bytes | Local build of current `lib.rs` = **23,787 bytes** — **consistent**. |
| Wasm sha256 | `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6` (line 15) | `stellar contract build` reproduced the **exact same hash** — **consistent**. (The claim that *chain* code re-hashes to it is **UNVERIFIED** — no network calls.) |
| ABI | "same 19 functions, 3 types, 4 events, 100–116 errors" | `stellar contract build`: "Exported Functions: 19 found" listing exactly the `pub fn`s in §1; 4 events (263–309); error block 100–116 — **consistent**. |
| Deprecated bug #1 (`set_alias` left old destination known) | line 22 | **Fixed** in current `lib.rs`: refcounted `Known`/`KnownRefs` (369–382, 824–857); regression tests present. |
| Deprecated bug #2 (run did not extend `OwnerScheds`/`NextSchedId` TTL) | lines 22, 254–261 | **Fixed** (678–692); test `execute_schedule_extends_the_index_and_id_counter_ttl` (test.rs:706). |
| Deprecated IDs `CDIWQTYA…`, `CB5CQHV6…` | lines 22–23 | Descriptions match the reported history; their on-chain code is **UNVERIFIED** (no network). |
| `scripts/demo.sh` calls | — | Uses `set_rule`, `set_executor`, `pay_executor`, `pay_owner`, `create_schedule`, `execute_schedule`, `list_due`, `spent_today`, `get_schedule`, SAC `approve`/`balance` — all exist with matching arg order. One comment bug F-09. |

### Keeper `<->` contract ABI (`stellar/src/keeper/**`) vs `lib.rs`
| Contract call | lib.rs | Keeper | Result |
|---|---|---|---|
| `list_due(cursor: u32, limit: u32) -> (Vec<u32>, u32)` | 780 | `chain.ts:143–159` (decodes tuple, maps `0`→`null`) | **Match** |
| `get_schedule(id: u32) -> Option<Schedule>` | 716 | `chain.ts:162–165` (null for `None`); `Schedule` fields `id, owner, to, asset, amount, next_run_at, interval_secs, runs_left, active` (`chain.ts:43–53`) | **Match** (field names/order match `lib.rs:187–198`) |
| `execute_schedule(id: u32)` | 639 | `chain.ts:247`; no auth expected, one run per call | **Match** |
| Error codes 100–116 | 105–148 | `errors.ts:65–83` maps all 17 names/kinds | **Match** (drift test exists per keeper.md) |
| Events | `Paid`, `ScheduleRun`, `ScheduleCreated`, `ScheduleCancelled` | Keeper does not consume guard events (only diagnostic error events) | **No mismatch** |

**Mismatches found: none.** Documentation-only inconsistency: `stellar/src/keeper/README.md:146` example error code (F-10).

## 8. Unfinished / handed-off work (what is NOT done)
- Per-asset daily budgets (`Spent(owner, asset)`), so >1 allowed asset stays rejected.
- Per-day transaction-count / velocity cap (review M2).
- Explicit pause / emergency stop on the contract (F-01).
- Upgrade path (deliberately absent; would require a schema version).
- Keeper sweep-cost scaling with ids ever created (F-02); optional lowest-active-id cursor.
- `ScheduleRun.next_run_at` stale on final run (m5).
- Failed schedules are retried indefinitely (F-12); no auto-deactivation.
- No fuzz/property tests.
- README / `docs/architecture.md` still describe the skeleton; `sprints.md:79` guard line still unchecked.
- Keeper tests could not be executed here (`stellar/node_modules` absent; `npm install` needs network). The keeper ABI check in §7 is by reading the source.

## 9. Suggested next steps (ordered, max 8)
1. Fix the doc-only issues: F-09 (`demo.sh:81`) and F-10 (keeper README example); bump both `Known`/`KnownRefs` TTLs on every alias touch (F-04).
2. Add the missing security tests from §6 — at minimum #1 (schedule + `known_recipients_only`), #2 (`create_schedule` disallowed asset), #3 (foreign signatures on all owner functions), #5/#6 (overflow).
3. Decide and document the kill-switch boundary: `revoke_executor` does not stop schedules (test #11), and adding a per-owner pause (F-01).
4. Set `GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` wherever the keeper runs, and wire `npm test -w @polaris/stellar` into `scripts/check.sh` (from backlog/keeper.md).
5. Refresh `README.md` and `docs/architecture.md` to the real guard, and tick/adjust `sprints.md:79`.
6. Accept-and-record F-02 and F-12 as known testnet-demo limitations; revisit if the keeper becomes production-facing.
7. If time allows post-milestone, land per-asset `Spent(owner, asset)` and the per-day count cap (spec gaps).
8. Keep the no-upgrade decision explicit in release notes (contract ID is final for the milestone).
