# Review: anchor-live-check (independent)

- **Date:** 2026-09-19 22:22Z (review window 22:21–22:23Z)
- **Reviewer:** W-review-anchor (DeepSeek v4.1 Flash, L4) — did not write the code under review
- **Branch/worktree:** `review/anchor-check` @ `.worktrees/anchor-check-review` (HEAD `8bd983e`)
- **Method:** static read of the diff + surrounding code; read-only GETs to `horizon-testnet.stellar.org` and the TR mock anchor's public endpoints; an offline mocked-HTTP scratch attack test (removed); a mutation run; `test:anchor` + `check`. All long commands under `caffeinate -i`.

## Verdict: approve with corrections

1. The fix is correct, minimal and safe: the anchor's `message`/`more_info_url` are sanitised/capped at parse time, the narration stays separate, the success path is untouched, and the new regression test genuinely fails without the fix (mutation) and passes with it (112/112).
2. The anchor-side claim is independently **CONFIRMED and still ongoing**: no treasury outgoing payment after `2026-09-19T20:59:32Z` while 24 incoming payments landed up to `22:12:02Z`, the stuck order is still frozen in `pending_anchor`, and no other user's deposit was paid either.
3. One correction required before merge: `more_info_url` is not restricted to the anchor's own host (any `https://` host is accepted). Low severity (never auto-fetched), but it contradicts the stated acceptance criterion and the report's "validated" wording.

## 1. Anchor-side claim re-verified (now)

Treasury `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6`, Horizon `GET /accounts/<treasury>/payments?order=desc&limit=200` (200 records covering `18:42:02Z`–`22:12:02Z`):

| Item | Value | Verdict |
|---|---|---|
| Newest **outgoing** payment | `2026-09-19T20:59:32Z`, `10.1982630 USDC` → `GBC36KZGIIL2…` | matches report's `20:59:32Z` |
| Outgoing after that cut | **none** (0 of any type) | stall persists |
| Incoming after the cut | **24** payments, latest `2026-09-19T22:12:02Z` (`1.0000000 USDC` ← `GACRC72RDQ2U…`) | withdrawals keep landing |
| Other users' deposits paid? | no — zero outgoing to anyone in the window after `20:59:32Z` | not just our order |
| Stuck order `sep_uwg7nu53jr5inqpc1926` | `pending_anchor`, `status_eta 5`, `message "TRY received; paying USDC on Stellar."`, `started_at 22:12:45.100Z`, `updated_at 22:12:45.355Z` (frozen) | unchanged at fetch time `22:21:56Z` |
| `/health` | `ok:true`, `treasury.usdc_balance 29139.6701437`, `low_balance:false`, `limits {min/max:null}`, `time 2026-09-19T22:21:56.699Z` | anchor healthy |
| `/sep6/info` | deposit USDC enabled, `authentication_required:true`, `fee_percent 0.5`; **no `min_amount`/`max_amount`** | report's omission confirmed |

**Decision: anchor-side stall CONFIRMED (not resumed, not contradicted).** As of `2026-09-19T22:22Z` the last outgoing is ~83 min old and no other user has been paid, so the diagnosis in `backlog/anchor-live-check.md` holds.

## 2. Alternative explanations (our account / asset / usage)

