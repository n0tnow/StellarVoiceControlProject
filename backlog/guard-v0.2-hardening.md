# Report: guard-v0.2-hardening — new crate `polaris_guard_v2` (NOT an edit of `polaris_guard`)
- **Date:** 2026-09-19
- **Worker/Agent:** coordinating agent (plan) — implementation unassigned
- **Branch/Worktree:** none yet (PLANNED) — suggest `feat/guard-v0.2`
- **PR:** none
- **Status:** **planned, not started**

> **D9 (user, 2026-09-19) — contract evolution = new crates, v0.1 frozen.**
> `polaris_guard` v0.1 is **FROZEN** and stays the reference deployment (ID in `contracts/DEPLOYED.md`);
> its source under `contracts/polaris_guard/` is never edited again except for a critical fix decided by
> the owner. Every future contract change or addition is a **NEW crate** under `contracts/` (own Cargo
> package + own tests + own testnet deployment + own section in `contracts/DEPLOYED.md`), registered as
> an extra member of the contracts Cargo workspace (`contracts/Cargo.toml`), so old and new contracts can
> be tested and run side by side and a demo never depends on an in-place redeploy. This report therefore
> targets the **new crate `polaris_guard_v2`**; the v0.1 crate is never touched.

## Completed
- Nothing implemented. This file is the batched specification for the **new crate `polaris_guard_v2`**
  (NOT an edit of `contracts/polaris_guard/`), sourced from `backlog/contracts-audit.md`
  (findings F-01…F-12, N-01…N-03) and `backlog/contracts-audit-review.md`.
- v0.1 (`polaris_guard`) stays deployed and frozen; the items below ship as `polaris_guard_v2` alongside it.
- N-03 is documented, not fixed, in v0.2.

## Preconditions
1. **Only after the headless slice works** (D1 steps 1–3: real `sendPayment`, guard owner-side TS
   client, headless e2e `Intent → XDR → sign → submit` with `#105` rejection). Do not start v0.2 before
   the slice is green.
2. **Single new deployment (new contract id).** All items below ship in ONE new contract
   (`polaris_guard_v2`, one new contract ID), never item-by-item. Any change here = a new crate + new
   testnet deployment + new contract ID = every owner re-publishes rule + allowance + keeper env update.
3. **New crate, not an edit (D9).** Start from a copy of the frozen v0.1 source: create
   `contracts/polaris_guard_v2/` (own `Cargo.toml`, `src/lib.rs`, `src/test.rs`), then apply the items
   below. Register the crate as an extra member of the contracts Cargo workspace in
   `contracts/Cargo.toml`, so `cargo test --manifest-path contracts/Cargo.toml` runs every member and
   this crate is green on its own. Do not edit `contracts/polaris_guard/`.
4. **Own deployment + own `DEPLOYED.md` section.** Build and deploy the new wasm to testnet under a new
   contract id, and record it in `contracts/DEPLOYED.md` in its own section (contract id, deploy tx,
   wasm sha256, explorer). The v0.1 section stays unchanged.
5. **Client/keeper are contract-id parametrised.** The owner-side TypeScript guard client and the keeper
   must take the contract id as a parameter (e.g. `GUARD_CONTRACT_ID`) and never hard-code it, so they
   can target v0.1 or v0.2 side by side. An ABI difference between versions is handled by an explicit
   version adapter, never by silent assumptions.

## ABI impact (applies to the whole batch)
- **Breaking change:** yes — the contract has no upgrade entrypoint, so `polaris_guard_v2` is a **new
  contract ID** deployed alongside v0.1. v0.1
  (`CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`) stays deployed and frozen; nothing
  replaces it in place.
- Keeper and the owner-side TS client take the contract id as a parameter via env `GUARD_CONTRACT_ID`
  (`stellar/src/keeper/README.md`, `.env.example`); `contracts/DEPLOYED.md` gains a **new section** for
  the new contract (new ID, deploy tx, wasm sha256, explorer) while the v0.1 section stays.
- New exported functions (`set_paused`/`get_paused`, `get_spent` per asset, etc.) extend the ABI;
  existing callers keep working once re-pointed. New events are additive.
- The v0.1 error block stays `100–116`; any new error variant must continue from 117 to avoid
  colliding with the token/host range `< 100` (`errors.ts` `GUARD_ERROR_BASE`).

## Item list (v0.2)

### V2-01 — Per-owner pause / emergency stop (F-01)
- **Finding:** F-01 (Medium) — no pause; `revoke_executor` does not stop schedules.
- **Exact change:** add an owner-controlled `paused: bool` (storage key `Paused(owner)`); add
  `set_paused(owner, paused)` (owner auth) and `get_paused(owner)`; check `paused` in ALL payment
  paths — `pay_owner`, `pay_executor`, `execute_schedule` — and refuse with a new typed error
  (`Paused`, code 117) before any spend.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `stellar/src/keeper/errors.ts` (map code 117 → `rule_violated`), `stellar/src/keeper/README.md`
  (error table; contract id as a parameter), `contracts/DEPLOYED.md` (new `polaris_guard_v2` section +
  error table + kill-switch matrix), `contracts/scripts/demo.sh` (optional showcase).
