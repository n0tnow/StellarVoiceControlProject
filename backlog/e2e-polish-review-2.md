# Review 2 (delta): e2e-polish review fixes — strict approval gate, key hardening, reset confirmation, unified timeouts

- **Date:** 2026-09-20
- **Reviewer:** W-review-polish2 (DeepSeek v4.1 Flash, L4, independent — did not write the fixes)
- **Branch/worktree:** `review/e2e-polish-2` == `chain/e2e-polish` @ `.worktrees/e2e-polish-review2`, HEAD `50ca33e`
- **Under review (delta):** `git diff HEAD~1` — 12 files: `stellar/src/live/{confirm,args,rpc,setup,tool,keys}.ts`, `__tests__/{confirm,args,keys,tool}.test.ts`, `stellar/src/live/README.md`, `backlog/e2e-polish.md`
- **Spec:** `brief-polish-fix.md`; prior review: `backlog/e2e-polish-review.md` (approve with corrections: B1/B2/B3 + non-blocking 1,3,4,5,6,7)
- **Network:** **none** (offline only). No key file outside worktree temp dirs was read; no commit/push/add.

## Verdict: approve with corrections

Every blocking item from the prior review is fixed and each fix is now proven by a committed test that fails against the old behaviour (4/4 mutations caught). All gates pass: `check` clean, `test:live` **112 in 12 files**, full `test` **922 = 67+111+121+133+112+121+145+112**. Three low-severity, non-blocking gaps remain (symlinked-directory chmod, a mislabelled `RpcTimeoutError` alias, prototype-named flags); none weakens the signing gate.

## 1. Numbers re-run (verbatim)

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
Sum = 67+111+121+133+112+121+145+112 = **922 passed, 0 failed**. Matches the report's claim exactly.

## 2. Confirmation gate attack table

Scratch `zz-review2-attacks.test.ts` (32 tests, all pass). `parseConfirmation` accepts only `y`/`yes` plus at most one trailing `\n`:

| Input | Result | Input | Result |
|---|---|---|---|
| `y` | true | `YES` / `Yes` | false |
| `yes` | true | ` y` / `y ` / `yes ` | false |
| `y\n` / `yes\n` | true | `yes please` / `yy` | false |
| `y\r\n` | false | `1` / `true` / `ok` | false |
| `Y` | false | empty / `\n` | false |
| `y\n\n` | false | `y\0` | false |
| fullwidth `ｙ` U+FF59 | false | Cyrillic `у` U+0443 | false |
| 1 MB string | false | `null` / `undefined` | **throws TypeError** (see N4) |

`interactiveConfirm` (injected `PassThrough` streams): EOF → deny; closed stdin mid-prompt → deny; idle timeout (fake timers, `vi.advanceTimersByTimeAsync`) → deny + writes `approval timed out`; input arriving after the timeout ignored; a second answer ignored (only the first decides); `Y\n`/`YES\n`/` y\n`/`y \n`/`yes please\n`/`1\n` → deny; `y\n`/`yes\n` → approve. Prompt text is exactly `Type y or yes (lowercase) to approve, anything else aborts: ` (asserted). `DEFAULT_CONFIRM_TIMEOUT_MS === 120_000`. **PASS.**

## 3. Mutation results

Each mutation applied to the worktree, the committed `src/live` suite run (scratch excluded), then `git checkout -- <file>`.

| # | Mutation | Committed test that fails | Result |
|---|---|---|---|
| a | `parseConfirmation` → `answer.trim().toLowerCase()` | `confirm.test.ts`: 11 fail (`Y`, `Y `, ` y`, ` y `, `YES`, `Yes`, `yes\n\n`, `y\r\n`, `yes\r\n`, "states the newline rules", and the end-to-end B3 deny) | **caught** |
| b | EOF default → `finish(true)` | `confirm.test.ts` "defaults to deny on EOF" | **caught** |
| c | remove `signedHash !== step.payloadHash` in `signExact` | `tool.test.ts` "refuses to submit when the displayed payload hash is for a different XDR (B2)" | **caught** |
| d | idle timeout → `finish(true, …)` | `confirm.test.ts` "defaults to deny and says so on an idle timeout" | **caught** |

