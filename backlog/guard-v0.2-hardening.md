# Report: guard-v0.2-hardening
- **Date:** 2026-09-19
- **Worker/Agent:** coordinating agent (plan) — implementation unassigned
- **Branch/Worktree:** none yet (PLANNED) — suggest `feat/guard-v0.2`
- **PR:** none
- **Status:** **planned, not started**

## Completed
- Nothing implemented. This file is the batched v0.2 specification for `polaris_guard`, sourced from
  `backlog/contracts-audit.md` (findings F-01…F-12, N-01…N-03) and `backlog/contracts-audit-review.md`.
- N-03 is documented, not fixed, in v0.2.

## Preconditions
1. **Only after the headless slice works** (D1 steps 1–3: real `sendPayment`, guard owner-side TS
   client, headless e2e `Intent → XDR → sign → submit` with `#105` rejection). Do not start v0.2 before
   the slice is green.
2. **Single redeploy.** All items below ship in ONE new contract version (one new contract ID), never
   item-by-item. Any change here = new contract ID = every owner re-publishes rule + allowance + keeper
   env update.

## ABI impact (applies to the whole batch)
- **Breaking change:** yes — the contract has no upgrade entrypoint, so v0.2 is a **new contract ID**
  (replaces `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`).
- Keeper must be pointed at the new ID via env `GUARD_CONTRACT_ID` (`stellar/src/keeper/README.md`,
  `.env.example`); `contracts/DEPLOYED.md` must be updated (new ID, deploy tx, wasm sha256, explorer).
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
- **Files:** `contracts/polaris_guard/src/lib.rs`, `contracts/polaris_guard/src/test.rs`,
  `stellar/src/keeper/errors.ts` (map code 117 → `rule_violated`), `stellar/src/keeper/README.md`
  (error table), `contracts/DEPLOYED.md` (error table + kill-switch matrix),
  `contracts/scripts/demo.sh` (optional showcase).
- **Test to add:** "pause blocks all three payment paths" + audit §6 #11
  (`revoke_executor` does not stop schedules — document the boundary); assert state unchanged.
- **ABI impact:** new functions + new error; new contract ID; keeper env; DEPLOYED.md.

### V2-02 — On-chain failure counter / auto-deactivation (F-12)
- **Finding:** F-12 (Low) — a schedule that can never succeed stays active forever.
- **Exact change:** add a per-schedule `fail_count: u32` (or a `failed_at` marker); increment on a
  refused/failed run; deactivate + emit `ScheduleCancelled`/`ScheduleDeactivated` after **3 consecutive
  failed runs** (default; making this threshold configurable at create time is out of scope for v0.2).
  Expose it in `get_schedule`/`Schedule`.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`,
  `stellar/src/keeper/errors.ts` (drop `inactive` backoff for deactivated schedules),
  `stellar/src/keeper/chain.ts` (`Schedule` interface gains the field), `stellar/src/keeper/README.md`,
  `contracts/DEPLOYED.md`.
- **Test to add:** "a schedule whose run keeps failing is deactivated after N failures" + audit §6 #4
  (insufficient balance with sufficient allowance) as the failure source.
- **ABI impact:** `Schedule` type change (breaking for the keeper's `get_schedule` decode); new event;
  new contract ID; keeper env; DEPLOYED.md.

### V2-03 — Bump both `Known` and `KnownRefs` TTLs on every alias touch (F-04)
- **Finding:** F-04 (Low) — `Known` vs `KnownRefs` TTL divergence; same-address `set_alias` bumps
  neither.
- **Exact change:** in `set_alias` (both the re-point branch and the same-address branch) and in
  `remove_alias`, call `bump` on both `Known` and `KnownRefs`.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`.
- **Test to add:** audit §6 #10 (`set_alias` idempotence + refcount) plus a TTL-consistency assertion.
- **ABI impact:** none (internal storage behaviour); still bundled into the single redeploy.

### V2-04 — Distinguish `limit=0` from end-of-space in `list_due` (N-01)
- **Finding:** N-01 (Info) — `list_due(cursor, 0)` returns `([], 0)`, same as end-of-space.
- **Exact change:** either reject `limit == 0` with `InvalidAmount`/`InvalidSchedule`, or return a
  distinct sentinel; document the choice in `DEPLOYED.md`.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `stellar/src/keeper/chain.ts`
  (if the sentinel changes), `contracts/DEPLOYED.md` (keeper notes).
