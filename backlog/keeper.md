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
  (`GUARD_SRC=<path>` overrides the location; `npm -w` runs the test with cwd `stellar/`, so use
  `GUARD_SRC=../../guard-rules/contracts/polaris_guard/src/lib.rs` or an absolute path; it skips itself while
  `contracts/polaris_guard` on main predates the enum; I ran it against W1's source: green).
- Missed runs are skipped, not replayed: the keeper has no catch-up logic; `executed` log lines now carry an `after`
  object (`next_run_at`, `runs_left`, `active`) read back via `get_schedule`. Tests model the contract's skip rule and
  prove: 50 missed intervals -> one run; a week of refusals then a fix -> one run, not a burst; a stale `list_due`
  claiming a not-due id -> quiet `not_due` + short back-off.
- Coordinator's heads-up on the upcoming paginated `list_due` (index removal): the keeper now talks to a paged port
  `listDue(cursor, limit) -> {ids, nextCursor}` and loops **bounded** (stops at `KEEPER_MAX_PER_TICK` eligible ids, at
  `nextCursor === null`, when the cursor does not advance, or after 10 pages; a failure on a later page keeps what was
  found). The one place that knows the on-chain `list_due` signature is `SorobanChain.listDue` in `chain.ts`
  (a single page with `nextCursor: null` in that round; superseded by Round 3 below). 6 tests cover the cursor loop.
- Unit tests now: 53 (`npm test -w @polaris/stellar`), `npm run check` green.

### Round 3 (2026-09-19): paginated ABI + restore-path/host-error fixes
The guard was redeployed with the paginated ABI (`CDIWQTYA7OBF2FKLLHQWYZ2Q2L4PAEBLLMFRXVY4R7MAM45LX7Q2R2XB`,
read-only reference: `.worktrees/guard-rules/contracts/polaris_guard/src/lib.rs:752`). Per the coordinator this round is
code+tests only — no live testnet E2E until the guard worker's final redeploy (the ID may change again).

- **ABI (was a blocker):** `SorobanChain.listDue` (`chain.ts`) now calls `list_due(cursor: u32, limit: u32)` and decodes
  the `(Vec<u32>, u32)` tuple; the contract's end-of-space cursor `0` maps to `nextCursor: null`. The stale comment was
  replaced with the current signature/semantics. The keeper's bounded cursor loop (`keeper.ts`) needed no change and its
  6 cursor-loop fakes still pass. New fake-RPC tests: two-arg call argument assertion, mid-list cursor decode, and a
  two-page sweep ending at cursor 0.
- **K2 (restore fee cap):** `restore()` built/signed/submitted a `RestoreFootprint` without checking
  `KEEPER_MAX_FEE_STROOPS`; only `execute()` had the cap. The RPC-supplied `restorePreamble.transactionData` resource fee
  is attacker-controllable, so the total built fee (base + resource) is now checked BEFORE signing, using an exact
  BigInt comparison (shared `feeAboveCap` helper; the execute path uses it too). Tests: above-cap restore is rejected
  with `FeeAboveCap` and nothing is sent; a restore at exactly the cap is allowed.
- **K3 (restore-pending was reported as executed):** `execute()` returned the restore tx hash as `pending`, the keeper
  stored it, and on a SUCCESS resolution logged `event:"executed"` although `execute_schedule` never ran. New
  `restore_pending` `ExecResult` variant; the keeper tracks the pending hash's `purpose` (`execute` | `restore`). A
  resolved restore now logs `restore_confirmed` (no `executed`) and leaves the id eligible, so the same tick re-executes
  the schedule; failures log `restore_failed`/`restore_rejected` and back off. Tests at both chain and keeper level,
  including "restore hash is never in an `executed` line" and "the schedule runs in the same tick the restore settles".
- **K5:** `getSchedule` tests added: None (`void`) -> `null`, Some -> decoded record with bigint `amount`,
  `next_run_at`, `interval_secs` (and number `id`/`runs_left`).
- **K6:** `TOKEN_ERRORS` was stale. Verified against local `soroban-env-host` 28.0.2 sources
  (`src/builtin_contracts/contract_error.rs`): code 1 is `_Reserved1` and is now intentionally unmapped (degrades to
  `ContractError#1` / `unknown_contract`); 4 `Unauthorized`, 5 `Authentication`, 7 `AccountIsNotClassic`,
  14 `InsufficientAccountReserve`, 15 `TooManyAccountSubentries` are mapped; the full 2..15 table is covered by a new
  test. Guard codes 100-116 are unchanged and still drift-guarded against the contract source.
- **K7:** keeper README Node floor corrected to **>= 22.18** (default type stripping), and `engines.node: ">=22.18"`
  added to `stellar/package.json`.
- Tests now: **64**, 63 pass, 0 fail, **1 conditional skip** (the guard-source drift test skips because this worktree's
  `contracts/polaris_guard` predates the `#[contracterror]` enum; run with
  `GUARD_SRC=../../guard-rules/contracts/polaris_guard/src/lib.rs` from `stellar/` — or an absolute path — it is
  64/64 with 0 skips). Workspace-wide `npm run check` green.

### Round 4 (2026-09-19): live E2E against the FINAL guard deployment
Final guard: `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` (deploy tx
`f6017b43cef06047b6c3bc04e2f88a2e9fb0b3ee3b3aa5a0261a0c43dfacaf59`, wasm sha256
`c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6`, 23,787 bytes). ABI unchanged from Round 3:
`list_due(cursor, limit) -> (Vec<u32>, u32)`, errors 100-116, 19 functions. The intermediate `CDIWQTYA…` is
**DEPRECATED**. Throwaway identities in a scratch config dir outside the repo (nothing from W1's keystore, no
treasury, no shared keys):

| Role | Address |
|---|---|
| asset issuer (`KE2E`) | `GBWI2O4RJJU6Y56UAHTJYL2G2KAO2F3EWOSIJHSMQENNPYWL2TLNNTRY` |
| asset SAC | `CABIE62NFV23AJCPYX5CXXHZ6EVO7ZQ45WOTVPNY65VT337GMIOIR2U2` |
| owner (user) | `GAH46SQ3W7V74L4VT3Z2OVBMJWZXK3KJZ2MEM5KUYR5CK3XC7CS6UAXA` |
| payee | `GD4YHC4UCKO4NLFEOLKGSW7FHSR3KL46NMOBXJK4B43L3VJDA7C25XUR` |
| keeper (fees only) | `GC2YF5BNXUK7SMYX75HIXGBD3RHTCYJFI5UVOKHSBDGH2WHIFCHZPWIW` |

Setup: 1000 KE2E minted to the owner, owner approved the guard for 1000 on the SAC, `set_rule` (auto-approve 10,
per-tx 50, daily 200, allowed_assets = [SAC]). Schedules: ids 2-5 far-future one-shots (id-space holes), id 6 one-shot
2 due immediately, id 7 recurring 1 every 30 s x3, id 8 recurring 1 every 30 s x3, id 9 recurring 1 every 20 s x5,
id 10 one-shot 3 (revocation test). Keeper runs used `KEEPER_POLL_SECONDS=10`, `KEEPER_MAX_PER_TICK=2`.

1. **Dry-run: paging + `get_schedule` decode against the real contract** (`keeper:once --dry-run`,
   `KEEPER_LOG_LEVEL=debug`; the four not-due entries before the due ids force a multi-page sweep):
```
{"event":"tick","due":[6,7],"candidates":[6,7],"limit":2,"pages":4}
{"event":"dry_run","id":6,"schedule":{"active":true,"amount":"20000000","asset":"CABIE62N...","id":6,"interval_secs":"0","next_run_at":"1789826601","owner":"GAH46SQ3...","runs_left":1,"to":"GD4YHC4U..."}}
{"event":"dry_run","id":7,"schedule":{"active":true,"amount":"10000000","interval_secs":"30","next_run_at":"1789826601","runs_left":3,...}}
{"event":"once_done","ok":true,"due":2,"attempted":2,"executed":0,"failed":0,"pending":[]}
```
   4 pages at `limit=2`: the keeper followed `next_cursor` 0 -> 3 -> 5 -> 7 -> 0 across the real id space;
   `get_schedule` decoded (bigint fields appear as JSON strings), nothing signed or sent.
2. **Executes when due** (keeper started before the due time):
```
{"event":"executed","id":6,"hash":"9898fa270e86491014bbb62e46bc8aa9dc86608afa654854a188d5aa7b0633b9","status":"SUCCESS","ledger":4760628,"after":{"next_run_at":"1789826601","runs_left":0,"active":false}}
{"event":"executed","id":7,"hash":"b155636f128cc923c265a1c70621cccf680e890aeea71876547a75899b5e3eee","status":"SUCCESS","ledger":4760629,"after":{"next_run_at":"1789826751","runs_left":2,"active":true}}
{"event":"executed","id":7,"hash":"faf91dc5021d2b9981b917845b6a306e15d4e803014f1c79b40de70cbf4e974c","status":"SUCCESS","ledger":4760636,"after":{"next_run_at":"1789826781","runs_left":1,"active":true}}
{"event":"shutdown_requested","signal":"SIGINT"}
{"event":"executed","id":7,"hash":"187f9b17c1f5a368cef90e3b4b22b778953021e51d72b3d2ca3636acaa3d00df","status":"SUCCESS","ledger":4760640,"after":{"next_run_at":"1789826781","runs_left":0,"active":false}}
{"event":"keeper_stopped","pending":[]}
```
   One-shots end `active:false`; the recurring ran 3 times ~30 s apart; SIGINT flushed the in-flight submission
   before exiting.
3. **Missed runs are skipped, not replayed:** id 8 executed twice, then id 9 ran once at 14:08:08
   (`next_run_at=1789826892`, `runs_left=4`) and once at 14:08:38 (`1789826932`, `runs_left=3`); the keeper was then
   stopped for ~100 s (5 missed 20 s slots). On restart one `keeper:once` made exactly **one** payment:
```
{"event":"executed","id":9,"hash":"4b66d8e27b578331313489b7e1039127b3a6b2a9e989109c2db513a887daa903","status":"SUCCESS","ledger":4760688,"after":{"next_run_at":"1789827032","runs_left":2,"active":true}}
{"event":"once_done","ok":true,"due":1,"attempted":1,"executed":1,"failed":0,"pending":[]}
```
   `next_run_at` jumped 1789826932 -> 1789827032 (exactly the five skipped slots), one payment, not five.
4. **Allowance kill-switch (`InsufficientAllowance` #116) and recovery:** owner `approve --amount 0`, one tick
   rejected both due schedules at simulation (no fee spent):
```
{"level":"warn","event":"rejected","id":9,"status":"REJECTED","error":{"kind":"allowance_missing","name":"InsufficientAllowance","code":116,"message":"HostError: Error(Contract, #116)"},"retryInMs":60000}
{"level":"warn","event":"rejected","id":10,"status":"REJECTED","error":{"kind":"allowance_missing","name":"InsufficientAllowance","code":116,"message":"HostError: Error(Contract, #116)"},"retryInMs":60000}
{"event":"once_done","ok":true,"due":2,"attempted":2,"executed":0,"failed":2,"pending":[]}
```
   After re-approving, the next tick executed both:
```
{"event":"executed","id":9,"hash":"4e3e8764ad07c6859595f5d0729a2b7f17772ef2adc9dc0ed73c3d08c651a6e6","status":"SUCCESS","ledger":4760699,"after":{"next_run_at":"1789827092","runs_left":1,"active":true}}
{"event":"executed","id":10,"hash":"c06ba4b93b5d4a73564e4132c9fa25ee915e83d2970db74899747078093fb0bc","status":"SUCCESS","ledger":4760700,"after":{"next_run_at":"1789827021","runs_left":0,"active":false}}
```
5. **Money check:** payee SAC balance `150000000` raw (= 15 KE2E = 2 + 3x1 + 3x1 + 4x1 + 3) and guard
   `spent_today` `150000000` — exactly the sum of all executed schedules: every payment once, no duplicates, no
   catch-up. (id 9 kept 1 unused run at that point; consumed by the Round 5 sanity run.)

### Round 5 (2026-09-19): review F1 — persistent sweep cursor (starvation fix)
The round-2 independent review (PR #9, issuecomment-5742582532) requested changes: `tick()` reset the scan cursor to
0 every tick and capped a tick at 10 pages x `limit` ids, so with the default `KEEPER_MAX_PER_TICK=5` only ids 1..50
were ever scanned. Guard ids are global and never reused, so any due schedule above that window was silently starved
(cross-tenant: any owner creating schedules grows the id space). Reviewer repro: due id 999, 20 ticks -> 200
`list_due` calls always from cursor 0, 0 executions.

- `keeper.ts` now keeps `sweepCursor` on the `Keeper` instance: each tick resumes where the previous one stopped and
  wraps to 0 only when the contract reports the end of the id space (a non-advancing cursor is treated as
  end-of-space). Per-tick work stays bounded (10 pages, `KEEPER_MAX_PER_TICK` candidates). A failed page sets the
  resume cursor to that page so the next tick retries it rather than skipping ids. `state()` exposes `sweepCursor`
  and the debug `tick` log carries `cursorFrom`/`cursorTo`. Restart behavior is explicit: the cursor is in-memory,
  so a new process starts a fresh sweep at id 0 (documented in `keeper.ts` and the README).
- Tests (3 new, 67 total): the reviewer's exact repro (id space 1000, due id 999, 10 pages x 5 ids per tick) is
  executed on tick 20 with strictly increasing, unique cursors and no per-tick reset; a cross-tenant case where a
  front-page due id (1) is paid once and does not monopolize the sweep while a far tenant id (999) is still reached
  by tick 20; and a small-space resume/wrap test (12-id space, due id 11) asserting `sweepCursor` 0 -> 11 -> 12 -> 0
  across ticks. Existing loop tests were adjusted for resume semantics (backed-off pages are no longer re-scanned:
  the cursor resumes past them).
- Minor review fixes: the guard-table comment in `errors.ts` now says the built-in range is 1..15 (code 1 reserved,
  2..15 mapped) instead of "1..13"; the `GUARD_SRC` note in this report now uses a path that works from `stellar/`
  (`../../guard-rules/...`), since `npm -w` sets the cwd there.
- Live sanity against the deployed guard (no full E2E repeat): a short `keeper` run with `KEEPER_MAX_PER_TICK=1`,
  `KEEPER_LOG_LEVEL=debug` showed the window sliding across ticks and wrapping:
```
{"event":"tick","due":[9],"candidates":[9],"limit":1,"pages":9,"cursorFrom":0,"cursorTo":10}
{"event":"executed","id":9,"hash":"7aafbc260ddc9e284aa12ea93d899ecb712576ed409072c8b666517dfa6239bf","status":"SUCCESS","ledger":4760846,"after":{"next_run_at":"1789827092","runs_left":0,"active":false}}
{"event":"tick","due":[],"candidates":[],"limit":1,"pages":1,"cursorFrom":10,"cursorTo":0}
```
  (id 9's last run was consumed; the next tick resumed at cursor 10 and wrapped at the end of the id space instead of
  re-scanning ids 1..9.)
- Tests now: **67**, 66 pass, 0 fail, **1 conditional skip**; `npm run check` green.


### End-to-end on testnet, round 1 (superseded deployment `CB5CQHV6…`): DONE
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
- Review F1 is fixed (Round 5) and awaiting the reviewer's re-check on PR #9.
- The live E2E against the final deployment is done (Round 4); the four undone verifications listed in Round 3 are
  all evidenced there.
- `scripts/check.sh` does not run `npm test`; adding it there was out of scope (shared file).

## Blockers
- None. The keeper is E2E-verified against the final guard
  `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`; PR #9 can move out of draft for review.

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
  5. Node >= 22.18 native TS: `.ts` import specifiers, no enums/parameter properties (`erasableSyntaxOnly` enforces it).
  6. Signed transactions are limited to a single `execute_schedule` invocation whose auth is source-account only.
  7. Multi-tenant guard: `list_due` returns due schedules of *every* owner, so the keeper serves everyone by design;
     anyone can run one. Refusals cost nothing (they fail at simulation), so a schedule whose owner tightened the rule
     or revoked the allowance is only re-simulated on the back-off cadence (max 1 h).
- ABI mismatches worked around: (a) `get_schedule` returns `Option<Schedule>` (I had assumed a bare `Schedule`) ->
  `Schedule | null`; (b) error codes start at 100 (I had an empty table) -> tables + range routing; (c) missed runs are
  skipped (no replay) -> logging/tests; (d) the old single-argument `list_due` became paginated -> isolated decoder +
  bounded cursor loop (Round 3), verified live in Round 4.
  Function names and argument types (`u32` ids/limits, no auth on `execute_schedule`) matched what I was told.
  Minor doc inconsistency in W1's `demo.sh` comments: it says `expiration_ledger` where the argument is
  `live_until_ledger` (DEPLOYED.md has it right).
- Reviewer should not be W3.

## Suggested Next Step
- Review and merge PR #9; then set `GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`
  (per `contracts/DEPLOYED.md`) wherever the keeper runs.
- Wire `npm test -w @polaris/stellar` into `scripts/check.sh` and decide where the keeper runs (a small VM/launchd
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
