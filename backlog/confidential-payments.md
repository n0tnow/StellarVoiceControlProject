# Report: confidential-payments
- **Date:** 2026-09-19
- **Worker/Agent:** coordinating agent (plan) — spike worker unassigned (suggest L2, DeepSeek v4.1 Flash)
- **Branch/Worktree:** `spike/ct` and `spike/spp` (PLANNED, separate worktrees)
- **PR:** none
- **Status:** **planned** (blocked on D1 steps 1–3; see `docs/confidential-payments.md` §9)

## Completed
- Nothing implemented. This file is the task plan for the two privacy-mode spikes and their
  conditional integration, derived from decision D2 and the spike definition in the ground-truth notes
  (2026-09-19). Design and rules live in [`docs/confidential-payments.md`](../docs/confidential-payments.md).

## Preconditions
1. **After D1 steps 1–3** (real `sendPayment` ChainTool, `polaris_guard` owner-side TS client, headless
   end-to-end script with the `#105` over-limit rejection). Do not start a spike before then.
2. **Testnet only.** Network calls are required, so **explicit user approval** must be obtained before
   running either spike (network + testnet key generation/funding).
3. **Cap: 2 hours per system.** If the cap is hit, stop and write the go/no-go as **no-go**.

## Spike 1 — Confidential Tokens (CT)

- **Objective:** cheaply learn whether Confidential Tokens are integrable in the remaining time before
  committing to full integration. Amount hidden, addresses visible.
- **Scope:** `stellar/` only (headless Node script). Touch nothing outside `stellar/`.
- **Worktree/branch:** `.worktrees/spike-ct` / `spike/ct`.
- **Approval needed:** network calls + funded testnet keys (explicit user approval first).
- **Cap:** 2 hours.
- **Steps:** with two funded testnet accounts A and B —
  1. register B (and A) in the confidential system;
  2. deposit an amount of a testnet SEP-41 token into the CT wrapper;
  3. perform `confidential_transfer` A→B;
  4. decrypt/read B's balance locally;
  5. print the tx hashes.
- **Acceptance criteria:** the script completes on testnet and prints the tx hashes for register,
  deposit and `confidential_transfer`; B's balance decrypts locally to the transferred amount.
- **Output contents (go/no-go):** contract addresses used; SDK/package used; where proofs are generated
  (Node? WASM in webview?); proof time and memory; key derivation/storage approach; what a deposit
  amount reveals publicly; merge/pending-balance semantics; **whether the guard can gate
  deposit/withdraw**; list of blockers.
- **Report format:** `backlog/confidential-spike-ct.md` (report-template format), with an explicit
  **GO / NO-GO** verdict at the top.

## Spike 2 — Stellar Private Payments (SPP)

- **Objective:** same shape as the CT spike, for Nethermind's Privacy Pools implementation. Sender,
  receiver and amount hidden inside the shared pool; only pool usage visible.
- **Scope:** `stellar/` only (headless Node script). Touch nothing outside `stellar/`.
- **Worktree/branch:** `.worktrees/spike-spp` / `spike/spp`.
- **Approval needed:** network calls + funded testnet keys (explicit user approval first).
- **Cap:** 2 hours.
- **Steps:** with funded testnet accounts —
  1. deposit into the pool;
  2. perform a private transfer inside the pool;
  3. withdraw to a **different** address;
  4. decrypt/scan own notes;
  5. handle ASP membership;
  6. export a view key.
- **Acceptance criteria:** deposit, private transfer and withdrawal-to-a-different-address complete on
  testnet; the worker can decrypt/scan its own notes; ASP membership and view-key export are
  demonstrated; tx hashes printed.
- **Output contents (go/no-go):** same list as the CT spike (contract addresses, SDK/package, proof
  environment and cost, key derivation/storage, pending/merge semantics, guard gating, blockers), plus
  **ASP allow-list onboarding** and **view-key export** findings.
- **Report format:** `backlog/confidential-spike-spp.md` (report-template format), with an explicit
  **GO / NO-GO** verdict at the top.

## Follow-up integration tasks (conditional on GO)

Only start these after the corresponding spike reports a **GO**. Each is its own branch/worktree/PR.

| # | Task | Scope | Depends on | Notes |
|---|---|---|---|---|
| I1 | CT client (`register`/`deposit`/`merge`/`withdraw`/`confidential_transfer`, decrypt/viewing) | `stellar/src/confidential/` (PLANNED) | CT spike GO | Mirror the spike script into a typed client. |
| I2 | CT ChainTool wiring: `Intent.mode === "confidential"` → build CT transfer + summary with `privacy.mode`/`recipientRegistered` | `stellar/`, `interfaces/` (reserved fields) | I1 + seam lands | Fail-closed on unregistered recipient. **Acceptance:** on testnet, a headless script produces the CT transfer + decoded summary that matches the §5 approval-card checklist **and** a refusal case returns the machine-readable `refusal` (design §12 C5/C8). |
| I3 | SPP client (pool deposit, private transfer, withdraw, note scan, ASP handling, view-key export) | `stellar/src/spp/` (PLANNED) | SPP spike GO | Compliance-first; ASP onboarding in scope. |
| I4 | SPP ChainTool wiring: `Intent.mode === "private"` → build SPP transfer + summary | `stellar/`, `interfaces/` (reserved fields) | I3 + seam lands | Fail-closed on non-onboarded recipient. **Acceptance:** on testnet, a headless script produces the SPP transfer + decoded summary that matches the §5 approval-card checklist **and** a refusal case returns the machine-readable `refusal` (e.g. `not_on_allow_list`/`pool_unavailable`; design §12 C5/C8). |
| I5 | Approval-card privacy variant + batch payroll card | `app/`, `agent/` (Owner A) | I2/I4 | Checklist in `docs/confidential-payments.md` §5. |
| I6 | Local encrypted transaction history | `app/` (Owner A) | I5 | Key custody is an open question (design §6). |
| I7 | Guard boundary caps (deposit cap + client-side per-transfer limit) | `stellar/`, possibly `contracts/` v0.2 | spike Q9 answer | See `backlog/guard-v0.2-hardening.md`. |

## On NO-GO
- Record the blocker(s) in the spike report; add the documented roadmap (what would unblock it) and a
  **demo slide** explaining the mode and why it is not integrated yet. Do not force a partial
  integration.

## Unfinished (handed off)
- Both spikes and all conditional integration tasks above.

## Blockers
- D1 steps 1–3 not done. No network/testnet-key approval granted yet.

## Review Notes
- Spike reports must state clearly what was actually run vs read (attribution), and must use the exact
  source URLs/dates in `docs/reports/2026-09-19-privacy-on-stellar-research.md`.

## Suggested Next Step
- Finish the headless slice, then run the CT spike under `spike/ct` (2h cap) and file
  `backlog/confidential-spike-ct.md` with a GO/NO-GO.
