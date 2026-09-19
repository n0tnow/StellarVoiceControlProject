# Polaris — Confidential & Private Payments (design)

> **Status:** design / decision record. **Testnet only.** No implementation exists yet — everything
> marked PLANNED is a future file or task, not code.
> This document records the decisions D1–D8 taken on **2026-09-19** so no one has to re-derive them.
> Ground truth for the Stellar facts below: `docs/reports/2026-09-19-privacy-on-stellar-research.md`.
> Related: `docs/interfaces.md` (reserved seam fields), `contracts/DEPLOYED.md` (guard limitations),
> `backlog/confidential-payments.md` (spike task definitions).
> *Last updated: 2026-09-19*

---

## 1. Purpose & scope

Polaris is a voice-controlled Stellar wallet agent for macOS. This document specifies **privacy
modes** — ways to move value so that the amount (Confidential Tokens) or the parties (Stellar Private
Payments) are hidden on the public ledger.

**In scope**
- Two privacy systems, implemented in order:
  1. **Confidential Tokens (CT)** — *amount hidden, addresses visible.* Wrapper around an existing
     SEP-41 token; balances held as Pedersen commitments.
  2. **Stellar Private Payments (SPP)** — *sender, receiver and amount hidden inside a shared shielded
     pool*; only pool usage is visible.
- The **public** mode as the default (normal SEP-41 / guarded payment path).
- Voice intent handling, manual-only operations, approval-card requirements, payroll batches, a local
  encrypted history, and the interaction with `polaris_guard`.
- A time-boxed **spike** per system that decides go/no-go before any integration work.

**Out of scope**
- Mainnet and real assets. **Testnet only** (project-wide non-goal; the privacy systems are themselves
  unaudited developer previews, which is acceptable *because* this is testnet).
- **Scheduled / unattended** confidential payments. The keeper cannot produce the zero-knowledge
  proof because it does not hold the sender's secret material (D6). Public scheduled payments via
  `polaris_guard` + keeper are unchanged.
- Writing our own ZK circuit. We connect to the existing contracts (CT wrapper / SPP pool).
- The Turkey/TRY anchor path: it stays **SEP-6 only**. SEP-24 is never introduced there (see
  `stellar/src/anchor/README.md` → "Why SEP-24 is deliberately not used in Turkey").

**Why this is in scope at all (D2):** the project is testnet-only, so the "unaudited developer
preview" status of CT and SPP is not a blocker. Everything shipped and shown must still be labelled
**testnet-only / unaudited**, in docs and in the UI.

---

## 2. Glossary & the three modes side by side

| Term | Meaning |
|---|---|
| **CT** | Confidential Token: a wrapper around a SEP-41 token whose balance is a Pedersen commitment. Identity visible, amount hidden. |
| **SPP** | Stellar Private Payments: Nethermind's Privacy Pools implementation on Stellar. A shared shielded pool; deposits/withdrawals visible, transfers inside not. |
| **ASP** | Association Set Provider — manages allow/deny lists for the SPP pool (compliance-first onboarding). |
| **View key** | Key material that lets an authorized party (holder, auditor, law enforcement) decrypt specific amounts/transactions without breaking other users' privacy. |
| **Registration** | A recipient's one-time enrolment in the confidential system so they can receive (CT: publishing an encryption key; SPP: joining the ASP set / pool notes). |
| **Fail-closed** | A private-mode request that cannot be honoured is **refused**, never silently downgraded to a public transfer. |

### The three modes (D2)