- **Test to add:** "pause blocks all three payment paths" + audit §6 #11
  (`revoke_executor` does not stop schedules — document the boundary); assert state unchanged.
- **ABI impact:** new functions + new error; new contract `polaris_guard_v2`; new deployment section;
  keeper env; DEPLOYED.md.

### V2-02 — On-chain failure counter / auto-deactivation (F-12)
- **Finding:** F-12 (Low) — a schedule that can never succeed stays active forever.
- **Exact change:** add a per-schedule `fail_count: u32` (or a `failed_at` marker); increment on a
  refused/failed run; deactivate + emit `ScheduleCancelled`/`ScheduleDeactivated` after **3 consecutive
  failed runs** (default; making this threshold configurable at create time is out of scope for v0.2).
  Expose it in `get_schedule`/`Schedule`.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `stellar/src/keeper/errors.ts` (drop `inactive` backoff for deactivated schedules),
  `stellar/src/keeper/chain.ts` (`Schedule` interface gains the field), `stellar/src/keeper/README.md`,
  `contracts/DEPLOYED.md` (new `polaris_guard_v2` section).
- **Test to add:** "a schedule whose run keeps failing is deactivated after N failures" + audit §6 #4
  (insufficient balance with sufficient allowance) as the failure source.
- **ABI impact:** `Schedule` type change (breaking for the keeper's `get_schedule` decode); new event;
  new contract `polaris_guard_v2`; new deployment section; keeper env; DEPLOYED.md.

### V2-03 — Bump both `Known` and `KnownRefs` TTLs on every alias touch (F-04)
- **Finding:** F-04 (Low) — `Known` vs `KnownRefs` TTL divergence; same-address `set_alias` bumps
  neither.
- **Exact change:** in `set_alias` (both the re-point branch and the same-address branch) and in
  `remove_alias`, call `bump` on both `Known` and `KnownRefs`.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member).
- **Test to add:** audit §6 #10 (`set_alias` idempotence + refcount) plus a TTL-consistency assertion.
- **ABI impact:** none (internal storage behaviour); still bundled into the single new deployment
  (`polaris_guard_v2`).

### V2-04 — Distinguish `limit=0` from end-of-space in `list_due` (N-01)
- **Finding:** N-01 (Info) — `list_due(cursor, 0)` returns `([], 0)`, same as end-of-space.
- **Exact change:** either reject `limit == 0` with `InvalidAmount`/`InvalidSchedule`, or return a
  distinct sentinel; document the choice in `DEPLOYED.md`.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `stellar/src/keeper/chain.ts` (if the sentinel changes), `contracts/DEPLOYED.md` (new
  `polaris_guard_v2` section + keeper notes).
- **Test to add:** audit §6 #7 (`list_due` clamp with >100 ids) plus a `limit=0` case.
- **ABI impact:** possible return-value semantics change; bundled into the single new deployment
  (`polaris_guard_v2`).

### V2-05 — Events for rule/executor/alias mutations (N-02)
- **Finding:** N-02 (Info) — `set_rule`/`set_executor`/`revoke_executor`/`set_alias`/`remove_alias`
  emit no events.
- **Exact change:** publish events from all five mutators (owner, key, and e.g. old/new alias target);
  keep topics small and typed (`#[contractevent]`).
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `contracts/DEPLOYED.md` (new `polaris_guard_v2` section + events list).
- **Test to add:** assert each mutator emits its event (extend existing auth tests).
- **ABI impact:** additive events only; still bundled into the single new deployment (`polaris_guard_v2`).

### V2-06 — Per-asset daily budgets `Spent(owner, asset)` (spec gap)
- **Finding:** §5(b) of the audit — `daily_limit` is one cross-asset counter, so `set_rule` rejects
  `allowed_assets.len() > 1`.
- **Exact change:** key the spend counter by `(owner, asset)`; lift the `> 1` restriction in
  `validate_rule`; make `MAX_ALLOWED_ASSETS` reachable (F-08) and update its comment.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `contracts/DEPLOYED.md` ("One asset per rule, for now" section + new `polaris_guard_v2` section),
  `stellar/src/keeper/errors.ts` if codes shift.
- **Test to add:** "multi-asset rules keep independent daily budgets" + audit §6 #5 (i128 overflow on
  the daily counter).
- **ABI impact:** storage layout change (`Spent` key); new contract `polaris_guard_v2`; new deployment
  section; keeper env; DEPLOYED.md.

### V2-07 — Per-day transaction-count / velocity cap (review M2)
- **Finding:** §5(b) of the audit — `daily_limit` is the only proxy for transaction count.
- **Exact change:** add a per-owner per-day transaction-count cap (and/or a velocity window) to `Rule`
  and enforce it in all payment paths.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `contracts/DEPLOYED.md` (new `polaris_guard_v2` section).
