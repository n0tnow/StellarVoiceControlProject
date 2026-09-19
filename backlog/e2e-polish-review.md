# Review: e2e-polish — manual testnet tool (`e2e:tool`, `e2e:status`), timeouts, docs

- **Date:** 2026-09-20
- **Reviewer:** W-review-polish (DeepSeek v4.1 Flash, L4, independent — did not write the code)
- **Branch/worktree:** `review/e2e-polish` == `chain/e2e-polish` @ `.worktrees/e2e-polish-review`, HEAD `51bd605`
- **Under review:** `git diff HEAD~2` — `stellar/src/live/{tool,args,status,timeout,keys,run,setup,submit}.ts` + tests, `stellar/src/live/README.md`, `stellar/package.json`, `backlog/e2e-polish.md`, `backlog/e2e-testnet.md` (Polish section).
- **Spec:** `brief-e2e-polish.md`; prior review §9 context: `backlog/e2e-testnet-review.md`.
- **Network:** read-only testnet only (`soroban-testnet.stellar.org` getTransaction/getLedgers; no writes, no Friendbot, no other host). Secrets were never read.

## Verdict: approve with corrections

The tool is functionally correct, testnet-gated, and safe: the approval pipeline builds with the production code, decodes the card from the XDR, signs only after confirmation, signs exactly the displayed XDR, and never prints a secret. Two of the brief's mandatory safety tests are **not actually present** in the committed suite (proven by mutation), and a few docs/behaviour details are off; all fixes are small test/doc additions, no code redesign.

## 1. Hash verification

Independently fetched each hash via `getTransaction` (read-only) and decoded `envelopeXdr` with the repo's `decodeInvocation`. All five are `SUCCESS`; function/args/source/ledger all match `backlog/e2e-polish.md`.

| Claimed step | Hash | Status | Ledger | Decoded fn | Source (role) | Decoded args (key ones) |
|---|---|---|---|---|---|---|
| guarded pay (`pay_owner`) | `fbf7c3a1…27c43` | SUCCESS | 4765893 | `pay_owner` | owner `GBKTFHHLB62…ODO7QU` | to `GBKBLL2ICQZ…EPY42WC` (= alias `ada`), SAC `CBRBMTWR44FT…KQ6K4KK`, amount `50000000` (5 E2EUSD) |
| schedule #15 | `a0d73201…c0f541` | SUCCESS | 4765896 | `create_schedule` | owner | to `ada`, SAC, amount `20000000` (2), `first_run_at=1789853220`, interval `0`, runs `1` |
| keeper fires #15 | `60cf3292…f60031` | SUCCESS | 4765928 | `execute_schedule(15)` | keeper `GB5NFVLPAO7…TNI44RO` | `[15]` |
| schedule #16 | `e3b40c09…d695b1` | SUCCESS | 4765949 | `create_schedule` | owner | to `ada`, amount `30000000` (3), `first_run_at=1790026080`, runs `1` |
| cancel #16 | `a0af9381…708b4` | SUCCESS | 4765957 | `cancel_schedule(16)` | owner | `[owner, 16]` |

- **Sources:** guarded pay/creates/cancel are owner-signed; the keeper execution is signed by the keeper key. Exactly as claimed.
- **Amounts:** `50000000` raw / 1e7 = 5, `20000000` = 2, `30000000` = 3. Decoded from the XDR, not the report.
- **Schedule delay (recomputed):** `first_run_at = 1789853220`; execute tx `createdAt` **and** ledger 4765928 close time (`getLedgers`) = `1789853227` → **7 s**, not the report's 8 s. The report's `first_run_at` (21:27:00Z) is right; its `21:27:08` close time is one second high. See non-blocking #2.
- `create #16` `first_run_at = 1790026080` = 2026-09-21T21:28:00Z = 2026-09-22 00:28 Europe/Istanbul. Consistent with the claimed `--date 2026-09-22 --time 00:28`.

**Result: PASS (one 1-second doc discrepancy, non-blocking).**

## 2. Approval-gate results (per command)

Scratch tests (`stellar/src/live/__tests__/zz-review-attacks.test.ts`, removed after the review) stub the chain (`runTool` deps: injected `createChain`/`buildPlan`) and count `sendTransaction` calls. The gate lives in the shared `executePlan`, so every state-changing command goes through it.