| Property | **public** | **confidential** (CT) | **private** (SPP) |
|---|---|---|---|
| Hidden | nothing | **amount** | **sender, receiver, amount** (inside the pool) |
| Stays visible | sender, receiver, amount, memo, asset | sender and receiver addresses, asset, that a wrapper was used | that the pool was used; **deposit and withdrawal** amounts/addresses |
| Who can audit | anyone (public ledger) | holder's viewing key; auditor given view access | ASP allow/deny lists; **view keys** let authorized parties inspect specific transactions without revealing others' |
| Recipient prerequisite | trustline for the asset (classic SEP-41) | recipient must first `register` their encryption key with the confidential system — "like opening a trustline, one level deeper" (D3, §2 of the notes) | inside the pool; **ASP membership / allow-list onboarding** |
| Proof system | none | Pedersen commitment; verified by Nethermind's **UltraHonk** verifier (Noir circuits, Barretenberg backend); ZK host functions BN254 (CAP-74) and Poseidon/Poseidon2 (CAP-75) since Protocol 25/26 | **Circom** circuits, **Groth16** proofs, Soroban contracts |
| Operation set | SEP-41 `transfer` | `register / deposit / merge / withdraw / confidential_transfer` | deposit into pool, private transfer, withdraw to a different address, decrypt/scan own notes, ASP membership handling, view-key export |
| Use case | everyday transparency, demo default | payroll, treasury, B2B settlement — parties already know each other | compliance-oriented shielded transfers ("Tornado Cash / Railgun in idea, but compliance-first") |
| Status | production | **developer preview — unaudited**, testnet only | **developer preview — unaudited**, testnet only |
| Mode name in the seam | `"public"` | `"confidential"` | `"private"` |

**Source links (with dates)**
- Stellar docs — *Privacy on Stellar*, section `#confidential-tokens`: <https://developers.stellar.org/docs/build/apps/privacy#confidential-tokens> — read **2026-09-19** (also the source for SPP on the same page).
- Blog — *Developer Preview: Confidential Tokens on Stellar* (OpenZeppelin + Nethermind) — **2026-06-28**: <https://stellar.org/blog/developers/developer-preview-confidential-tokens-on-stellar>; dev-preview stream **2026-07-02**: <https://www.youtube.com/watch?v=FxOz4jo3QIE>.
- Blog — *Developer Preview: Stellar Private Payments* — **2026-08-28**: <https://stellar.org/blog/developers/developer-preview-stellar-private-payments>; stream **2026-08-28**.
- CT implementation: OpenZeppelin Confidential Token repo + demo (linked from the docs page); standard work by the **Confidential Token Association** (SDF, Nethermind, OpenZeppelin, Zama): <https://confidentialtoken.org>.

---

## 3. Voice vs manual matrix (D3)

**Normative rule — FAIL-CLOSED:** *If the user asks for a private mode and it cannot be honoured, the
request is refused; it is never downgraded to public.*

**Normative rule — no dictated addresses:** 56-character strkeys are **never** dictated by voice in
any mode; addresses are entered manually or resolved from the alias book.

| Action | Voice | Manual tab | Not allowed + reason |
|---|---|---|---|
| Send to a **known contact**, public mode | ✅ "send 10 USDC to ada" | ✅ (same) | — |
| Send to a **known contact**, confidential (CT) | ✅ only if the contact is CT-registered; otherwise **refused** (fail-closed, never downgraded) | ✅ if registered | ❌ if the contact is not registered → agent says the refusal text in §4 |
| Send to a **known contact**, private (SPP) | ✅ only if the contact is reachable in the pool / ASP-allowed; otherwise **refused** | ✅ if onboarded | ❌ if not onboarded → refuse (fail-closed) |
| **Register** a confidential recipient | ❌ never by voice | ✅ settings/privacy tab; also how CT-recipient state is recorded | ❌ voice: registration is a trust-like setup step, needs deliberate manual action |
| **Add contact** (name ↔ address) | ❌ never by voice | ✅ alias book UI (name ↔ 56-char address) | ❌ voice: an address must never be dictated/invented |
| **Enter an address** | ❌ never by voice | ✅ manual paste/typing | ❌ voice: STT could mis-hear a strkey and send funds to the wrong place |
| **Choose / change default privacy mode** | ❌ never by voice (cannot be changed implicitly by a send) | ✅ settings/privacy tab | ❌ voice: changing a default is a sticky setting, not a per-command intent |
| Mode-related settings | ❌ | ✅ | ❌ voice |
| **Batch payroll** ("send the salaries", instant) | ✅ — user is present; one approval card for all lines | ✅ | — |
| **Schedule** a confidential payment | ❌ | ❌ | ❌ **Out of scope** (D6): the keeper has no sender secret material, so it cannot generate the ZK proof |
| Schedule a **public** payment | ✅ (unchanged) | ✅ | — |

**Notes**
- The privacy mode is expressed as intent: the words **"secretly" / "privately"** map to
  `confidential` or `private`; default is `public`.
- The recipient of a private-mode send must be a **saved contact** (alias). For CT the contact must
  **also** be registered in the confidential system.
