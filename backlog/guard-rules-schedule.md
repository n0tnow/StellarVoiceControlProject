# Report: guard-rules-schedule
- **Date:** 2026-09-19
- **Worker/Agent:** W1 (Claude Opus 5)
- **Branch/Worktree:** `feat/guard-rules-schedule` / `.worktrees/guard-rules`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/10 (draft)

## Completed

### Contract (`contracts/polaris_guard`)
The skeleton (global owner, one per-tx limit, `check_amount`) is replaced by a
multi-tenant rule engine plus scheduler. One deployment serves every user; every
function is keyed by an `owner` address that authorises its own calls, so there is
no `init`, no admin, and nothing to front-run at deploy time.

- **`Rule`** — `auto_approve_limit` / `per_tx_limit` / `daily_limit` /
  `allowed_assets` / `known_recipients_only`, validated on write so the ceilings
  are ordered (`0 <= auto <= per_tx <= daily`), positive, and bounded (≤10 assets).
- **Three payment paths with different powers.** `pay_owner` (owner auth) applies
  hard caps only — the agent-facing guardrails are deliberately skipped so a
  misconfigured allowlist can never lock the user out of their own guard.
  `pay_executor` (executor auth) applies the full rule. `execute_schedule`
  requires **no authorization at all**.
- **Scheduler** — `create_schedule` / `cancel_schedule` / `execute_schedule`,
  plus `get_schedule` / `list_schedules` / `list_due`.
- **Rolling daily counter** — `DaySpend { day, amount }` per owner, `day =
  timestamp / 86400`. A stale entry reads as zero, so rollover costs no write and
  no extra ledger entry.
- **Settlement** via SEP-41 `transfer_from(spender = guard, from = owner, …)`.
  The guard calls the token directly, so the host treats that direct call as the
  spender's authorization — no `authorize_as_current_contract` needed.
- Checked arithmetic throughout, checks-effects-interactions ordering (the spend
  counter is committed before the transfer), TTL bumps on every write, and
  `#[contractevent]` events for every settled payment and schedule transition.

### Two design decisions worth flagging to review

1. **Error codes start at 100.** The test suite caught this: a Soroban contract
   error crosses the wire as a bare `u32` with no record of which contract raised
   it, and the generated client decodes whatever arrives into the guard's enum.
   The SAC uses codes 1–13 (`AllowanceError` = 9), so a guard numbered from 1
   reported a missing allowance as a confident, wrong policy error. Numbering from
   100 makes the families separable: anything below 100 reaching the app came from
   the token or the host, not from policy. A regression test asserts the range.
   Consequence for the app/agent workers: **treat `#105 NeedsOwnerApproval` as the
   Touch ID trigger and anything `< 100` as an infrastructure failure.**

2. **Missed schedule runs are skipped, not caught up.** After a run, `next_run_at`
   jumps to the first slot strictly after `now`, computed in O(1) as
   `next_run_at + (elapsed / interval + 1) * interval`. So: one call settles at
   most one payment; a second call in the same period always gets
   `ScheduleNotDue`; a keeper that wakes up a month late cannot burst backdated
   runs against the daily limit; and `runs_left` decrements only per executed run,
   so "12 monthly payments" still makes 12 — it just finishes later in wall-clock
   time. The alternative (replay every missed slot) was rejected as an unbounded
   catch-up flood. **W3 (keeper) should know the contract will not let it catch
   up, and that calling `execute_schedule` repeatedly is safe but pointless.**

