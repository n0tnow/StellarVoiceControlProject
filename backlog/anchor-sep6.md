# Report: anchor-sep6

- **Date:** 2026-09-19
- **Worker/Agent:** W4 (Claude Sonnet 5); round-2 hardening by W4b (L2 implementer)
- **Branch/Worktree:** `feat/anchor-sep6` @ `.worktrees/anchor-sep6`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/11 (draft, `feat/anchor-sep6` -> `main`)
- **Status (round 3 + main sync):** round-1 findings 1-6 closed; round-2 review residuals N1-N3, N5-N7, N9 fixed and covered by tests; branch synced with `main` (PRs #9 keeper, #10 guard) with the five shared files resolved and combined test wiring (N8 closed); 111/111 anchor + 67/67 keeper tests green; typecheck green; plain `node` loads the package. N4 (backlog index) remains a coordinator-owned follow-up.

## Completed

SEP-6 anchor client in `stellar/src/anchor/` (README there maps every SEP to code). Anchor-agnostic: the home domain is a parameter (default `tr-mock-anchor.fly.dev`), the asset code defaults to `USDC`. Standard endpoints only (SEP-1, 10, 12, 38, 6); no SEP-24/31/45 anywhere in code, config or demo (only the README note requested). No dependency on the mock's proprietary API path or keys; the one proprietary call (`simulate-bank-transfer`) is isolated in `sandbox.ts`, opt-in, demo/e2e only.

| Piece | File(s) | Notes |
|---|---|---|
| SEP-1 discovery | `sep1.ts` | `smol-toml` parse; refuses an anchor on another network passphrase; only reads WEB_AUTH_ENDPOINT / TRANSFER_SERVER / KYC_SERVER / ANCHOR_QUOTE_SERVER / SIGNING_KEY / CURRENCIES |
| SEP-10 auth | `sep10.ts` | validates BEFORE signing via the SDK's `WebAuth.readChallengeTx` (server key, seq 0, manage_data ops, home domain, web_auth_domain, time bounds) plus our extra checks (client account matches, `web_auth_domain` op mandatory, network passphrase). After signing: same tx hash and signature verifies. JWT `sub` must be our account. Two-phase API (`beginLogin`/`finishLogin`) so a UI can show the challenge for approval first |
| SEP-12 | `sep12.ts` | empty PUT for the mock; real anchors' required fields surface as `KycRequiredError`, never invented |
| SEP-38 | `sep38.ts` | indicative `GET /price`, both directions, decimal strings |
| SEP-6 | `sep6.ts` | info, deposit, withdraw, transaction/transactions, status classification, narrated polling state machine (final vs `stopAt` vs `pending_trust` vs `pending_user`, timeout with last tx), `buildWithdrawPayment` (memo text/id/hash) |
| Preflight | `preflight.ts` | Friendbot (testnet only) + `changeTrust` through the injected signer, idempotent |
| Session + flows | `session.ts`, `flows.ts` | every step returns `{ data, explain[] }`; `runDepositFlow`, `runWithdrawFlow`; `waitForTransaction` auto-repairs `pending_trust` |
| Explain-log | `explain.ts` | `{ step, what, why, at }`, subscribe (TTS narrator), per-step slices; about 25 distinct plain-English record types (per SEP step and per SEP-6 status) |
| Signer | `types.ts`, `testSigner.ts` | `Signer { publicKey(), signTransaction(xdr, {networkPassphrase?}) }`; `EnvSigner` reads `POLARIS_TEST_SECRET`; no key handling elsewhere |
| ChainTool wiring | `chainTools.ts`, `stellar/src/index.ts` | `depositTry` and `submitSignedTx` implemented, `ChainTool`/`Intent` contract untouched; `interfaces/` NOT edited |
| Tests | `__tests__/` (5 files, 111 tests) | mocked HTTP only: toml parsing, SEP-10 (valid, wrong server key, wrong home/web_auth domain, other account, other network, tampered, garbage, non-zero sequence, missing web_auth_domain, memo, time window, signer swap, wrong JWT sub/prefix), SEP-38, SEP-12, SEP-6 requests + statuses, polling machine, preflight, full session flows, `depositTry`/`withdrawTry`, explain-log content. `hardening.test.ts` (43 tests) covers the review: host/URL policy, redirect + size caps, issuer pinning, quote-field/memo/toml-error sanitisation, memo/destination validation, session-bound payment, signer-output verification, test-signer packaging, sanitisation/JWT redaction, `pending_*_info_update`, transient poll failures, exact stroops |
| Docs | `stellar/src/anchor/README.md` | SEP-to-code map, pending_trust gotcha, verified mock behaviour, mock-vs-mainnet, SEP-24 note |

### Wallet SDK decision (`@stellar/typescript-wallet-sdk`)
Evaluated (~10 min), rejected in favour of direct `fetch` + `@stellar/stellar-sdk`:
* v5.0.0 pins its own `@stellar/stellar-sdk` 17.0.1 (we use ^17.1) and ships browser polyfills (`stream-http`, `vm-browserify`, ...); 96 MB installed; `npm audit` flags a transitive `query-string` -> `decode-uri-component` DoS with no fix available.
* Its SEP-10 `authenticate` wants a keypair/`WalletSigner` and is a black box: no hook between "challenge fetched", "validated" and "signed", which is exactly where the explain-log and the Touch-ID approval need to sit. Its docs and examples are SEP-24-centred.
* SEP-6/10/12/38 are thin HTTP; the security-relevant part (challenge validation) is provided by `stellar-sdk`'s `WebAuth` directly, so nothing is re-implemented. Added one small dependency, `smol-toml`, for SEP-1.

### Live testnet verification (real output)
Test wallet `GB3EIJMIGWZZ5FTGZJF3Q4VVJXHQKJKKCHEQCHKZDK42YBURIH7BV275` (throwaway) against `tr-mock-anchor.fly.dev`:

1. **pending_trust reproduced and repaired.** Wallet funded by Friendbot, deposit 50 TRY started WITHOUT a trustline, bank simulated: order `sep_kk83g0yhz2tx71t8knaz` sat in `pending_trust` ("Add a USDC trustline to G...; the anchor pays the USDC once the trustline exists."). `waitForTransaction` added the trustline (tx `4ba5a396...`), and the order went `pending_trust -> completed`, 1.0198045 USDC, stellar tx `dcdfdd7b2e80c90f408753a76acbf2638c07ddc9f147899b596eed4dbea5049e`.
2. **Deposit via e2e:** order `sep_ykxs7yb8rg5jz7pxpn3b`, 50.00 TRY -> 1.0198045 USDC, fee 0.25 TRY, stellar tx `2fb5222f57317834f1c826dc4c273b13668017c10719fea5c110c0c37f6180be`, balance 1.0198045 -> 2.0396090.
3. **Withdraw (real, first attempt):** 0.5 USDC failed `400 "Minimum off-ramp is 1.0000000 USDC"` although `/sep6/info` says min 0.5. Then 1 USDC: order `sep_npconbhgpz5my7x5ul1m`, paid the anchor account `GCLCZEQZ2THTEDAOFI66LACNPLY4OBKN7VKLEZFMBIHYKYQOW2W7T3Z6` with memo id `523107803354`, tx `ffa428033869533d881d8b7e61f602d44f8a392c5727ff3ed58fd7d0f16bf944`, anchor answered "TRY paid to TR02... via FAST (simulated)", 1 USDC -> 48.54 TRY (fee 0.24 TRY), balance 2.0396090 -> 1.0396090.
4. **Full e2e from a fresh in-memory key** (`npm run anchor:e2e -w @polaris/stellar`, no `POLARIS_TEST_SECRET`), account `GCZRITYLSPWKTWZ3QEYTINEXHS36JAWOWL3JJDSWJXPOY5IHTWX3PHS7`:
   * preflight: Friendbot funded, trustline tx `fc470ad3...`
   * deposit `sep_y1ln6k8ax813lniczjlo`: 50.00 TRY -> 1.0198045 USDC, fee 0.25 TRY, stellar tx `2b6e840c94f86aa53ddb84be408914dadfe0981c3b4129aa3a26cefb2d57b850`, balance 0 -> 1.0198045
   * withdraw `sep_gs3ns31ccobdgda7wkt9`: 1 USDC (memo id `967170023947`, tx `7b5c2b04bac3e7c96ecc3f8bf7b0c4fa7e2910207df8e15975e8234593dd1d54`) -> 48.54 TRY, balance 1.0198045 -> 0.0198045
   * `E2E OK`.
5. **Second anchor smoke test:** `testanchor.stellar.org` with asset `SRT`: SEP-1 discovery, `/info` (min 1, max 10), SEP-10 login (signing key validated) all work; `registerCustomer`/`startDeposit` correctly stop with `KycRequiredError` (needs `first_name, last_name, email_address`) instead of guessing PII. Its SEP-24/31/45 endpoints are never read.

Total shared-treasury use: 150 TRY deposited (3 x 50 TRY) and 97 TRY worth withdrawn back (2 x 1 USDC); about 1.06 USDC remain on throwaway testnet wallets.

### Mock behaviour that differs from the guide (precise)
* `/sep6/info` shows deposit `min 0.5 / max 300` and withdraw `min 0.5`; reality: deposit `50 / 3000` TRY (`/deposit` response, guide agrees), withdraw minimum **1 USDC** (`400` error text). Deposit `amount` = TRY, withdraw `amount` = USDC.
* Withdraw response has the treasury in `account_id` with `memo_type: "id"`; `withdraw_anchor_account` appears only on the transaction record. The rate is locked for 30 min (text in `extra_info.message`), but no `quote_id` is used (no firm quote).
* A withdrawal completes about 5-6 s after our payment lands; `pending_user_transfer_start` may already be gone by the first poll (then history is just `completed`).
* SEP-38 `total_price` is `sell/buy`: TRY per USDC on deposit (49.03) but USDC per TRY on withdraw (0.0206). The narration converts this to "1 USDC = 48.54 TRY".

## Round-2 hardening (review findings resolved)

The previous worker's uncommitted WIP was completed; `describe.ts`, `amount.ts`,
`net.ts`, `text.ts` are now wired (no dead modules), the bogus
`./anchor/testing` export and the keeper test script are gone, and the lockfile
loses only the `tsx` devDependency line (`tsx` itself stays: Vite needs it).

| Finding | Fix | Tests |
|---|---|---|
| 1. Home domain/URL policy | `net.ts`: plain FQDN only; toml endpoints https + same domain/subdomain; test-only `allowInsecure`/`allowedEndpointHosts`. `http.ts`: `redirect: "error"`, timeout covering the body, 100 KB toml and 1 MB JSON caps (declared or streamed) | `hardening.test.ts` host-policy + size-cap blocks |
| 2. `payWithdrawal` trusted its argument | The session stores its own `startWithdraw` response; `payWithdrawal(amount)` refuses without it or for another amount, pays only that destination/memo, checks the signed envelope via `assertSameTransaction`, then forgets the order. Muxed `M...` rejected; numeric memo > 2^53 made exact with `quoteNumericMemo`; `prepareWithdrawal()` + `withdrawalSummary()` give the approval card | hardening memo/session-binding blocks; `preflight-session.test.ts` preview test |
| 3. Approval card lacked the issuer | `describe.ts` decodes operations from the XDR and the card names `Asset issuer:` / `USDC:G...`; `withdrawTry` uses it | `withdrawTry` test + preview test |
| 4. Unsanitised anchor text + JWT leak | `text.ts` sanitises all anchor strings; explain records carry them as `anchorSaid` (never in `what`/`why`, `narrate()` excludes them); `login()`/`finishLogin()` return `SessionInfo` without the JWT | injection, narrator, redaction tests |
| 5. Plain node / scripts | No parameter properties or enums; `erasableSyntaxOnly: true`; `test` = anchor vitest only (no `src/keeper`); `anchor:e2e` uses `node`; `node --input-type=module -e "await import('./stellar/src/anchor/index.ts')"` loads all 81 exports | verified manually (recorded in PR) |
| 6. `pending_customer_info_update` | `sep6.ts` classifies it (and `pending_transaction_info_update`) as `needs_info`, stops polling immediately with `TransactionInfoRequiredError`, and asks SEP-12 `GET /customer?transaction_id=` for the missing fields | hardening pending-info block |

Narration event shape matches PR #8 exactly (`{ type: "anchor_step", step, what,
why }`, local structural copy + TODO until #8 merges), and `withdrawTry` uses the
local `AnchorIntent` with the `"withdraw"` kind.

## Round-3 fixes (round-2 review residuals)

The round-2 review closed findings 1, 2, 3, 5, 6 and requested the sanitisation
residuals (finding 4) plus a few small items:

| Item | Fix | Tests |
|---|---|---|
| N1 (Major) quote fields in speech | `sep38.ts`: `sell_amount`/`buy_amount`/`total_price`/`price`/`fee.total` must match a bounded decimal pattern (`^\d{1,20}(\.\d{1,10})?$`) and `fee.asset` a strict SEP-38 asset id, else `QuoteError`; every echoed value is also sanitised (`what` only). `chainTools.ts:69` now only ever sees validated values | SEP-38 hardening block (3 tests) |
| N2 text memo echo | `sanitizeAnchorText(value, 28)` before echoing in `sep6.ts` and `session.ts`; the exact memo still goes on chain | text-memo echo tests in both paths |
| N3 toml parser message | `sep1.ts` parse errors carry a sanitised, 200-char-capped detail (`MAX_ANCHOR_TEXT`); the raw line is never surfaced | TOML parser-error test |
| N5 doc drift | report/PR counts corrected to the measured suite (was 100) | — |
| N6 signer output | `preflight.ts` compares the signed envelope with the one it built (`assertSameTransaction`); `submitSignedTx(signedXdr, expectedXdr?)` compares when the expected XDR is passed and refuses a sequence-0 login challenge with a clear message | preflight signer-swap test; `submitSignedTx` test |
| N7 EnvSigner barrel | removed from `anchor/index.ts`; test-only entry point `stellar/src/anchor/testing.ts` exported as `@polaris/stellar/anchor/testing` | barrel test |
| N9 withdrawTry path | documented: pass the returned `unsignedXdr` back to `submitSignedTx` so the hash check applies | doc-only |
| N4 backlog index | coordinator-owned docs pass (instructed NOT to touch `backlog.md` here) | — |
| N8 test-runner agreement | resolved in the main sync: `stellar/package.json` `test` = `test:keeper && test:anchor`; `scripts/check.sh` runs the combined suite | `npm test` (keeper 67/67 + anchor 111/111) |

Same-class adjacent fix: the SEP-1 discovery narration no longer echoes raw
endpoint paths (`sep1.ts`, sanitised and capped at 120 chars).

## Sync with main (PRs #9 keeper, #10 guard)

`origin/main` (`259dbe9`) was merged into the branch before merge; the five shared files were resolved so both suites live side by side:

| File | Resolution |
|---|---|
| `stellar/package.json` | `test` = `test:keeper && test:anchor`; `test:keeper` = `node --test "src/keeper/**/*.test.ts"`, `test:anchor` unchanged; keeper's `keeper`/`keeper:once` scripts and `engines` kept from main; anchor's `exports["./anchor/testing"]`, `anchor:e2e`, `smol-toml`, `vitest` kept. Main's broad `src/**/*.test.ts` glob was dropped: it would feed the vitest anchor suite to `node --test`. |
| `stellar/tsconfig.json` | both sides added the same options (`types: ["node"]`, `allowImportingTsExtensions`, `erasableSyntaxOnly`); the union is identical and `erasableSyntaxOnly: true` is kept. |
| `stellar/src/index.ts` | anchor's `depositTry`/`withdrawTry`/`submitSignedTx`/`SubmitResult` re-exports and `export * as anchor` kept; `export * as keeper` added from main; main's obsolete `submitSignedTx`/`SubmitResult` stubs dropped (superseded by `anchor/chainTools.ts`; keeper does not import them). |
| `.env.example` | union: anchor block (`POLARIS_ANCHOR_HOME_DOMAIN`, `POLARIS_TEST_SECRET`) + keeper block (`KEEPER_*`, `GUARD_CONTRACT_ID`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`); every value empty, no secrets. |
| `package-lock.json` | regenerated with a root `npm install` after the package.json resolution; diff vs main is +293/-1 (anchor deps only). |

