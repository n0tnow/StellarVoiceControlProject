# Polaris keeper

Soroban has no built-in cron. The `polaris_guard` contract stores the user's
scheduled payments and enforces their rules on-chain, but something off-chain
must *call* `execute_schedule(id)` when a schedule becomes due. That something
is the keeper.

## Trust model

The keeper is **untrusted by design**.

| Concern | Who decides |
|---|---|
| Is the schedule due (time)? | the contract (`execute_schedule` checks ledger time) |
| Amount, recipient, asset, limits, allowance | the contract |
| Who pays the recipient | the user's own allowance to the guard, not the keeper |
| Who pays the network fee | the keeper key (`KEEPER_SECRET`) |

Consequences:

- `KEEPER_SECRET` should hold a **little testnet XLM and nothing else**. It can
  spend that XLM on fees; it cannot move user funds, change schedules or bypass
  a rule. Never reuse a user key here.
- A malicious or buggy keeper can only (a) fail to trigger a schedule
  (liveness) or (b) trigger one that is legitimately due. It cannot make the
  contract accept a payment the rules forbid.
- Anyone can run a keeper; two keepers racing on the same schedule is safe, the
  loser is rejected by the contract (`already executed` / `not due`).
- The keeper refuses to sign anything that needs authorization from an address
  other than itself, and refuses fees above `KEEPER_MAX_FEE_STROOPS`.
- Secrets are read from the environment only and never logged (the `config`
  log line shows the derived public key).

## What one tick does

1. Resolve any earlier transaction that has no final status yet.
2. Simulate `list_due` from the keeper account, page by page, resuming where the
   previous tick stopped and wrapping only at the end of the id space (bounded:
   stops at `KEEPER_MAX_PER_TICK` eligible ids, at the end of the list, when the
   cursor stops advancing, or after 10 pages).
3. For each due id (up to `KEEPER_MAX_PER_TICK`, one at a time):
   `getAccount` -> build `execute_schedule(id)` -> `simulateTransaction` ->
   (if the simulation asks for it, `RestoreFootprint` for archived entries and
   re-simulate) -> `assembleTransaction` (footprint, auth, resource fee) ->
   sign -> `sendTransaction` -> poll `getTransaction` until `SUCCESS`/`FAILED`.
4. Log every outcome as a JSON line.

A schedule the contract refuses is already rejected at simulation time, so a
refused run costs no fee.

## Missed runs are skipped, not replayed

This is the contract's rule and the keeper never assumes otherwise: if the
keeper (or the RPC) is down for many intervals, `execute_schedule` settles **one**
payment and moves `next_run_at` to the first slot strictly after now; the missed
slots are dropped and `runs_left` drops by one. So the keeper has no catch-up
logic, never loops on a schedule, and a schedule that was refused for a week
(say, the allowance was revoked) pays once when the cause is fixed, not a
backlog. Each `executed` log line includes an `after` object
(`next_run_at`, `runs_left`, `active`) read back from the contract.

## Robustness

- **No double submit.** An id being executed, or whose transaction has no final
  status yet, is never submitted again. An unresolved transaction is tracked by
  hash and re-checked each tick; once its validity window (+ slack) has passed
  without inclusion it is treated as dead and the id becomes eligible again.