| Command | Deny (no `y`) signs nothing | `--yes` signs | Notes |
|---|---|---|---|
| `pay` | PASS (0 submits, "aborted") | PASS | Executor-signed path derives the role from the decoded fn (`pay_executor` → executor key) |
| `schedule` | PASS | PASS | |
| `cancel` | PASS | PASS | |
| `alias-add` | PASS | PASS | |
| `alias-remove` | PASS | PASS | |
| `enable-auto` | PASS | PASS (3 steps, one card) | each step signed with its own resequenced hash |
| `disable-auto` | PASS | PASS | |
| `tighten` | PASS | PASS (no-op plan prints "No change", signs nothing) | |

- **Exact-XDR signing:** `signExact` recomputes the signed envelope's hash and throws if it differs from the card's payload hash. Scratch attack (card hash = honest XDR, signed XDR = tampered) → exit 1, **0 submits**, stderr `does not equal the displayed payload hash`. PASS.
- **Card decoded from the XDR, not flags:** a step whose summary text claims `999` but whose XDR carries `50000000` renders `XDR: pay_owner(…, 50000000, …)` (decoded) alongside the untrusted summary line. PASS. (Amount/alias/time values are always rendered from the decoded `scVal`s.)
- **Prompt parsing (`interactiveConfirm`, exercised directly):** `y`, `Y`, `Y `, `yes` → approve; `yes please`, `1`, `no`, `N` → deny; empty/EOF → process exits with no signature (Node "unsettled top-level await", code 13). So nothing is ever signed without an affirmative. **Caveat vs the stated criterion:** the brief's acceptance says `Y ` must abort, but the implementation trims+lowercases, so `Y ` approves; there is also no timeout on the prompt. See blocking B3 / non-blocking #1.
- `keeper-once`/`keeper-watch` bypass the card (they only execute *previously approved* schedules with the fee-only keeper key); by design, noted.

## 3. Argument-parsing attacks

Tested through the real parser/`buildPlan` (no network reached on rejects) and the production value parsers.

