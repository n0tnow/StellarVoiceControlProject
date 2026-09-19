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
- Tests: 41 unit tests (`npm test -w @polaris/stellar`), no network. Cover: due id executed once, duplicate ids,
  concurrent tick suppression (in-flight), pending-tx blocks resubmission, error classification, exponential
  backoff, no starvation, RPC failure recovery (`list_due` failure and thrown execute errors), `run()` backoff/abort,
  dry-run submits nothing (loop and chain level), restore-then-execute, foreign-auth refusal, fee cap, bad seq,
  TRY_AGAIN_LATER, ambiguous send, polling error, expiry, FAILED decoding, fresh sequence per attempt, config parsing.
- `make check` passes (needs `~/.cargo/bin` on PATH for the Rust step in this environment).

### End-to-end on testnet (real RPC, real transactions) — against a STAND-IN contract
W1's guard was not pushed when this was written (`git branch -r` shows no guard branch), so the flow was
verified against a throwaway contract that implements the same ABI (`create`, `list_due`, `get_schedule`,
`execute_schedule`, typed errors). The stand-in source lives only in the scratchpad (not committed).
- stand-in contract: `CBT76X54OWOMIEF72AHBHELWXMWGKCESZFHWQVVUMTXBVZVZOPBCNM5T` (testnet, throwaway)
- keeper key: throwaway, friendbot-funded, `GDQA5CLSYGNXIJ4NG3YWDV6UQVZUOQ7P55PU7QFZWWAE4J4H34XZFV6V`
- schedules: id 1 due now, 3 runs, every 60 s (OK); id 2 far future (never listed); id 3 inactive (contract error #2);
  id 4 amount above rule limit (contract error #3).

Dry-run (`-- --dry-run`, nothing submitted): id 1 -> `dry_run` (with `get_schedule` details), ids 3/4 rejected at simulation.

Continuous mode (`KEEPER_POLL_SECONDS=10`, ~95 s, then SIGINT):
```
{"event":"keeper_started","pollSeconds":10,"dryRun":false}
{"level":"warn","event":"rejected","id":3,"error":{"kind":"unknown_contract","name":"ContractError#2","code":2},"retryInMs":60000}
{"level":"warn","event":"rejected","id":4,"error":{"kind":"unknown_contract","name":"ContractError#3","code":3},"retryInMs":60000}
{"level":"info","event":"executed","id":1,"hash":"951f78df4e7fadd1a0d28875c9224c0d5ad92f20f26d3c03f145a030ebdb5ab8","status":"SUCCESS","ledger":4759611}
{"level":"warn","event":"rejected","id":3,...,"retryInMs":120000}     <- backoff doubled after the retry
{"level":"warn","event":"rejected","id":4,...,"retryInMs":120000}
{"event":"shutdown_requested","signal":"SIGINT"}
{"event":"keeper_stopped","pending":[]}   (exit code 0)
```
`--once` (real run before the loop): id 1 `executed` hash
`6b083415b37a7ee2898f4756b8d2913d5947df758dcca133779e3487f21c7ec1` ledger 4759597; the loop then ran id 1 again
about 60 s later (recurring schedule), i.e. the keeper only triggered each occurrence when due. Errors #2/#3 show as
`unknown_contract` because `GUARD_ERRORS` is intentionally empty until W1's enum lands (graceful degradation).

## Unfinished (handed off)
- **E2E against the real `polaris_guard`: PENDING** (W1 has not pushed a deployment). Exact commands:
  ```bash
  git fetch origin && git show origin/feat/guard-rules-schedule:contracts/DEPLOYED.md   # get the contract id
  export KEEPER_SECRET=<funded testnet key>  GUARD_CONTRACT_ID=<C... from DEPLOYED.md>
  # create a schedule due in ~1 min for a user who has approved an allowance to the guard (per W1's docs), then:
  npm run keeper:once -w @polaris/stellar -- --dry-run     # what would run
  npm run keeper -w @polaris/stellar                       # execute; watch for "event":"executed"
  ```
- **Fill `GUARD_ERRORS` in `stellar/src/keeper/errors.ts`** from the real `#[contracterror]` enum (code -> name ->
  kind) and add a table-driven test. Until then every contract error is `unknown_contract` (still backed off).
- If W1's ABI deviates (names/types of `list_due`, `get_schedule`, `execute_schedule`), adjust `chain.ts` (one place).
- `scripts/check.sh` does not run `npm test`; adding it there was out of scope (shared file).

## Blockers
- W1's contract deployment/branch not available at the time of writing (only affects the real-contract E2E).

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
- Reviewer should not be W3.

## Suggested Next Step
- Merge W1's guard, fill `GUARD_ERRORS`, run the real-contract E2E above and paste the log here.
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
