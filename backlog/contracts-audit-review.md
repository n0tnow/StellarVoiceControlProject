# Review: contracts-audit
- Date: 2026-09-19
- Reviewer: opencode-go/deepseek-v4.1-flash (L4, independent session)
- Reviewed: backlog/contracts-audit.md (branch audit/contracts-deepseek)
- Review branch/worktree: `audit/contracts-review` @ `.worktrees/contracts-audit-review`

## Verdict: **accept with corrections**

Every material claim I could test reproduced exactly: 38/38 contract tests, a
clean `clippy --all-targets -- -D warnings`, the wasm sha256 **rebuilt from the
current `lib.rs`** (`stellar contract build`), and the keeper suite the audit
could not run (67/67 keeper + 111/111 anchor, exit 0). All 12 findings
(F-01…F-12), the line references and the ABI/error tables check out against the
source; I could not refute any of them. Corrections are limited to (a) one
limitation in the report that is now false (keeper tests could not run) and
(b) three new Info-level observations in §3. No factual error was found in the
report itself.

## 1. Numbers I re-ran (real output)

Commands were run from the worktree with the shared target dir, as prescribed.

**Contract tests** — `cargo test --manifest-path contracts/Cargo.toml`:
```
test result: ok. 38 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.70s

Doc-tests polaris_guard
running 0 tests
test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```
→ **38 passed / 0 failed / 0 ignored** (plus 0 doc-tests). Matches the audit.
`grep -c '#\[test\]' test.rs` = 38; `ls test_snapshots/test | wc -l` = 37, so the
"37 snapshots + 1 snapshot-free test" claim is correct.

**Clippy** — `cargo clippy --manifest-path contracts/Cargo.toml --all-targets -- -D warnings`:
```
Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.56s
```
→ **0 warnings** with `-D warnings`; exit 0.

**Wasm hash / size** — `shasum -a 256 …/wasm32v1-none/release/polaris_guard.wasm`:
```
c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6  …/polaris_guard.wasm
```
→ matches `DEPLOYED.md:15` exactly; file size `23,787` bytes (`-rw-r--r-- … 23787`),
matching `DEPLOYED.md:14`. I did **not** trust the cached artifact: I re-ran
`CARGO_TARGET_DIR=…/contracts/target stellar contract build` on the current
source, it printed "✅ Build Complete" with the 19 exported functions, and the
re-hashed wasm was again `c4f65e65…` — so **current `lib.rs` → this hash** is
confirmed, not just "the file on disk happens to have this hash".

