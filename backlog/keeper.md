# Report: keeper
- **Date:** 2026-09-19
- **Worker/Agent:** W3 (Claude Sonnet 5)
- **Branch/Worktree:** `feat/keeper` / `.worktrees/keeper`
- **PR:** draft PR on `n0tnow/StellarVoiceControlProject` (link in the coordinator hand-off)

## Completed
- `stellar/src/keeper/` — the off-chain keeper for `polaris_guard` schedules:
  - `config.ts` env config (`KEEPER_SECRET`, `GUARD_CONTRACT_ID`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`,
    `KEEPER_POLL_SECONDS`, `KEEPER_MAX_PER_TICK`, `KEEPER_DRY_RUN`, plus `KEEPER_TX_TIMEOUT_SECONDS`,
    `KEEPER_MAX_FEE_STROOPS`, `KEEPER_LOG_LEVEL`); secrets never logged (`redactedConfig` prints the public key).
  - `chain.ts` `SorobanChain`: `list_due`/`get_schedule` via simulation; `execute_schedule` via
    getAccount -> build -> simulate -> (RestoreFootprint + re-simulate when the simulation carries a `restorePreamble`)
    -> refuse non-source auth -> `assembleTransaction` -> fee cap -> sign -> `sendTransaction` -> poll `getTransaction`.
    Tx hash is computed locally before sending, so an ambiguous send/poll failure never loses a transaction.
  - `keeper.ts` `Keeper`: tick loop, in-flight set, pending-tx tracking by hash (resolved next tick; dead once
    max-time + slack passes), per-id exponential backoff by error class, `list_due` page grows with suppressed ids
    (no starvation), loop survives RPC errors with tick-level backoff, abortable sleep, graceful SIGINT/SIGTERM.
  - `errors.ts` classification (`already_executed`, `not_due`, `inactive`, `rule_violated`, `allowance_missing`,
    `unknown_contract`, `auth_required`, `keeper_funds`, `bad_seq`, `tx_expired`, `rpc`, `unknown`) + backoff table.
  - `cli.ts` (`--once`, `--dry-run`), `log.ts` (JSON lines), `xdr-compat.ts`, `index.ts`, `README.md`
    (trust model + how to run).
- Scripts in `stellar/package.json`: `keeper`, `keeper:once`, `test` (node:test, no new dev-dependency).
  Run as `npm run keeper -w @polaris/stellar` / `npm run keeper:once -w @polaris/stellar`.
- Only dependency added: `@stellar/stellar-sdk` (resolved 17.1.0). Shared-file edits: `stellar/package.json`,
  `stellar/tsconfig.json` (`types: node`, `allowImportingTsExtensions`, `erasableSyntaxOnly` so the code also runs
  under Node's native TS stripping), `stellar/src/index.ts` (one namespaced export `keeper`), `.env.example`.
- Tests (round 1: 41; now 53, see Round 2): `npm test -w @polaris/stellar`, no network. Cover: due id executed once, duplicate ids,
  concurrent tick suppression (in-flight), pending-tx blocks resubmission, error classification, exponential
  backoff, no starvation, RPC failure recovery (`list_due` failure and thrown execute errors), `run()` backoff/abort,
  dry-run submits nothing (loop and chain level), restore-then-execute, foreign-auth refusal, fee cap, bad seq,
  TRY_AGAIN_LATER, ambiguous send, polling error, expiry, FAILED decoding, fresh sequence per attempt, config parsing.
- `make check` passes (needs `~/.cargo/bin` on PATH for the Rust step in this environment).

### Round 2 (after W1 pushed the real guard, PR #10)
- Aligned to the real ABI (contract read from `origin/feat/guard-rules-schedule`, read-only): `list_due(limit: u32)
  -> Vec<u32>`, `get_schedule(id: u32) -> Option<Schedule>` (now decoded as `Schedule | null`),
  `execute_schedule(id: u32)` (no auth, one run per call). Multi-tenant: no init/admin, so nothing to configure.
- `GUARD_ERRORS` filled for all 17 guard codes (100-116) plus `TOKEN_ERRORS` for the Stellar Asset Contract range (1-13);
  codes are routed by range so a token error is never read as guard policy. Mapping onto the existing back-off
  classes is in `errors.ts` (e.g. #110 -> `not_due`, #116 -> `allowance_missing`, #111/#109 -> `inactive`,
  #100/#103/#104/#106 -> `rule_violated`). A drift test parses the contract's `#[contracterror]` enum
  (`GUARD_SRC=<path>` overrides the location; it skips itself while `contracts/polaris_guard` on main predates the enum;
  I ran it against W1's source: green).
- Missed runs are skipped, not replayed: the keeper has no catch-up logic; `executed` log lines now carry an `after`
  object (`next_run_at`, `runs_left`, `active`) read back via `get_schedule`. Tests model the contract's skip rule and
  prove: 50 missed intervals -> one run; a week of refusals then a fix -> one run, not a burst; a stale `list_due`
  claiming a not-due id -> quiet `not_due` + short back-off.
- Coordinator's heads-up on the upcoming paginated `list_due` (index removal): the keeper now talks to a paged port
  `listDue(cursor, limit) -> {ids, nextCursor}` and loops **bounded** (stops at `KEEPER_MAX_PER_TICK` eligible ids, at
  `nextCursor === null`, when the cursor does not advance, or after 10 pages; a failure on a later page keeps what was
  found). The one place that knows the on-chain `list_due` signature is `SorobanChain.listDue` in `chain.ts`
  (currently a single page, `nextCursor: null`). 6 tests cover the cursor loop.
- Unit tests now: 53 (`npm test -w @polaris/stellar`), `npm run check` green.

### End-to-end on testnet against the REAL deployed guard: DONE
Guard `CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY` (W1's deployment, the version *before* the planned
paging/index change). Everything below used my own throwaway testnet identities (nothing from W1's keystore, no
shared anchor treasury; keys stayed in a scratch keystore outside the repo):

| Role | Address |
|---|---|
| asset issuer (`KUSD`) | `GA4YDDUKOLLT5N3XSVFUFVSPPZM4FIS3JOACADSA7ATW66PCU4QGCUMU` |
| asset SAC | `CDIDJ77RTJJNG43AAYTYLH325AZNFCZX2A5PU3XKI3OJSOAX5D76YAJG` |
| owner (user) | `GAS7YDBW5ZMQHFYEJX6HCBA2F5PPCEKLXRYLAWU5YFW5UAMLXIGQB472` |
| payee | `GCH3MNOFKMVS6YWEYN2B44O3GC3QLRVAON3H6G4JTIABE75VFCW7NEJY` |
| keeper (fees only) | `GDQA5CLSYGNXIJ4NG3YWDV6UQVZUOQ7P55PU7QFZWWAE4J4H34XZFV6V` |

Setup (per `contracts/DEPLOYED.md`): trustlines + 1000 KUSD to the owner, SAC deployed, owner `approve`d the guard for
100 KUSD, `set_rule` (auto-approve 10, per-tx 50, daily 200, allowed asset = KUSD SAC). Then schedules:
id 2 one-shot 2 KUSD, id 3 recurring 1 KUSD every 30 s x 6 (both due ~70 s after creation), id 4 one-shot far in the
future, id 5 one-shot 3 KUSD due immediately. The keeper (`npm run keeper -w @polaris/stellar`, `KEEPER_POLL_SECONDS=10`)
was started *before* they were due.

1. **Executes when due** (run 1, keeper started 12:54:13, schedules due 12:54:55; polls at 10 s):
```
{"event":"keeper_started","pollSeconds":10,"dryRun":false}
{"event":"executed","id":2,"hash":"b7c4ab6bb6ce50303fdeb3639c9477a8dd4b7587fc4fbefd14c7584786c3cfc1","status":"SUCCESS","ledger":4759785,"after":{"next_run_at":"1789822495","runs_left":0,"active":false}}
{"event":"executed","id":3,"hash":"46ef2435f47e33f66ed25314806239b612e88f05140ef3c677f6dbdb87819bb7","status":"SUCCESS","ledger":4759786,"after":{"next_run_at":"1789822525","runs_left":5,"active":true}}
{"event":"executed","id":3,"hash":"e56be0cce2af2abcccff45a45e1b22e80cee5012383944aa3aa55a27e065d287","status":"SUCCESS","ledger":4759789,"after":{"next_run_at":"1789822555","runs_left":4,"active":true}}
{"event":"shutdown_requested","signal":"SIGINT"}
{"event":"keeper_stopped","pending":[]}
```
2. **Missed runs are skipped, not replayed.** Keeper stopped at 12:55:44 with `next_run_at=1789822555`; ~146 s offline
   (about 5 missed 30 s slots), then restarted at 12:58:10:
```
{"event":"keeper_started","pollSeconds":10,"dryRun":false}
{"event":"executed","id":3,"hash":"3b44a4cca76529b0e546bed52daa510af5d7cb31aa9e496c55797667d3148c65","status":"SUCCESS","ledger":4759822,"after":{"next_run_at":"1789822705","runs_left":3,"active":true}}
{"event":"executed","id":3,"hash":"055c2a314f940f65126a0e18b4193015df33caee51bd4b7d979e9af1e3f52385","status":"SUCCESS","ledger":4759825,"after":{"next_run_at":"1789822735","runs_left":2,"active":true}}
{"event":"shutdown_requested","signal":"SIGINT"}
{"event":"executed","id":3,"hash":"6a7d2cc6b71de7a7d0a9f0ab29a23e4cd0608f23cbeeec48cac84b928d10b0be","status":"SUCCESS","ledger":4759832,"after":{"next_run_at":"1789822765","runs_left":1,"active":true}}
{"event":"keeper_stopped","pending":[]}
```
   One payment on the first tick (`runs_left` 4 -> 3, not 4 -> 0), `next_run_at` jumped from 555 to 705 (four slots
   dropped) and the following runs are 30 s apart. The last line also shows graceful shutdown: the in-flight
   submission finished and was logged before the keeper stopped.
3. **Early / not-due / inactive / unknown calls are handled.** In normal operation the keeper never calls an undue id
   (it only acts on `list_due`), so I forced it: a scratch script (not committed) made the real chain adapter's
   `listDue` return stale ids `[4, 2, 9999]`, id 4 being due in an hour:
```
{"event":"forced_tick","ids":[4,2,9999]}
{"level":"info","event":"rejected","id":4,"status":"REJECTED","error":{"kind":"not_due","name":"ScheduleNotDue","code":110,"message":"HostError: Error(Contract, #110)"},"retryInMs":15000}
{"level":"warn","event":"rejected","id":2,"status":"REJECTED","error":{"kind":"inactive","name":"ScheduleInactive","code":111,"message":"HostError: Error(Contract, #111)"},"retryInMs":300000}
{"level":"warn","event":"rejected","id":9999,"status":"REJECTED","error":{"kind":"inactive","name":"ScheduleNotFound","code":109,"message":"HostError: Error(Contract, #109)"},"retryInMs":300000}
{"event":"forced_tick_done","ok":true,"due":3,"attempted":3,"executed":0,"failed":3}
{"event":"forced_tick_again","ok":true,"due":3,"attempted":0,"executed":0,"failed":0}
```
   The second tick attempted nothing (all three suppressed by back-off). No fee is spent on these: they fail at simulation.
4. **Dry-run on the real contract** (`npm run keeper:once -w @polaris/stellar -- --dry-run`, ids 3 and 5 due):
   `dry_run` events with the decoded `get_schedule` record (`amount":"30000000"`, `runs_left":1`, ...), `executed":0`,
   nothing submitted.
5. **Revoked allowance (`InsufficientAllowance` #116)**: owner `approve ... --amount 0`, then `keeper:once`:
```
{"level":"warn","event":"rejected","id":3,"status":"REJECTED","error":{"kind":"allowance_missing","name":"InsufficientAllowance","code":116,"message":"HostError: Error(Contract, #116)"},"retryInMs":60000}
{"level":"warn","event":"rejected","id":5,"status":"REJECTED","error":{"kind":"allowance_missing","name":"InsufficientAllowance","code":116,"message":"HostError: Error(Contract, #116)"},"retryInMs":60000}
```
   After re-approving, the next `keeper:once` executed both:
```
{"event":"executed","id":3,"hash":"b2f0c79804e8cff38e2f6fa654b0da00d3f6a5d66951ce87bcf482a1097ef854","status":"SUCCESS","ledger":4759851,"after":{"next_run_at":"1789822765","runs_left":0,"active":false}}
{"event":"executed","id":5,"hash":"7d65bca96cb4272822988dd319c183b7d72425bebc4422e2bdd204105ce81cd5","status":"SUCCESS","ledger":4759852,"after":{"next_run_at":"1789822790","runs_left":0,"active":false}}
```
6. **Money check:** payee balance `110000000` raw (= 11 KUSD = 2 + 6x1 + 3) and owner `spent_today` `110000000`:
   every payment made exactly once, no duplicates, no catch-up.

(An earlier smoke test against a throwaway stand-in contract, before W1's push, is superseded by the above.)

## Unfinished (handed off)
- **Re-run the E2E and update `chain.ts` once W1 pushes the final paginated `list_due` + new contract ID**
  (coordinator will message). Expected change is confined to `SorobanChain.listDue` (+ `GUARD_ERRORS` if the enum
  changes, and README/report). Commands:
  ```bash
  export KEEPER_SECRET=<funded testnet key>  GUARD_CONTRACT_ID=<new C... from DEPLOYED.md>
  npm run keeper:once -w @polaris/stellar -- --dry-run
  npm run keeper -w @polaris/stellar
  ```
- `scripts/check.sh` does not run `npm test`; adding it there was out of scope (shared file).

## Blockers
- None. (W1's ABI is in flux: paginated `list_due` and a new contract ID are coming; see Unfinished.)

## Review Notes
- Design choices worth a reviewer's eye:
  1. Sequential execution (one tx at a time, fresh `getAccount` each time) instead of managing sequence numbers
     locally: slower under heavy load, but no sequence drift, no restart state, trivial to reason about.
  2. Low-level `Contract.call` + `simulateTransaction` + `assembleTransaction` rather than `contract.Client`
     (which Raven's dapp skill calls canonical for clients): the keeper needs control over restore, auth refusal,
     fee cap and hash tracking.
  3. `xdr-compat.ts`: SDK 17 exposes XDR unions as objects (`.type`, properties); older SDKs use `.switch().name`
     and accessor methods, and the Raven skill/docs examples still show the old style. The keeper only *reads* a few
     result fields, so a tiny compat reader keeps it working on either.
  4. Restore fee: `TransactionBuilder.build()` adds the `transactionData` resource fee to the fee we pass, so the
     restore transaction is built with the base fee only (adding `minResourceFee` too would double-count).
  5. Node >= 22 native TS: `.ts` import specifiers, no enums/parameter properties (`erasableSyntaxOnly` enforces it).
  6. Signed transactions are limited to a single `execute_schedule` invocation whose auth is source-account only.
  7. Multi-tenant guard: `list_due` returns due schedules of *every* owner, so the keeper serves everyone by design;
     anyone can run one. Refusals cost nothing (they fail at simulation), so a schedule whose owner tightened the rule
     or revoked the allowance is only re-simulated on the back-off cadence (max 1 h).
- ABI mismatches worked around: (a) `get_schedule` returns `Option<Schedule>` (I had assumed a bare `Schedule`) ->
  `Schedule | null`; (b) error codes start at 100 (I had an empty table) -> tables + range routing; (c) missed runs are
  skipped (no replay) -> logging/tests; (d) `list_due` is about to become paginated -> isolated + bounded cursor loop.
  Function names and argument types (`u32` ids/limits, no auth on `execute_schedule`) matched what I was told.
  Minor doc inconsistency in W1's `demo.sh` comments: it says `expiration_ledger` where the argument is
  `live_until_ledger` (DEPLOYED.md has it right).
- Reviewer should not be W3.

## Suggested Next Step
- After W1's final ABI lands: adjust `SorobanChain.listDue`, re-run the E2E, refresh this report.
- Then wire `npm test -w @polaris/stellar` into `scripts/check.sh` and decide where the keeper runs (a small VM/launchd
  job on the demo machine; it only needs a few XLM).

## Raven calls
1. `stellarDocs.search_rpc_horizon_data_docs` / `search_docs` / `search_soroban_contract_docs` /
   `search_sdk_cli_tools_docs` — queries for `simulateTransaction`, `sendTransaction`, `getTransaction` polling,
   `assembleTransaction`, restore of archived entries.
   Came back: the RPC/Horizon-scoped op returned soft-empty (per-method reference pages are not indexed);
   `search_docs` gave the frontend guide snippet "poll `getTransaction` until status is not NOT_FOUND";
   soroban docs gave the simulateTransaction guide ("Handling archived ledger entries", `restorePreamble`) and the
   "Restore archived contract data using the JavaScript SDK" page; the transaction-simulation fundamentals page
   (footprint may go stale -> re-simulate). Changed: implemented restore -> re-simulate -> assemble; poll-until-final;
   re-simulate on each attempt instead of caching footprints.
2. `search(kind: skill)` -> `skills.stellar-dev.dapp`, `skills.stellar-dev.data`; `codemode.skill.read` sections
   `sdk-initialization`, `transaction-building`, `transaction-submission`, `transaction-ux-checklist`, `stellar-rpc`,
   `best-practices`. Came back: `rpc.Server`, `Contract.call`, `prepareTransaction` = simulate + `assembleTransaction`,
   `Api.isSimulationError/isSimulationSuccess`, the NOT_FOUND polling loop, `contract.Client` as the canonical client
   path, and "getTransaction covers ~7 days" as an RPC limitation. Changed: kept `Server`/`assembleTransaction`
   (low-level path, reason in Review Notes); a pending hash must be resolved well inside the retention window
   (it is: we resolve within one tick / max-time + slack).
3. `stellarDocs.get_doc_page_sections` for `/docs/build/guides/transactions/simulateTransaction-Deep-Dive`,
   `/docs/build/guides/archival/restore-data-js`, `/docs/build/guides/transactions/submit-transaction-wait-js`:
   "not found in these sources" (paths not in the docs index); I used the search snippets/`includeContent` for the
   first two and nothing for the third.
4. `stellarDocs.search_docs("sendTransaction TRY_AGAIN_LATER DUPLICATE ERROR status")`: off-target hits only
   (guestbook tutorial) -> **not found in these sources**. The `sendTransaction` status set
   (`PENDING | DUPLICATE | TRY_AGAIN_LATER | ERROR`) and `errorResult` shape were therefore taken from the installed
   SDK's type definitions (`@stellar/stellar-sdk` 17.1.0), not from Raven, and handled accordingly
   (ERROR -> classify tx result code; TRY_AGAIN_LATER -> transient; DUPLICATE/PENDING -> poll).
5. Finding: Raven's examples use the pre-17 XDR accessor style; the installed SDK is 17.1.0, which changed it
   (see Review Notes 3). Not something Raven could tell me; discovered by the type checker.

### Round 2 Raven calls
6. `stellarDocs.search_docs("Stellar Asset Contract error codes AllowanceError BalanceError TrustlineMissingError")` ->
   the SAC `ContractError` enum (1 Internal, 2 OperationNotSupported, 3 AlreadyInitialized, 6 AccountMissing,
   8 NegativeAmount, 9 AllowanceError "insufficient allowance / bad expiration", 10 BalanceError, 11 BalanceDeauthorized,
   12 Overflow, 13 TrustlineMissing; 4, 5, 7 unused). Changed: `TOKEN_ERRORS` (codes < 100) with the kinds above; this
   independently confirms W1's claim that 1-13 belong to the token.
7. `stellarDocs.search_soroban_contract_docs("contract invoking another contract authorization implicit invoker ...")`:
   off-target (custom-account/testing pages) -> **not found in these sources** for a direct statement that a
   contract-to-contract `transfer_from` needs no auth entry from the keeper. Settled empirically instead: the real
   simulations returned no foreign auth entries and executed with a source-account-only signature (see E2E).
8. `stellarDocs.search_docs("signing soroban invocations source account credentials")` ->
   `/docs/build/guides/transactions/signing-soroban-invocations#how-it-works`: when the tx source equals the
   authorized address, the envelope signature suffices (`sorobanCredentialsSourceAccount`). Confirms the keeper's
   "sign only as source, refuse any other credential" rule.
9. `stellarDocs.search_docs("SEP-41 token interface transfer_from spender allowance approve live_until_ledger")` ->
   token-interface docs show `approve(from, spender, amount, live_until_ledger)`; matches W1's DEPLOYED.md note (used
   `--live_until_ledger` in my setup, worked).
10. `stellarDocs.search_docs("Error(Contract, #) contract error code diagnostic events simulateTransaction error")` ->
    only a generic "recoverable and non-recoverable errors" overview -> **not found in these sources** for the exact
    text format. The `HostError: Error(Contract, #N)` shape and the fact that it is the first line of `sim.error` were
    taken from real simulations (E2E logs above) and W1's DEPLOYED.md.
