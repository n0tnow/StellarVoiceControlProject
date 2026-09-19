# Report: guard-rules-schedule
- **Date:** 2026-09-19
- **Worker/Agent:** W1 (Claude Opus 5)
- **Branch/Worktree:** `feat/guard-rules-schedule` / `.worktrees/guard-rules`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/5 (draft)

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

## Unfinished (handed off)

- **The daily limit sums all assets into one budget.** It only reads correctly when
  `allowed_assets` holds a single stablecoin. Per-asset daily budgets are a
  follow-up; the storage key would become `Spent(owner, asset)`.
- **No pause / emergency stop on the contract.** The user's kill switch today is
  revoking the SAC allowance or `revoke_executor`, both of which work — but Raven's
  checklist asks for an explicit pause on value-bearing contracts.
- **No upgrade path.** The contract has no `upgrade` entrypoint, so the deployed ID
  is final for this milestone. Deliberate for a hackathon build; if we want
  upgradeability it must be added *before* users configure rules, and a storage
  schema version should land with it.
- **`remove_alias` shares one `Known` marker between aliases** pointing at the same
  address, so removing either un-trusts the recipient. Documented in the code; a
  refcount would fix it.
- **`list_due` scans up to 200 entries per call.** Fine on testnet; if the keeper
  ever polls at high frequency, a due-time-ordered index would be cheaper.
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

Nothing needed was missing from these sources; no "not found in these sources"
cases arose.