N8 closed: `scripts/check.sh` now runs `caffeinate -i npm test -w @polaris/stellar` between the workspace typecheck and the shell build; `set -euo pipefail` makes either suite's failure fail the script.

Evidence after the merge (`caffeinate -i`):
* `npm test` (from `stellar/`): keeper **67/67 pass, 0 skipped**, anchor **111/111 pass** (5 files). The conditional drift-guard test no longer skips because `contracts/polaris_guard/src/lib.rs` is now in-tree (guard PR #10 merged).
* `GUARD_SRC=../../guard-rules/contracts/polaris_guard/src/lib.rs npm run test:keeper`: **67/67 pass**.
* `GUARD_SRC=/nonexistent/lib.rs npm run test:keeper`: **66 pass + 1 skip** (the conditional path still works when the contract source is absent).
* `npm run check` and `npm run typecheck`: green for all four workspaces.

## Unfinished (handed off)
* Real signer (Rust/Touch ID) not connected; `Signer` is the plug point (the other team). `docs/interfaces.md` `SigningService.sign(payloadHash)` does not match `Signer.signTransaction(xdr)`; an adapter or an interface decision is needed.
* Firm SEP-38 quotes (`POST /quote`) and `deposit-exchange`/`withdraw-exchange`; indicative quotes only, no `quote_id` locking.
* Zero-XLM production path (sponsored reserves, fee bumps): Friendbot only, per `docs/architecture.md` §4.3.
* Withdraw `dest` (bank details) and SEP-12 field collection: only wired as parameters; a voice flow to ask the user for KYC fields is not built.
* `depositTry` needs a live account and network calls (quote, Horizon, SEP-10 GET); it is only unit-tested against fakes plus manually via the e2e flow, not through the agent.

## Blockers
None.

## Review Notes
* Shared-file edits (kept minimal): `stellar/package.json` (deps `@stellar/stellar-sdk`, `smol-toml`; devDeps `vitest`, `tsx`; scripts `test`, `anchor:e2e`), `stellar/tsconfig.json` (`types: ["node"]`, `allowImportingTsExtensions`, mirroring `agent/tsconfig.json`; the keeper worker likely makes the same edit, so expect a trivial rebase conflict), `stellar/src/index.ts` (removed the `depositTry` stub and the `submitSignedTx` stub, added two re-exports and `export * as anchor`), `.env.example` (added `POLARIS_TEST_SECRET=` with no value; removed the unused `POLARIS_ANCHOR_URL`, since a proprietary API path must not be a dependency), `package-lock.json`.
* Security review points: no key material in the repo (secret scan clean); `EnvSigner` is test-only and never logs; SEP-10 challenges are validated before the signer is ever called (tested: a bad challenge causes zero sign calls); amounts are decimal strings validated by `assertAmount`; Friendbot refused off testnet; `submitSignedTx` refuses unsigned envelopes; challenges must never go to `submitSignedTx` (they go to `finishLogin`).
* A test caught a real race (concurrent steps triggering duplicate SEP-1 fetches); fixed by caching the discovery promise.
* Type-only runtime facts: `tx.hash()` returns a `Uint8Array` in stellar-sdk 17 (wrapped in `Buffer.from` for hex compare).

### Requested changes to `@polaris/interfaces` (owned by another worker; NOT made here)
1. `IntentKind` lacks `"withdraw"`; add it (voice: "cash out 10 dollars to my bank").
2. `Intent.amount` for `deposit` is in the OFF-CHAIN currency (TRY) while for other kinds it is in `asset`; either document that or add `amountKind?: "asset" | "fiat"`.
3. `ChainToolResult` is single-step. Anchor flows need a discriminator so the shell knows where the signed XDR goes: e.g. `next?: { kind: "submit_network" | "anchor_auth" | "none"; label: string }`. Today a SEP-10 challenge is signed like a transaction but must go to `AnchorSession.finishLogin`, not to `submitSignedTx`.
4. `SigningService.sign(payloadHash)` vs `Signer.signTransaction(xdr, { networkPassphrase })`: the anchor code needs the full XDR (validation, decoded summary) and the network. Align the two (suggest the shell's signer takes XDR and returns signed XDR).
5. `PolarisEvent`: add `{ type: "explain"; step: string; what: string; why: string }` so the UI/TTS can render the explain-log through the existing event stream.

## Suggested Next Step
1. Reviewer re-verifies the merge resolution, then the coordinator squash-merges this PR; no tag yet (no milestone).
2. Interfaces owner takes the five requested changes above; then wire `configureAnchor({ signer })` in the agent with the Touch-ID signer and let the agent call `AnchorSession` steps, speaking each `explain` record.
3. Decide whether the demo shows the zero-XLM path (sponsored reserve) since a real user has no XLM after an on-ramp.

## Raven calls
1. **Asked** `search`: "SEP-6 deposit withdraw anchor transfer server". **Came back:** `stellarDocs.search_anchor_sep_docs` (SEP-1/6/10/12/38, but also lists SEP-24/31 in its description), `search_wallet_dapp_docs`, `skills.stellar-dev.standards`. **Changed:** chose these three as my sources; ignored every SEP-24/31 result.
2. **Asked** `search`: "wallet sdk sep10 authentication typescript". **Came back:** `search_wallet_dapp_docs` (Wallet SDK tutorials, described as SEP-24-oriented), `skills.stellar-dev.standards`. **Changed:** confirmed the SDK has SEP-6/10 pages; triggered the SDK evaluation.
3. **Asked** `execute`: five `search_anchor_sep_docs` queries (SEP-10 challenge validation; SEP-6 `pending_trust`; SEP-6 withdraw response; SEP-38 quote parameters; SEP-12 customer PUT/GET) + `search_wallet_dapp_docs` + `skill.read("skills.stellar-dev.standards", ["high-value-seps-for-app-developers","quick-mapping-by-use-case"])`. **Came back:** doc URLs and snippets only. Useful: the Anchor Platform SEP-6 integration page documents the `pending_trust` status (there are two ways a transaction moves into it), the SEP-10 guide's "typical authentication flow" (client verifies then signs the challenge), and the standards skill's mapping "SEP-0006 for API-first flows, SEP-0012 for KYC". **Changed:** design of the `pending_trust` repair loop and the validate-before-sign step. The `WebAuth.readChallengeTx` checks came from the installed `@stellar/stellar-sdk` type docs, not Raven.
4. **Asked** `execute` again with `includeContent: true` for the Wallet SDK SEP-6/SEP-10 tutorials and the pending_trust integration section. **Came back:** empty `content` strings (only URLs). Full page text: "not found in these sources" through Raven; I fetched the two Wallet SDK tutorial pages (`developers.stellar.org/docs/build/apps/wallet/sep6` and `.../sep10`) with WebFetch instead. **Changed:** fed the SDK-fit decision (methods `sep6().deposit/withdraw/watcher`, `sep10().authenticate({accountKp, walletSigner})`; the docs did not say what client-side challenge validation the SDK performs, which counted against adopting it as a black box).
5. Not found in these sources: the exact text of SEP-10 client-side validation rules and the SEP-6 status list with per-status client actions (I used the SEP-6 status names I know plus the anchor's own messages, and cross-checked them against live mock responses).