All four fail exactly as the task expects, and only the intended file/test fails each time. **PASS.**

## 4. Command coverage

`tool.ts` dispatch (lines 1120–1152): `rule` and `list` are read-only; the eight state-changing commands (`pay`, `schedule`, `cancel`, `alias-add`, `alias-remove`, `enable-auto`, `disable-auto`, `tighten`) all reach the shared `executePlan`, which calls `io.confirm` (or skips it only for `--yes`) before any `signExact`/submit. Scratch `zz-review2-coverage.test.ts` (12 tests, all pass) injects a synthetic `Plan` and a counting fake `sendTransaction` for each of the eight commands: confirm=false → exit 0, **0 submits**, "aborted"; `--yes` → exit 0, **1 submit**, and `io.confirm` is asserted never called. `keeper-once`/`keeper-watch` bypass the card **by design** (they run the inherited keeper CLI, which only executes already-approved schedules with the fee-only keeper key); the scratch test proves they call the injected keeper runner without prompting — same accepted exception as the prior review.

`e2e:setup --live --reset` gate: spawned as a real child process with `E2E_KEYS_PATH` inside the worktree and piped stdin. Piped `n`, EOF, and `Y` all exit 0 with `aborted: the previous throwaway keys were not changed.`, and the key file is **never created** (no network: the abort returns before `setup()`). `--yes` skips the prompt (documented). `--yes` is documented in `--help` and README. **PASS.**

## 5. keys.ts hardening

Scratch `zz-review2-keys.test.ts` + `zz-review2-keys-crash.test.ts` (11 tests, all pass).

- **Symlinked `keys.json`:** `lstat` guard refuses; target keeps `0644`; warning matches `/symlink/` and contains no secret. **PASS.**
- **Dangling symlink:** warns, does not follow; `loadOrCreateKeys` replaces the link with a real `0600` file and never creates the old target. **PASS.**
- **Self-referential symlink loop:** `lstat` reports the link (no ELOOP crash), warns; load replaces it with a real file. **PASS.**
- **Symlinked parent directory:** warns `refusing to chmod a symlinked keys directory` **but then still chmods the file through the directory** (observed target `0644 → 0600`). See N1. **PARTIAL.**
- **Atomic write / crash simulation** (`renameSync` mocked to throw): original file byte-for-byte intact; temp file removed when unlink succeeds. When `unlinkSync` also throws, the leftover temp is `0600` and the original is intact. **PASS.**
- **Permissions:** new nested dir `0700`, file `0600`; after 25 rapid rewrites mode stays `0600` with no temp left. **PASS.**
- **Concurrent writes:** 20 `Promise.all` `writeKeys` calls leave one valid `keys.json`, `0600`, no temp. (All fs calls are synchronous, so true interleaving is impossible in-process; cross-process safety is the rename.) **PASS.**
- **No secret in warnings/errors:** symlink warnings and the invalid-key error (`…missing a valid owner key…`) match no `S[A-Z2-7]{55}`. **PASS.**
- **Missing directory:** created recursively `0700`. **PASS.**

## 6. Args and timeouts

**Args** — scratch `zz-review2-args.test.ts` (39 tests, all pass). Duplicated flags are a usage error (`/more than once/`, exit 2) for all 25 value flags (incl. `--amount`, `--to`, `--yes`… `--to`/`--amount`/`--id`/`--name`/`--seconds`/`--per-tx`/…) and all 4 boolean flags (incl. `--live`, `--yes`, `--revoke-allowance`, `--allow-loosening`), plus `--flag=a --flag b` and `--flag=a --flag=b`; duplicate state does not leak between parses. Earlier attacks still reject: unknown flag, unknown command, `--live=true`, missing value, second positional, bare `--`, `--to=`. **FINDING N3:** prototype-named flags `--__proto__`, `--constructor`, `--hasOwnProperty`, `--toString` are silently accepted (exit 0) instead of unknown-flag errors (only `--prototype` is rejected); no pollution occurs.