| Attack | Result |
|---|---|
| unknown flag `--nope` | usage error, **exit 2** |
| unknown command | usage error, exit 2 |
| `--live=true` (boolean with value) | usage error |
| value flag missing value (`--to --amount 5`) | usage error |
| second positional | usage error |
| bad `--route sneaky` / `--profile sneaky` | usage error (before any network) |
| raw `G...` as `--to` | `unknown alias` usage error (strkeys are never accepted as recipients) |
| `--tz Not/AZone` | usage error, exit 2 |
| schedule invalid date `2026-02-30`, hour `25:00`, bad tz, past time | refused (`time_in_past` / invalid) |
| `alias-add --name Ada`, `--name Bob` | usage error (`[a-z][a-z0-9_-]{0,31}`) |
| `alias-add --address not-a-key` | usage error (not a valid `G...`) |
| missing required (`pay` no `--amount`, `enable-auto` no `--threshold`, `tighten` no flags, `cancel` none) | usage error |
| `--every month` | usage error |
| `keeper-watch --seconds 0/301/abc` | usage error, exit 2, keeper **not** run; `--seconds 1/300` run |
| duplicated flag `--to a --to b` | **last wins silently** (see non-blocking #6) |
| prototype keys `constructor`/`__proto__`/`prototype` | `resolveAlias` returns `undefined`; `parseAliasBook` refuses them as reserved |
| `--amount` `1e3`, `-1`, `1.12345678`, `" 5"`, `NaN`, `+5`, `0x10`, 13-digit integer | rejected by production `toRawUnits`; `0`/`5` accepted |
| no `--live` for any of the 12 commands | plan-only, **fetch never called** (chain/signer injection throws if touched) |

## 4. Security checklist

- **No secret in any output/error path:** every `process.stdout`/`process.stderr`/`throw` in the new code emits public data or a message; `signer`'s error contains only "invalid encoded string length…", never the seed. Secrets appear only at `signExact` (handed to `signEnvelope`) and `KEEPER_SECRET` (env). Committed test "never prints a secret seed" passes; my scratch variant confirms per-command. PASS.
- **`keys.ts` permission repair (COR-2):** `repairPermissions` chmods `dirname(path)` `0700` and `path` `0600` on load; the new committed test sets `0777/0644` and asserts repair. It chmods exactly those two paths (no unrelated paths). **Symlink caveat:** `chmodSync` follows symlinks — a symlinked `keys.json` has its *target* chmodded and the parent dir set `0700` (verified empirically). Only reachable via a non-default `E2E_KEYS_PATH`; non-blocking #4. Writes are not atomic (plain `writeFileSync`); throwaway keys, non-blocking #5.
- **`--reset` semantics/confirmation:** `e2e:setup --live --reset` overwrites keys with no backup and **does not prompt**; the destructive semantics are now printed in the plan text and README. Non-blocking #3.
- **Testnet-only still holds / no new hosts:** `e2e:tool`/`e2e:status` call `loadLiveConfig` (pinned hosts + passphrase, `assertTestnet`) before I/O; the only servers constructed use `config.rpcUrl`/`config.horizonUrl`. No literal HTTP host or new `fetch` is introduced in the new files. Non-testnet RPC is refused (exit 1, "only Stellar testnet").
- **Keeper child process:** `spawn(process.execPath, [cliPath, "--once"?], { env, stdio })` — no shell, no user-controlled argv, `KEEPER_SECRET` passed **via env only** (never argv/`ps`), and `--env-file` is not used so the repo `.env` is untouched. Runtime bounded: `SIGTERM` at `--seconds`, `SIGKILL` at +5 s (`keeper-once`: 120 s); timers cleared on exit. PASS.

## 5. Timeouts

- `timeout.ts` defines `NETWORK_CALL_TIMEOUT_MS=30_000`, `DEFAULT_OPERATION_TIMEOUT_MS=120_000`, typed `NetworkTimeoutError`/`OperationTimeoutError`, and a monotonic `Deadline`.
- **Per-call bound:** `submitSoroban`/`submitClassic`/`resequenceEnvelope`/`fetchSorobanTx` wrap `sendTransaction`, `getTransaction`, `horizon.submitTransaction`, `loadAccount` in `withNetworkTimeout`. Committed tests drive each with a hanging fake server; my scratch re-confirms.
- **Hash is not lost on timeout:** `hash` is computed before `sendTransaction`; every FAILED return carries it. Scratch asserts `res.hash` equals the signed hash for a `sendTransaction` hang, a `getTransaction` hang, and an `OperationTimeout`. The tool prints that hash + explorer link for FAILED steps (`formatSubmit`), so the tester can look it up. PASS.
- **Polling bounded:** the poll loop exits on `waitDeadline` (`WaitTimeout`) or `opDeadline` (`OperationTimeout`); scratch confirms an unbounded `NOT_FOUND` stream ends with `OperationTimeout` and the hash preserved.
- **Nuance:** the whole-operation deadline is checked between steps / before each `getAccount`; a single in-flight call can overrun a nearly-spent budget by up to its own 30 s bound. This never signs after expiry (`deadline.check()` before every sign/submit), so impact is latency only. Non-blocking #7.

## 6. README walkthrough

Ran every documented command in `--help` / plan-only / `e2e:status` (no `--live`) mode. All 12 subcommands and `e2e:status`/`e2e:setup` exist with the documented flags; `--help` renders for each; unknown flags exit 2.

- `e2e:setup` / `--reset` plan prints the overwrite warning; `e2e:status` plan performs zero network I/O; `--tz` validation works.
- Scenarios A–J map to real commands/flags; the safety notes (testnet only, throwaway keys, no secret seeds, `--reset` no backup, `e2e:run` not idempotent) are true.
- Troubleshooting entries name real refusal codes (`OverPerTxLimit #103`, `OverDailyLimit #104`, `TooManySchedules #114`, `NoExecutor #107`, allowance) and match the production classifiers.
- Inaccuracy: the headline schedule example hardcodes `--date 2026-09-20 --time 00:30`, which is in the past as of the review date, so a copy-paste yields `time_in_past`. Non-blocking #1(doc).

## 7. Gates (verbatim)

`npm run check -w @polaris/stellar` → `tsc -p tsconfig.json`, exit 0, no diagnostics.

`npm run test:live -w @polaris/stellar`:
```
 Test Files  11 passed (11)
      Tests  84 passed (84)
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
test:live       Test Files 11 passed (11) / Tests   84 passed (84)
```
Sum = 67+111+121+133+112+121+145+84 = **894 passed, 0 failed** — matches the report exactly.

**Regression & scope:** `git diff HEAD~2 --stat -- stellar/src/{payments,guard,approval,schedule,suggest,keeper,anchor}` is **empty**; `stellar/package.json` adds only `e2e:status` + `e2e:tool`; `grep -E "S[A-Z2-7]{55}"` over the diff, the report and the README is empty. PASS.

## 8. Mutation results

Each mutation applied to the worktree, `npm run test:live` (committed 84-test suite, scratch tests excluded) run, then `git checkout -- <file>`.

| # | Mutation | Catch | Evidence |
|---|---|---|---|
| a | `interactiveConfirm` default → **YES** (`return true`) | **NOT caught** | suite still **84 passed**; no committed test calls `interactiveConfirm` (it injects a fake `io.confirm`) |
| b | **skip** `signedHash !== payloadHash` check in `signExact` | **NOT caught** | suite still **84 passed**; no committed test builds a mismatched card/XDR pair |
| c | **drop** the whole-operation deadline (`opDeadline`) block in `submit.ts` | caught | `submit.test.ts > reports OperationTimeout…` fails (`expected 'WaitTimeout'`) |
| d | print a secret from the results writer (`executePlan` prints `keys[role].secret`) | caught | `tool.test.ts > never prints a secret seed` fails |

(c) and (d) are covered; (a) and (b) are the gaps in §2 — both are invariants the brief requires offline tests for.

## 9. Blocking issues (exact fix each)

- **B1 — Default-deny prompt is untested (mutation (a) survives).** `tool.test.ts` injects `io.confirm`, so the actual `interactiveConfirm` parser can regress to "always yes" undetected. Fix: add a test that drives `interactiveConfirm` with injected input (e.g. wrap it to read from an `EventEmitter`, or add an internal `parseConfirmation(answer: string): boolean` used by `interactiveConfirm` and unit-test that), asserting `true` only for `y`/`yes` and `false` for `""`, `"n"`, `"yes please"`, `"1"`, and the uppercase/padded forms the spec says must abort.
- **B2 — Displayed-vs-signed hash check is untested (mutation (b) survives).** Fix: add a `runTool` test with an injected `buildPlan` returning a `PlanStep` whose `payloadHash` is the hash of a *different* XDR than `unsignedXdr`; assert exit `1`, `sendTransaction` called **0** times, stderr matches `/does not equal the displayed payload hash/`. (My scratch test is exactly this and passes against the current code.)
- **B3 — `Y ` (and `Y`) approve although the acceptance criteria say they must abort.** `interactiveConfirm` trims/lowercases before comparing. Fix (pick one): (i) make the gate exact (`answer === "y" || answer === "yes"` with no trim/case-fold) so padded/uppercase variants abort; or (ii) if case-insensitive trimmed input is intended, update `brief-e2e-polish`/the report to state it explicitly and add the "must abort" test for the remaining non-`y`/`yes` inputs. Either way the committed test in B1 should pin the chosen behaviour.

## 10. Non-blocking

1. **Prompt has no timeout** though the brief lists "timeouts must abort"; an idle prompt waits until stdin closes/kill. Consider a bounded wait that returns `false`.
2. **Schedule delay in the report:** `backlog/e2e-polish.md` says 8 s (21:27:08Z); the execute ledger close time is `1789853227` = 21:27:07Z → **7 s**. Correct the report.
3. **`e2e:setup --reset` does not confirm** before destroying the key file (documented, but the tool's own rule is explicit approval for destructive ops). Consider a `y/N` or `--yes`.
4. **`repairPermissions` follows symlinks:** a symlinked `keys.json` (only via custom `E2E_KEYS_PATH`) has its target chmodded and its parent dir set `0700`. Guard with `lstat` and skip chmod on a symlink.
5. **Non-atomic key writes** (`writeFileSync` without temp+rename); a crash mid-write can truncate `keys.json`. Low impact (throwaway, `--reset` recovers).
6. **Duplicated flags silently take the last value**; consider rejecting duplicates for untrusted scripted input.
7. **Two timeout implementations coexist** (`rpc.ts` `withTimeout`/`RpcTimeoutError` for guard-client reads vs `timeout.ts` `withNetworkTimeout`/`NetworkTimeoutError` for submit). Consider unifying.
8. **Whole-operation deadline vs 30 s calls:** a single in-flight call may overrun a mostly-spent budget by up to 30 s; signing is still gated, so latency-only.
9. **README schedule example uses a fixed past date** (`2026-09-20 00:30`); replace with a clearly-future/relative example so the walkthrough works on any day.

## Scope statement

Only the review file `backlog/e2e-polish-review.md` was added. Scratch tests (`zz-review-*`), the temporary root `node_modules` symlink, and the scratch decode/perm fixtures were removed; `git status --short` shows only this file after cleanup. No commit/push/add. No production module was modified.

DONE polish-review
