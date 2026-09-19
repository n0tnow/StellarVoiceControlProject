# Report: e2e-polish (manual-testing tool, `e2e:status`, timeouts and docs)

- **Date:** 2026-09-20
- **Worker/Agent:** W-e2e (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/e2e-polish` @ `/Users/bilalkaya/StellarVoiceControlProject/.worktrees/e2e-polish` (based on `integration/chain-lane`, HEAD `0589697`)
- **PR:** none (the task kept the repo read-only apart from the allowed paths; the coordinator/reviewer opens the PR)
- **Predecessors:** `backlog/e2e-testnet.md` (12/12 live run) and `backlog/e2e-testnet-review.md` (independent verification, approve with corrections). This round implements the review's §9 non-blocking items and the follow-up brief.

## Summary verdict

**Done.** The project owner now has a safe, explicit-approval command-line tool that exercises the **same chain-lane code** the app will use, plus a read-only status command and a manual-testing guide.

- **Uniform timeouts (review #1):** every network call in `submit.ts` and the live modules is hard-bounded (30 s) and submissions honour a whole-operation deadline (120 s) with typed errors.
- **`e2e:status`:** read-only snapshot (addresses, balances, rule, executor, alias, `spent_today`, SAC allowance, schedules with local + UTC next-run), `--json`, `--help`; without `--live` it prints a plan and touches no network.
- **`e2e:tool`:** 12 commands; every state-changing command builds with the production tools, decodes the card **from the XDR**, requires an explicit `y/N` (default NO) or `--yes`, signs the **exact displayed XDR**, submits, waits and reads the result back.
- **Live smoke passed on Stellar TESTNET** using the existing throwaway accounts; the tool fired a scheduled payment through the untouched keeper CLI (7 s after due) and cancelled a second schedule. Hashes below.
- Offline gates green: `check` clean, `test:live` **112 passed** (12 files), full `test` **922 passed / 0 failed**. (These are the current, post-review-fix numbers; the **84 / 894** figures quoted in the original draft were the pre-review baseline — see "Review fixes" below, which added 28 live tests.)

## Scope / files changed

Allowed-and-touched only:

| File | Change |
|---|---|
| `stellar/src/live/timeout.ts` | **new** — typed network/operation timeouts + `Deadline` |
| `stellar/src/live/args.ts` | **new** — strict CLI parser + help rendering |
| `stellar/src/live/status.ts` | **new** — `e2e:status` |
| `stellar/src/live/tool.ts` | **new** — `e2e:tool` |
| `stellar/src/live/submit.ts` | per-call 30 s bound + operation deadline; `setSequence` helper |
| `stellar/src/live/__tests__/{timeout,args,status,tool}.test.ts` | **new** offline suites |
| `stellar/src/live/__tests__/{keys,submit}.test.ts` | extended |
| `stellar/src/live/keys.ts` | repair permissions on load (COR-2); removed unused `maskSecret` |
| `stellar/src/live/run.ts` | explicit non-idempotence in the plan text |
| `stellar/src/live/setup.ts` | explicit `--reset` overwrite note in the plan text |
| `stellar/src/live/README.md` | **new** manual-testing guide |
| `stellar/package.json` | scripts `e2e:status`, `e2e:tool` (nothing else) |
| `backlog/e2e-testnet.md` | appended "Polish" section |
| `backlog/e2e-polish.md` | **new** — this report |

Production modules (`stellar/src/{payments,guard,approval,schedule,keeper,anchor}/**`) and `contracts/**` were **not** modified. No bug was found in them that blocked the tool.

## Deliverable 1 — uniform timeouts (review #1)

`stellar/src/live/timeout.ts`:

- `NETWORK_CALL_TIMEOUT_MS = 30_000`, `DEFAULT_OPERATION_TIMEOUT_MS = 120_000`.
- `withNetworkTimeout(promise, label, ms?)` races any promise against a timer and rejects `NetworkTimeoutError` (`code: "network_timeout"`).
- `Deadline` is a monotonic budget with `remainingMs`, `expired`, `check()` (throws `OperationTimeoutError`, `code: "operation_timeout"`) and `clamp(waitMs)`.

`submit.ts` now wraps `server.sendTransaction`, `server.getTransaction`, `horizon.submitTransaction` and the `loadAccount` inside `resequenceEnvelope`; each is bounded by `callTimeoutMs` (default 30 s). `submitSoroban` tracks `waitDeadline` (existing `waitMs`, default 60 s) and `opDeadline` (`operationTimeoutMs`, default 120 s); hitting the latter returns a `FAILED` result classified as `OperationTimeout`. Both timeout names surface as `kind: "rpc"` classifications for callers that only read `SubmitResult.error`.

Offline proof: `submit.test.ts` "uniform timeouts" runs a **hanging fake server** (`() => new Promise(() => {})`) for `sendTransaction`, `getTransaction`, Horizon `submitTransaction` and `loadAccount`, and asserts `NetworkTimeout` / `OperationTimeout`.

## Deliverable 2 — `e2e:status`

`npm run e2e:status -w @polaris/stellar -- [--live] [--json] [--tz <IANA>] [--help]`

- Without `--live`: prints the plan (network, endpoints, guard id, keys path, zone) and performs **zero network I/O** (test stubs `fetch` and asserts it is never called).
- With `--live`: prints the five public addresses, per-role E2EUSD balances, the owner's `get_rule`, `get_executor`, `get_alias("ada")`, `spent_today`, the SAC allowance and `list_schedules` (each with local and UTC next-run). `--json` emits the same data (bigints as strings, so it is valid JSON). `--tz` defaults to the system zone.

## Deliverable 3 — `e2e:tool`

`npm run e2e:tool -w @polaris/stellar -- --live <command> [options]`

Commands: `pay`, `schedule`, `cancel`, `list`, `alias-add`, `alias-remove`, `enable-auto`, `disable-auto`, `rule`, `tighten`, `keeper-once`, `keeper-watch`. Every command supports `--help`; unknown flags are a usage error (exit 2).

Pipeline for every state-changing command:

1. **BUILD** with the production builders (`createSendPayment`, `schedulePayment`, `cancelSchedule`, `guard.*`, `approval.*`).
2. **RESEQUENCE** each step (multi-step flows share one account sequence, so steps get `base+1`, `base+2`, … **before** the card is shown) and recompute the payload hash from the final XDR.
3. **CARD** — `renderCard` prints the title, all production summary lines, the route, the signer (role + public address), the fee, the payload hash, the explorer link, the decoded `XDR: fn(args) @ contract` proof, warnings, notes and, for `enable-auto`, the D13 arming note with the `set_executor` step marked `[ARMING]`.
4. **CONFIRM** — interactive `y/N` (default NO; anything but `y`/`yes` aborts) or `--yes`.
5. **SIGN** the exact displayed XDR; `signExact` recomputes the signed hash and **throws if it differs** from the card's payload hash.
6. **SUBMIT + VERIFY** — hash, ledger and explorer link are printed; then a command-specific read-back (`get_alias`/`get_schedule`/`get_rule`/`get_executor`/allowance/balances/`list_schedules`).

Notes on specific commands:

- `pay --profile auto_under_limit`: when the amount is inside the executor mandate the built XDR is `pay_executor`; the tool decodes the function name from the XDR and signs with the **executor** key, and the card states no owner approval card is required on that path.
- `enable-auto`: one card, one confirmation, three transactions in the D13 order `approve → set_rule → set_executor` (executor last, the arming step).
- `disable-auto`: `revoke_executor`, plus `approve(0)` with `--revoke-allowance` (kill switch).
- `tighten`: refuses loosening unless `--allow-loosening`; a loosening returns the full `card_and_touch_id` classification and is labelled on the card. A no-op rule builds nothing.
- `alias-add`/`alias-remove`: reject names that are not `[a-z][a-z0-9_-]{0,31}` and addresses that are not valid `G...` strkeys; mirrored to a local alias book (`~/.polaris-e2e/aliases.json`, `0600`) so `pay --to <name>` works afterwards.
- `keeper-once` / `keeper-watch --seconds <n>`: run the **existing** keeper CLI in the foreground with the keeper key from the keys file, streaming its JSON logs; `--seconds` is bounded to 1..300.

The tool never prints a secret seed; secrets are read only from `~/.polaris-e2e/keys.json` and passed to the signer / keeper child (env, never argv).

## Deliverable 4 — review cleanups

- **`maskSecret`**: removed (it was exported but unused); its assertion was dropped from `keys.test.ts`.
- **`e2e:run` non-idempotence**: stated explicitly in the run plan text (`run.ts`) and in `stellar/src/live/README.md`.
- **Earlier failed attempt**: the "one uninterrupted run" wording is qualified in the new "Polish" section of `backlog/e2e-testnet.md` (the earlier `20-55` results file and its S3/S5 failures are named).
- **COR-1** (`setup --reset` overwrite): stated in the setup plan text and the README.
- **COR-2** (key permissions on load): `loadOrCreateKeys` now calls `repairPermissions` (dir `0700`, file `0600`, fail loudly); a new test sets `0777`/`0644` and asserts they are repaired.

## Deliverable 5 — manual-testing guide

`stellar/src/live/README.md` documents prerequisites, `e2e:setup --live`, `e2e:status`, ten manual scenarios (direct/guarded pay, enable auto-pay, executor-signed pay, tighten, alias book, schedule + keeper watch, cancel, disable), how to inspect on stellar.expert, reset, safety notes and troubleshooting (`tx_too_early`, allowance missing, `TooManySchedules`, limits, keeper down, `NoExecutor`, unknown alias).

## Deliverable 6 — offline tests

New/extended suites under `src/live/__tests__/`:

- **`args.test.ts`** — command/value/boolean parsing, `--flag=value`, unknown flag/command, missing value, boolean-with-value, extra positional, `--help`, flag readers, help rendering.
- **`timeout.test.ts`** — fast/hanging `withNetworkTimeout`, default constants, `Deadline` countdown/throw/clamp.
- **`submit.test.ts`** (extended) — hanging `sendTransaction`/`getTransaction`/Horizon submit/`loadAccount` → `NetworkTimeout`; operation deadline → `OperationTimeout`.
- **`status.test.ts`** — `renderStatus` content, `statusJson` bigint→string, plan-only does no network, `--help`, invalid `--tz`.
- **`tool.test.ts`** — card proof for ten invocations (`pay_owner`, `pay_executor`, `set_alias`, `remove_alias`, `set_rule`, `set_executor`, `revoke_executor`, `create_schedule`, `cancel_schedule`, `approve`) is decoded from the XDR (a sentinel line proves it is not the summary); changing the XDR changes the proof; production `set_alias` XDR → card; **default-deny** confirms nothing is signed; `--yes` signs the exact displayed XDR (signed hash == card payload hash) and reports the read-back; **no secret seed** ever appears in stdout/stderr; `cancel --to` maps to `recipient`; no network without `--live`; unknown flag → exit 2; mainnet RPC refused; missing flag value.

## Deliverable 7 — live smoke (TESTNET, existing throwaway accounts)

Explorer: `https://stellar.expert/explorer/testnet/tx/<hash>`. All hashes were produced by the tool itself.

| Step | Command | Result |
|---|---|---|
| status | `e2e:status --live` | matched the reviewed state (owner 9735, recipient 265, rule per_tx 100 / daily 2000 / auto 0, executor none, alias `ada`, spent 240, allowance 4800, 0 schedules) |
| read rule | `e2e:tool rule --live` | owner rule + allowance 4800 |
| guarded pay | `e2e:tool pay --live --to ada --amount 5 --route guarded --yes` | `pay_owner` — tx [`fbf7c3a1…`](https://stellar.expert/explorer/testnet/tx/fbf7c3a156efbd279ba6abee8db83d82d57feff110e7806dd7b61c94fce27c43), ledger 4765893; `ada` +5 (265→270), `spent_today` 245 |
| list | `e2e:tool list --live` | `No active schedules.` |
| schedule #15 | `e2e:tool schedule --live --to ada --amount 2 --date 2026-09-20 --time 00:27 --tz Europe/Istanbul --yes` | create_schedule tx [`a0d73201…`](https://stellar.expert/explorer/testnet/tx/a0d73201f38cd53c9894ace46d478bb33828a63bb1e0fd768f61e03509c0f541), ledger 4765896; read-back schedule #15 active |
| keeper | `e2e:tool keeper-watch --live --seconds 240` | keeper executed #15 — tx [`60cf3292…`](https://stellar.expert/explorer/testnet/tx/60cf329288060aa625d45f2a902d7389e33cb0e42633cff83afcac3b0ff60031), ledger 4765928; `ada` +2 (270→272) |
| schedule #16 | `e2e:tool schedule --live --to ada --amount 3 --date 2026-09-22 --time 00:28 --tz Europe/Istanbul --yes` | create_schedule tx [`e3b40c09…`](https://stellar.expert/explorer/testnet/tx/e3b40c09ebdb2039396d7bf96c022863285f1883f6d895aa2e66fdea0fd695b1), ledger 4765949; read-back #16 active |
| cancel #16 | `e2e:tool cancel --live --to ada --yes` | cancel_schedule tx [`a0af9381…`](https://stellar.expert/explorer/testnet/tx/a0af9381dd9ab4f0ce4ebd6a9da8839a79e0b511080b27467e859175195708b4), ledger 4765957; read-back #16 `active=false` |
| json | `e2e:status --live --json` | valid JSON, no bigints |

**Measured schedule delay:** `first_run_at` = `1789853220` (21:27:00 UTC); keeper execution ledger close = `1789853227` = 21:27:07 UTC → **7 s** (well inside the 15–25 s guidance; keeper poll 5 s). Corrected from 8 s per the independent review §1.

**Final on-chain state (read back by the tool):** owner 9728 E2EUSD, recipient 272, `spent_today` 247, SAC allowance 4793, `get_executor` null, `get_alias(ada)` = recipient, no active schedules. No `enable-auto`/`tighten` was needed to reach the state the smoke required — the current state already had `per_tx 100 / daily 2000 / auto 0 / executor revoked`, and guarded payments were owner-signed (`pay_owner`).

No contract bug was observed; the frozen guard behaved as before.

## Gates (verbatim)

`npm run check -w @polaris/stellar` → `tsc -p tsconfig.json`, exited 0, no diagnostics.

`npm run test:live -w @polaris/stellar`:
```
 Test Files  11 passed (11)
      Tests  84 passed (84)
```

`npm test -w @polaris/stellar`:
```
test:keeper     ℹ tests 67   / ℹ pass 67   / ℹ fail 0
test:anchor     Test Files  5 passed (5)  / Tests  111 passed (111)
test:payments   Test Files  7 passed (7)  / Tests  121 passed (121)
test:guard      Test Files  7 passed (7)  / Tests  133 passed (133)
test:approval   Test Files  4 passed (4)  / Tests  112 passed (112)
test:schedule   Test Files  5 passed (5)  / Tests  121 passed (121)
test:suggest    Test Files  4 passed (4)  / Tests  145 passed (145)
test:live       Test Files 11 passed (11) / Tests   84 passed (84)
```

Sum = 67+111+121+133+112+121+145+84 = **894 passed, 0 failed** (previous baseline: 701 without the suggest suite; `test:live` grew from 36 to 84).

## Security notes

- Testnet-only enforcement is unchanged and airtight: `loadLiveConfig`/`assertTestnet` refuse any non-pinned host or passphrase before any I/O; `e2e:tool`/`e2e:status` go through it too.
- Secrets are read only from `~/.polaris-e2e/keys.json`; output is public data only. `tool.test.ts` asserts that no `S[A-Z2-7]{55}` appears in stdout/stderr for a real key set.
- The tool signs only the XDR it displayed: the payload hash is recomputed after resequencing and re-checked on the signed envelope before submission.
- No deploy, no contract writes; `contracts/**` untouched. `git grep -E "S[A-Z2-7]{55}"` over the diff is empty; the report and README contain no secret material.

## Known limitations / handed off

- `e2e:tool` resolves `--to` aliases through a local book seeded with `ada` (+ aliases added via `alias-add`). The contract exposes no alias enumerator, so an alias added outside the tool is unknown to `pay`/`schedule` until re-added.
- `keeper-once`/`keeper-watch` use the existing global-scan keeper (untrusted, fee-only key); on the shared guard it may also run other owners' due schedules, exactly as noted in `backlog/e2e-testnet.md`.
- `--json` is provided for `e2e:status` only; the tool prints human cards.
- The task restricted the repo scope; `backlog.md` was **not** touched, so the coordinator should add `backlog/e2e-polish.md` to the index when merging.
- No PR was opened (task); the reviewer should verify the live hashes above and merge via the normal async review flow.

## Review checklist (what to re-verify)

- `git diff` touches only the files in the table above.
- `npm run check`, `npm run test:live`, `npm test` reproduce the numbers above.
- Live smoke hashes exist on-chain (Soroban `getTransaction` for `fbf7c3a1…`, `a0d73201…`, `60cf3292…`, `e3b40c09…`, `a0af9381…`).
- `e2e:tool` never signs before `y`/`yes` (offline test "defaults to DENY") and signs exactly the card's XDR (offline test "signedHashes[0] === displayed").
- `grep -E "S[A-Z2-7]{55}"` over the diff, the report and the README is empty.

## Review fixes

This section applies the independent review `backlog/e2e-polish-review.md`
(approve with corrections) to the same branch. Offline only: no network, no
keys/accounts touched.

### Blocking

- **B3 — STRICT approval gate.** Extracted the pure `parseConfirmation(answer)`
  into `stellar/src/live/confirm.ts`. It approves ONLY the exact lowercase `y`
  or `yes` after removing at most one trailing `\n`; there is no trimming and no
  case folding, so `Y`, `Y `, ` y`, `YES`, `Yes`, `yes please`, `1`, `""` and EOF
  all abort (`yes\n` approves; `y\r\n` does not). `interactiveConfirm` now uses
  it and the prompt reads
  `Type y or yes (lowercase) to approve, anything else aborts: `. `tool.ts`
  re-exports the two functions for backwards compatibility.
- **B1 — default-deny is now tested.** New `confirm.test.ts`: a table over
  every approve/abort input above (including the explicit `yes\n` /
  `y\r\n` newline rules) plus `interactiveConfirm` end-to-end with **injected
  input/output streams** (`PassThrough`), asserting `true` only for exact
  lowercase `y`/`yes`, and `false` on uppercase/padded input, on EOF, and on an
  idle timeout.
- **B2 — displayed-vs-signed hash check is now tested.** New `tool.test.ts`
  case "refuses to submit when the displayed payload hash is for a different
  XDR": an injected `buildPlan` returns a `PlanStep` whose `payloadHash` is the
  hash of a different XDR than `unsignedXdr`; the test asserts exit code `1`,
  `sendTransaction` called **0** times and stderr matching
  `/does not equal the displayed payload hash/`.

### Non-blocking (all applied)

1. **Bounded prompt** — `interactiveConfirm` waits at most
   `DEFAULT_CONFIRM_TIMEOUT_MS` (120 s), then returns `false` and prints
   `approval timed out; nothing was signed or submitted.` (covered by a test).
2. **Report delay corrected** — 8 s → **7 s** (`1789853227`), per §1 above.
3. **`e2e:setup --reset` confirmation** — prints the destructive warning and
   asks for the same strict `y`/`yes` gate (or `--yes`); on approval it prints
   that the previous throwaway keys were destroyed, on denial nothing is
   changed.
4. **`repairPermissions` symlink guard** — uses `lstat` and refuses to chmod a
   symlinked file (or a symlinked parent directory), skipping with a warning; a
   `keys.test.ts` case proves the link target keeps its mode.
5. **Atomic key writes** — `writeKeys` writes a `0600` temp file in the same
   directory, `fsync`s it and renames it over the destination; a test asserts
   no temp file is left behind and the final mode is `0600`.
6. **Duplicated flags are a usage error** — `parseCommandLine` rejects any flag
   given more than once (no more silent last-wins); covered in `args.test.ts`.
7. **Single timeout implementation** — `timeout.ts` remains the only source;
   `rpc.ts` now delegates to `withNetworkTimeout` and keeps
   `RpcTimeoutError` / `withTimeout` / `DEFAULT_RPC_TIMEOUT_MS` as
   backwards-compatible exports.

### Mutation proof (tests fail against the old behaviour)

Each mutation was applied to the worktree, `npm run test:live` run, then
reverted (files restored from the pre-mutation copies).

| # | Temporary mutation | Result |
|---|---|---|
| B1 | `parseConfirmation` reverted to the old `answer.trim().toLowerCase()` compare | **caught**: `1 failed | 11 passed` files, `11 failed | 101 passed` tests (only `confirm.test.ts` fails) |
| B2 | the `signedHash !== payloadHash` check removed from `signExact` | **caught**: `1 failed | 11 passed` files, `1 failed | 111 passed` tests (exactly the new B2 case fails) |

### Files touched by this round

`stellar/src/live/confirm.ts` (new), `__tests__/confirm.test.ts` (new),
`tool.ts`, `setup.ts`, `keys.ts`, `rpc.ts`, `args.ts`,
`__tests__/{tool,keys,args}.test.ts`, `README.md`, and this report. Nothing
under `stellar/src/{payments,guard,approval,schedule,keeper,anchor}` or
`contracts/**` was touched; no key material is present anywhere in the diff.

### Gates (verbatim)

`npm run check -w @polaris/stellar` → `tsc -p tsconfig.json`, exit 0, no diagnostics.

`npm run test:live -w @polaris/stellar`:
```
 Test Files  12 passed (12)
      Tests  112 passed (112)
```

`npm test -w @polaris/stellar` (exit 0):
```
test:keeper     ℹ tests 67   / ℹ pass 67   / ℹ fail 0
test:anchor     Test Files  5 passed (5)  / Tests  111 passed (111)
test:payments   Test Files  7 passed (7)  / Tests  121 passed (121)
test:guard      Test Files  7 passed (7)  / Tests  133 passed (133)
test:approval   Test Files  4 passed (4)  / Tests  112 passed (112)
test:schedule   Test Files  5 passed (5)  / Tests  121 passed (121)
test:suggest    Test Files  4 passed (4)  / Tests  145 passed (145)
test:live       Test Files 12 passed (12) / Tests  112 passed (112)
```
Sum = 67+111+121+133+112+121+145+112 = **922 passed, 0 failed** (was 894; +28 new offline live tests).

DONE polish-fix