| Hypothesis | Evidence | Verdict |
|---|---|---|
| Our account lacked the issuer trustline at payout | Horizon `GAHUQAPZ…DCIE` has a USDC `GBBD47…` trustline (balance `0`) and a real sequence; report's timeline adds it at `22:12:43Z`, before deposit `22:12:45Z`. Also, a missing trustline yields `pending_trust`, not `pending_anchor`. | refuted |
| Treasury balance / sequence problem | `/health` balance `29139.67 USDC`, `low_balance:false`; no outgoing at all. | refuted |
| Anchor rejecting small / duplicate deposit | Same amount paid successfully: tx `2fb5222f…6180be` = `2026-09-19T12:38:02Z`, source **treasury**, `payment 1.0198045 USDC` → `GB3EIJMIGWZZ…`, memo `none`, 1 op, fee 100. Matches report's order `sep_ykxs7yb8rg5jz7pxpn3b` (50 TRY → 1.0198045 USDC). The stalled order's `amount_out` is the identical `1.0198045 USDC`. | refuted |
| Our client used the wrong flow | Anchor accepted every step and the order reached `pending_anchor` with "TRY received". | refuted |
| "Completed in ~2 s on 2026-09-19" sub-claim | Horizon only gives ledger close time (`12:38:02Z`); the ~2 s timing is from `backlog/anchor-sep6.md`, not independently reproducible from this tx. | PARTIAL (report-sourced) |
| Our account got a payout | Horizon shows only the Friendbot `create_account` (`22:12:37Z`); no USDC. | refuted |

## 3. The fix (`sep6.ts`) — sanitisation, URL abuse, secret echo, narration, regression

Diff `HEAD~1..HEAD -- stellar/src/anchor` touches only the `pollTransaction` timeout branch (`sep6.ts:659-670`); no other production change.

| Check | Evidence | Verdict |
|---|---|---|
| Terminal/log injection | `tx.message` is sanitised at parse time (`parseTransaction`, `sep6.ts:353`, `sanitizeAnchorText`, cap 200) and `tx.moreInfoUrl` via `safeHttpsUrl` (`sep6.ts:354`). Scratch test with `ESC[31m…\n…\u202e…\u200b…` + 500 chars: no `[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]` survives in `err.message`, `anchorSaid`, `what` or `why`; `anchorSaid` capped at 200 (+`…`). | PASS |
| Anchor text never in narration | `sep6.timeout` passes the message only as `anchorSaid`; `ExplainLog.record` re-sanitises it (`explain.ts:60`); `narrate()` = `what + why` and `toAnchorStepEvent` omit it. New test asserts `rec.what` does not contain the message. | PASS |
| `more_info_url` URL abuse | `http://…`, `javascript:…`, `https://user:pass@…`, and >300 chars are all dropped. **But** `https://attacker.example/steal` is **accepted** (host not restricted). | FAIL (host) |
| Never fetched automatically | Scratch test recorded only requests to `anchor.example.test`; `moreInfoUrl` appears only in `types.ts` and the error string, never in a fetch. | PASS |
| Secret echo | Values come solely from the anchor's JSON response; no key material is read or echoed. | PASS |
| `sep6.timeout` format | Consistent with sibling records (`step`, speakable `what`/`why`, optional `anchorSaid`, `at`); emitted via `ctx.explain.record` before the throw, so `e2e.ts`'s subscriber prints it. | PASS |
| Regression on success / other statuses | Timeout branch is the last branch, after all status handling; success, failed, stopped, needs_info, needs_trustline, needs_user paths unchanged. | PASS |

## 4. Tests and gates

| Gate | Command | Result | Verdict |
|---|---|---|---|
| Mutation: revert new logic | restored the old bare `PollTimeoutError`, ran `sep6-sep38-sep12.test.ts` | `1 failed \| 22 passed (23)` — the new test failed; then `git checkout -- sep6.ts` | PASS (reproduces) |
| Anchor tests | `npm run test:anchor -w @polaris/stellar` | `Test Files 5 passed (5)` / `Tests 112 passed (112)` | PASS (matches claim 112) |
| Typecheck | `npm run check -w @polaris/stellar` | `tsc -p tsconfig.json` exit 0 | PASS |
| Full suite | not run | allowed to skip | UNVERIFIED |

## 5. SEP-24 audit

| Location | Match | Meaning |
|---|---|---|
| `http.ts:29` | `non_interactive_customer_info_needed` | SEP-12/6 error `type` string, not SEP-24 |
| `sep6.ts:103` | same error mapping | not SEP-24 |
| `__tests__/sep6-sep38-sep12.test.ts:128,130` | same error type | not SEP-24 |
| `anchor/README.md:206-207` | prose "Why SEP-24 is deliberately not used in Turkey" | allowed rationale only |
| `stellar/src/live/*` (`interactiveConfirm`) | CLI approval prompt | unrelated to SEP-24 |

