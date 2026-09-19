# Final pre-PR gate — `integration/chain-lane`

- **Date:** 2026-09-20
- **Worker:** W-gate (DeepSeek v4.1 Flash, verifier)
- **Branch:** `integration/chain-lane` @ `9242b86d2eec3953240cb19544694b544d68c935`
- **Base:** `origin/main` @ `e3aae2a96e02d75ea2e72cfc89bc558e659eeab4`
- **Mode:** READ-ONLY, offline (no network), one new file only. Temporary root `node_modules` symlink used and removed at the end; no commit/push/add.

## Verdict: READY

- Scope is clean: **123 files added, 2 modified** vs `main`, all under `stellar/` + `backlog/`; nothing under `contracts/`, `app/`, `agent/`, `interfaces/`, `docs/`, root config, `CLAUDE.md`, `AGENTS.md`, `.gitignore`.
- Offline gates are green: `tsc` exits 0; full `npm test` = **922 passed / 0 failed** (keeper 67, anchor 111, payments 121, guard 133, approval 112, schedule 121, suggest 145, live 112) — every suite matches expectation exactly.
- Hygiene and docs are clean (no secrets, no name-scan hits, no conflict markers, no spike/UI code, no new deps); only non-blocking debt found: 1 new production `TODO`, a superseded summary number in `e2e-polish.md`, and `backlog.md` index not updated.

---

## Step 1 — Scope vs `main`

`git log --oneline origin/main..HEAD | wc -l`:
```
62
```

`git diff origin/main --stat | tail -3`:
```
 stellar/src/suggest/suggest.ts                     |  802 +++++++++++++
 stellar/src/suggest/types.ts                       |  226 ++++
 125 files changed, 21459 insertions(+), 2 deletions(-)
```

Top-level paths changed (`git diff origin/main --name-only | awk -F/ '{print $1"/"$2}' | sort | uniq -c`):
```
   1 backlog/approval-policy-review-2.md
   1 backlog/approval-policy-review-3.md
   1 backlog/approval-policy-review.md
   1 backlog/approval-policy.md
   1 backlog/e2e-polish-review-2.md
   1 backlog/e2e-polish-review.md
   1 backlog/e2e-polish.md
   1 backlog/e2e-testnet-review.md
   1 backlog/e2e-testnet.md
   1 backlog/guard-client-review-2.md
   1 backlog/guard-client-review.md
   1 backlog/guard-client.md
   1 backlog/integration-chain-lane.md
   1 backlog/schedule-tools-review-2.md
   1 backlog/schedule-tools-review.md
   1 backlog/schedule-tools.md
   1 backlog/send-payment-review-2.md
   1 backlog/send-payment-review.md
   1 backlog/send-payment.md
   1 backlog/suggest-engine-review-2.md
   1 backlog/suggest-engine-review-3.md
   1 backlog/suggest-engine-review.md
   1 backlog/suggest-engine.md
   1 stellar/config
   1 stellar/package.json
 100 stellar/src
```

Out-of-scope check — `git diff origin/main --name-only | grep -v -E "^(stellar/|backlog/)"`:
```
(EMPTY)
```

Name-status split (`git diff origin/main --name-status | awk '{print $1}' | sort | uniq -c`):
```
 123 A
   2 M
```
The only modified files are `stellar/package.json` and `stellar/src/index.ts`. Added source files per module: `approval 11`, `guard 18`, `live 28`, `payments 14`, `schedule 17`, `suggest 11` (including tests). `keeper/` and `anchor/` are untouched vs `main`.

## Step 2 — Type-check and full test suite

`npm run check -w @polaris/stellar` → `tsc -p tsconfig.json`, exit 0, no diagnostics.

`npm test -w @polaris/stellar` → exit 0. Per-suite verbatim summaries:

| Suite | Command | Verbatim result | Expected | Match |
|---|---|---|---|---|
| keeper | `test:keeper` | `ℹ tests 67` / `ℹ pass 67` / `ℹ fail 0` | 67 | ✅ |
| anchor | `test:anchor` | `Test Files  5 passed (5)` / `Tests  111 passed (111)` | 111 | ✅ |
| payments | `test:payments` | `Test Files  7 passed (7)` / `Tests  121 passed (121)` | 121 | ✅ |
| guard | `test:guard` | `Test Files  7 passed (7)` / `Tests  133 passed (133)` | 133 | ✅ |
| approval | `test:approval` | `Test Files  4 passed (4)` / `Tests  112 passed (112)` | 112 | ✅ |
| schedule | `test:schedule` | `Test Files  5 passed (5)` / `Tests  121 passed (121)` | 121 | ✅ |
| suggest | `test:suggest` | `Test Files  4 passed (4)` / `Tests  145 passed (145)` | 145 | ✅ |
| live | `test:live` | `Test Files  12 passed (12)` / `Tests  112 passed (112)` | 112 | ✅ |