- Registration, contact management, default-mode changes and any address entry are **manual-tab-only**
  and never voice.

---

## 4. Intent & result model

### 4.1 Reserved seam fields (D7)

> ⚠️ **RESERVED — not yet in `interfaces/src`.** These fields are written into the docs now; the code
> change to the shared `interfaces/` workspace will be coordinated with Owner A separately.
> `docs/interfaces.md` → "Reserved — not yet in `interfaces/src`" is the authoritative seam entry.

```ts
// RESERVED. Default when absent = "public".
export interface Intent {
  // ...existing fields (kind, asset, amount, recipient, alias, memo, source)...
  mode?: "public" | "confidential" | "private";
}

// RESERVED. The shared TS summary is `ChainToolResult["summary"]`; the Rust mirror of the
// summary is `TxSummary` (app/src-tauri/src/types.rs). Privacy state rides on the result.
// `mode` echoes the resolved mode; `recipientRegistered` is the CT/SPP precheck outcome.
export interface TxSummary {
  // ...existing fields (title, lines, explorerUrl, estimatedFee)...
  privacy?: {
    mode: "public" | "confidential" | "private";
    recipientRegistered?: boolean;
    // ...provisionally: pool/ASP status, pending/merge state, audit/explorer refs...
  };
}

// RESERVED event names (PROVISIONAL — names may change before the seam lands):
//   privacy_register_required
//   privacy_balance
```

**Semantics**
- `Intent.mode` is optional; **absent means `"public"`**. The agent must not infer a private mode from
  anything except the user's words ("secretly" / "privately") plus the manual default setting.
- `TxSummary.privacy.mode` is the **resolved** mode actually built (after the registration precheck),
  so the approval card renders ground truth, not the model's description.
- `recipientRegistered` is set only when a private mode was requested; it is the result of the CT/SPP
  registration/ASP precheck for that contact.
- Event names are provisional; do not wire them into product code until the seam lands.

### 4.2 Example — public send

```json
{
  "kind": "send",
  "asset": "USDC",
  "amount": "10",
  "recipient": "ada",
  "mode": "public",
  "source": "send 10 USDC to ada"
}
```
```json
{
  "unsignedXdr": "AAAAAgAAAAB...",
  "summary": {
    "title": "Send 10 USDC to ada",
    "lines": [
      "Pay 10 USDC (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5)",
      "to GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO (alias: ada)",
      "Network: Test SDF Network ; September 2015"
    ],
    "estimatedFee": "0.00001 XLM",
    "privacy": { "mode": "public" }
  }
}
```

### 4.3 Example — confidential send to a registered contact

```json
{
  "kind": "send",
  "asset": "USDC",
  "amount": "10",
  "recipient": "ada",
  "mode": "confidential",
  "source": "secretly send 10 USDC to ada"
}
```
```json
{
  "unsignedXdr": "AAAAAgAAAAB...",
  "summary": {
    "title": "Confidential send 10 USDC to ada",
    "lines": [
      "Private mode: confidential (CT) — amount hidden on-chain",
      "Deposit 10 USDC into the confidential wrapper, then confidential_transfer to ada",
      "Recipient GARXWVN... (alias: ada) — registered",
      "Network: Test SDF Network ; September 2015"
    ],
    "estimatedFee": "0.00001 XLM",
    "privacy": { "mode": "confidential", "recipientRegistered": true }
  }
}
```

### 4.4 Example — confidential send **refused** (contact not registered)

The request fails the registration precheck. **It is not built as a public transfer.** The agent must
speak/show exactly the refusal below and stop; the user is sent to the manual privacy tab to register
the contact.

```json
{
  "kind": "send",
  "asset": "USDC",
  "amount": "10",
  "recipient": "ada",
  "mode": "confidential",
  "source": "secretly send 10 USDC to ada"
}
```
```json
{
  "unsignedXdr": "",
  "summary": {
    "title": "Cannot send confidentially",
    "lines": [
      "ada is not registered to receive confidential payments.",
      "I will not send this as a normal public payment.",
      "Open the privacy tab to register ada first, then try again."
    ],
    "estimatedFee": "-",
    "privacy": { "mode": "confidential", "recipientRegistered": false }
  }
}
```

