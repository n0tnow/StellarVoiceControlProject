# Privacy on Stellar — Confidential Tokens & Stellar Private Payments

- **Date:** 2026-09-19
- **Author/Agent:** coordinating agent (W-docs), consolidating the ground-truth notes
- **Keywords:** privacy, confidential-tokens, ct, stellar-private-payments, spp, zk, pedersen, ultrahonk, noir, barretenberg, circom, groth16, view-key, asp, masak, sep-6, testnet

## Summary

Stellar now has two developer-preview privacy systems relevant to Polaris: **Confidential Tokens
(CT)** — amount hidden, addresses visible — and **Stellar Private Payments (SPP)** — sender, receiver
and amount hidden inside a shared shielded pool. Both are **unaudited developer previews, testnet
only**, which the project accepts because Polaris itself is testnet-only (decision D2). This report
records the exact facts, their sources and dates, and separates what was **verified from official
Stellar sources** from what comes from a **prior research session, relayed by the project owner**.
Full product rules and the implementation plan are in
[`docs/confidential-payments.md`](../../docs/confidential-payments.md).

## Findings

### Confidential Tokens (CT)

- **What it is:** an existing SEP-41 token (e.g. USDC) is deposited into a wrapper contract; the balance
  is encoded on-chain as a **Pedersen commitment** (verifiable, amount hidden). "Identity visible,
  amount hidden."
- **Operation set:** `register / deposit / merge / withdraw / confidential_transfer`.
- **Recipient prerequisite:** the recipient must first `register` their encryption key with the system —
  "like opening a trustline but one level deeper" — so a random never-seen address cannot receive a
  confidential transfer.
- **Proof system:** **UltraHonk** verifier for **Noir** circuits (Barretenberg backend); ZK host
  functions **BN254 (CAP-74)** and **Poseidon/Poseidon2 (CAP-75)** since Protocol 25/26.
- **Implementation:** package by **OpenZeppelin**, verifier by **Nethermind**; live on testnet. We do not
  write our own ZK circuit — we connect to the existing contract.
- **Use cases:** payroll, treasury, B2B settlement — parties already know each other.
- **Status:** developer preview; "contracts and demo are unaudited — not yet intended for production use
  or real assets."
- **Standardisation:** the **Confidential Token Association** (SDF, Nethermind, OpenZeppelin, Zama) is
  developing an open standard; implementation on Stellar is in progress.

### Stellar Private Payments (SPP)

- **What it is:** **Nethermind's Privacy Pools** implementation for Stellar, using **Circom** circuits,
  **Groth16** proofs and Soroban contracts. Users hold a private balance in a shared shielded pool and
  pay each other inside it.
- **Visibility:** the public ledger records only that the **pool was used** — never who paid whom or how
  much. **Deposits/withdrawals into/out of the pool are visible**; transfers inside need not be.
- **Compliance-first design:** **Association Set Providers (ASPs)** manage allow/deny lists; **view keys**
  let authorized parties (auditor/law enforcement) inspect specific transactions without breaking other
  users' privacy.
- **Status:** docs label it "developer preview … unaudited — testnet only".
- **Analogy (from the research session):** like Tornado Cash / Railgun in idea (deposit into a pool,
  withdraw to a different address, link hidden) but compliance-oriented.

### Provenance — what was verified vs relayed

| Fact cluster | Provenance |
|---|---|
| CT "identity visible, amount hidden"; unaudited developer preview; UltraHonk/Noir/Barretenberg; BN254 (CAP-74) / Poseidon (CAP-75); developer preview status; association (SDF, Nethermind, OpenZeppelin, Zama) | **Verified from the Stellar docs privacy page** (`#confidential-tokens`), read **2026-09-19**. |
| SPP = Nethermind Privacy Pools, Circom/Groth16/Soroban; pool-usage-only visibility; ASP allow/deny lists; view keys; "testnet only"; blog 2026-08-28 | **Verified from the same Stellar docs privacy page**, read **2026-09-19**, plus the **2026-08-28** blog/stream. |
| CT operation set (`register / deposit / merge / withdraw / confidential_transfer`); recipient must register an encryption key; OpenZeppelin package + Nethermind verifier; "Identity visible, amount hidden"; use cases; the Tornado Cash/Railgun analogy | **Prior research session, relayed by the project owner.** Treated as established fact per the ground-truth notes. |
| CT blog + dev-preview stream dates (2026-06-28 blog, 2026-07-02 stream) | **Verified URLs/dates** for the blog and stream. |

No fact above is labelled "unverified"/"assumed": the notes establish them. Open questions are listed in
`docs/confidential-payments.md` §10 and are resolved by the spikes.

## Sources

- Stellar docs — *Privacy on Stellar*, `#confidential-tokens` (also the SPP source on the same page):
  <https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens> — read **2026-09-19**.
- Stellar blog — *Developer Preview: Confidential Tokens on Stellar* (OpenZeppelin + Nethermind) —
  **2026-06-28**: <https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar>.
- Confidential Tokens dev-preview stream — **2026-07-02**:
  <https://www.youtube.com/watch?v=FxOz4jo3QIE>.
- Stellar blog — *Developer Preview: Stellar Private Payments* — **2026-08-28**:
  <https://stellar.org/blog/developers/developer-preview-stellar-private-payments> (stream
  **2026-08-28**).
- Confidential Token Association: <https://confidentialtoken.org>.
- OpenZeppelin Confidential Token repo + demo (linked from the docs page).
- CAP-74 (BN254 host functions), CAP-75 (Poseidon/Poseidon2 host functions), Protocol 25/26 — Stellar
  protocol CAPs (referenced from the docs page).
- Prior research session relayed by the project owner (CT operation set, registration prerequisite,
  package/verifier attribution, use cases, SPP analogy).

## Impact on Project / Recommendations

**So what for Polaris:** both systems are usable on testnet and fit the "privacy modes" feature
(decisions D2–D6). CT hides amounts for known parties (payroll/treasury — a good fit for the payroll
demo); SPP hides the parties themselves but is compliance-gated (ASP onboarding, view keys) and more
complex. **Implement CT first, SPP second**, each behind a 2h spike.

Concrete recommendations, all captured in the design doc:

- Label everything **testnet-only / unaudited** in docs and UI; never claim "fully private".
- **Fail-closed:** a private-mode request that cannot be honoured (recipient not registered / not in the
  ASP set) is **refused**, never downgraded to public.
- Voice may send to a **known, registered** contact only; registration, contacts, addresses and default
  modes are **manual-tab only**.
- **Instant payroll batches** are in; **scheduled confidential payments** are out (keeper has no sender
  secret material to build a proof).
- The guard cannot enforce limits on hidden amounts → cap at the **public deposit boundary** plus a
  client-side per-transfer limit gated by the approval card (`docs/confidential-payments.md` §7).

Links: design [`docs/confidential-payments.md`](../../docs/confidential-payments.md); spike tasks
[`backlog/confidential-payments.md`](../../backlog/confidential-payments.md).
