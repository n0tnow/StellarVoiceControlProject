# Polaris — Demo Runbook

> **Status:** skeleton. Real content is filled in only where it is known today; steps that depend on
> unbuilt pieces are marked **(requires Tn)** — see `docs/approval-and-scheduling.md` §9. Every open
> step names its `requires Tn` dependency instead of an undecided placeholder.
> Testnet only. Design background: `docs/approval-and-scheduling.md`,
> `contracts/DEPLOYED.md`, `stellar/src/keeper/README.md`.
> *Last updated: 2026-09-19*

---

## 1. Prerequisites

**Testnet accounts** (demo identities from `contracts/DEPLOYED.md`; secrets in the stellar-cli
keystore, never committed):

| Role | CLI identity | Address |
|---|---|---|
| Owner (the user) | `w1` | `GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E` |
| Executor (the agent) | `w1-exec` | `GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5` |
| Demo asset issuer / keeper | `w1-iss` | `GB7YX7MYCIGU6DRSBACQ4HJHQAVUP4K7BHT7NP5VP6IYVACDSEF3F2EE` |
| Payee | `w1-bob` | `GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO` |

**Funded keeper key.** Create a throwaway testnet key and fund it with a little XLM (fees only — never
a user key):

```bash
stellar keys generate keeper --network testnet --fund      # or any funded testnet key
export KEEPER_SECRET=$(stellar keys show keeper)            # never commit this
```

**Guard contract id.**

```bash
export GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D
```

**Aliases.** The owner's alias book (also the known-recipient allowlist) must contain the payee:

```bash
stellar contract invoke --id "$GUARD_CONTRACT_ID" --network testnet --source-account w1 \
  -- set_alias --owner "$(stellar keys address w1)" --alias bob \
  --address GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO
```

**SAC allowance (mandatory, before the first payment).** Every guard payment — `pay_owner`,
`pay_executor` and every schedule run — settles through SEP-41 `transfer_from`, so the owner must first
`approve(owner → guard)` on the asset SAC with an amount covering the intended mandate **plus all
schedules**. This step is required even for the "Always ask" profile, before the first payment demo.
Revoking the allowance disables **ALL** guard payments. *(requires T1 for app-driven setup; raw
commands are in `contracts/DEPLOYED.md`.)*

**Demo asset.** `PGUSD` (`PGUSD:GB7YX7…F2EE`), SAC `CC2V2R6JLMVGXQOXMZLATCNOVNS2QEOKSNZYO7DATCWJNJTUPCI5QX3E`,
7 decimals — a throwaway issuer because the Circle USDC faucet is captcha-gated.
(`requires T1/T2` for app-driven setup; the raw commands are in `contracts/DEPLOYED.md`.)

---

## 2. Keeper: start / rehearse / verify

**Rehearse (simulate only, submits nothing):**

```bash
export GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D
npm run keeper -w @polaris/stellar -- --dry-run
```

Single deterministic tick (demos/CI):

```bash
npm run keeper:once -w @polaris/stellar
```

**Start (long-running, wrapped in caffeinate):**

```bash
caffeinate -i npm run keeper -w @polaris/stellar
```

**Verify.** Watch the JSON log lines on stdout; an execution logs an `executed` event:

```json
{"ts":"2026-09-19T12:00:00.000Z","level":"info","event":"executed","id":7,"hash":"ab12...","status":"SUCCESS","ledger":1234567}
```

- `--once` exits `0` when the tick completed (even if the contract refused some schedules) and `1` on
  a config error or when `list_due` itself failed.
- Confirm the recipient's balance or the token's own `transfer` event; `Paid`/`spent_today` only prove
  the guard authorised a payment (`contracts/DEPLOYED.md`).

**Note (D12 — PROPOSED):** the demo recommendation is the same Mac as the app under `caffeinate -i`;
production is an always-on VM with multiple independent keepers. The recommendation awaits user
confirmation.

---

## 3. Scheduled-payment demo

**3.1 Create.** Voice a one-shot: "send 50 USDC to bob tomorrow at 15:00", or a recurring one:
"every Friday 10:00 for 8 weeks". The card shows **local time AND UTC**; approval is the owner
signature (Touch ID). *(requires T2 for the ChainTool, T5 for the voice/UI card.)*

**3.2 Watch it fire.** Keep the keeper running (`npm run keeper`). When the first run comes due, the
keeper submits `execute_schedule` and the payment settles roughly **15–25 s** after the due time
(poll interval + ledger close). Confirm via the `executed` log line and the explorer. **It is never
to the second.** *(requires T2, and a funded keeper + allowance.)*

**3.3 Cancel a second one.** Create a second schedule, then cancel it: voice "cancel my payment to
bob", or the **Cancel** button in "Upcoming payments". If more than one candidate matches, the agent
asks which one. Cancellation calls `cancel_schedule` (owner auth; lighter confirmation). *(requires
T2 for cancel, T5 for the list/button.)*

**Funding reminder.** The SAC allowance (not the keeper key) pays the recipient and must cover the
total of all schedules.

---

## 4. Approval-profile demo

**4.1 Always ask [DEFAULT].** Baseline state = no executor registered, `set_rule` with the Always ask
default, aliases set, and the mandatory SAC allowance already in place (§1). A payment shows an
approval card and requires Touch ID. Nothing is auto-approved. *(base slice; no T1 needed.)*

**4.2 Enable auto-pay by voice.** Say "don't ask me for payments under 25 USDC". The app builds a
`RuleDraft`, reads it back, then shows **ONE approval card** listing the three owner calls in safe
order (SAC `approve`, `set_rule`, `set_executor` last = **arming**; D13); one Touch ID submits them in
order. *(requires T1 + T5.)*

**4.3 Small payment goes through without a card.** Send an amount ≤ the threshold; it runs via
`pay_executor`, agent-signed, bound by the on-chain limits. *(requires T1 + T2.)*

**4.4 Large payment asks.** Send an amount above the threshold; it falls back to the `pay_owner` card
path and asks for Touch ID. *(requires T1 + T5.)*

---

## 5. Demo talking points (known limitations)

From `contracts/DEPLOYED.md` "Demo talking points":

- `known_recipients_only` does **not** bind schedules (F-03).
- The only kill switch for an existing schedule is `cancel_schedule` or revoking the SAC allowance
  (which also disables `pay_owner`) (F-01).
- The contract is **non-upgradeable by design** (F-11).
- **Testnet only** — no mainnet deployment exists and none is planned for this milestone.

Additional honest caveats:

- Scheduled payments are precise to roughly **15–25 s**, not the second, and only while a keeper runs.
- Failed schedules are retried indefinitely (F-12) until cancelled.
- State the public deposit/withdraw leg of any private flow; never claim "fully private".

---

*Cross-references: `docs/approval-and-scheduling.md` (design + T1–T6),
`contracts/DEPLOYED.md` (ABI, limitations, demo), `stellar/src/keeper/README.md` (keeper config),
`docs/confidential-payments.md` (privacy modes).*