**Refusal message text (speak + show):**
> "I can't send that confidentially — **ada** isn't registered for confidential payments yet. I won't
> send it as a public payment. Open the privacy tab and register ada, then ask me again."

For SPP the same shape is used, with *"isn't reachable in the private pool / not on the allow-list"* in
place of *"isn't registered for confidential payments"*.

---

## 5. Approval card requirements for private modes (D4)

Private modes show **more** than a public transfer. Every money-out still ends in an approval card
(Touch ID / approval click); there is no unattended path.

**Checklist (private-mode approval card must show all of):**
- [ ] **Recipient alias**
- [ ] **Recipient address** (full, not truncated to an unrecognisable prefix)
- [ ] **Amount**
- [ ] **Asset**
- [ ] **Mode** — `CT` / `SPP` / `public` — **visually prominent** (the user must never confuse a private send with a public one)
- [ ] **Network** (testnet)
- [ ] **Fee**
- [ ] For CT: registration state of the recipient (`recipientRegistered: true`)
- [ ] For SPP: pool / ASP reachability of the recipient
- [ ] Public-boundary disclosure: the deposit/withdraw leg of a private flow is **visible on-chain** (see §2 and §7)

**Batch (payroll) card layout — one card, N lines:**
- One approval card for the whole batch (user present, D6).
- A **line per recipient**: alias + address + amount, N lines.
- A **total per asset** at the bottom (raw total plus the sum of fees).
- Mode shown once, prominently. For a mixed batch the card must flag it or refuse it (see §11 risks).

---

## 6. Local encrypted history (D5)

Because the chain does not keep a readable record of confidential amounts, the app keeps a **local
encrypted transaction history** on the user's device ("what did I really send").

| What is stored | Where | Why |
|---|---|---|
| intent (kind, asset, recipient alias/address) | device-local, **encrypted at rest** | the chain hides the amount for CT and the parties for SPP, so the app is the only readable record for the user |
| **mode** (`public` / `confidential` / `private`) | device-local, encrypted at rest | to distinguish private from public after the fact |
| **amount** | device-local, encrypted at rest | unrecoverable from the chain in CT/SPP |
| recipient **alias / address** | device-local, encrypted at rest | rebuild "who did I pay" |
| **tx hash** | device-local, encrypted at rest | link to explorer for the public legs |
| **timestamp** | device-local, encrypted at rest | ordering |
| **status** | device-local, encrypted at rest | pending / confirmed / refused |

- **Key custody is an OPEN QUESTION** (see §10): derive from the Stellar key? separate key in the
  macOS Keychain? This is resolved by the spike.
- **What it is NOT:** it is **not** a source of truth for balances. Balances come from the chain
  (public) or from the confidential system's decrypt path (CT/SPP); the local history is a convenience
  and audit trail only.

---

## 7. Interaction with `polaris_guard`

`polaris_guard` enforces **per-transaction and daily limits on plaintext amounts**. A confidential
transfer hides its amount, so the guard **cannot enforce those limits on-chain for the confidential
leg** — the contract never sees the number.

**Design consequences**
- **Move the guarantee to the public boundary.** Cap what may be moved *into* the privacy system:
  the **deposit** into the CT wrapper / the SPP pool has a **public** amount, so that is where the
  guard can bind. Deposit caps become the enforceable envelope for private spending.
- **Client-side per-transfer limit.** The app knows the amount *before* encrypting, so it enforces the
  per-transfer limit in the client. The **approval card is the gate** (Touch ID / approval click).
- **Keeper exclusion.** The keeper cannot run confidential schedules (D6) because it holds no sender
  secret material and therefore cannot produce the proof. Public scheduled payments via
  `polaris_guard` + keeper are unchanged.
- **Alias book vs registration state.** The alias→address book stays the **single contact list**.
  CT registration state is tracked **separately** per contact (`ctRegistered: boolean`), checked before
  building an intent result. The alias book does not imply registration; removing/re-pointing an alias
  is a guard concern only (see `backlog/guard-v0.2-hardening.md`, F-03).

**Open question (for the spike):** whether `polaris_guard` can gate `deposit`/`withdraw` **on-chain**
(the executor calls the wrapper) — i.e. whether the guard can be the contract that invokes the deposit,
rather than merely enforcing a client-side cap at the boundary. This is unresolved and is one of the
CT-spike outputs (§9, §10).

