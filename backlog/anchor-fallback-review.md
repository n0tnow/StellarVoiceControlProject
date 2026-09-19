# Review: anchor-fallback — labelled non-TR scenario, `anchor:check`, TR payout-health, and the B1 fix (independent)

- **Date:** 2026-09-20 (UTC evidence ~2026-09-19 22:38–22:45Z; local +03)
- **Reviewer:** W-review-anchor2 (DeepSeek v4.1 Flash, L4) — did **not** write the code under review
- **Branch/worktree:** `review/anchor-fallback` @ `.worktrees/anchor-fallback-review`, HEAD `d103ffb` (== `chain/anchor-check`)
- **Under review:** the last two commits (`git diff HEAD~2 --stat`): `7774571` (feature) + `d103ffb` (B1 fix)
- **Method:** static read of the full diff and surrounding code; independent scratch attacks (43 + 3 tests, removed); 4 mutations (each reverted); read-only GETs to `tr-mock-anchor.fly.dev` (`/health`, `/.well-known/stellar.toml`, `/sep6/info`), `testanchor.stellar.org` (toml, SEP-6 `/info`), `horizon-testnet.stellar.org` (treasury payments); a real `readPayoutHealth` run. `--live` was never executed (only offline mocked HTTP); plan mode was run for real. All long commands under `caffeinate -i`.

## Verdict: approve with corrections

1. The security-critical layers are correct and survived every independent attack: strict scenario/domain validation, SEP-1 endpoint host restriction (no foreign-host JWT leak), `redirect: "error"`, validate-before-sign SEP-10, JWT never printed, and the B1 `more_info_url` host restriction.
2. **One blocking correction:** the mandatory SDF final line *"Deposit is not attempted: … SEP-12 KYC fields"* is **not** printed when SDF discovery fails (the discovery-failure early return skips it). Fix + regression test in §9.
3. Gates are all green and match the claimed counts exactly; the committed suite catches 3 of the 4 required mutations, but **"print the JWT" is NOT caught** (the test marker is base64-encoded) — non-blocking, because the shipped code does not print it (independently verified).

## 1. Gates

| Gate | Command | Summary line | Result |
|---|---|---|---|
| Typecheck | `npm run check -w @polaris/stellar` | `tsc -p tsconfig.json` → exit 0 | PASS |
| Anchor tests | `npm run test:anchor -w @polaris/stellar` | `Test Files 8 passed (8)` / `Tests 186 passed (186)` | PASS (matches claim 186 in 8 files) |
| Keeper | `npm test` → `test:keeper` | `# tests 67` / `# pass 67` / `# fail 0` | PASS (67) |
| Payments | `test:payments` | `121 passed (7 files)` | PASS |
| Guard | `test:guard` | `133 passed (7 files)` | PASS |
| Approval | `test:approval` | `112 passed (4 files)` | PASS |
| Schedule | `test:schedule` | `121 passed (5 files)` | PASS |
| Suggest | `test:suggest` | `145 passed (4 files)` | PASS |
| Live | `test:live` | `112 passed (12 files)` | PASS |

Full `npm test -w @polaris/stellar` exit 0. All counts equal the task's claims (keeper 67, anchor 186, payments 121, guard 133, approval 112, schedule 121, suggest 145, live 112).

## 2. Scenario / domain validation and SSRF

`describeAnchorScenario` calls `assertPlainAnchorDomain` (pure; imports only `net.ts`), then the `KNOWN` map, else throws unless `{ custom: true }`. Independent attacks (scratch `zz-review`, all as expected):