- **Test to add:** audit §6 #7 (`list_due` clamp with >100 ids) plus a `limit=0` case.
- **ABI impact:** possible return-value semantics change; bundled into the single redeploy.

### V2-05 — Events for rule/executor/alias mutations (N-02)
- **Finding:** N-02 (Info) — `set_rule`/`set_executor`/`revoke_executor`/`set_alias`/`remove_alias`
  emit no events.
- **Exact change:** publish events from all five mutators (owner, key, and e.g. old/new alias target);
  keep topics small and typed (`#[contractevent]`).
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `contracts/DEPLOYED.md` (events list).
- **Test to add:** assert each mutator emits its event (extend existing auth tests).
- **ABI impact:** additive events only; still bundled into the single redeploy.

### V2-06 — Per-asset daily budgets `Spent(owner, asset)` (spec gap)
- **Finding:** §5(b) of the audit — `daily_limit` is one cross-asset counter, so `set_rule` rejects
  `allowed_assets.len() > 1`.
- **Exact change:** key the spend counter by `(owner, asset)`; lift the `> 1` restriction in
  `validate_rule`; make `MAX_ALLOWED_ASSETS` reachable (F-08) and update its comment.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `contracts/DEPLOYED.md`
  ("One asset per rule, for now" section), `stellar/src/keeper/errors.ts` if codes shift.
- **Test to add:** "multi-asset rules keep independent daily budgets" + audit §6 #5 (i128 overflow on
  the daily counter).
- **ABI impact:** storage layout change (`Spent` key); new contract ID; keeper env; DEPLOYED.md.

### V2-07 — Per-day transaction-count / velocity cap (review M2)
- **Finding:** §5(b) of the audit — `daily_limit` is the only proxy for transaction count.
- **Exact change:** add a per-owner per-day transaction-count cap (and/or a velocity window) to `Rule`
  and enforce it in all payment paths.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `contracts/DEPLOYED.md`.
- **Test to add:** "N+1 payments in a UTC day are rejected by the count cap" + audit §6 #9
  (allowance exactly equal to amount boundary).
- **ABI impact:** `Rule` type change (breaking for clients constructing rules); new contract ID;
  keeper env; DEPLOYED.md.

### V2-08 — Decide F-03: re-check `known_recipients_only` at run time, or keep
- **Finding:** F-03 (Low) — `execute_schedule` skips the known-recipient check; removing/re-pointing an
  alias does not stop an existing schedule.
- **Exact change (decision needed):** either (a) keep the current behaviour and document it as a product
  promise, or (b) add a `Known` read (refcount-aware) in `execute_schedule` so alias removal stops
  schedules. If (b), a schedule to an alias that is later removed must fail closed.
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `contracts/DEPLOYED.md` (rule
  promises + demo talking points).
- **Test to add:** audit §6 #1 (`known_recipients_only` + `create_schedule` to an unknown recipient)
  and §6 #2 (`create_schedule` with a disallowed asset), asserting the chosen behaviour.
- **ABI impact:** none if kept; behaviour change (and possibly a new typed error) if changed.

### V2-09 — Optional storage schema version
- **Finding:** F-11 (Info) — non-upgradeable by design; a schema version would make future migrations
  possible without ambiguity.
- **Exact change:** store a `SchemaVersion` key on first write and expose `get_schema_version()`
  (optional; only if it does not delay the batch).
- **Files:** `contracts/polaris_guard/src/lib.rs`, `src/test.rs`, `contracts/DEPLOYED.md`.
- **Test to add:** "schema version is set once and readable".
- **ABI impact:** additive read function; still bundled into the single redeploy.

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
- Decision on V2-08 (keep vs re-check F-03).

## Blockers
- Waiting on the headless slice (D1 steps 1–3). No implementation until then.

## Review Notes
- Any v0.2 PR must be reviewed by a worker who did not write it (constitution §3) and must include the
  corresponding `DEPLOYED.md`/`errors.ts`/keeper README updates in the same PR (constitution §7).

## Suggested Next Step
- Finish the headless slice, then open `feat/guard-v0.2` with all items in one branch, one PR, one
  redeploy; run the full contract + keeper + anchor suites and update `DEPLOYED.md` in the same PR.