No SEP-24 endpoint, config, client or call on the TR path. **PASS.**

## 6. Demo guidance judgement

The report's guidance is broadly **sound and honest**: it names the stall as anchor-side, tells the operator to check the treasury's last outgoing payment on Horizon (not just `/health`, which cannot reveal a dead payout worker), recommends one 50 TRY deposit and never looping, and says not to ask the user to pay again.

Caveats I would add: (a) "demonstrate withdraw instead" is only half-verified — the user→treasury leg is alive, but the anchor's TRY payout leg is off-chain/simulated and withdrawal completion was not re-tested, so it is not guaranteed to reach `completed` either; (b) `testanchor.stellar.org` demands real SEP-12 fields and is rightly flagged as non-TR.

**My 5-line recommendation:**
1. Before the demo, treat a deposit as stalled if the treasury's newest outgoing USDC payment on Horizon is older than ~5 min (the current one is `2026-09-19T20:59:32Z`); `/health` alone is not enough.
2. Show the always-available, honest path: SEP-1 discovery, SEP-10 login, SEP-38 quote, SEP-12 approval, `/sep6/info`, and building a withdrawal order.
3. If a deposit is required, run one 50 TRY deposit, let the client time out, and use the new `sep6.timeout` message to say the order is stuck on the anchor's side.
4. Avoid: repeated deposits, looping the shared treasury, or presenting `testanchor.stellar.org` as the Turkish path.
5. **Notify the TR mock anchor's operators** (the maintainers of the `tr-mock-anchor.fly.dev` deployment / its project channel; the allowed public endpoints expose `ORG_URL=https://tr-mock-anchor.fly.dev` but no support address) and send exactly: order `sep_uwg7nu53jr5inqpc1926`; `started_at 2026-09-19T22:12:45.100Z`, `updated_at 2026-09-19T22:12:45.355Z` frozen, status `pending_anchor`, message "TRY received; paying USDC on Stellar.", `amount_out 1.0198045 USDC`, external `TRMA-NLSP-2AK5`; treasury `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6`; last outgoing payment `2026-09-19T20:59:32Z` (10.1982630 USDC → `GBC36KZGIIL2…`), none since, 24 incoming up to `22:12:02Z`; comparison payout tx `2fb5222f…6180be` at `2026-09-19T12:38:02Z`.

## 7. Blocking issues (exact fix each)

- **B1 — `more_info_url` host is not restricted.** `safeHttpsUrl` (`text.ts:41-50`) accepts any `https:` host, so a hostile/compromised anchor can put an arbitrary link (e.g. `https://attacker.example/…`) into the timeout error that is attributed to "order details". It is never auto-fetched, so severity is low, but it fails the stated criterion and the report's "validated `more_info_url`". **Exact fix:** at the point of use in `pollTransaction` (which has `toml`), include the URL only if `new URL(tx.moreInfoUrl).host === new URL(toml.transferServer).host`; otherwise omit it (and optionally record a `sep6.timeout` note that the anchor's link was off-host). Add a test case asserting an off-host `more_info_url` is dropped.

## 8. Non-blocking

- **N1** The thrown `PollTimeoutError.message` is now unbounded-ish (up to 200-char message + 300-char URL); consider capping the composed string, or keeping the URL only in the explain record.
- **N2** `message` is wrapped in `"…"` without escaping embedded quotes; cosmetic only.
- **N3** The report's "withdraw is safe" demo advice is not live-verified (see §6); add the caveat.
- **N4** The report header says `2026-09-20` while all evidence is `2026-09-19` UTC (commit local time is +03); label times as UTC for clarity.
- **N5** The report says "validated `more_info_url`"; make it precise ("https-only, credentials/length rejected; host not checked") until B1 is fixed.
