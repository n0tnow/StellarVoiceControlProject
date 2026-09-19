# Delta review: anchor fallback corrections — B1 final line, effective JWT test, per-asset auth, clock skew, branded links (independent)

- **Date:** 2026-09-19 22:55Z (local 2026-09-20 01:55 +03)
- **Reviewer:** W-review-anchor3 (DeepSeek v4.1 Flash, L4) — did **not** write the code under review
- **Branch/worktree:** `review/anchor-fix2` @ `.worktrees/anchor-fix2-review`, HEAD `5a5fbb9` (== `chain/anchor-check`)
- **Delta under review:** the last commit only — `5a5fbb9` "fix(anchor): always print the SDF KYC line, effective JWT-leak test, per-asset auth flag, clock-skew handling, branded anchor-owned links" (`git diff HEAD~1`, 13 files, +201/−31)
- **Prior review:** `backlog/anchor-fallback-review.md` (`d103ffb`, "approve with corrections" — B1 + N1..N7). Fix spec: `brief-anchor-fix2.md`.
- **Method:** static read of the full delta and surrounding code; independent offline scratch suite (27 tests, removed at the end); 4 mutations (each reverted with `git checkout --`); a real plan-mode CLI run (no network). No network was used anywhere; long commands under `caffeinate -i`.

## Verdict: approve with corrections

1. Every correction from the prior review is implemented and independently verified: **B1 is fixed on all discovery paths**, and N1, N2, N3, N5, N7 are genuinely fixed (mutation-proven).
2. Gates are green and match the claimed counts exactly (anchor 197 in 8 files; keeper 67; payments 121; guard 133; approval 112; schedule 121; suggest 145; live 112).
3. No blocking issues. One non-blocking gap remains: the **N6 branded link is compile-time only** — a plain-JS caller (or an `as` cast) can still record any https host; the committed suite does not catch it (only the `tsc` gate catches a type widening). This was the original N6 severity, and the fix brief explicitly permitted the branded-type approach, so it does not block.

## 1. Gates

| Gate | Command | Summary line | Result |
|---|---|---|---|
| Typecheck | `npm run check -w @polaris/stellar` | `tsc -p tsconfig.json` → exit 0 | PASS |
| Anchor tests | `npm run test:anchor -w @polaris/stellar` | `Test Files 8 passed (8)` / `Tests 197 passed (197)` | PASS (claim 197 in 8 files) |
| Keeper | `npm test` → `test:keeper` | `# tests 67` / `# pass 67` / `# fail 0` | PASS (67) |
| Payments | `test:payments` | `121 passed (7 files)` | PASS |
| Guard | `test:guard` | `133 passed (7 files)` | PASS |
| Approval | `test:approval` | `112 passed (4 files)` | PASS |
| Schedule | `test:schedule` | `121 passed (5 files)` | PASS |
| Suggest | `test:suggest` | `145 passed (4 files)` | PASS |
| Live | `test:live` | `112 passed (12 files)` | PASS |

Full `npm test -w @polaris/stellar` exit 0. All counts equal the task's claims.

## 2. B1 — the SDF final line is now on every path

`SDF_KYC_FINAL_LINE` is a single constant (`check.ts:46-47`). It is set on the **discovery-failure early return** (`check.ts:199-201`) and on the **normal path** (`check.ts:246-249`), so the two cannot drift.

Independent scratch evidence (offline, mocked fetch):

| Path | Setup | `finalLine` | JSON output | Result |
|---|---|---|---|---|
| Discovery 500 | `GET testanchor…/stellar.toml` → 500 | `=== SDF_KYC_FINAL_LINE`, contains "Deposit is not attempted" | `JSON.stringify(report)` contains the line | PASS |
| Discovery timeout | fetch throws `AbortError` | `=== SDF_KYC_FINAL_LINE` | — | PASS |
| Invalid toml | route returns `"this is [ not = valid toml"` | `=== SDF_KYC_FINAL_LINE` | — | PASS |
| Normal path | full routes | `=== SDF_KYC_FINAL_LINE` | — | PASS |
| TR (tr-mock) normal | full routes | `undefined` | line absent | PASS |
| TR discovery failure | 500 | `undefined` | line absent | PASS |

Committed test `B1: always prints the SDF KYC final line, even when discovery fails` (`anchor-check.test.ts:165-173`) asserts the 500 path. Mutation **(a)** (remove the `if (scenario.id === "sdf-test")` line on the early return) made the committed suite fail (1 failure) — see §8. **PASS.**

## 3. N1 — the JWT-leak test is now effective

- `fakeJwt(claims, signature = "sig")` now takes a raw signature segment (`helpers.ts:128-131`); the test issues a token whose signature is the plain sentinel `RAWSIGNATURE_SENTINEL` and whose payload carries `TOPSECRETJWT` (`anchor-check.test.ts:19-20,56`).
- The test renders `stdout` lines **plus** `JSON.stringify(report)`, `JSON.stringify(report.results)` and every step `detail`, then asserts none contains the full JWT, the raw signature sentinel, or the decoded payload marker (`anchor-check.test.ts:181-197`).

