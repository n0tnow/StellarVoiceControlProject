# Review: W8a — polaris_p2p_escrow
- **Date:** 2026-09-20 · **Reviewer:** independent (L4) · **Under review:** `backlog/w8a-p2p-escrow.md`, `contracts/polaris_p2p_escrow/**` + `contracts/{Cargo.toml,DEPLOYED.md}`
- **Diff:** `git diff origin/main...HEAD` = 2 commits (`31672ad` code, `c540476` report). Scope matches the report; nothing outside the stated files.

## Verdict: APPROVE WITH CORRECTIONS
No BLOCKER or MAJOR. The funds logic is correct, auth-complete, CEI-ordered and reentrancy-safe; all 58 tests and clippy pass and the on-chain wasm hash matches. Corrections are documentation + optional test only (below).

## Commands run (real)
- `cargo test --manifest-path contracts/Cargo.toml` → **38 guard + 20 escrow = 58 passed, 0 failed**, 0 doc-tests.
- `cargo clippy --manifest-path contracts/Cargo.toml --all-targets -- -D warnings` → **clean**.
- `stellar contract build --manifest-path contracts/Cargo.toml` → `polaris_p2p_escrow.wasm` **12,663 bytes, 8 exports** (`accept,cancel,confirm_fiat,create_offer,get_offer,list_open,next_offer_id,reclaim`), sha256 `59822484…` = local hash = `DEPLOYED.md`.
- On-chain (RPC `https://soroban-testnet.stellar.org`): `stellar contract info hash --id CBMXLTXS…` → `59822484ade82fcdff342c378cc316fee0e8e8c76e829887e9e8b787e095ff16`; `stellar contract fetch` → 12,663 B, same sha256 (**byte-identical to the build**). Deployer `GAXZBZ3T…` exists on Horizon. **Contract id + wasm hash verified.**

## Findings
| # | Sev | file:line | Issue / failure scenario | Fix |
|---|---|---|---|---|
| R-1 | MINOR | lib.rs:495-500 (+68-72) | `read_next_id` defaults to `1`. If `NextOfferId` archives after ~120 d idle, a new `create_offer` reads 1 and can **overwrite a still-live `Offer` entry** (its TTL can outlive the counter), reusing ids and hiding funds. | Don't silently default to 1: initialise the counter explicitly, bump on view reads, or document that a restore is required. (Protocol-23 auto-restore **UNVERIFIED**.) |
| R-2 | MINOR | lib.rs:489-493, 230-289 | An untouched `Open` offer's `Offer` entry archives at `BUMP_TO` (120 d) while its tokens stay in the contract; `get_offer`/`reclaim` then return `OfferNotFound`. Not lost (entry is restorable with rent) but no helper exists. Testnet-only, far horizon. | Document the archival/restore path in crate docs + DEPLOYED.md; consider a renew/sweep. |
| R-3 | MINOR | lib.rs:277,355,387,428 | Token failures surface as **SAC codes** (e.g. `#10 BalanceError`), not the escrow 200+ block; a non-SEP-41/lying token is not validated at create (bounded: seller signs). Same class as `contracts-audit` F-05/F-06. | Document that clients range-route token codes; enforce SEP-41 client-side. |
| R-4 | INFO (design, accepted) | lib.rs:24-29, 393-432 | No arbiter: after `pay_deadline` the seller may `reclaim` even if the buyer paid fiat; `confirm_fiat` stays open forever, so a good seller can still release. Any address can `accept` (auth) and lock the seller's funds for up to `PAY_WINDOW`=1800 s without paying. | Documented in crate docs + DEPLOYED.md; acceptable for the testnet MVP. The order-book UI **must** surface it. |
| R-5 | INFO | lib.rs:460-482 | Same id-space cost growth as guard F-02: a griefer who create+cancels N offers forces clients to sweep `ceil(next/20)` pages. | Accepted tradeoff; record as known. |
| R-6 | NIT (tests) | test.rs | No host test for the confirm-vs-reclaim ordering after `pay_deadline`, nor for the `checked_add` overflow branches (`expires_at`/`pay_deadline`). | Add if time allows; not blocking. |

`contracts-audit` F-01..F-12: F-02 (id-space cost) applies as R-5; F-05 (partial typed errors) as R-3; F-11 (no upgrade path) same deliberate choice. F-01 (pause) N/A — cancel/reclaim are always available to the seller, so no global stop is needed. F-04/F-03/F-06-F-10/F-12 are guard-specific.

## Verified correct
- **Auth**: `create_offer` 238, `accept` 294, `confirm_fiat` 334 + seller check 341, `cancel` 368 + 375, `reclaim` 402 + 409.
- **State machine**: terminal states rejected everywhere; double accept/confirm/cancel/reclaim, settle-after-cancel, reclaim-after-settle all rejected; self-trade blocked (309).
- **Reentrancy**: every external `transfer` is preceded by the state write (CEI) — create 271→277, confirm 351→355, cancel 383→387, reclaim 424→428.
- **Boundaries**: accept `now>=expires_at` (306), reclaim Open `now>=expires_at` (415), reclaim Accepted strict `now>pay_deadline` (416); tests confirm both sides.
- **Arithmetic**: `amount`/`price > 0` (239/242); `checked_add` on `expires_at`/`pay_deadline`/id; no `unwrap`/`panic` in non-test lib (only `unwrap_or(1u64)`).
- **list_open**: ≤ `MAX_PAGE`=20, holes/non-open/expired skipped, `start` clamped, `saturating_add`; events: exactly one per transition with exact-shape test.
- **Report claims**: 58 tests, clippy clean, 12,663 B/8 exports, sha256 `59822484…`, testnet id — all reproduced above.

## Human-verify / unverified
No live wallet/Touch ID/mic/Freighter (N/A here). On-chain demo was create→accept→confirm only (per DEPLOYED.md); cancel/reclaim/paging/7-day TTL cap are host-test covered. Protocol-23 auto-restore of archived persistent entries is **UNVERIFIED** (no archival test).