---

## 8. Payroll (instant batch) flow — step by step (D6)

**In scope:** instant / interactive batches — "send the salaries" means several confidential transfers
with the user present and **one approval card**.

1. **Voice** — the user says e.g. "secretly send the salaries" (a saved payroll list) or "send 10 USDC
   to each of ada, bob, carol, secretly".
2. **Agent** — resolves the payroll list / aliases to contacts, runs the registration precheck for
   **every** recipient. If any recipient is not registered, the batch is **refused** (fail-closed);
   it is not partially downgraded to public.
3. **N intents** — the agent produces one `Intent` per line, each with `mode: "confidential"`
   (or `"private"`), same asset/amount shape as a single send.
4. **ChainTool(s)** — the chain lane builds each transfer (CT: deposit + `confidential_transfer`;
   SPP: deposit + private transfer), resolving aliases and registration state. Proofs are generated
   per transfer (see §9 for the proof-generation question).
5. **ONE approval card** — a single card listing every line and a total per asset (§5). Touch ID /
   approval click once.
6. **Proofs** — once approved, the ZK proofs are produced for each line.
7. **N txs** — each line is submitted; results are tracked per line.
8. **Results / history** — per-line status is surfaced, and the whole batch is written to the local
   encrypted history (§6).

**Why scheduled confidential payments are out of scope:** the keeper is untrusted and holds only a fee
key — it has **no sender secret material**, so it cannot generate the zero-knowledge proof a private
transfer requires. A schedule for a public payment continues to work through
`polaris_guard` + keeper; a schedule for a confidential/private payment does not exist by design.

---

## 9. Implementation plan & gates

### 9.1 Work order (D1)

The chain lane is done **headless first**, in this order:

1. Real **`sendPayment`** ChainTool — `Intent` → unsigned XDR + decoded summary; alias resolution via
   the committed `aliases.json` first.
2. `polaris_guard` **owner-side TypeScript client** — `set_rule`, `set_alias`, SAC `approve`,
   `pay_executor`, plus `direct` / `guarded` modes of `sendPayment`.
3. **Headless end-to-end script** — `Intent` → XDR → dev-key sign → `submitSignedTx` → testnet tx;
   over-limit rejected with guard error **#105** (`NeedsOwnerApproval`).
4. **Only then** the confidential / private-payments spike (below).