- **Per-id backoff, by error class** (exponential, capped; see `errors.ts`):

  | Class | Meaning | Backoff |
  |---|---|---|
  | `already_executed` | someone else ran it | 1 min .. 10 min |
  | `not_due` | ledger-clock skew (`ScheduleNotDue` #110) | 15 s .. 2 min |
  | `inactive` | cancelled / exhausted / unknown id (#109, #111, #112) | 5 min .. 1 h |
  | `rule_violated` | the owner's rule forbids this run (#100-#106, #114) | 1 min .. 1 h |
  | `allowance_missing` | SAC allowance revoked/short (`InsufficientAllowance` #116) or token balance too low | 1 min .. 1 h |
  | `unknown_contract` | unmapped contract error code, `Overflow` #115 | 1 min .. 30 min |
  | `auth_required` | needs a foreign signature (#107, #108, #113; or auth found at simulation) | 5 min .. 1 h |
  | `keeper_funds` | keeper underfunded / fee above cap | 1 min .. 10 min |
  | `bad_seq`, `tx_expired`, `rpc` | transient | 5 s .. 1 min |

  Backed-off ids do not starve other schedules: the `list_due` page size grows
  by the number of suppressed ids.
- **The sweep cursor is remembered across ticks.** A tick resumes at the page
  where the previous one stopped and wraps to 0 only when the contract reports
  the end of the id space, so a due schedule behind one tick's page budget
  (10 pages x `limit` ids) is reached within a bounded number of ticks instead
  of never — the guard id space is global and only grows, so ids near the top
  must not require a reset to 0. The cursor is in-memory like the rest of the
  state: a keeper restart starts a fresh sweep from id 0 (worst case, one extra
  sweep window before a far id is re-reached).
- **RPC failures** never crash the loop: a failing `list_due` is logged and the
  next attempt waits with growing delay (up to 2 min), then resumes. A page that
  fails mid-sweep is retried by the next tick (the cursor does not advance past
  it).
- **Sequence numbers** always come fresh from the network (`getAccount`) for
  every attempt; submissions are sequential, so there is no local counter to
  drift. A `txBadSeq` is classified as transient and retried.
- **Restarts** are safe: state is in memory only. `list_due` is the source of
  truth, and the contract rejects stale/duplicate runs, so the worst case after
  a restart is one extra attempt that fails at simulation.
- **Shutdown:** the first `SIGINT`/`SIGTERM` finishes the submission in flight
  (so its hash is not lost) and exits; a second one forces exit.

## Run it

Needs Node >= 22.18 (the release where native TypeScript execution is on by
default) and a deployed `polaris_guard`.

```bash
# 1. Create a throwaway testnet keeper key and fund it (a few XLM is plenty).
stellar keys generate keeper --network testnet --fund      # or any funded testnet key

# 2. Configure (repo-root .env is loaded automatically; see .env.example).
export KEEPER_SECRET=$(stellar keys show keeper)            # never commit this
export GUARD_CONTRACT_ID=C...                               # see contracts/DEPLOYED.md

# 3. Run.
npm run keeper       -w @polaris/stellar                    # poll forever
npm run keeper:once  -w @polaris/stellar                    # one tick, then exit (demos/CI)
npm run keeper       -w @polaris/stellar -- --dry-run       # simulate only, submit nothing
```

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_SECRET` | required | key that pays fees (S...) |
| `GUARD_CONTRACT_ID` | required | guard contract (C...) |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | falls back to `STELLAR_RPC_URL` |
| `NETWORK_PASSPHRASE` | testnet passphrase | falls back to `STELLAR_NETWORK_PASSPHRASE` |
| `KEEPER_POLL_SECONDS` | `15` | seconds between ticks |
| `KEEPER_MAX_PER_TICK` | `5` | max executions per tick |
| `KEEPER_DRY_RUN` | `false` | simulate only (also `--dry-run`) |
| `KEEPER_TX_TIMEOUT_SECONDS` | `30` | transaction validity window |
| `KEEPER_MAX_FEE_STROOPS` | `5000000` | refuse to sign above this fee |
| `KEEPER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

`--once` exits `0` when the tick completed (even if the contract refused some
schedules) and `1` on a config error or when `list_due` itself failed.

### Log lines

One JSON object per line on stdout:

```json
{"ts":"2026-09-19T12:00:00.000Z","level":"info","event":"executed","id":7,"hash":"ab12...","status":"SUCCESS","ledger":1234567}
{"ts":"...","level":"warn","event":"rejected","id":8,"status":"REJECTED","error":{"kind":"allowance_missing","name":"SacAllowanceError","code":9,"message":"HostError: Error(Contract, #9)"},"retryInMs":60000}
```

Events: `config`, `keeper_started`, `executed`, `dry_run`, `pending`,
`restore_pending`, `restore_confirmed`, `restore_failed`, `restore_rejected`,
`failed`, `rejected`, `list_due_failed`, `pending_check_failed`,
`shutdown_requested`, `keeper_stopped`, `once_done`.

## Contract ABI used

Deployed `polaris_guard` (see `contracts/DEPLOYED.md`); multi-tenant, no init/admin. Current testnet deployment
(2026-09-19): `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`; the earlier `CDIWQTYA…` and `CB5CQHV6…`
are DEPRECATED. The keeper always takes the id from `GUARD_CONTRACT_ID` — no default is compiled in.

- read (simulated by the keeper account):
  - `list_due(cursor: u32, limit: u32) -> (Vec<u32>, u32)`: ids due at the
    current ledger time, scanning at most `limit` ids from `cursor` (the
    contract clamps `limit` to its own `MAX_DUE_SCAN = 100`). The returned
    cursor is the id to pass next, or `0` once the scan reached the end of the
    id space; `SorobanChain.listDue` maps that `0` to `nextCursor: null` (the
    port's only end-of-pages signal). Only `SorobanChain.listDue` in `chain.ts`
    knows this signature; the keeper loop talks to a paged interface
    (`listDue(cursor, limit) -> { ids, nextCursor }`).
  - `get_schedule(id: u32) -> Option<Schedule>` (`null` when unknown); used for
    the `after` state in logs and for dry-run output.
- write: `execute_schedule(id: u32)`, no caller auth, one run per call.

### Error codes

Guard errors start at **100** on purpose, so a code below 100 came from a
built-in contract (Stellar Asset Contract / account contract) or the host, never
from guard policy. `GUARD_ERRORS` and `TOKEN_ERRORS` in `errors.ts` map both
ranges to the classes above (e.g. `#110 ScheduleNotDue` -> `not_due`,
`#116 InsufficientAllowance` -> `allowance_missing`, SAC `#9 AllowanceError` ->
`allowance_missing`). `TOKEN_ERRORS` covers `soroban-env-host`'s shared
`ContractError` codes 2..15 (4 `UnauthorizedError`, 5 `AuthenticationError`,
7 `AccountIsNotClassic`, 14 `InsufficientAccountReserve`, 15
`TooManyAccountSubentries`, ...); code 1 is reserved upstream and intentionally
unmapped, so it degrades to `unknown_contract`. A test parses the contract's
`#[contracterror]` enum and fails if the guard table drifts. Unmapped codes
still work (`unknown_contract`, backed off).

Only a few codes can come out of `execute_schedule` in practice: `#109`, `#110`,
`#111`, `#116`, plus the rule checks (`#100`, `#103`, `#104`, `#106`).

## Tests

```bash
npm test -w @polaris/stellar     # node:test, no network: fake chain + fake RPC
npm run check -w @polaris/stellar
```