Mutation proof (both reverted):
- Print the JWT in the SEP-10 detail (`jwt=${token.jwt}`) → **committed N1 test fails** (`1 failed | 223 passed`).
- Include it in a **thrown error** (`throw new Error(\`auth token was ${token.jwt}\`)`) → the error is caught and sanitised into `step.detail`, and **the committed N1 test fails** (plus 2 other committed tests that assert the SEP-10 step is PASS).

So leaking via stdout, via JSON output, or via an error message is now caught. **PASS.** (Note: the test includes `JSON.stringify(report)`/step details, not raw `Error.message` objects; because the CLI funnels error text through `message()` → `sanitizeAnchorText` into a `detail`, the error path is covered end-to-end.)

## 4. N2 — per-asset `authentication_required`

`summarizeInfoAssets` now emits `auth=` per asset via `authFlag()` (true/false/absent) (`check.ts:151,162-167`), and the SEP-6 `/info` detail prints the top-level flag separately as `authentication_required(top)=…` (`check.ts:210`).

| Shape | Result | Result |
|---|---|---|
| Real TR shape `{ deposit: { USDC: { enabled, authentication_required: true, min, max } }, withdraw: { USDC: { enabled } } }` (no top level) | `authentication_required(top)=absent`; `deposit: USDC(enabled=true, auth=true, min=1, max=10, fee_percent=absent)`; `withdraw: … auth=absent` | PASS |
| SDF shape `{ SRT: {…auth:true}, USDC: {…auth:true} }` | `auth=true` per asset | PASS |
| Malformed (`undefined`, `null`, `"x"`, `{ USDC: "x" }`, `{ USDC: null }`, bad asset code, non-boolean `authentication_required`) | `none` / `auth=absent`, **no crash** | PASS |
| Non-JSON `/info` body at CLI level | step present, no crash | PASS |

Committed test `N2: reports the per-asset authentication_required flag from SEP-6 /info (real TR shape)` (`anchor-check.test.ts:220-232`) plus the updated `summarizeInfoAssets` cases. **PASS.**

## 5. N3 — future-dated newest outgoing

`CLOCK_SKEW_TOLERANCE_MS = 2 * 60 * 1000` (`payoutHealth.ts:31`); the guard runs **before** the `payouts-flowing` branch (`payoutHealth.ts:125-135`) and returns `unknown` with a clock-skew/future reason. The `payment`/`path_payment*`-only rule is documented in the heuristic comment and README.

Independent evidence:
- **Oracle cross-check:** 30 deterministic pseudo-random cases (0–6 payments, offsets −60..+60 min) compared against a from-scratch classifier → `0` mismatches.
- **Boundary exactly 2 min ahead** → `payouts-flowing` (accepted); **2 min + 1 s ahead** → `unknown`.
- **Large negative ages** (−3, −10, −60, −1440 min) → never `payouts-flowing`.
- **Existing boundaries unchanged:** 10 min → flowing, 10 min + 1 ms → unknown, 30 min → unknown, 30 min + 1 ms → stalled.
- `create_claimable_balance`/`account_merge` ignored; `path_payment_strict_send/receive` counted.

Committed tests `payout-health.test.ts:41-56`. Mutation **(b)** (delete the skew guard) made the committed suite fail with 4 failures. **PASS** — with one wording caveat: within the 2-min tolerance a negative age *does* classify as `payouts-flowing` (the committed suite asserts `out(-2)` → `payouts-flowing`), which is the intended reading of "2-min tolerance"; the checklist phrase "negative ages never `payouts-flowing`" holds only **beyond** the tolerance. Flagged in §10.

## 6. N6 — branded anchor-owned link (compile-time PASS, runtime FAIL)

`AnchorOwnedLink = string & { readonly [ANCHOR_OWNED_LINK]: true }` (`text.ts:52-60`). `ExplainLog.record`'s `link` parameter is typed `AnchorOwnedLink` (`explain.ts:64`). Grep confirms the **only** `as AnchorOwnedLink` in the repo is the legitimate factory `u.toString() as AnchorOwnedLink` (`sep6.ts:574`); no production code forges it.

- **Compile-time:** PASS. The committed `@ts-expect-error` (`sep6-sep38-sep12.test.ts:382-391`) is meaningful — `npm run check` is green, and widening the parameter to `string` turns it into `error TS2578: Unused '@ts-expect-error' directive` (mutation (c)).
- **Runtime: FAIL (non-blocking).** `record` still calls `safeHttpsUrl(opts.link)` (`explain.ts:68`), which accepts **any** https URL. A JS caller passing `"https://evil.example/x"` is **recorded, not refused or dropped** (scratch: `log.all()[0].link === "https://evil.example/x"`). An `"https://evil.example/y" as AnchorOwnedLink` cast is likewise recorded. Non-https strings *are* dropped.
- **Suite coverage:** mutation (c) (widen to `string`) leaves vitest at **224/224 passed** — the committed suite does not exercise the runtime boundary; only the `tsc` gate catches the type widening.