Sum = 67+111+121+133+112+121+145+112 = **922 passed, 0 failed** — exact match, no mismatch to investigate.

## Step 3 — Hygiene scans over the diff vs `main`

**Secret-shaped `S[A-Z2-7]{55}`** (tracked + diff added lines + broad `{54,57}`):
```
=== S[A-Z2-7]{55} (no word boundary) tracked ===
(none)
=== S[A-Z2-7]{55} in diff added lines ===
(none)
=== S[A-Z2-7]{54,57} broad ===
(none)
```
Test fixture/public constants: the only token that even resembles a key is the public testnet account `GBKTFHHLB62NDBK6EGNXODHZO2AWZTT2HEGDM4IQTNWYDIHG3TODO7QU` (a `G…` public key in `stellar/src/live/__tests__/status.test.ts:5` and `backlog/e2e-testnet.md:26`) — not secret material.

**Personal-name scan** (`git grep -n "<collaborator name>"` over `*.md *.ts *.rs`, excluding `CLAUDE.md`/`AGENTS.md`):
```
(none)
```

**Conflict markers** (`^(<<<<<<<|=======|>>>>>>>)`):
```
(none)
```

**`TODO|FIXME|XXX` in NEW production code** (`stellar/src`, excluding `__tests__`):
```
stellar/src/approval/enableAutoPay.ts:212: * TODO(T1-fix): this duplicates `guard/describe.ts`'s private `describeValue`.
stellar/src/index.ts:41: * TODO(B): implement in this order — `sendPayment` first (it is the M2 vertical
```
Only **one is new**: `approval/enableAutoPay.ts:212` (`TODO(T1-fix)` — a self-documented duplicated-helper note, same as the pre-existing integration finding D1, non-blocking). `index.ts:41 TODO(B)` is a **context line present unchanged on `main`** (`git show origin/main:stellar/src/index.ts` contains it), not introduced here. The added-line-only scan's second hit (`...IQTNWYDIHG3TODO7QU`) is the base32 public key above, a false positive on the substring `TODO`.

**`console.` in `stellar/src/live` non-test** (secret-printing check):
```
(none)
```
No live module prints key material; all output is public keys/hashes/balances/plan text.

**`.only(` / `.skip(` in tests:**
```
stellar/src/keeper/errors.test.ts:159:  if (!existsSync(src)) return t.skip("contract source not found");
stellar/src/keeper/errors.test.ts:162:  if (!block) return t.skip("no #[contracterror] enum in this revision of the contract");
```
These are pre-existing conditional `node:test` guards (`t.skip`) in `keeper/`, which is **not in the diff vs `main`**. No `*.only` / `*.skip` was introduced by this branch.

**Large files (> 500 KB) added:** none. Largest added files: `live/tool.ts` 46,256 B, `suggest/__tests__/suggest.test.ts` 35,183 B, `suggest/suggest.ts` 31,705 B.

## Step 4 — No spike/UI code; `~/.polaris-*` usage

`git ls-files | grep -E "^stellar/src/(spike|live/ui)"`:
```
(EMPTY)
```

`grep -rn "polaris-e2e" stellar/src` non-test — all hits are the documented key/result-file location constants and README text only:
```
stellar/src/live/status.ts:9: * reads a secret from anywhere other than the throwaway `~/.polaris-e2e`
stellar/src/live/tool.ts:15: * (`~/.polaris-e2e/keys.json`), secrets are never printed, nothing is signed
stellar/src/live/README.md:9:- Secrets live only in `~/.polaris-e2e/keys.json` (dir `0700`, file `0600`).
stellar/src/live/README.md:41:`--reset` overwrites `~/.polaris-e2e/keys.json` with a brand-new key set and
stellar/src/live/README.md:136:(`~/.polaris-e2e/aliases.json`) so `pay --to bob` works.
stellar/src/live/README.md:197:- Keys stay in `~/.polaris-e2e/keys.json`; the tools never print a secret seed.
stellar/src/live/keys.ts:4: * Secrets live ONLY here, in `~/.polaris-e2e/keys.json` (dir `0700`, file
stellar/src/live/config.ts:36:  keysPath: join(homedir(), ".polaris-e2e", "keys.json"),
stellar/src/live/config.ts:37:  resultsDir: join(homedir(), ".polaris-e2e"),
stellar/src/live/config.ts:107:  /** Overrides `~/.polaris-e2e/keys.json` (tests, CI). */
```
Only `config.ts` resolves the paths (`keysPath`, `resultsDir`); the rest are docs/comments. No other `~/.polaris-*` path is referenced.