- **Test to add:** "N+1 payments in a UTC day are rejected by the count cap" + audit §6 #9
  (allowance exactly equal to amount boundary).
- **ABI impact:** `Rule` type change (breaking for clients constructing rules); new contract
  `polaris_guard_v2`; new deployment section; keeper env; DEPLOYED.md.

### V2-08 — Decide F-03: re-check `known_recipients_only` at run time, or keep
- **Finding:** F-03 (Low) — `execute_schedule` skips the known-recipient check; removing/re-pointing an
  alias does not stop an existing schedule.
- **Exact change (decision needed):** either (a) keep the current behaviour and document it as a product
  promise, or (b) add a `Known` read (refcount-aware) in `execute_schedule` so alias removal stops
  schedules. If (b), a schedule to an alias that is later removed must fail closed.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `contracts/DEPLOYED.md` (rule promises + demo talking points + new `polaris_guard_v2` section).
- **Test to add:** audit §6 #1 (`known_recipients_only` + `create_schedule` to an unknown recipient)
  and §6 #2 (`create_schedule` with a disallowed asset), asserting the chosen behaviour.
- **ABI impact:** none if kept; behaviour change (and possibly a new typed error) if changed.

### V2-09 — Optional storage schema version
- **Finding:** F-11 (Info) — non-upgradeable by design; a schema version would make future migrations
  possible without ambiguity.
- **Exact change:** store a `SchemaVersion` key on first write and expose `get_schema_version()`
  (optional; only if it does not delay the batch).
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`
  (copy of v0.1 as the starting point, then apply the change), `contracts/Cargo.toml` (workspace member),
  `contracts/DEPLOYED.md` (new `polaris_guard_v2` section).
- **Test to add:** "schema version is set once and readable".
- **ABI impact:** additive read function; still bundled into the single new deployment
  (`polaris_guard_v2`).

### V2-idea (PARKED) — Keeper tip (D14)
- **Idea:** `execute_schedule` needs no auth, so anyone can trigger a due schedule. A future
  `polaris_guard_v2` could pay a small **tip** to whoever triggers a due schedule, so unrelated third
  parties run keepers without us hosting one.
- **Status:** **PARKED** — not for the hackathon. Would need a new crate per D9 plus careful incentive
  design. The hackathon demo relies on D12 (keeper on the same Mac) and the D14 "app as opportunistic
  keeper" option.
- **Exact change (if picked up):** add tip accounting to the schedule run path; transfer the tip to the
  caller on a successful `execute_schedule`, with the tip size bounded by the rule/allowance.
- **Files:** `contracts/polaris_guard_v2/src/lib.rs`, `contracts/polaris_guard_v2/src/test.rs`,
  `contracts/DEPLOYED.md` (new `polaris_guard_v2` section), keeper docs.
- **ABI impact:** new tip parameters + an extra transfer per run; bundle into the single v0.2 deployment.

### Missing tests to add with the batch (from audit §6)
The following audit §6 cases are not yet covered and should land with the items above (not all map to a
single item): #2 (`create_schedule` disallowed asset), #3 (foreign signatures on
`set_executor`/`revoke_executor`/`set_alias`/`remove_alias`/`cancel_schedule`), #6 (u64 overflow on
schedule advance), #8 (rule removed after schedule creation → `NotConfigured`).

## Read-only task — verify deployed wasm hash on-chain
- **What:** `stellar contract fetch` the deployed code and `sha256` it against the value in
  `contracts/DEPLOYED.md` (`c4f65e65…`). The audit had no network, and the review reproduced the hash
  from source but did not fetch the chain code.
- **How:**
  ```bash
  caffeinate -i stellar contract fetch --id CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D \
    --network testnet --out /tmp/polaris_guard_deployed.wasm
  shasum -a 256 /tmp/polaris_guard_deployed.wasm
  ```
- **Acceptance:** hash equals `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6`
  (23,787 bytes). Record the result in `DEPLOYED.md`.
- **Scope:** read-only; does not touch the deployment table, contract IDs or hashes except to confirm
  them.

## Unfinished (handed off)
- All nine items above (V2-01…V2-09), plus the missing tests and the read-only hash check.
- Parked idea **"V2-idea: keeper tip"** (D14) — see above; not part of the v0.2 batch unless promoted.
- Decision on V2-08 (keep vs re-check F-03).

## Blockers
- Waiting on the headless slice (D1 steps 1–3). No implementation until then.

## Review Notes
- Any v0.2 PR must be reviewed by a worker who did not write it (constitution §3) and must include the
  corresponding `DEPLOYED.md`/`errors.ts`/keeper README updates in the same PR (constitution §7).

## Suggested Next Step
- Finish the headless slice, then open `feat/guard-v0.2` with all items in one branch, one PR, one new
  deployment (new contract id, `polaris_guard_v2`); run the full contract + keeper + anchor suites and
  update `DEPLOYED.md` in the same PR.