### Tests — `cargo test` green, 27 tests
The fixture registers a **real** Stellar Asset Contract and moves real balances, so
allowance semantics and `transfer_from` auth are exercised rather than mocked.
Covered: executor within limit; over auto-approve → `NeedsOwnerApproval`; hard caps
taking precedence over `NeedsOwnerApproval`; owner path over `per_tx`; daily limit
accumulation, both-path rejection and UTC rollover; disallowed asset (rejected for
the agent, allowed for the owner); `known_recipients_only` including alias removal
re-closing the door; revoked executor; a stranger impersonating the executor;
missing allowance → typed `InsufficientAllowance` with no counter drift; zero and
negative amounts on all three entry points; schedule early-call rejection, on-time
execution, interval advance, no double execution in a period, missed-run skipping,
runs exhaustion, cancel (including a stranger's cancel and a double cancel), rule
re-evaluation at execution time for both the daily limit and the asset allowlist,
schedule ignoring `auto_approve_limit`, and parameter validation.

Four tests assert **real** authorization rather than relying on `mock_all_auths`:
two narrow the mock with `MockAuth`/`MockAuthInvoke` and then assert `env.auths()`
names exactly the expected signer, one proves a foreign signature cannot set
another owner's rule, and `keeper_needs_no_authorization_at_all` installs an empty
mock list (so any `require_auth` would fail) and shows `execute_schedule` still
settles and consumes no auth.

`cargo clippy --all-targets` is warning-free.

### Build, deploy, demo
- `stellar contract build` OK — **`polaris_guard.wasm`, 22,367 bytes** (21.8 KB).
- Deployed to testnet: **`CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY`**,
  deployer `GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E` (own `w1`
  identity, generated for this task).
- Demo asset `PGUSD` issued from a throwaway issuer, SAC
  `CC2V2R6JLMVGXQOXMZLATCNOVNS2QEOKSNZYO7DATCWJNJTUPCI5QX3E` — chosen over Circle
  testnet USDC because that faucet is Captcha-gated and cannot be scripted.
- **Real testnet USDC SAC: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`**,
  derived with `stellar contract id asset` and **identical** to the constant the
  Stellar `agentic-payments` playbook publishes as `USDC_TESTNET_ADDRESS`. Both
  sources agree, so the anchor work can use either.
- `contracts/scripts/demo.sh` + `demo.env` (public IDs only) and
  `contracts/DEPLOYED.md` (contract ID, identities, build, from-scratch deploy,
  the allowance step, the full error-code table).

#### Demo output — the on-chain over-limit rejection

```
==> 4. Agent pays 3 (inside the mandate) — EXPECT SUCCESS
✅ Transaction submitted successfully!
📅 CB5CQ… - Success - Event: Paid (paid), owner: "GCLBGU2P…", to: "GARXWVNC…",
   asset: "CC2V2R6J…", amount: "30000000", via: "executor"
    settled; spent today: "30000000"

==> 5. Agent pays 25 (over the mandate, inside the hard caps) — EXPECT REJECTION
❌ error: transaction simulation failed: HostError: Error(Contract, #105)
   0: [Diagnostic Event] contract:CB5CQ…, topics:[error, Error(Contract, #105)],
      data:"escalating Ok(ScErrorType::Contract) frame-exit to Err"
   1: [Diagnostic Event] topics:[fn_call, CB5CQ…, pay_executor],
      data:[GB3HO3WG…, GCLBGU2P…, GARXWVNC…, CC2V2R6J…, 250000000]
    rejected on-chain: NeedsOwnerApproval (contract error #105)
    this is the signal the desktop app turns into a Touch ID prompt

==> 6. Owner signs the same payment themselves — EXPECT SUCCESS
📅 … Event: Paid (paid), … amount: "250000000", via: "owner"

==> 7. Owner creates a one-shot schedule, due ~20s from now
📅 … Event: ScheduleCreated (schedule_created), owner: "GCLBGU2P…", id: 1, …
   amount: "70000000", next_run_at: 1789821779, interval_secs: 0, runs: 1
    calling it early — EXPECT ScheduleNotDue
❌ error: transaction simulation failed: HostError: Error(Contract, #110)
    rejected on-chain: ScheduleNotDue (contract error #110)

==> 8. Waiting for the schedule to come due, then a keeper triggers it
    due schedules according to the contract: [1]
📅 … Event: Paid (paid), … amount: "70000000", via: "schedule"
📅 … Event: ScheduleRun (schedule_run), owner: "GCLBGU2P…", id: 1,
   amount: "70000000", next_run_at: 1789821779, runs_left: 0, active: false

==> Result
    payee balance:     "380000000"
    owner spent today: "380000000"
Demo complete.
```

Note the keeper in step 8 is `w1-iss`, an account that is neither the owner nor the
executor and holds no registration in the contract.

## ABI deviations from the brief

Every deviation, precisely:

| Deviation | Why |
|---|---|
| Error discriminants start at **100**, not 1 | SAC error-code collision, see above. |
| **`InsufficientAllowance` (116) added** | The guard reads the SEP-41 allowance before settling so a revoked allowance is a typed guard error instead of the SAC's opaque numeric one. Costs one extra cross-contract read per payment. |
| **`remove_alias(owner, alias)` added** | `known_recipients_only` is an allowlist; without a removal path a recipient could never be un-trusted. Also drops the reverse `Known` marker. |
| **`is_known_recipient(owner, to)` added** | Read-only; lets the app warn before attempting a payment the rule will refuse. |
| `get_alias(owner, alias)` **replaces** `resolve_alias(alias)` | Aliases are now owner-scoped, matching the brief's `set_alias(owner, alias, address)`. |
| `init`, `owner`, `set_limit`, `limit`, `check_amount` **removed** | Superseded by the multi-tenant `set_rule`/`get_rule`. Nothing outside `contracts/` referenced them (grepped). |
| `set_executor` / `revoke_executor` / `set_alias` / `remove_alias` / `is_known_recipient` return `()` rather than `Result` | They have no failure mode beyond auth. |
| `set_rule` rejects `auto_approve_limit > per_tx_limit` and `per_tx_limit > daily_limit` | Not in the brief. An unreachable ceiling is always a misconfiguration and would give the user a wrong mental model. |
| Empty `allowed_assets` means **deny-all** for the agent and keeper | Fail-closed. `pay_owner` ignores the list entirely so the owner is never locked out. |
| `list_schedules(owner)` returns **active** schedules only | Bounds the index entry. Inactive ones stay readable by id via `get_schedule`. |
| Caps: 25 active schedules per owner, 200 globally, 10 allowed assets | `list_due` and the rule scan are iterated per call; unbounded growth is a fee-griefing DoS (Raven security.md class #10). |
| `create_schedule` takes `runs: u32` with `interval_secs == 0 ⇒ runs == 1` | The brief's one-shot marker needed an explicit consistency rule. |

## Review round 1 — CHANGES-REQUESTED, all findings resolved

Reviewer verdict on `bcac4b5`: one blocker, four majors, six minors. Both decisions
flagged for an ack (error codes at 100+, skip-don't-catch-up) were **ACKed**. The
review was correct on every point; B1 in particular found a real design flaw I had
missed, and the fix changed the storage layout.

| Finding | Resolution | Where |
|---|---|---|
| **B1 (blocker)** — global schedule cap is a permanent cross-tenant DoS: 8 funded accounts × 25 far-future schedules fill the shared list, only the attacker can cancel them, and with no admin or upgrade path the sole remedy is a new contract | **Fixed.** `MAX_ACTIVE_GLOBAL` and `DataKey::ActiveScheds` removed entirely. Per-owner cap (25) kept — it is the bound that actually protects anything and one tenant cannot aim it at another. The read is bounded instead of the write, via pagination. | `ae39f7d` |
| **M1** — `ActiveScheds` is one global read-write entry, so unrelated tenants and the keeper all serialize on it | **Fixed by the same change.** The only shared entry left is `NextSchedId`, and only `create_schedule` writes it: the keeper never contends, and two owners collide only if they create schedules in the very same ledger. Cancels and runs now touch nothing shared. | `ae39f7d` |
| **M2** — `auto_approve_limit` is per transaction; nothing caps payment count, so "auto-approve under 10" really means "up to 200/day unattended" | **Documented.** New *"What the rule actually promises"* section states that `daily_limit` is the agent's real mandate and that app copy must say so; recommends turning on `known_recipients_only`. Per-day count cap tracked below. | `cbce058` |
| **M3** — 10 allowed assets but one cross-asset daily counter makes `daily_limit` meaningless across decimals | **Enforced in code.** `validate_rule` rejects `allowed_assets.len() > 1` (`InvalidRule`). `MAX_ALLOWED_ASSETS` stays as the structural bound for when `Spent(owner, asset)` lands. Documented. | `2bcf399` |
| **M4** — `pay_owner` calls an unvalidated token, so `Paid`/`spent_today` are not proof value moved | **Documented, no code change.** A post-transfer balance check would cost two more cross-contract reads per payment and still not cover a token that lies about `balance`, so it buys less than it costs. The real fix is client-side and is now a stated requirement: resolve `asset` from the owner's own allowlist, never forward an agent-supplied address into `pay_owner`. | `cbce058` |
| **m1** — TTL extended on write but never on read, so the hottest *read* entries archive | **Fixed.** `load_rule` and the executor lookup bump their entries. Both are reached only from payment paths, which already write, so the entry is in the read-write footprint and this cannot turn a read-only call into a write. | `2bcf399` |
| **m2** — no test asserts any event | **Fixed.** `Paid` (both `via` values), `ScheduleCreated`, `ScheduleRun` and `ScheduleCancelled` are compared against their exact XDR, filtered to the guard's own events with `filter_by_contract`. Plus a test that a rejected payment emits nothing. | `ae39f7d` |
| **m3** — `TooManySchedules` untested; no second owner anywhere in the suite | **Fixed.** `schedule_cap_is_per_owner_and_does_not_block_other_owners` fills owner A's 25 slots, asserts the 26th fails, shows owner B scheduling and running unaffected, and shows a cancel freeing exactly one slot. `two_owners_are_fully_isolated` covers rules, executors (rejected in both directions), spend counters, daily-limit exhaustion, alias books and schedule ownership. Cancel on an unknown id also added. | `ae39f7d` |
| **m4** — error-floor test checks 2 of 17 variants | **Fixed.** All 17 listed explicitly, with a length assertion so adding a variant forces a deliberate edit, plus the exact 100/116 endpoints. | `ae39f7d` |
| **m5** — `ScheduleRun.next_run_at` stale on the final run | **Not fixed — deliberate.** Correcting it means either losing the last-run timestamp or adding a `last_run_at` field, which is an ABI change rippling into the keeper (PR #9) and interfaces (PR #8) for a cosmetic gain. `active: false` disambiguates. Tracked below. | — |
| **m6** — `demo.sh` busy-waits then sleeps 6s for the ledger | **Not fixed.** Fine for a demo; a retry loop is worth it only if this ever runs in CI. Tracked below. | — |

### ABI diff (for the keeper, PR #9, and interfaces, PR #8)

Only one breaking change, plus one addition:

| Before | After |
|---|---|
| `list_due(limit: u32) -> Vec<u32>` | `list_due(cursor: u32, limit: u32) -> (Vec<u32>, u32)` |
| — | `next_schedule_id() -> u32` (new) |

`list_due` now bounds the **scan**, not the result: it examines at most `limit` ids
(clamped to 100) starting at `cursor` and returns `(due_ids, next_cursor)`, where
`next_cursor == 0` means the sweep reached the end of the id space. A keeper sweep is

```
cursor = 0
loop { (ids, cursor) = list_due(cursor, 100); for id in ids { execute_schedule(id) }
       if cursor == 0 { break } }
```

Over the CLI the tuple prints as `[[1],0]`. Everything else — `execute_schedule(id)`,
the error codes, `Schedule`, `Rule`, every payment function — is unchanged. One
behavioural change worth knowing: `set_rule` now rejects rules with more than one
allowed asset (`InvalidRule` / #102).

### Redeploy

The guard has no upgrade entrypoint, so the fix is a new contract:

| | |
|---|---|
| New contract | `CDIWQTYA7OBF2FKLLHQWYZ2Q2L4PAEBLLMFRXVY4R7MAM45LX7Q2R2XB` |
| Superseded | `CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY` — marked DEPRECATED in `DEPLOYED.md` with the reason |
| Wasm | 23,261 bytes (was 22,367) |
| Tests | **35 passed**, 0 failed; `cargo clippy --all-targets` clean |

Demo re-run against the new contract — the load-bearing lines:

```
==> 4. Agent pays 3 (inside the mandate) — EXPECT SUCCESS
📅 CDIWQ… Event: Paid (paid), … amount: "30000000", via: "executor"
    settled; spent today: "30000000"

==> 5. Agent pays 25 (over the mandate, inside the hard caps) — EXPECT REJECTION
❌ error: transaction simulation failed: HostError: Error(Contract, #105)
   0: [Diagnostic Event] contract:CDIWQ…, topics:[error, Error(Contract, #105)]
   1: [Diagnostic Event] topics:[fn_call, CDIWQ…, pay_executor],
      data:[GB3HO3WG…, GCLBGU2P…, GARXWVNC…, CC2V2R6J…, 250000000]
    rejected on-chain: NeedsOwnerApproval (contract error #105)

==> 6. Owner signs the same payment themselves — EXPECT SUCCESS
📅 Event: Paid (paid), … amount: "250000000", via: "owner"

==> 7. … calling it early — EXPECT ScheduleNotDue
❌ error: … Error(Contract, #110)  ->  rejected on-chain: ScheduleNotDue

==> 8. keeper (neither owner nor executor) triggers the due schedule
    due schedules according to the contract (paginated scan from cursor 0):
[[1],0]
📅 Event: Paid (paid), … amount: "70000000", via: "schedule"
📅 Event: ScheduleRun, id: 1, runs_left: 0, active: false

==> Result
    payee balance:     "730000000"
    owner spent today: "350000000"
Demo complete.
```

(The payee balance carries over from the superseded contract's demo run on the same
asset; `spent_today` of 350000000 is this contract's own 3 + 25 + 7 PGUSD.)

### Process note

The reviewer's environment tip was right and worth repeating: `cargo` is not on the
non-interactive `PATH` here, so every run in this round used
`PATH=$HOME/.cargo/bin:$PATH` and I verified the reported test count each time
(28 after the M3 commit, 35 after the B1 commit) rather than trusting a silent pass.

I also initially committed B1, M3 and m1 together; that commit was reset and split
into `2bcf399` (M3 + m1) and `ae39f7d` (B1/M1) before pushing, so the history is
atomic as the constitution requires.

## Review round 2 — G1/G2 fixed + second redeploy

Round 2 left two findings open (G1, G2) plus deployment-record gaps. All are
addressed in this worktree.

### G1 — re-pointing an alias left the old address known

`set_alias` wrote `Known(new)` but never cleared `Known(old)`, and `remove_alias`
could only drop the address the alias currently mapped to, so a stale marker had
no removal path at all. With `known_recipients_only = true`, moving an alias to a
new wallet left the **previous** wallet agent-payable without owner approval.

**Fix** (`6607c11`): `Known` is refcounted per `(owner, recipient)` in a new
`DataKey::KnownRefs`. `set_alias` drops one reference from the old address and
adds one for the new; `remove_alias` drops one; the marker goes away with the
last reference. There is no reverse alias index to consult — alias names are
arbitrary strings and the storage API cannot enumerate keys — so a counter is the
only way to answer "does another alias still resolve here?" while keeping the
invariant exact rather than approximate. Side effect: the old `remove_alias`
caveat (two aliases sharing one marker, removing either un-trusts the address) is
gone.

Regression tests: `repointing_an_alias_un_marks_the_old_address` (also asserts
the executor path refuses the abandoned wallet and pays the new one) and
`an_address_stays_known_while_another_alias_points_at_it` (shared address stays
known until the last alias goes).

### G2 — keeper-path TTL hygiene

`execute_schedule` bumped only the `Schedule` entry. `NextSchedId` (written only
by `create_schedule`) and `OwnerScheds` (written on create, and on `deindex` only
when a schedule goes inactive) were never extended by a running schedule, so a
long-lived recurring schedule could let both fall below the bump threshold.
Protocol 23 auto-restores archived persistent entries, so this was a restore-cost
problem rather than data loss — but the bill would land on the untrusted keeper,
whose `list_due` path reads both entries.

**Fix** (`bdf9fb1`): an active run bumps `OwnerScheds`; the inactive branch keeps
using `deindex`, which bumps the index when it rewrites it. Both branches extend
`NextSchedId`. Documented tradeoff: `NextSchedId` is the one shared storage entry
left, so two runs landing in the same ledger now contend on it — a bounded rent
bump traded for TTL hygiene.

Test: `execute_schedule_extends_the_index_and_id_counter_ttl` walks the ledger to
just inside the bump window, asserts both TTLs are within threshold, runs the
schedule, then asserts both were pushed back out. A true archival test was not
needed — the test host emulates Protocol 23 auto-restoration, and remaining TTL
is directly observable through `testutils::storage::Persistent::get_ttl`, which
is exactly the quantity the fix changes.

### Deployment record

- `DEPLOYED.md` test count corrected (27 → 38 after this round; it had been 35
  since round 1) — re-verified with a real run, not assumed.
- `TooManySchedules` error doc no longer says "Per-owner or global".
- Deploy tx hash and wasm sha256 are recorded for every deployment. The current
  artifact's sha256 was re-derived by fetching the deployed code with
  `stellar contract fetch`, so artifact and chain agree.
- **Second redeploy:** the fixes change the wasm (23,787 bytes, sha256
  `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6`).
  New contract **`CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`**
  (deploy tx `f6017b43cef06047b6c3bc04e2f88a2e9fb0b3ee3b3aa5a0261a0c43dfacaf59`);
  `CDIWQTYA…` marked DEPRECATED with its own tx hash and wasm hash. `demo.env`
  updated.
- Spec check: `stellar contract info interface --id CDRLSFJ5W…` shows the same
  19 functions, 3 types, 4 events and the 100–116 error block as the source; the
  fetched wasm re-hashes to the local build.
- Demo re-run against the new contract: all 8 steps as expected (agent 3 settled,
  agent 25 refused `#105`, owner 25 settled, early schedule call `#110`,
  `list_due` → `[[1],0]`, keeper settled the schedule; payee ended at
  `108.0000000 PGUSD`, owner `spent_today` `350000000`).

Test/quality gate for this round: `cargo test -p polaris_guard` **38 passed,
0 failed**; `cargo clippy --all-targets` clean.

## Unfinished (handed off)

- **Per-asset daily budgets (`Spent(owner, asset)`).** Until they land, `set_rule`
  refuses more than one allowed asset (review M3), so the restriction is enforced
  rather than merely documented — but a user who wants USDC *and* EURC needs this.
- **A per-day transaction-count cap (review M2).** `auto_approve_limit` bounds the
  size of one unattended payment, not how many the agent makes, so the honest
  description of the agent's mandate is `daily_limit`. A count or velocity cap would
  let the user say "at most 5 unattended payments a day" and mean it.
- **No pause / emergency stop on the contract.** The user's kill switch today is
  revoking the SAC allowance or `revoke_executor`, both of which work — but Raven's
  checklist asks for an explicit pause on value-bearing contracts.
- **No upgrade path.** The contract has no `upgrade` entrypoint, so the deployed ID
  is final for this milestone. Deliberate for a hackathon build; if we want
  upgradeability it must be added *before* users configure rules, and a storage
  schema version should land with it.
- **A schedule run extends the shared `NextSchedId` entry** (round-2 G2), so two
  runs landing in the same ledger contend on that one entry. It is a bounded rent
  bump, not a lock held across the transfer, and it buys TTL hygiene for the
  keeper path; if keeper throughput ever matters, a per-owner id source or
  batching removes it.
- **Keeper sweep cost grows with ids ever created, not schedules still active.**
  `list_due` scans a bounded id window (<=100 entries per call) and skips holes left
  by cancels and completed runs, so someone creating throwaway schedules raises
  polling cost — they cannot block scheduling, which is the tradeoff chosen in
  review B1. A due-time-ordered index, or a keeper that remembers the lowest
  still-active id, would cut it if it ever matters.
- **`ScheduleRun.next_run_at` is stale on a schedule's final run** (review m5).
  `active: false` disambiguates it, but an indexer reading the field alone is
  misled. Fixing it properly means a `last_run_at` field — an ABI change touching
  the keeper and interfaces, not worth it for this milestone.
- **`demo.sh` busy-waits on the wall clock then sleeps 6s** for the ledger (review
  m6). Fine interactively; needs a retry loop before it runs in CI.
- **No fuzz / property tests.** Raven's testing.md covers both; the daily counter
  and the schedule advance arithmetic are the obvious candidates.
- **README / architecture.md still describe the skeleton** (`per-tx limit + alias
  book`). Out of my file scope — flagged for the documentation agent.
  `sprints.md` line "polaris_guard Soroban contract: per-tx/daily spending limit +
  alias book; deployed on testnet, contract ID documented" can be ticked.

## Blockers

None. Everything in the brief landed.

## Review Notes

For the reviewer, in rough order of how much I'd want a second pair of eyes:

1. **The error-code base (100).** It solves a real collision I hit, but it is a
   permanent ABI commitment — codes can never be renumbered after users configure
   rules. Worth a conscious ack.
2. **Skip-don't-catch-up schedule semantics.** A product decision as much as a
   technical one: a user whose keeper was down for a week will see payments shifted
   later rather than several firing at once. I think that is the right default for
   money, but it should be a deliberate choice, and W3's keeper docs must match.
3. **`pay_owner` ignores `allowed_assets` and `known_recipients_only`.** Deliberate
   (those are agent guardrails, and the owner is signing), but it means the rule is
   not a single global policy — check this matches the product intent.
4. **The allowance pre-check adds a cross-contract read to every payment.** Cheap,
   but it is a check-then-act window; the comment in `settle` argues why it is
   harmless (only the owner can shrink their own allowance, and the transfer would
   fail and roll back anyway).
5. **`spent_today` is not per-asset** — see Unfinished. If the demo ever shows two
   assets, this reads wrong.
6. `contracts/scripts/demo.env` is committed. It holds only public testnet
   identifiers (contract IDs, CLI identity *names*); no secrets. Say so if you'd
   rather it were gitignored.

## Suggested Next Step

1. Assign a reviewer (not me) for the PR; the six points above are the agenda.
2. **W3 (keeper)** can start now against the live contract: poll
   `list_due(limit)`, call `execute_schedule(id)`, and treat `#110 ScheduleNotDue`
   / `#111 ScheduleInactive` as benign races, `#104 OverDailyLimit` as "retry
   tomorrow". No key registration needed — any funded account works.
3. **App/agent workers** can wire the error table from `contracts/DEPLOYED.md`:
   `#105` → Touch ID prompt → retry via `pay_owner`; `< 100` → infrastructure
   error, do not re-prompt.
4. Documentation agent: refresh `README.md`, `docs/architecture.md` §5.3 and tick
   the `sprints.md` guard line.

## Raven calls

Raven was consulted before each major piece; its answers changed the design in
three concrete places.

| # | Call | What came back | What it changed |
|---|---|---|---|
| 1 | `search(kind: skill)` for soroban development/testing/security | Ranked `skills.stellar-dev.smart-contracts` top (gated) with `development.md` / `testing.md` / `security.md` | Set the reading list below. |
| 2 | `search(service: stellarDocs)` for SEP-41 `transfer_from` / allowance / `expiration_ledger` | Operation catalogue (`search_asset_token_docs`, `search_soroban_contract_docs`, …); also surfaced `skills.stellar-dev.agentic-payments` as a filter-excluded skill | Pointed me at the agentic-payments skill for the USDC constant (call #5). |
| 3 | `codemode.skill.read("skills.stellar-dev.smart-contracts", ["file:development.md"])` | Storage/TTL table and `extend_ttl(threshold, extend_to)` idiom; typed `DataKey` enums with fine-grained keys; auth trees and the rule that **a direct call from A to B authorizes A to B** (no `authorize_as_current_contract` for an immediate invocation); `#[contractevent]` (and that `env.events().publish` is deprecated); `#[contracterror]` + `panic_with_error!`; token semantics — `transfer_from` auths the **spender**, allowances expire and re-approving has a front-running race, SAC classic quirks (trustlines, clawback) | Direct architectural input: the `DataKey` layout, the `BUMP_THRESHOLD`/`BUMP_TO` constants, using `#[contractevent]` structs instead of the deprecated publish API, and — importantly — the confirmation that the guard needs **no** `authorize_as_current_contract` before calling the SAC. Also the "approve to 0 first" note now in DEPLOYED.md. |
| 4 | `codemode.skill.read(..., ["file:security.md"])`, headings then lines 102–183 | Check-then-act races, TTL-is-not-security, resource exhaustion (#10: cap loops on attacker-shaped input), the token-consumer review checklist, and the contract checklist | Produced the `MAX_ALLOWED_ASSETS` / `MAX_ACTIVE_PER_OWNER` / `MAX_ACTIVE_GLOBAL` caps, the O(1) (loop-free) schedule advance, and the explicit deadline-in-the-value approach (`next_run_at` is stored and checked, never implied by a TTL). |
| 5 | `codemode.skill.read("skills.stellar-dev.agentic-payments", ["two-usdc-addresses…", "testnet-setup-shared"])` | `USDC_TESTNET_ADDRESS = CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`, issuer `GBBD47IF…`, the G-vs-C distinction, and the explicit statement that the Circle faucet is **web-only Captcha, no API** | Confirmed my locally derived USDC SAC matches the published constant, and justified the throwaway-issuer demo asset instead of waiting on the faucet. |
| 6 | `codemode.skill.read(..., ["file:testing.md"])`, lines 11–119 | `mock_all_auths` hides missing `require_auth` — always pair with `env.auths()` assertions or `mock_auths`; `env.auths()` returns the **most recent invocation only** and resets on any later call, so assert immediately; `env.ledger().set_timestamp`; registering a real dependency contract | Directly produced the four real-auth tests, the "assert `env.auths()` immediately after the call" discipline, and the decision to register a real SAC in the fixture rather than stub the token. |

### Round 2 — the B1/M1 redesign

| # | Call | What came back | What it changed |
|---|---|---|---|
| 7 | `codemode.skill.read("skills.stellar-dev.smart-contracts", ["file:development.md"])`, re-read for the storage and fees sections | *"Every transaction declares its read/write footprint upfront; transactions touching the same read-write entry serialize, while fine-grained keys let unrelated transactions run in parallel"*, and the per-transaction ceilings table (**200 ledger entries read / 200 written**, 400M CPU instructions) | Confirmed M1's mechanism in the source the reviewer cited, and gave the hard number behind `MAX_DUE_SCAN = 100` — half the read ceiling, leaving headroom for the rest of the footprint. |
| 8 | `stellarDocs.search_soroban_contract_docs` ×2 — footprint/parallel execution/contention, and bounded iteration + per-transaction entry limits | Both queries surfaced `/docs/build/guides/storage/storage-strategies`, a page I had not read in round 1 | Pointed me at the canonical guidance instead of inventing a layout. |
| 9 | `stellarDocs.get_doc_page_sections("/docs/build/guides/storage/storage-strategies")` | **Strategy 8 — "Enumeration: build the index yourself"**, three variants. Variant (a) *append-only: counter + indexed keys* — *"Appending = write index n, bump counter. Enumeration = clients loop `all_pairs(i)` for i in 0..total — **pagination is pushed to the caller, which is the point: no single transaction ever needs the whole set**"*, with Soroswap's factory as the worked example. Also: *"No key iteration exists. An unbounded Vec eventually exceeds the 64 KiB entry cap, and O(n) rewrites eventually exceed transaction budgets."* | **Decided the redesign.** The new layout is Strategy 8(a) verbatim: monotonic `NextSchedId`, one `Schedule(id)` entry, and `list_due(cursor, limit)` pushing pagination to the keeper. It also justified *not* reaching for variant (b) (double mapping + swap-and-pop): removal is O(1) there, but it reintroduces a shared mutable index, which is exactly what B1 is about. Variant (c) (events + off-chain indexer) was rejected because the keeper must be able to discover work on-chain without trusting an indexer. |

Nothing needed was missing from these sources in either round; no "not found in
these sources" cases arose.
