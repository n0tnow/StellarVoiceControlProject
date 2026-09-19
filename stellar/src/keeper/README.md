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
2. Simulate `list_due(limit)` from the keeper account.
3. For each due id (up to `KEEPER_MAX_PER_TICK`, one at a time):
   `getAccount` -> build `execute_schedule(id)` -> `simulateTransaction` ->
   (if the simulation asks for it, `RestoreFootprint` for archived entries and
   re-simulate) -> `assembleTransaction` (footprint, auth, resource fee) ->
   sign -> `sendTransaction` -> poll `getTransaction` until `SUCCESS`/`FAILED`.
4. Log every outcome as a JSON line.

A schedule the contract refuses is already rejected at simulation time, so a
refused run costs no fee.

## Robustness

- **No double submit.** An id being executed, or whose transaction has no final
  status yet, is never submitted again. An unresolved transaction is tracked by
  hash and re-checked each tick; once its validity window (+ slack) has passed
  without inclusion it is treated as dead and the id becomes eligible again.
- **Per-id backoff, by error class** (exponential, capped; see `errors.ts`):

  | Class | Meaning | Backoff |
  |---|---|---|
  | `already_executed` | someone else ran it | 1 min .. 10 min |
  | `not_due` | ledger-clock skew | 15 s .. 2 min |
  | `inactive` | cancelled / no runs left | 5 min .. 1 h |
  | `rule_violated` | the user's rules forbid this run | 1 min .. 1 h |
  | `allowance_missing` | allowance/balance not there | 1 min .. 1 h |
  | `unknown_contract` | unmapped contract error code | 1 min .. 30 min |
  | `auth_required` | needs a foreign signature | 5 min .. 1 h |
  | `keeper_funds` | keeper underfunded / fee above cap | 1 min .. 10 min |
  | `bad_seq`, `tx_expired`, `rpc` | transient | 5 s .. 1 min |

  Backed-off ids do not starve other schedules: the `list_due` page size grows
  by the number of suppressed ids.
- **RPC failures** never crash the loop: a failing `list_due` is logged and the
  next attempt waits with growing delay (up to 2 min), then resumes.
- **Sequence numbers** always come fresh from the network (`getAccount`) for
  every attempt; submissions are sequential, so there is no local counter to
  drift. A `txBadSeq` is classified as transient and retried.
- **Restarts** are safe: state is in memory only. `list_due` is the source of
  truth, and the contract rejects stale/duplicate runs, so the worst case after
  a restart is one extra attempt that fails at simulation.
- **Shutdown:** the first `SIGINT`/`SIGTERM` finishes the submission in flight
  (so its hash is not lost) and exits; a second one forces exit.

## Run it

Needs Node >= 22 (native TypeScript execution) and a deployed `polaris_guard`.

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
{"ts":"...","level":"warn","event":"rejected","id":8,"status":"REJECTED","error":{"kind":"allowance_missing","name":"AllowanceMissing","code":5,"message":"HostError: Error(Contract, #5)"},"retryInMs":60000}
```

Events: `config`, `keeper_started`, `executed`, `dry_run`, `pending`, `failed`,
`rejected`, `list_due_failed`, `pending_check_failed`, `shutdown_requested`,
`keeper_stopped`, `once_done`.

## Contract ABI used

- read (simulated): `list_due(limit: u32) -> Vec<u32>`,
  `get_schedule(id: u32) -> Schedule` (only for dry-run logs)
- write: `execute_schedule(id: u32)` — no caller auth required.

`GUARD_ERRORS` in `errors.ts` maps the contract's error codes to the classes
above; update it when the `#[contracterror]` enum in `contracts/polaris_guard`
changes. Unmapped codes still work (class `unknown_contract`, backed off).

## Tests

```bash
npm test -w @polaris/stellar     # node:test, no network: fake chain + fake RPC
npm run check -w @polaris/stellar
```