**Timeouts** — scratch `zz-review2-timeout.test.ts` (8 tests, all pass). `rpc.ts` now imports `withNetworkTimeout`/`NETWORK_CALL_TIMEOUT_MS` from `timeout.ts`; `DEFAULT_RPC_TIMEOUT_MS === NETWORK_CALL_TIMEOUT_MS === 30_000`, `DEFAULT_OPERATION_TIMEOUT_MS === 120_000`. `createLiveRpc` resolves fast calls and rejects every hanging `getAccount`/`simulateTransaction`/`getLatestLedger` with `NetworkTimeoutError`. `withTimeout` preserves the `(promise, ms, label)` order and the `${label} did not complete within ${ms} ms` message. `withNetworkTimeout` with no `ms` rejects only after exactly 30 000 ms (fake timers). `Deadline` defaults to 120 000 ms and throws `OperationTimeoutError` when spent. A hanging `sendTransaction` still returns `status: "FAILED"`, `error.name === "NetworkTimeout"` **and the signed `res.hash`**, which `formatSubmit` prints with the explorer link. **PASS**, except **N2**.

## 7. Blocking issues (exact fix each)

**None.** All prior blocking items (B1/B2/B3) are fixed and mutation-proven.

## 8. Non-blocking

1. **`repairPermissions` still chmods a file through a symlinked parent directory.** It warns `refusing to chmod a symlinked keys directory` but then unconditionally runs `chmodSync(path, 0o600)`, which resolves through the directory link. The fix spec says it should refuse to chmod *through* symlinks. Fix: after the `isSymlink(dir)` branch, `return;` instead of falling through to `chmodSync(path, …)` (and cover it in `keys.test.ts`). Impact: low — needs an attacker-controlled parent path via `E2E_KEYS_PATH`, and the keys are throwaway.
2. **`RpcTimeoutError` is exported as a "backwards-compatible alias" but is not the class actually thrown.** `withTimeout` now rejects with `NetworkTimeoutError`, so `err instanceof RpcTimeoutError === false` (proven). No production importer or committed test references `RpcTimeoutError`, so nothing breaks today, but the alias is misleading. Fix: `export { NetworkTimeoutError as RpcTimeoutError } from "./timeout.ts";` (or make `RpcTimeoutError extends NetworkTimeoutError`).
3. **Prototype-named flags bypass the unknown-flag check.** `lookupFlag` uses `cmd?.flags[name]` / `spec.globalFlags?.[name]`, which read the prototype chain, so `--constructor`, `--__proto__`, `--hasOwnProperty`, `--toString` are accepted as value flags (exit 0, silently ignored). No pollution occurs (a string assigned to `__proto__` is ignored; the others become harmless own keys). Fix: `Object.prototype.hasOwnProperty.call(cmd.flags, name)` (and likewise for `globalFlags`). Pre-existing; the delta's own `setFlag` duplicate check already uses `hasOwnProperty` correctly.
4. **`parseConfirmation(null)` / `parseConfirmation(undefined)` throw `TypeError`** instead of returning `false`. Unreachable via `readline` (always a string), so informational; a defensive `if (typeof answer !== "string") return false;` would make it total.
5. **`--help` does not state the 120 s prompt timeout or the duplicate-flag rejection** (both are in the README; `--yes`'s description does state the strict gate). Optional doc nit.
6. **`keeper-once`/`keeper-watch` bypass the card by design** (carried over from review 1) — accepted, documented in README/prior review.
7. **Whole-operation deadline vs 30 s calls** (carried over) — a single in-flight call can overrun a nearly-spent budget by up to 30 s; signing stays gated, so latency-only.

## Scope / hygiene statement

`git diff HEAD~1 --name-only` lists only `stellar/src/live/**` (code, tests, README) and `backlog/e2e-polish.md`; `git diff HEAD~1 --name-only -- 'stellar/src' ':!stellar/src/live'` and the non-`stellar`/non-`backlog` diff are both empty. `git diff HEAD~1 | grep -E "S[A-Z2-7]{55}"` is empty. The report was corrected 8 s → 7 s (`first_run_at 1789853220`; execute ledger close `1789853227`), and the README now documents the strict gate, the 120 s prompt timeout, duplicate-flag rejection, the reset confirmation, atomic writes and the symlink note; the headline schedule example was made relative-date. Only `backlog/e2e-polish-review-2.md` was added; all scratch tests (`zz-review2-*`), temp dirs and the root `node_modules` symlink were removed. No commit/push/add.

DONE polish-review-2