## Step 5 — `stellar/package.json`

- Valid JSON: `stellar/package.json: VALID JSON` (and root `package.json: VALID JSON`).
- `test` script, each suite exactly once:
  ```
  npm run test:keeper && npm run test:anchor && npm run test:payments && npm run test:guard && npm run test:approval && npm run test:schedule && npm run test:suggest && npm run test:live
  ```
- Dependency diff vs `main` (`git diff origin/main -- stellar/package.json package-lock.json`): **only the `scripts` block changed; no dependency added/removed** (`package-lock.json` unchanged). Verbatim diff:
  ```
  diff --git a/stellar/package.json b/stellar/package.json
  @@ -14,9 +14,19 @@
     "scripts": {
       "check": "tsc -p tsconfig.json",
  -    "test": "npm run test:keeper && npm run test:anchor",
  +    "test": "npm run test:keeper && npm run test:anchor && npm run test:payments && npm run test:guard && npm run test:approval && npm run test:schedule && npm run test:suggest && npm run test:live",
       "test:keeper": "node --test \"src/keeper/**/*.test.ts\"",
       "test:anchor": "vitest run src/anchor",
  +    "test:payments": "vitest run src/payments",
  +    "test:guard": "vitest run src/guard",
  +    "test:approval": "vitest run src/approval",
  +    "test:schedule": "vitest run src/schedule",
  +    "test:suggest": "vitest run src/suggest",
  +    "test:live": "vitest run src/live",
  +    "e2e:setup": "node src/live/setup.ts",
  +    "e2e:run": "node src/live/run.ts",
  +    "e2e:status": "node src/live/status.ts",
  +    "e2e:tool": "node src/live/tool.ts",
       "keeper": "node --env-file-if-exists=../.env src/keeper/cli.ts",
       "keeper:once": "node --env-file-if-exists=../.env src/keeper/cli.ts --once",
       "anchor:e2e": "node src/anchor/e2e.ts"
  ```
- e2e scripts present: `e2e:setup`, `e2e:run`, `e2e:status`, `e2e:tool`.

## Step 6 — Report / review consistency (spot-check)

Spot-checked hashes appear in **both** the scenario report and its independent review:

| Hash (short) | Source | `e2e-polish.md` | `e2e-polish-review.md` |
|---|---|---|---|
| `fbf7c3a1…27c43` | guarded pay | present | present |
| `a0d73201…c0f541` | schedule #15 | present | present |
| `60cf3292…f60031` | keeper fires #15 | present | present |
| `e3b40c09…d695b1` | schedule #16 | present | present |
| `a0af9381…708b4` | cancel #16 | present | present |

| Hash (short) | Source | `e2e-testnet.md` | `e2e-testnet-review.md` |
|---|---|---|---|
| `b36551fc4e…` | S1 `set_rule` | present | present |
| `30bb69e63e…` | S8 keeper execute | present | present |
| `6a4642d31d…` | S4 `pay_owner` | present | present |
| `711c326ffe…` | S7 `pay_executor` | present | present |

Review verdicts match the reports: `e2e-testnet-review.md` = *approve with corrections* (all 20/20 hashes SUCCESS; corrections subsequently applied in `e2e-polish.md`); `e2e-polish-review.md` = *approve with corrections* (B1/B2/B3); `e2e-polish-review-2.md` = *approve with corrections* on the fixes (4/4 mutations caught; states `test:live` 112, full 922). The final gates in `e2e-polish.md` "Review fixes" (922) match this gate's rerun.

Minor doc inconsistency (non-blocking): the *Summary verdict* at the top of `backlog/e2e-polish.md` still quotes the pre-fix baseline (`test:live` 84 / full 894); the later "Review fixes" section and both reviews state the final 112/922 that this gate reproduced.

## Step 7 — PR-ready summary