| Attack | Expected | Actual | Result |
|---|---|---|---|
| `tr-mock-anchor.fly.dev.evil.com` | reject (suffix look-alike) | `UnsafeAnchorError` | PASS |
| `evil.com.tr-mock-anchor.fly.dev` | reject (prefix look-alike) | `UnsafeAnchorError` | PASS |
| `https://tr-mock-anchor.fly.dev@evil.com` | reject (credentials) | `UnsafeAnchorError` | PASS |
| `evil.com/tr-mock-anchor.fly.dev` | reject (path) | `UnsafeAnchorError` | PASS |
| `TR-MOCK-ANCHOR.FLY.DEV` | reject (no canonicalisation) | `UnsafeAnchorError` | PASS |
| `tr-mock-anchor.fly.dev.` | reject (trailing dot) | `UnsafeAnchorError` | PASS |
| `tr-mock-anchor.fly.dev:8443` | reject (port) | `UnsafeAnchorError` | PASS |
| `tr-mock-anchor.fly.dev%2f@evil.com` | reject | `UnsafeAnchorError` | PASS |
| `1.2.3.4`, `169.254.169.254`, `0x7f000001`, `[::1]` | reject (IP literals) | `UnsafeAnchorError` | PASS |
| `localhost`, `flydev` | reject (local/single-label) | `UnsafeAnchorError` | PASS |
| empty, `"   "` | reject | `UnsafeAnchorError` | PASS |
| `tr-mock-anchor.fly\u0000.dev` | reject (control char) | `UnsafeAnchorError` | PASS |
| 254-char name | reject (>253) | `UnsafeAnchorError` | PASS |
| unicode homoglyph `…fly.de\u0432` | reject | `UnsafeAnchorError` | PASS |
| punycode `xn--…com` (unknown) | reject without custom | `UnsafeAnchorError` (accepted by `assertPlainAnchorDomain`, refused by `describeAnchorScenario`) | PASS |
| `  tr-mock-anchor.fly.dev  ` | accept (trim) | canonical host | PASS |
| custom: `anchor.example.com` | accept, `id=custom`, `UNVERIFIED`, `allowed=[]` | as expected; custom still rejects uppercase/IP | PASS |

**Home domain → fetch:** the CLI validates via `describeAnchorScenario` first, and `discoverAnchor` re-validates with `parseHomeDomain`; `runAnchorCheck(["evil.example.com"], {live:true})` rejects before any fetch (committed test). Only the two approved hosts can reach `fetch`.

**Hostile stellar.toml endpoints** (`parseStellarToml` → `assertSafeEndpoint` → `hostBelongs`; `check.ts` builds `policy` with neither `allowInsecure` nor `allowedEndpointHosts`):