The fix brief explicitly allowed either "enforce the anchor-own-host rule at the boundary" **or** "take an `AnchorOwnedLink` branded type", so the chosen approach satisfies the spec; the runtime half of this re-review's criterion does not hold. See §10.

## 7. N7 / N5 — plan-mode note and doc fixes

| Item | Evidence | Result |
|---|---|---|
| Non-TR `--payout-check` plan note | `check.ts:296-303`; real CLI run `node src/anchor/check.ts --home-domain testanchor.stellar.org --payout-check` (offline) printed "payout-check applies to the TR mock only; … no payout read is planned." and did **not** print the TR `/health` line. Committed test `anchor-check.test.ts:110-122`. | PASS |
| TR + SDF both requested | still prints the TR payout plan line (TR present) | PASS |
| Runbook endpoint | `docs/demo-runbook.md:185` = `GET /sep6/transaction?id=<id>`; no `/sep6/tx` remains in the runbook | PASS |
| Backlog test counts | `backlog/anchor-fallback.md:114,117` = `197` (8 files), matching reality | PASS |
| Runbook §5 commands verbatim | `npm run anchor:check -w @polaris/stellar` and `… -- --live --payout-check` exist verbatim in `stellar/package.json`; README "Primary vs fallback demo" (§195) exists | PASS |
| README N3 limits | README documents payment/path_payment-only counting and the 2-min skew → `unknown` | PASS |

## 8. Regression and hygiene

| Item | Evidence | Result |
|---|---|---|
| B1 `more_info_url` host restriction still holds | Independent scratch attack table (12 inputs: foreign host, suffix look-alike, credentials, http, uppercase canonicalisation, scheme-relative, `javascript:`, over-long, control chars, non-string, non-standard port, exact host) → all as before. Committed `sep6-sep38-sep12.test.ts` green. | PASS |
| TR timeout hint unchanged | `git diff HEAD~1` does **not** touch `TR_MOCK_PAYOUT_HINT`; `sep6.ts:750` still appends it only when `toml.homeDomain === DEFAULT_HOME_DOMAIN`. | PASS |
| Diff scope | `git diff HEAD~1 --name-only` = the 13 `stellar/src/anchor/**` files + `docs/demo-runbook.md` + `backlog/anchor-fallback.md` only | PASS |
| Secrets | `grep -E "S[A-Z2-7]{55}"` over the diff → none | PASS |
| Mutation **(a)** drop the SDF line on the discovery-failure path | **Caught** by the committed suite (1 failure: the new B1 test) | PASS (caught) |
| Mutation **(b)** treat future-dated outgoing as flowing (delete skew guard) | **Caught** by the committed suite (4 failures in `payout-health.test.ts`) | PASS (caught) |
| Mutation **(c)** let `ExplainLog.record` accept any `string` link | **Not caught by the test suite** (vitest 224/224); caught only by `npm run check` (`TS2578` unused `@ts-expect-error` + `TS6133` unused import) | ⚠ §10 |
| N1 leak mutations (print / throw the JWT) | **Caught** by the committed N1 test | PASS (caught) |

All mutations reverted with `git checkout -- <file>`; the temporary root `node_modules` symlink and the scratch test were removed; final `git status --short` shows only this review file.

## 9. Blocking issues (exact fix each) — none

No blocking issues. The prior B1 (the original blocker) is fully fixed and regression-tested, and N1/N2/N3/N5/N7 are fixed.

## 10. Non-blocking

- **N6 — runtime boundary is not enforced.** `ExplainLog.record` validates with `safeHttpsUrl` (any https host), so a plain-JS caller or an `as` cast can record a foreign-host link; the brand protects only TS callers and only at compile time. Either (i) enforce the anchor-own-host rule inside `record` (it would need the `AnchorToml`, so a cleaner option is a host-checked wrapper), or (ii) explicitly document that the brand is compile-time-only and JS callers bypass it. The committed suite does not test the runtime boundary (mutation (c) passes vitest); the `tsc` gate is the only guard. Low severity: all realistic callers are TS, and the only production caller passes a host-checked `safeLink`.
- **N3 wording.** Within the 2-min tolerance a future-dated (negative-age) outgoing is reported as `payouts-flowing` by design and by the committed test (`out(-2)`), so "negative ages never `payouts-flowing`" is true only beyond the tolerance. No code change needed; noted for accuracy.
- **Pre-existing (not this delta).** `docs/demo-runbook.md:190-192` still quotes "26 incoming since" (the prior review saw 27 at its time); the worked example is dated and time-drifts. Not introduced by `5a5fbb9`.
- **N4 (carried).** Only the first 200-record Horizon page is read; unchanged and already documented as a heuristic limit.