**What the branch adds (12 lines):**
1. `stellar/src/guard/**` — read/write Soroban guard client (SEP-agnostic): rule/executor/allowance reads, route/amount/error classification, ABI golden tests.
2. `stellar/src/approval/**` — approval profiles, `always_ask` / `auto_under_limit` routing, and the `approve → set_rule → set_executor` auto-pay enable/disable builders (executor armed last).
3. `stellar/src/schedule/**` — `schedulePayment`, `cancelSchedule`, `listUpcoming`, DST-safe IANA local-time conversion, typed refusals, mandatory allowance pre-check.
4. `stellar/src/payments/**` — guarded/direct `sendPayment`, alias resolution, asset summaries; approval-aware routing; the `tx_too_early` fix (`timebounds.minTime = 0`).
5. `stellar/src/suggest/**` — deterministic payment-suggestion engine (stats/amount/ranking) with a privacy guard test.
6. `stellar/src/live/**` — testnet-only live adapters: config/key store (`~/.polaris-e2e/keys.json`, `0700`/`0600`), signer, submit+poll, uniform timeouts, friendbot.
7. `stellar/src/live/{setup,run}.ts` — `e2e:setup` / `e2e:run`: fresh throwaway keys + full S0–S11 testnet scenario run (12/12 PASS, all hashes SUCCESS on-chain).
8. `stellar/src/live/{status,tool,args,confirm}.ts` — `e2e:status` (read-only snapshot, `--json`) and `e2e:tool` (12 commands, card decoded from XDR, strict lowercase `y`/`yes` gate, signs exactly the displayed XDR, 120 s prompt timeout).
9. `stellar/src/index.ts` — public exports wired for all lanes; `stellar/package.json` — `test:*` for all 8 suites plus `e2e:*` scripts (no new dependencies).
10. Tests: **922** across 8 suites (keeper 67, anchor 111, payments 121, guard 133, approval 112, schedule 121, suggest 145, live 112), all green; `tsc` clean.
11. `stellar/src/live/README.md` — manual-testing guide (prerequisites, status, ten scenarios, troubleshooting).
12. `backlog/**` — 19 review reports plus worker reports documenting the full independent-review trail per module.

**Risks / known limitations:**
- `e2e:tool` aliases resolve through a local book seeded with `ada`; aliases added outside the tool are unknown until re-added (contract exposes no alias enumerator).
- `keeper-once`/`keeper-watch` use the existing **global-scan** keeper (fee-only key); on the shared guard it may also run other owners' due schedules.
- `e2e:run` is not idempotent against a used setup (assumes the fresh S0 baseline); `e2e:setup --reset` overwrites `keys.json` with no backup. Both are now stated in the plan text and README.
- Documented simulation-only coverage: S5 `#104 OverDailyLimit` and the "submitted failed tx" case are not exercised live (client pre-simulates by design), and are reported as uncovered, not passed.
- `backlog.md` index was not updated with the new `backlog/*.md` reports (documented handoff for the coordinator).
- One new production `TODO(T1-fix)` records a known duplicated helper (`describeValue`) — cleanup debt, not a defect.
- Minor doc nit: `e2e-polish.md` *Summary verdict* still shows the superseded 84/894 baseline.

**Independent review per module (in `backlog/`):**
- guard-client: `backlog/guard-client-review.md` (reject) → `backlog/guard-client-review-2.md` (approve)
- send-payment: `backlog/send-payment-review.md` → `backlog/send-payment-review-2.md` (approve)
- approval-policy: `backlog/approval-policy-review.md` → `-review-2.md` → `backlog/approval-policy-review-3.md` (approve)
- schedule-tools: `backlog/schedule-tools-review.md` → `backlog/schedule-tools-review-2.md` (approve)
- suggest-engine: `backlog/suggest-engine-review.md` → `-review-2.md` → `backlog/suggest-engine-review-3.md` (approve with corrections)
- e2e-testnet: `backlog/e2e-testnet-review.md` (approve with corrections)
- e2e-polish: `backlog/e2e-polish-review.md` → `backlog/e2e-polish-review-2.md` (approve with corrections)
- integration + hygiene: `backlog/integration-chain-lane.md`

## Blocking findings (or none)

**None.** No correctness, security, scope, hygiene or reproducibility issue blocks the merge. The items in Step 7 are non-blocking debt / documentation nits; the `backlog.md` index update and the `e2e-polish.md` summary nit are the only follow-ups, and both are coordinator-level.