Workers run sequentially. Integration with the voice/UI lane is deliberately paused until both sides
are done (owner A's branches land first in dependency order `a0 → a1-stt → a1-ondevice → a2 → a3 →
docs/rule-types-and-decisions`; see `backlog/2026-09-19-slice-gap-analysis.md` §H).

### 9.2 The spike (time-boxed experiment)

**Purpose:** cheaply learn whether CT (then SPP) is integrable in the remaining time before committing
to full integration.

| | |
|---|---|
| **Cap** | **2 hours per system** (CT spike 2h; SPP spike 2h). |
| **Runs after** | D1 steps (1)–(3). |
| **Network** | Testnet only; needs network calls + testnet key generation/funding. **Explicit user approval before running.** |
| **Go/no-go output** | `backlog/confidential-spike-ct.md` / `backlog/confidential-spike-spp.md`. |

**CT spike acceptance:** a Node script (in `stellar/`, headless) that, with two funded testnet accounts
A and B: registers B (and A), deposits an amount of a testnet SEP-41 token into the CT wrapper,
performs `confidential_transfer` A→B, and decrypts/reads B's balance locally, printing tx hashes.

**SPP spike acceptance:** same shape — deposit into the pool, private transfer, withdraw to a different
address, decrypt/scan own notes; ASP membership handling; view-key export.

**Go/no-go output contents (both):** contract addresses used; SDK/package used; where proofs are
generated (Node? WASM in webview?); proof time and memory; key derivation/storage approach; what a
deposit amount reveals publicly; merge/pending-balance semantics; **whether the guard can gate
deposit/withdraw**; list of blockers.

**On no-go:** record the blocker(s) in the spike report, add a documented roadmap entry (what would be
needed to unblock) and a **demo slide** that explains the mode and why it is not integrated yet. Do not
force a partial integration.

### 9.3 Planned file locations (PLANNED — not existing)

| Path | Purpose | Status |
|---|---|---|
| `stellar/src/confidential/` | CT client: register/deposit/merge/withdraw/confidential_transfer, decrypt/viewing | PLANNED |
| `stellar/src/spp/` | SPP client: pool deposit, private transfer, withdraw, note scan, ASP handling, view-key export | PLANNED |

Both live under Owner B's `stellar/` scope. No file in this repo backs these paths yet.

### 9.4 Owners

| Area | Owner |
|---|---|
| Voice intent, agent, manual privacy tab / approval UI, local encrypted history | **Owner A** (Fatih) |
| `stellar/src/confidential/`, `stellar/src/spp/`, CT/SPP client + proof plumbing, guard interaction | **Owner B** (the user) |
| Spike execution, go/no-go report | Owner B |

---

## 10. Open questions

All of the following are from the notes' "Unknowns" list and are to be resolved by the spikes.

| # | Question | Why it matters | Who/what resolves it | Resolved by |
|---|---|---|---|---|
| Q1 | Is there a usable **JS/TS client** for CT and SPP? | Determines whether the webview/Node lane can drive it at all | spike (inspect packages, run a call) | CT + SPP |
| Q2 | **Proof generation environment and cost** (Noir/Barretenberg for CT; Circom/Groth16 for SPP) | Proof generation may be too slow/heavy for the app; decides Node vs WASM-in-webview | spike (measure time + memory) | CT + SPP |
| Q3 | **Encryption / viewing key derivation and custody** — derive from the Stellar key? separate key in Keychain? | Security-critical; also drives the local encrypted history (§6) | spike | CT + SPP |
| Q4 | **Balance decryption and merge/pending semantics** | Needed to show the user a correct balance and to explain pending funds | spike | CT + SPP |
| Q5 | **Testnet contract addresses** for the CT wrapper and the SPP pool | Hard requirement to build anything | spike (from package/docs) | CT + SPP |
| Q6 | **Fee / resource budget** per private operation | May make a private transfer absurdly expensive for a demo | spike (measure) | CT + SPP |
| Q7 | **How a recipient learns of an incoming transfer** | UX: does Polaris notify, or does the recipient scan? | spike | CT + SPP |
| Q8 | **ASP allow-list onboarding for SPP** | SPP is unusable until the recipient is in an association set | spike | SPP |
| Q9 | **Can `polaris_guard` gate `deposit`/`withdraw` on-chain?** | Determines whether the private-spend envelope is contract-enforced or only client-side (§7) | spike decision + possible v0.2 contract | CT (primary), SPP |

---

## 11. Risks (each with a default)

| # | Risk | Default |
|---|---|---|
| R1 | **Proof generation too slow or too heavy** on the user's machine | If > 2h spike budget or unacceptable latency → no-go, ship the demo slide instead of integration. |
| R2 | **No usable JS/TS client** for the system | Build a thin client against the deployed contract; if still not viable in the budget → no-go. |
| R3 | **Registration friction**: a recipient not registered blocks every private send | Fail-closed refusal text (§4.4) + clear pointer to the manual privacy tab; never downgrade to public. |
| R4 | **Deposit/withdraw leg is public**, so privacy is incomplete | State it explicitly on the approval card and in the demo talking points; never claim "fully private". |
| R5 | **Guard cannot enforce limits on the confidential leg** | Cap at the public boundary (deposit) + client-side per-transfer limit + approval card as the gate (§7). |
| R6 | **Key custody for the local encrypted history** is unresolved | Default: a separate Keychain item for the history key (not derived from the Stellar secret) until the spike says otherwise; testnet only. |
| R7 | **Mixed payroll batches** (public + private recipients) leak or confuse | Default: refuse mixed-mode batches unless every line resolves cleanly; otherwise split into two cards. |
| R8 | **Stellar preview status changes** (contract/API churn under us) | Pin the versions/addresses found in the spike, record them in the spike report, and treat any change as a re-spike trigger. |

---

*Cross-references: `docs/interfaces.md` (reserved seam), `docs/reports/2026-09-19-privacy-on-stellar-research.md`
(research archive), `backlog/confidential-payments.md` (spike task definitions),
`contracts/DEPLOYED.md` (guard v0.1 limitations), `backlog/guard-v0.2-hardening.md` (v0.2 plan).*