| Attack | Expected | Actual | Result |
|---|---|---|---|
| `WEB_AUTH_ENDPOINT`/`TRANSFER_SERVER`/`ANCHOR_QUOTE_SERVER`/`KYC_SERVER` on `https://evil.com/…` | reject | `UnsafeAnchorError` | PASS |
| same endpoints on `http://` | reject | `UnsafeAnchorError` | PASS |
| credentials `https://u:p@tr-mock-anchor.fly.dev/…` | reject | `UnsafeAnchorError` | PASS |
| nonstandard port `:8443` | reject | `UnsafeAnchorError` | PASS |
| suffix look-alike `tr-mock-anchor.fly.dev.evil.com` | reject | `UnsafeAnchorError` | PASS |
| IP-literal host `https://1.2.3.4/…` | reject | `UnsafeAnchorError` | PASS |
| subdomain `https://api.tr-mock-anchor.fly.dev/…` | accept (anchor's own domain) | accepted | PASS (documented) |
| exact home host | accept | accepted | PASS |

**Assessment:** because endpoints are forced to be **https on the anchor's own domain (or a subdomain)**, a hostile/compromised toml **cannot** redirect the SEP-10 JWT (or any request) to a foreign host; no credential-leak path. Redirects are refused (`http.ts` `send()` sets `redirect: "error"`). This is stricter than SEP-1 allows, and safer.

## 3. `anchor:check` behaviour

| Check | Evidence | Result |
|---|---|---|
| No `--live` → zero network (fetch/http/https/DNS) | `runAnchorCheck` returns before building `ctx`; committed test stubs `fetch` to throw and asserts 0 calls for both domains and with `--payout-check`; plan mode run for real exits 0 offline. Static: no `ctx` is constructed on the plan path. | PASS |
| `--live` offline: SEP-1 + SEP-6 `/info` + SEP-10 PASS for both scenarios | committed test asserts `["PASS","PASS","PASS"]` per scenario | PASS |
| SEP-10 challenge **validated before signing** | `requestChallenge` → `validateChallenge` (client-side, pure). Independent attacks: wrong SIGNING_KEY → `SEP-10 FAIL` and **no `POST /auth`**; committed `sep10.test.ts` covers wrong home domain, wrong `web_auth_domain`, wrong account, wrong network, non-zero sequence, tampered XDR, garbage, missing `web_auth_domain`, memo, expiry/window, signer-never-asked-to-sign-tampered. | PASS |
| JWT never printed/logged/stringified | Independent live-mode scan with a signature sentinel (`…<base64>.RAWSIGNATURE_SENTINEL`) over **all** output lines → absent; wrong-key path prints nothing; thrown errors sanitised via `message()`. Committed code prints only `account`, `jwt length`, `expiresAt`. | PASS (behaviour) |
| Only account + expiry shown | `detail` = `account=<shortKey>; challenge validated before signing; jwt length=<n>; expiresAt=<iso>` | PASS |
| Friendbot only when needed, only throwaway key | `check.ts:206-209` calls Friendbot only when `scenario.id === "sdf-test"` **and** `looksLikeAccountMissing(e)`, for the in-memory `Keypair.random()` account; TR path never calls it. Committed test covers the SDF fallback. | PASS |
| SDF final line always printed | Normal path sets `finalLine`; **discovery-failure early return does not** (see §9). | **FAIL (blocking)** |
| Timeouts on every call | all calls go through `http.ts` `send()` → `AbortSignal.timeout(ctx.requestTimeoutMs)` (30 s default) covering the body | PASS |
| No deposit/withdraw/customer endpoint reachable | grep of `check.ts` URLs: `/.well-known/stellar.toml`, `<TRANSFER_SERVER>/info`, `<WEB_AUTH_ENDPOINT>`, Friendbot, Horizon `/accounts/<treasury>/payments`. No `/deposit`, `/withdraw`, `/customer`. | PASS |

## 4. Payout-health

Classifier thresholds are single-source constants (`PAYOUT_FLOWING_WITHIN_MS = 10 min`, `PAYOUT_STALLED_AFTER_MS = 30 min`, `PAYMENT_HISTORY_LIMIT = 200`). Independent oracle attacks:

| Case | Expected | Actual | Result |
|---|---|---|---|
| no payments | `unknown` | `unknown` | PASS |
| only incoming (no outgoing ever) | `payouts-stalled` | `payouts-stalled` | PASS |
| only outgoing, recent / only outgoing, old, no incoming | `payouts-flowing` / `unknown` | same | PASS |
| boundary: outgoing exactly 10 min | `payouts-flowing` | `payouts-flowing` | PASS |
| boundary: 10 min + 1 ms | `unknown` | `unknown` | PASS |
| boundary: outgoing exactly 30 min | `unknown` | `unknown` | PASS |
| boundary: 30 min + 1 ms with incoming | `payouts-stalled` | `payouts-stalled` | PASS |
| unsorted input | newest/oldest and incoming-since computed correctly | correct (`newest=at(60)`, `oldest=at(120)`, since=1) | PASS |
| non-payment op types (`create_account`, `account_merge`) ignored | ignored | ignored | PASS |
| direction vs treasury incl. `path_payment_strict_send`/`_receive` | `from===treasury` → outgoing; `to===treasury` → incoming | correct | PASS |
| pagination beyond page 1 | only first `_embedded` page parsed (no `next` follow) | as expected | PASS (documented limitation, §10) |
| future timestamp (clock skew) | (attack) | negative age → `payouts-flowing` | ⚠ observation, §10 |
| `create_claimable_balance` outflow | (attack) | ignored (anchor advertises `claimable_balances:true`) | ⚠ observation, §10 |

**Treasury discovery — the claimed bug fix, verified live.** Real `GET /health` JSON contains `asset.issuer = GBBD47…LFA5` **and** `treasury.address = GCLC…T3Z6`. `findTreasuryAddress` reads only `treasury.address`/`account`/`account_id`/`accountId` (or top-level `treasury_address`) and returns `GCLC…T3Z6`; it does **not** scan arbitrary G-keys, so the issuer is never mistaken for the treasury. Hostile values (`not-a-key`, injection-suffixed) return `undefined` (scratch). Response bodies go through `requestJson` (1 MB cap); only GETs are issued.

**Real read-only oracle (by hand).** `GET horizon-testnet.stellar.org/accounts/GCLC…T3Z6/payments?order=desc&limit=200` → 200 records, 132 outgoing / 68 incoming; newest outgoing `2026-09-19T20:59:32Z` (`10.1982630 USDC`); newest incoming `2026-09-19T22:34:22Z`; incoming since newest outgoing `27`; age ≈ 99 min. Verdict → `payouts-stalled`. The tool's real `readPayoutHealth` run returned `treasurySource="health"`, `verdict="payouts-stalled"`, `newestOutgoingAt="2026-09-19T20:59:32Z"` — **matches the expected verdict exactly**.

## 5. B1 fix (`more_info_url` host restriction, quoting, cap)

`anchorOwnedLink(value, toml)` accepts a link only if https, no credentials/port, ≤300 chars, no control chars, not an IP literal, and its host **exactly** equals a host the anchor declares (home domain or a `TRANSFER_SERVER`/`WEB_AUTH_ENDPOINT` host). Attack list from `brief-anchor-fix.md`:

| Attack | Expected | Actual | Result |
|---|---|---|---|
| `https://attacker.example/x` | drop | `undefined` | PASS |
| `https://tr-mock-anchor.fly.dev.evil.com/x` | drop | `undefined` | PASS |
| `https://tr-mock-anchor.fly.dev@evil.com/` | drop | `undefined` | PASS |
| `http://tr-mock-anchor.fly.dev/x` | drop | `undefined` | PASS |
| `https://TR-MOCK-ANCHOR.FLY.DEV/x` | allow (canonicalised) | `https://tr-mock-anchor.fly.dev/x` | PASS |
| `//tr-mock-anchor.fly.dev/x` | drop | `undefined` | PASS |
| `javascript:alert(1)` | drop | `undefined` | PASS |
| over-long URL, control characters, non-string | drop | `undefined` | PASS |
| host declared by `TRANSFER_SERVER`/`WEB_AUTH_ENDPOINT` (not home) | allow | allowed | PASS |
| `more_info_url` never auto-fetched | grep: appears only in `types.ts`, `sep6.ts` parse/use, and tests; no `fetch` | PASS |

Quoting: `quoteAnchorText` escapes `\` and `"` (`'a "b" c'` → `"a \"b\" c"`); committed test proves the error contains `\"send USDC\"` and not the raw quoted form. Cap: `composeTimeoutMessage` ≤ `MAX_POLL_TIMEOUT_MESSAGE` (600) and drops the link from the message when it does not fit (kept only in the explain `link`). Success/other-status branches are untouched by the diff; the full 186-test anchor suite passes. The TR hint is appended only when `toml.homeDomain === DEFAULT_HOME_DOMAIN`, is static/sanitised, and adds no network.

## 6. SEP-24 audit

| Location | Match | Meaning |
|---|---|---|
| `http.ts:29`, `sep6.ts:104`, tests | `non_interactive_customer_info_needed` | SEP-6/12 error `type` string, **not** SEP-24 |
| `scenarios.ts:12-13,47,51,115`, `README.md` | prose "SEP-24 prohibited…", "never read/configured/demoed" | rationale/labels only |
| `testanchor.stellar.org` toml (live) | advertises `TRANSFER_SERVER_SEP0024` / `WEB_AUTH_FOR_CONTRACTS_ENDPOINT` | **not parsed** — `parseStellarToml` reads only `WEB_AUTH_ENDPOINT`, `TRANSFER_SERVER`, `KYC_SERVER`, `ANCHOR_QUOTE_SERVER`; `check.ts` never reads a SEP-24 field |
| `stellar/src/live/*` `interactiveConfirm` | CLI approval prompt | unrelated to SEP-24 |

No `/sep24` endpoint is read, configured, called or demoed on either scenario. TR toml has no SEP-24 field at all. Labels are exact: TR = `"TR path — SEP-6 only (SEP-24 prohibited in Turkey)"`, SDF = `"NON-TR test scenario (SDF test anchor) — discovery + SEP-10 login + SEP-6 info only; deposit stops at SEP-12 KYC"` (asserted verbatim). **PASS.**

## 7. Docs accuracy

| Item | Evidence | Result |
|---|---|---|
| Commands exist verbatim | `npm run anchor:check -w @polaris/stellar [-- --live --payout-check] [-- --home-domain <d>]` present in `package.json`; `parseArgs` handles all three; plan run exits 0 offline | PASS |
| README "Primary vs fallback demo" / runbook §5 content | both present; labels, commands, "what it proves / does NOT prove", honest limits, SEP-24 prohibition | PASS |
| testanchor claims | live toml SIGNING_KEY `GCHL…33PR`; SEP-6 `/info` = SRT/native/USDC, min 1 / max 10 — matches README | PASS |
| "JWT never printed (only length and expiry)" | true (code + sentinel scan) | PASS |
| `/health → treasury.address` (runbook §5.4) | verified live | PASS |
| "newest outgoing 2026-09-19T20:59:32Z with 26 incoming since" | correct at report time; live now 27 (time drift, not an error) | PASS |
| No personal names / English only | no names; non-ASCII limited to symbols (`≤`, `→`, `–`, `§`) | PASS |
| Tables intact | both docs render as tables; no broken rows | PASS |
| Report gate counts | `backlog/anchor-fallback.md` still says `168` (actual 186 after the fix commit) | ⚠ §10 |
| Runbook order-lookup path | `GET /sep6/tx/<id>` should be `GET /sep6/transaction?id=<id>` | ⚠ §10 |

## 8. Scope / hygiene

| Item | Evidence | Result |
|---|---|---|
| Diff scope | `git diff HEAD~2 --name-only` = anchor src/tests/README, `stellar/package.json`, `docs/demo-runbook.md`, `backlog/anchor-{fallback,live-check,live-check-review}.md` only; `stellar/src/live/**` untouched | PASS |
| `package.json` | only `"anchor:check": "node src/anchor/check.ts"` added; no dependency changes | PASS |
| Secrets | `grep -E "S[A-Z2-7]{55}"` over the diff and the four docs → empty | PASS |
| Browser-safety | `scenarios.ts` imports only `net.ts` (pure); `payoutHealth.ts` has no `Buffer`/`node:`; only the CLI-only `check.ts` imports `node:url` and is **not** in the barrel (`index.ts`) | PASS |
| Mutation (a) accept any host in `describeAnchorScenario` | `if (true || opts.custom)` → **caught** (2 failures: scenarios + anchor-check) | PASS (caught) |
| Mutation (b) print the JWT in `check.ts` | `jwt=${token.jwt}` → **NOT caught** (full anchor suite 229 passed incl. scratch; the test marker is base64-encoded inside the JWT) | **FAIL (test gap)** |
| Mutation (c) treat `/health` issuer as treasury | scan `asset.issuer` first → **caught** (`payout-health.test.ts`, 1 failure) | PASS (caught) |
| Mutation (d) drop `more_info_url` host check | remove `anchorDeclaredHosts(...).has(...)` → **caught** (4 failures in `sep6-sep38-sep12.test.ts`) | PASS (caught) |

All mutations reverted with `git checkout -- <file>`; final `git status --short` shows only this review file.

## 9. Blocking issues (exact fix each)

- **B1 — the SDF final line is not "always" printed.** In `stellar/src/anchor/check.ts`, `runScenarioLive` sets `result.finalLine` for `sdf-test` only on the normal path (lines 227-232). The **discovery-failure early return** (lines 178-183) returns `{ scenario, homeDomain, steps }` with no `finalLine`, so `report.results[0].finalLine === undefined`. Independently reproduced: SDF `/.well-known/stellar.toml` → 500 → `finalLine` is `undefined` (scratch `SDF_DISCOVERY_FAIL_FINALLINE undefined`). This fails the stated criterion *"SDF-test final line … always printed for that scenario"*.
  **Exact fix:** extract the literal to a constant (e.g. `SDF_KYC_FINAL_LINE`), and in the discovery-failure branch set it before returning:
  ```ts
  const failed: ScenarioResult = { scenario, homeDomain, steps };
  if (scenario.id === "sdf-test") failed.finalLine = SDF_KYC_FINAL_LINE;
  return failed;
  ```
  Use the same constant on the normal path. **Regression test:** in `anchor-check.test.ts`, assert that a 500 on `GET testanchor.stellar.org/.well-known/stellar.toml` yields `result.finalLine` containing `"Deposit is not attempted"`.

## 10. Non-blocking

- **N1 — JWT-leak regression test is ineffective (mutation (b) uncaught).** `fakeJwt({ marker: "TOPSECRETJWT" })` base64-encodes the payload, so `expect(text).not.toContain("TOPSECRETJWT")` passes even if `token.jwt` is printed. The shipped code is correct (verified with a raw signature sentinel), but the guard does not guard. Recommend: give the fake token a decodable sentinel (e.g. signature `RAWSIGNATURE_SENTINEL`) and assert the rendered output does not contain the full JWT / decode it back.
- **N2 — `SEP-6 /info` auth flag is read only at top level.** The live TR `/sep6/info` sets `deposit.USDC.authentication_required = true` and has no top-level field, so `check.ts` prints `authentication_required=false` — misleading (the anchor does require auth). The SDF anchor behaves the same. Recommend reading the per-asset flag (or printing both) in `summarizeInfoAssets` / the `SEP-6 /info` detail.
- **N3 — classifier edges.** A future-dated newest outgoing yields `payouts-flowing` (negative age passes `<= 10 min`), and `create_claimable_balance`/`account_merge` outflows are ignored even though the TR anchor advertises `claimable_balances:true`. Currently the anchor pays via `payment`, so the live verdict is correct; document these limits or clamp negative ages.
- **N4 — pagination.** Only the first 200-record page is parsed (`order=desc`), with no `next` follow. Fine for the current treasury; note it in the heuristic docs (already partly covered).
- **N5 — doc nits.** `backlog/anchor-fallback.md` still reports `168` anchor tests (actual 186; the fix commit added the B1 tests). The runbook §5.4 says `GET /sep6/tx/<id>`; the real endpoint is `GET /sep6/transaction?id=<id>`.
- **N6 — `ExplainLog.record` re-validates `link` with `safeHttpsUrl` (any https host), not the host-restricted `anchorOwnedLink`.** The only production caller passes an already host-checked `safeLink`, so there is no current exposure, but the log API itself does not enforce the B1 rule. Consider accepting only host-checked links at the boundary.
- **N7 — plan-mode `--payout-check` with a non-TR `--home-domain` still prints the TR payout line** (payout-check is TR-only by design); cosmetic.