**Keeper tests** (the audit's §8 said these could not run) — with the permitted
`node_modules` symlink, `npm test -w @polaris/stellar`:
```
ℹ tests 67
ℹ pass 67
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0

 Test Files  5 passed (5)
      Tests  111 passed (111)
```
`EXIT: 0` → **67/67 node:test keeper tests + 111/111 vitest anchor tests pass.**
This also executes the `GUARD_ERRORS` drift guard in `errors.test.ts:156–172`
against the real `lib.rs`, so the audit's §7 ABI/error-code claim is now backed
by a passing test rather than by reading alone.

Scope hygiene: the `node_modules` symlink is **not** covered by this repo's
`.gitignore` (`node_modules/` with a trailing slash does not match a symlink),
so it appeared as untracked. I removed it after the run; `git status --short`
shows only this review file.

## 2. Claim check table

| ID | Claim (abridged) | Verdict | Evidence (file:line) |
|---|---|---|---|
| C1 | `execute_schedule` has no `require_auth` and pays only `to/amount/asset` from storage | **CONFIRMED** | `lib.rs:639` signature has no auth call; the only caller input is `id` used at `lib.rs:640` `load_schedule(&env, id)`; `settle` at `lib.rs:695` passes `schedule.to`/`schedule.asset`/`schedule.amount` (698–700). No caller-supplied destination/amount reaches `transfer_from`. |
| C2 | `execute_schedule` does not re-check `known_recipients_only`; severity Low; only owner can create/change a schedule | **CONFIRMED** | `lib.rs:651–654` applies only `check_asset` + `check_hard_caps`; there is no `DataKey::Known` read in `639–714`. `create_schedule`/`cancel_schedule` are `owner.require_auth()` (`526`, `599`) and there is **no** function that mutates an existing `Schedule`'s `to/amount/asset`, so an executor can never create or alter one → Low is defensible (owner-authored recipient); the only effect is that removing/re-pointing an alias does not stop an existing schedule, which the owner must cancel. |
| C3 | `revoke_executor` does not stop schedules; no pause flag | **CONFIRMED** | `lib.rs:351–354` only `remove(&DataKey::Executor(owner))`; `DataKey` (`231–256`) contains no pause variant; `execute_schedule` (`639–714`) reads no pause. Worst case: revoking the SAC allowance is the only kill switch and it also disables `pay_owner`. |
| C4 | state is written before the token transfer; a failed transfer rolls back the whole invocation | **CONFIRMED** | Effects first: `record_spend` `lib.rs:657`, state advance `660–674`, `set(Schedule)` `675–677`; interaction last: `settle` `695`. `settle` uses `?` (`1006`) and is the only `transfer_from`; a host error aborts the invocation and Soroban rolls back storage. `test.rs:406–416` shows `spent_today == 0` and balance `0` after a failed settle. |
| C5 | `set_alias` refcount (`Known`/`KnownRefs`) fixes the "old address stays known" bug | **CONFIRMED** | `set_alias` `lib.rs:369–382`: re-point → `unref_known(old); ref_known(new)` (`373–375`); same name→same address → `Some(_) => {}` (`377`) so the count is not double-incremented; new alias → `ref_known` (`378`). `ref_known` `824–837` sets `Known` and `refs+1`; `unref_known` `842–857` drops `Known` only when `refs <= 1`. Re-point/remove/set-twice all behave correctly; tests `test.rs:267`, `test.rs:302`. No bug found. |
| C6 | `pay_owner`, `pay_executor` and schedules share one `Spent` counter; no spend path skips the limit check | **CONFIRMED** | Single `DataKey::Spent(Address)` (`lib.rs:242`). Every path does `check_hard_caps` then `record_spend`: `423`/`427`, `469`/`483`, `654`/`657`. `settle` is private (`994`) and called only at `428`, `484`, `695`, all after the checks. No unchecked `transfer_from`. |
| C7 | `list_due` scan bound and `create_schedule` per-owner cap of 25 | **CONFIRMED** | `MAX_DUE_SCAN=100` `lib.rs:80`, clamp/bound `784–788`, loop `797` with `end = min(start+window, end_of_space)` `794`. `MAX_ACTIVE_PER_OWNER=25` `lib.rs:76`, enforced `546`. |
| C8 | no `unwrap()/expect()/panic!` in non-test code | **CONFIRMED** | `grep -nE '\.unwrap\(\)\|\.expect(\|panic!\|unreachable!\|todo!\|unimplemented!\|assert!' lib.rs` → **NONE** (only `unwrap_or`/`unwrap_or(…)` fallbacks, which do not panic). |
| C9 | keeper↔contract ABI, including `Schedule` field names and error-code table | **CONFIRMED** | `listDue` `chain.ts:143–159` (tuple decode + `0`→`null` at `158`); `getSchedule` `162–165`; `Schedule` interface `chain.ts:43–53` = `id, owner, to, asset, amount, next_run_at, interval_secs, runs_left, active`, identical to `lib.rs:187–198`; `execute_schedule` call `chain.ts:247`; `GUARD_ERRORS` `errors.ts:65–83` covers 100–116 and range-routes at `errors.ts:142`; drift test `errors.test.ts:156–172` passes in the 67/67 keeper run. **No mismatch.** |

## 3. New findings the audit missed

No new Critical/High issues. I did not find a way to move funds outside a path
the audit already flags. Three genuine, minor omissions — all Info:

| ID | Severity | file:line | Finding | Evidence |
|---|---|---|---|---|
| N-01 | Info | `lib.rs:789–791` | `list_due(cursor, 0)` returns `([], 0)`, which is byte-for-byte the same signal as "reached the end of the id space". A caller that passes `limit=0` (or a future keeper default of 0) would conclude its sweep is complete although nothing was scanned. The current keeper always requests `>= 1` (`keeper.ts:138`), so it is latent. | `window == 0` short-circuits `return (out, 0)` at `789–791`; the end-of-space return is also `0` at `808`. |
| N-02 | Info | `lib.rs:326–393` | Policy and alias mutations (`set_rule`, `set_executor`, `revoke_executor`, `set_alias`, `remove_alias`) emit **no** events. Off-chain monitoring of "who changed the rule/allowlist and when" is only possible by diffing persistent storage; only settlements and schedule transitions are evented. Consistent with the spec's "every settlement and schedule transition", but worth stating for indexers/mainnet. | Event structs are only `Paid`, `ScheduleCreated`, `ScheduleRun`, `ScheduleCancelled` (`lib.rs:263–309`); none of the mutators at `326–393` call `.publish`. |
| N-03 | Info | `lib.rs:650`, `896` | On the keeper's unauthenticated path, `execute_schedule` calls `load_rule`, which **bumps the owner's `Rule` TTL** (`896`), in addition to `Schedule` (`677`), `OwnerScheds` (`685`/`976`) and `NextSchedId` (`692`). `DEPLOYED.md:254–261` documents the schedule/index/counter TTL hygiene but not the rule entry, so the untrusted keeper silently pays to keep a third party's rule alive (bounded at ~120 days). Not fund-safety; a documentation/rent-transfer nuance. | `load_rule` calls `bump(env, &key)` at `lib.rs:896`; called from `execute_schedule` at `650`. |

I explicitly checked for and found **no** new issue in: authorization (all writers
except `execute_schedule` auth the correct actor — `require_auth` at `327, 342,
352, 370, 387, 421, 451, 526, 599`), storage key collisions (`DataKey` variants
are distinct, `231–256`), integer/amount handling (`checked_add/mul/sub`,
`amount <= 0` rejected), scheduler time math (`now - next_run_at` cannot
underflow because `now < next_run_at` is rejected first at `645`; the advance
formula always lands strictly in the future for recurring runs), and
cross-contract reentrancy (the only external calls are after all writes, and a
reentrant `execute_schedule` sees the advanced `next_run_at`/`active=false`).

## 4. Corrections to the audit report

1. **§8, last bullet is now false.** "Keeper tests could not be executed here"
   → they **were** executed during this review: 67/67 keeper (`node --test`) and
   111/111 anchor (vitest), exit 0. §7's ABI conclusions should be upgraded from
   "by reading the source" to "verified by the passing `errors.test.ts` drift
   guard and `chain.test.ts`/`keeper.test.ts`".
2. **§7 wasm-hash verification can be strengthened.** The audit says a local
   build "reproduced" the hash; I independently re-ran `stellar contract build`
   over the current `lib.rs` and reproduced `c4f65e65…` and the 19-entry export
   list. The claim is correct and now explicitly source→artifact verified.
3. **Add N-01…N-03 to the findings table** (all Info) or fold them into §5(c).
4. **Process note (not an audit error):** this repo's `.gitignore` has
   `node_modules/` (trailing slash), which does not match a `node_modules`
   *symlink*. Anyone using the documented symlink workaround will see an
   untracked `node_modules` in `git status`. Suggest `**/node_modules` or a bare
   `node_modules` pattern. This is the only file-scope deviation I had to undo
   (symlink removed after the run).

No finding in the audit was contradicted, and no severity needed re-rating. I
would keep F-01/F-02/F-12 as the tracked limitations and F-03 as an explicit
product decision.

## 5. Answer: is the on-chain part demo-ready?

**Yes — for a supervised hackathon testnet demo.** The guard is functionally
complete for the demo: 38/38 unit tests, clean clippy, a reproducible deployed
hash, typed errors that the app/keeper can act on, and fund-safety properties
that hold on review (effects-before-interaction, single `Spent` counter on every
path, per-owner isolation, allowance as a hard ceiling). The caveats are
product/liveness, not fund-safety: no global pause (F-01), schedules deliberately
ignore `known_recipients_only` and the alias book (F-03), failed/exhausted
schedules are retried forever with no auto-deactivation (F-12), there is no
per-asset budget or velocity cap yet, and the contract is non-upgradeable (F-11).
For the demo, call out explicitly that `known_recipients_only` does not bind
schedules and that the only kill switch for an existing schedule is cancel (or
revoke the SAC allowance, which also disables `pay_owner`/`pay_executor`).

---

*Reviewed by an independent session (L4). All numbers above were produced by
commands run in `.worktrees/contracts-audit-review`; no network/chain calls and
no commits were made.*
