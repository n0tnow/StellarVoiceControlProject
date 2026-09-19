# Report: anchor-fallback — labelled non-TR test scenario + TR payout-health check

- **Date:** 2026-09-20 (all times UTC; evidence window 2026-09-19 22:12–22:30Z)
- **Worker/Agent:** W-anchor (DeepSeek v4.1 Flash, L2)
- **Branch/Worktree:** `chain/anchor-check` @ `.worktrees/anchor-check`
- **Scope touched:** `stellar/src/anchor/{scenarios.ts, payoutHealth.ts, check.ts, sep6.ts, index.ts, README.md}`, `stellar/src/anchor/__tests__/{scenarios,payout-health,anchor-check,sep6-sep38-sep12}.test.ts`, `stellar/package.json` (one script), `docs/demo-runbook.md`, this report. Nothing else (`stellar/src/live/**` untouched).
- **Hosts contacted (read-only):** `tr-mock-anchor.fly.dev` (`.well-known/stellar.toml`, `/sep6/info`, `/auth`, `/health`), `testanchor.stellar.org` (SEP-1/6/10), `horizon-testnet.stellar.org` (treasury payments). No Friendbot call was needed live (SDF's challenge succeeded without an existing account); the Friendbot fallback is covered offline.

## Verdict (short)

The project now has a **safe, labelled fallback demo** (`testanchor.stellar.org`, explicitly NON-TR) plus a **read-only TR payout-health check**. The live run reproduces the anchor-side stall from `backlog/anchor-live-check.md`: all three TR steps PASS, and the treasury's newest outgoing USDC payment is `2026-09-19T20:59:32Z` (~90 min old) with 26 incoming since — verdict **`payouts-stalled`**. SEP-24 appears nowhere in code paths (only prose rationale + the standard `non_interactive_customer_info_needed` error type).

## What was added

| File | Role |
|---|---|
| `stellar/src/anchor/scenarios.ts` | Pure scenario registry. `describeAnchorScenario(homeDomain, { custom? })` → `{ id: "tr-mock" \| "sdf-test" \| "custom", label, sepScope: "SEP-6 only", allowed, notes }`. Strict canonical-host validation; unknown hosts refused unless deliberately `custom` (warning label). |
| `stellar/src/anchor/payoutHealth.ts` | Read-only TR payout health. Heuristic thresholds in one place, pure `classifyPayoutHealth`, `parseHorizonPayments`, `findTreasuryAddress`, `readPayoutHealth`. |
| `stellar/src/anchor/check.ts` | `anchor:check` runner: plan mode (zero network) and live mode (SEP-1 + SEP-6 `/info` + SEP-10), plus `--payout-check`. |
| `stellar/src/anchor/sep6.ts` | Timeout narration/error gets one extra TR-only hint line (`TR_MOCK_PAYOUT_HINT`). |
| `stellar/src/anchor/index.ts` | Barrel exports for the two pure modules + the hint constant. `check.ts` is deliberately NOT exported (it imports the test-only `EnvSigner`). |
| `stellar/package.json` | `"anchor:check": "node src/anchor/check.ts"` (only change). |
| `docs/demo-runbook.md` | New section 5 "Anchor demo: primary and fallback". |
| `stellar/src/anchor/README.md` | New "Primary vs fallback demo" section. |

### Scenario labels (exact)

- TR mock — `"TR path — SEP-6 only (SEP-24 prohibited in Turkey)"`, `sepScope: "SEP-6 only"`.
- SDF test — `"NON-TR test scenario (SDF test anchor) — discovery + SEP-10 login + SEP-6 info only; deposit stops at SEP-12 KYC"`, allowed `["sep1.discovery","sep10.login","sep6.info"]`.
- Custom — `"CUSTOM anchor (<host>) — UNVERIFIED, not a TR or SDF demo scenario"`, allowed `[]`.

### Strict domain validation (attack list, all refused)

`assertPlainAnchorDomain` (pure, unit-tested) rejects, never cleans: scheme/port/credentials/path, uppercase, trailing dot, empty/over-long labels, leading/trailing hyphen, IP literals (v4/v6), localhost + internal TLDs, single-label names, non-strings, unicode homoglyphs, and **look-alikes that embed a known domain as a label prefix/suffix**. The CLI has no custom escape hatch, so `runAnchorCheck` on `evil.example.com` rejects.

Tested attacks: `tr-mock-anchor.fly.dev.evil.com`, `evil.com.tr-mock-anchor.fly.dev`, `https://tr-mock-anchor.fly.dev@evil.com`, `evil.com/tr-mock-anchor.fly.dev`, `TR-MOCK-ANCHOR.FLY.DEV`, `tr-mock-anchor.fly.dev.`, `tr-mock-anchor..fly.dev`, `-tr-mock-anchor.fly.dev`, `tr-mock-anchor.fly.dev:443`, `1.2.3.4`, `[::1]`, `localhost`, `anchor.local`, `flydev`, `tr-mock-anchor.fly.de\u0432`, `tr-mock-anchor\u2024fly.dev`, `42`.

## `anchor:check` usage

```bash
# plan only — ZERO network (proven with a stubbed fetch that throws)
npm run anchor:check -w @polaris/stellar

# live, read-only, both approved domains + payout health
npm run anchor:check -w @polaris/stellar -- --live --payout-check

# one domain
npm run anchor:check -w @polaris/stellar -- --live --home-domain testanchor.stellar.org
```

Safety in the live path: 30 s per-request timeout, only approved hosts, throwaway in-memory keypair, SEP-10 challenge validated before signing (existing `requestChallenge`), JWT never printed (only length/expiry/account), no deposits/withdrawals/SEP-12 customer creation/treasury use. The SDF scenario ends with the required line: *"Deposit is not attempted: this anchor requires SEP-12 KYC fields (first_name, last_name, email_address)"*.

## Payout-health heuristic (read-only)

Thresholds (one place, marked heuristic): `PAYOUT_FLOWING_WITHIN_MS = 10 min`, `PAYOUT_STALLED_AFTER_MS = 30 min`, `PAYMENT_HISTORY_LIMIT = 200`.

- `payouts-flowing`: newest outgoing ≤ 10 min old.
- `payouts-stalled`: no outgoing > 30 min (or none in the window) **while incoming payments exist**.
- `unknown`: no payments, only old outgoing with no incoming, or the 10–30 min indeterminate gap.

The treasury address is read from `/health` (`treasury.address`); the documented fallback is `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6`. A live-run bug was caught and fixed: an earlier generic "first G-key" search picked the **USDC issuer** from `/health`; `findTreasuryAddress` now only reads `treasury.address`/`treasury.account[_id]` or a top-level `treasury_address`, and a regression test asserts the issuer is never used.

## Timeout hint (TR only, no new network)

`pollTransaction` timeout branch appends `TR_MOCK_PAYOUT_HINT` to the `sep6.timeout` narration and the `PollTimeoutError` message **only when `toml.homeDomain === DEFAULT_HOME_DOMAIN`**:

> "The TR mock anchor accepted the order but has not paid out; run `npm run anchor:check -w @polaris/stellar -- --live --payout-check` and, for a demo, the labelled non-TR scenario `--home-domain testanchor.stellar.org`."

Static, sanitised text; the timeout path fetches nothing. Covered by two offline tests (present for TR, absent otherwise).

## SEP-24 audit

```
grep -rniE "sep[-_ ]?24|/sep24|interactive" stellar/src/anchor/ --glob '!*.md'
```

Only hits: the README rationale, the new `scenarios.ts` prose labels/notes ("SEP-24 prohibited…", "never read, configured or demoed"), and the standard SEP-12/6 error string `non_interactive_customer_info_needed` (an error `type`, not SEP-24). No `/sep24` endpoint is read, configured or demoed; `stellar.toml` is never asked for one.

## Live run (trimmed, no secrets)

```
$ npm run anchor:check -w @polaris/stellar -- --live --payout-check

Anchor check (LIVE)
====================
Scenario [tr-mock]: TR path — SEP-6 only (SEP-24 prohibited in Turkey)
  home domain: tr-mock-anchor.fly.dev
  SEP-1 discovery    PASS signing key GDXY...E73M; auth=/auth; transfer=/sep6; kyc=/sep12; quote=/sep38
  SEP-6 /info        PASS authentication_required(top)=absent; deposit: USDC(enabled=true, auth=true, min=absent, max=absent, fee_percent=0.5); withdraw: USDC(enabled=true, auth=true, min=absent, max=absent, fee_percent=0.5)
  SEP-10 login       PASS account=GBYI...W6EA; challenge validated before signing; jwt length=371; expiresAt=2026-09-20T22:29:26.000Z

Scenario [sdf-test]: NON-TR test scenario (SDF test anchor) — discovery + SEP-10 login + SEP-6 info only; deposit stops at SEP-12 KYC
  home domain: testanchor.stellar.org
  SEP-1 discovery    PASS signing key GCHL...33PR; auth=/auth; transfer=/sep6; kyc=/sep12; quote=/sep38
  SEP-6 /info        PASS authentication_required(top)=absent; deposit: SRT(enabled=true, auth=true, min=1, max=10, fee_percent=absent); native(...); USDC(...); withdraw: SRT/native/USDC(...)
  SEP-10 login       PASS account=GD7Z...J6BF; challenge validated before signing; jwt length=451; expiresAt=2026-09-20T22:29:27.000Z
  Deposit is not attempted: this anchor requires SEP-12 KYC fields (first_name, last_name, email_address)

TR payout-health (read-only)
  treasury       : GCLC...T3Z6 (health)
  verdict        : payouts-stalled
  newest outgoing: 2026-09-19T20:59:32Z
  incoming since : 26 (of 68 incoming)
  reason         : The newest outgoing payment is about 90 min old (> 30 min heuristic) while 26 incoming payment(s) arrived after it.
  reason         : Deposit payouts look stalled; this is advisory evidence for the anchor operators, not proof.
```

Note (updated for the N2 correction): the `/info` line now reads the **per-asset** `authentication_required` flag and prints the top-level flag separately as `authentication_required(top)`. Both anchors omit the top-level field (so it prints `absent`) while setting `deposit.*.authentication_required = true` per asset — the old line rendered that as `false`, which was misleading. The SDF `/info` exposes min/max 1–10 per asset, the TR mock omits min/max (as first seen on 2026-09-20). The TR SEP-10 account is a fresh throwaway each run, and no JWT was printed.

## Gates (all with `caffeinate -i`, from `stellar/`)

```
npm run check -w @polaris/stellar        # tsc -p tsconfig.json -> EXIT 0
npm run test:anchor -w @polaris/stellar  # Test Files 8 passed (8), Tests 197 passed (197)
npm test -w @polaris/stellar             # EXIT 0
  test:keeper   : 67 pass, 0 fail
  test:anchor   : 197 passed (8 files)
  test:payments : 121 passed (7 files)
  test:guard    : 133 passed (7 files)
  test:approval : 112 passed (4 files)
  test:schedule : 121 passed (5 files)
  test:suggest  : 145 passed (4 files)
  test:live     : 112 passed (12 files)
```

## Tests added (offline, mocked HTTP; no network)

- `scenarios.test.ts` — labels for both scenarios, custom-with-warning, unknown refused, SEP-24 never allowed, 17 attack inputs, exact-host acceptance.
- `payout-health.test.ts` — table-driven verdicts (no payments / only incoming / only outgoing / recent / old / boundary at exactly 10 min, 10 min + 1 ms, exactly 30 min, 30 min + 1 ms / **N3: future-dated newest outgoing → `unknown` with a clock-skew note, 2-min tolerance boundary**), newest/oldest outgoing + incoming-since counts, Horizon parsing/direction (**N3: `create_claimable_balance`/`account_merge` ignored**), treasury-address extraction (issuer never mistaken), `readPayoutHealth` with `/health` exposing the treasury, not exposing it, and being unreachable.
- `anchor-check.test.ts` — plan mode makes ZERO network calls (stub throws) for both domains and with `--payout-check` (**N7: a non-TR `--home-domain` prints "payout-check applies to the TR mock only"**); live mode PASS table for both, **B1: SDF final line printed even when discovery fails**, **N1: full JWT + raw signature sentinel + decoded payload marker absent from stdout/errors/JSON**, **N2: per-asset `authentication_required` from the real TR `/info` shape**; discovery failure → FAIL + SKIP rows; SDF Friendbot fallback (first `/auth` 404 → Friendbot → retry); `--payout-check` classification; `parseArgs`/`summarizeInfoAssets`/`looksLikeAccountMissing`; unapproved domain refused.
- `sep6-sep38-sep12.test.ts` — TR hint present in narration + error for the TR domain; absent for a non-TR domain; **N6: `ExplainLog.record` accepts only an `AnchorOwnedLink` at the type boundary**.

## Acceptance

`git status --short` shows only the allowed paths (plus the temporary root `node_modules` symlink, removed at the end); no secrets in the report or diff (`grep -E "S[A-Z2-7]{55}"` over report + diff is empty). No commit/push/add was performed.

## Remaining risks / open items

- **Anchor payout stall is still unresolved** (anchor-side, not ours); `--payout-check` only surfaces it.
- `--payout-check` is a **heuristic**: a quiet-but-healthy anchor can look `unknown`, and a very busy treasury could hide a stall behind unrelated activity in the 200-record window. It is advisory evidence, not proof. Only `payment`/`path_payment*` outflows are counted — `create_claimable_balance` and `account_merge` outflows are ignored (the TR mock advertises `claimable_balances:true`); a newest outgoing dated in the future is reported as `unknown` (2-min clock-skew tolerance).
- SDF's SEP-10 worked live without funding the throwaway account; the Friendbot fallback therefore exists but was not exercised live (it is unit-tested).
- The scenario registry is a stricter, separate layer from `parseHomeDomain` (which still normalises uppercase for the session). A future refactor could unify them, but the strictness is intentional here.
