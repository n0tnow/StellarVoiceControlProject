# Polaris — Approval Profiles, Auto-Pay, Scheduling & Suggestions (design)

> **Status:** design / decision record. **Testnet only.** No implementation exists yet — everything
> marked PLANNED is a future file or task, not code.
> This document records the decisions D10, D10b, D10c, D11, D13 and D14 taken on **2026-09-19**, plus
> the keeper-hosting decision D12 which is **PROPOSED**.
> Ground truth for the contract facts below: `contracts/DEPLOYED.md` (ABI + "Known limitations"),
> `stellar/src/keeper/README.md`, and the source notes for this round.
> Related: `docs/confidential-payments.md` (privacy modes), `docs/interfaces.md` (reserved seam),
> `docs/demo-runbook.md` (demo steps).
> *Last updated: 2026-09-19*

---

## 1. Purpose & scope

This document specifies how the user approves or pre-approves money-out, how payments are scheduled
for unattended execution, and how the app may *suggest* (never silently apply) safer limits. It exists
so the later TypeScript/UI implementation can be done in one pass against fixed target shapes.

**Decisions in this document**

| ID | Decision |
|---|---|
| **D10** | The **default** approval profile is **"Always ask"**: every money-out shows an approval card (+ Touch ID / approval click). Nothing is auto-approved at first start. |
| **D10b** | The user can **later enable auto-pay under a threshold**, by the settings tab OR by voice ("don't ask me for payments under 25 USDC"). Payments **at or below** the threshold run without an approval card (`pay_executor`, agent-signed) and remain bound by the on-chain limits. Everything **above** the threshold still asks. |
| **D10c** | Enabling/loosening is **never silent**: a voice request creates a **draft** that is read back, and is applied only after **ONE approval card + Touch ID**. Tightening/disabling (lower limit, revoke executor, cancel schedule) may be done by voice with read-back and needs the **lighter confirmation**. The **app-side preference can only be STRICTER than the chain, never looser** — the chain is the last defence against a compromised agent. |
| **D11** | **Smart suggestions** are computed **locally and deterministically** (statistics). An LLM may only phrase them; raw history never leaves the device (only aggregates, and only if the owner allows). A suggestion is **never applied automatically** — it becomes a draft that goes through the same read-back + card + Touch ID flow as any change. |
| **D12 (PROPOSED)** | Keeper hosting for the demo = the **same Mac** as the app, wrapped in `caffeinate -i`; production = an always-on small server. **Awaiting user confirmation.** |
| **D13** | The enable-auto-pay flow executes **allowance → rule → executor** (`approve`, `set_rule`, `set_executor`): registering the executor is the **last, arming** step. The single approval card lists the same three actions in the same order and calls out the arming step. Disable reverses it: `revoke_executor` (disarm) first, then the optional `approve(0)`. Every earlier "allowance last" ordering is **SUPERSEDED by D13**. |
| **D14** | The keeper **cannot** live inside the contract — Soroban has no scheduler/timers and every run needs a transaction from someone. `execute_schedule` is auth-free, so the **app can act as an opportunistic keeper** (on start / while open) and the payee can trigger too; a future **tip-paying `polaris_guard_v2`** for third-party keepers is **PARKED**. The demo keeps D12. |

**In scope:** approval profiles, the voice/settings flows that enable or tighten them, `RuleDraft` /
`ScheduleDraft` handling, schedule creation/cancellation UX, the local suggestions engine, keeper
hosting explained plainly, and the work items T1–T6.

**Out of scope:** mainnet and real assets (**testnet only**); confidential/private scheduled payments
(`docs/confidential-payments.md` D6); any change to the frozen `polaris_guard` v0.1 source (D9).

### Glossary

| Term | Meaning |
|---|---|
| **Approval card** | The UI card that renders the decoded transaction(s) and gates them behind Touch ID / approval click. |
| **Executor** | The agent's registered key in `polaris_guard`. When registered, the agent may call `pay_executor` within the published rule. |
| **Auto-approve limit** | The rule's `auto_approve_limit`: **a per-transaction ceiling** on an unattended `pay_executor` payment. It is *not* the daily mandate. |
| **Daily limit** | The rule's `daily_limit`: the **agent's real spending mandate** per UTC day (shared counter across owner/executor paths). App copy must present this as the mandate. |
| **Allowance** | The SAC `approve(from=owner, spender=guard, amount, live_until_ledger)`: the money ceiling and the user's off-chain kill switch. Mandatory for every guard payment (`pay_owner`, `pay_executor`, schedules — all settle through `transfer_from`). |
| **Keeper** | An untrusted off-chain program that calls `execute_schedule(id)` when a schedule is due (the chain has no timers). |
| **Draft** | A speech/settings-derived, unsigned description of a change (`RuleDraft`, `ScheduleDraft`) that is read back and then signed. Never applied silently. |

For the full guard ABI, rule fields and error codes, see `contracts/DEPLOYED.md`.

---

## 2. Approval profiles

Three profiles are exposed in the UI and selected by voice/settings. All three share the same chain
contract; only what is registered on-chain and which call path is used differ.

| Profile | What the user sees | On-chain state (executor? / `auto_approve_limit` / `daily_limit` / allowance) | Allowance required? | Call path | Who signs | Card shown? |
|---|---|---|---|---|---|---|
| **Always ask** [DEFAULT] | Every money-out shows an approval card + Touch ID. Nothing is auto-approved. | **No executor** registered. `auto_approve_limit` unused (0). `daily_limit` may still be published as the owner-path hard cap. SAC allowance **mandatory** (see normative rule). | **Yes** (mandatory) | `pay_owner` | Owner (Touch ID) | **Yes**, every payment |
| **Auto-pay under threshold** | Payments **≤ threshold** complete without a card; payments **above** show a card. | **Executor registered.** `auto_approve_limit` = threshold. `daily_limit` = the real mandate (shown prominently). Allowance **mandatory**; ≥ largest schedule total, default `daily_limit * 7` (**PROPOSED**). | **Yes** (mandatory) | `pay_executor` for ≤ threshold (agent-signed); `pay_owner` for > threshold | Agent key for `pay_executor`; owner (Touch ID) for `pay_owner` | **No** for ≤ threshold; **Yes** for > threshold |
| **Custom** | Explicit values entered by the user (per-tx, daily, asset, contacts-only, allowance). Behaviour is the same as auto-pay. | **Executor registered.** `auto_approve_limit`, `per_tx_limit`, `daily_limit`, `allowed_assets` (currently at most ONE), `known_recipients_only` set explicitly. Allowance **mandatory**, set explicitly. | **Yes** (mandatory) | `pay_executor` for ≤ `auto_approve_limit`; `pay_owner` otherwise | Agent key for `pay_executor`; owner (Touch ID) for `pay_owner` | Same as auto-pay under threshold |

**Normative rule — the allowance is mandatory.** The SAC allowance (`approve(owner -> guard)`) is
MANDATORY for every guard payment (`pay_owner`, `pay_executor` and schedule runs all settle through
`transfer_from`, `contracts/polaris_guard/src/lib.rs` `settle()`); size it to cover the intended
mandate plus all schedules; revoking it disables ALL guard payments. The first-time setup therefore
creates the allowance (SAC `approve`) even before auto-pay is enabled — this is part of the "Always
ask" baseline state. Enabling auto-pay then **adds** `set_executor` + `set_rule` (and **raises** the
allowance if the intended mandate needs more).

**Normative rule — the app preference can only be stricter than the chain, never looser.** The stored
app preference may refuse or ask for more than the chain allows (e.g. an app-side lower threshold), but
it must never allow something the chain rule forbids. The chain is the last defence against a
compromised agent.

**Normative rule — `daily_limit` is the mandate.** The UI must present `daily_limit` as "how much the
agent may spend per day unattended", and `auto_approve_limit` only as "how big one unattended payment
may be". This wording comes from `contracts/DEPLOYED.md` ("What the rule actually promises").

**Normative rule — one asset per rule.** `set_rule` currently rejects more than one allowed asset
(`InvalidRule` #102) and the daily budget is one cross-asset counter; the UI must not offer a
multi-asset rule yet.

**Normative rule — `known_recipients_only` is off by default.** `recommend turning it on` for the
auto-pay profile (see §10, open question).

---

## 3. Enabling auto-pay (voice and settings)

Auto-pay is enabled **on top of the "Always ask" baseline state** from §2, which already contains the
mandatory SAC allowance. Enabling auto-pay **adds** `set_rule` + `set_executor` to that baseline and
**raises the allowance** if the intended mandate (plus schedules) exceeds the current allowance. The
allowance is never optional: without it even `pay_owner` cannot settle.

> **Safe execution order (D13).** The allowance is mandatory for every guard payment, so the baseline
> state already has one; what actually **arms** unattended payments is the executor registration
> together with a positive `auto_approve_limit`. The flow therefore executes as
> **`approve` → `set_rule` → `set_executor`**: registering the executor is the **last, arming** step.
> The approval card lists the same three actions in the same order and calls out the arming step.
> Earlier text that says "allowance last" or lists `set_executor, set_rule, approve` as the execution order is **SUPERSEDED by D13**.

### 3.1 Voice/settings flow

Enabling auto-pay is **three owner-signed Soroban calls**, each a separate transaction (a Soroban
transaction carries one invoke-host-function operation): SAC `approve`, `set_rule`, `set_executor`.
The app presents them as **ONE approval card** listing all three in that order and **one Touch ID**,
then submits them in order.

| Step | User says/does | App/agent does | On-chain result |
|---|---|---|---|
| 1 | Says "don't ask me for payments under 25 USDC" (or opens **Settings → Security**) | Parses intent, resolves the owner's asset locally, reads current rule | none |
| 2 | — | Builds a `RuleDraft` (speech-derived, unsigned) with threshold and daily limit | none |
| 3 | Hears the read-back | Speaks: **"Allow automatic payments up to 25 USDC, max 100 USDC per day, to saved contacts only, for 30 days?"** | none |
| 4 | Confirms | Shows **ONE approval card** listing the three owner calls in order — SAC `approve`, `set_rule`, `set_executor` — and calls out step 3 as the **arming** step | none |
| 5 | Touch ID | Authenticates once for the card | none |
| 6 | — | Submits SAC `approve(from=owner, spender=guard, amount, live_until_ledger)` | Allowance set |
| 7 | — | Submits `set_rule(owner, rule)` (threshold, daily limit, asset, contacts-only) | Rule published (no executor yet → auto-pay **not** armed) |
| 8 | — | Submits `set_executor(owner, executor)` | Executor registered — **auto-pay armed** |
| 9 | — | Reports the three results | Auto-pay active |
| 10 | Hears/sees confirmation | Speaks/shows: "Auto-pay is on: up to 25 USDC per payment, max 100 USDC per day." | none |

**Read-back sentence (exact example):**
> "Allow automatic payments up to 25 USDC, max 100 USDC per day, to saved contacts only, for 30 days?"

### 3.2 Failure semantics

- If a later step fails (**stop, report, leave a consistent safe state**). The app never retries
  automatically; it reports which step failed and the resulting state.
- **Invariant:** auto-pay is possible only when all three are present — an executor, a published rule
  and a SAC allowance. Any partial combination therefore **fails closed**: a rule + allowance without
  an executor cannot auto-pay, and an executor without a rule/allowance cannot move funds through
  `pay_executor`.
- **State after a failure (D13):** after step 1 (`approve`) only the allowance changed; after step 2
  (`set_rule`) the new rule is stored but **no executor exists**, so nobody can auto-pay; after step 3
  (`set_executor`) auto-pay is **armed**.
- **Disable order (D13):** `revoke_executor` first (**disarm**), then the optional `approve(0)`.
- The app must re-read the on-chain state after a partial failure and show the user what actually
  landed before offering to retry.

### 3.3 Allowance sizing (PROPOSED)

| Parameter | PROPOSED default | Constraint |
|---|---|---|
| Allowance amount | `daily_limit * 7` | **Must always be ≥ the largest schedule total the user has created.** |
| `live_until_ledger` | ~30 days (`17280 ledgers/day * 30`) | Protocol caps entry TTL at ~180 days, so pick a renewal cadence. |
| User adjustable | Yes (settings) | Lowering must be done safely (approve to 0 first — the classic allowance race). |

### 3.4 Disabling auto-pay

- **Order (D13):** `revoke_executor(owner)` first (**disarm**) — one owner call. Revoking the allowance
  is optional and happens after: SAC `approve` with amount 0.
- Disabling is a **tightening** (see §3.5): voice with read-back + lighter confirmation is allowed.
- Note: revoking the executor does **not** stop existing schedules (F-01); each schedule must be
  cancelled separately, or the allowance revoked (which also disables `pay_owner`).

### 3.5 Tightening vs loosening

| Change | Direction | Voice allowed? | Required confirmation |
|---|---|---|---|
| Raise `auto_approve_limit` | Loosening | Yes (draft) | Read-back + **ONE card + Touch ID** |
| Raise `daily_limit` | Loosening | Yes (draft) | Read-back + **ONE card + Touch ID** |
| Turn `known_recipients_only` **off** | Loosening | Yes (draft) | Read-back + **ONE card + Touch ID** |
| Register the executor (enable auto-pay) | Loosening | Yes (draft) | Read-back + **ONE card + Touch ID** |
| Create a schedule | Loosening (new commitment) | Yes (draft) | Read-back + **card + Touch ID** (owner signature) |
| Lower `auto_approve_limit` | Tightening | Yes | Read-back + **lighter confirmation** |
| Lower `daily_limit` | Tightening | Yes | Read-back + **lighter confirmation** |
| Turn `known_recipients_only` **on** | Tightening | Yes | Read-back + **lighter confirmation** |
| Revoke executor / disable auto-pay | Tightening | Yes | Read-back + **lighter confirmation** |
| Cancel a schedule (`cancel_schedule`) | Tightening | Yes | Read-back + **lighter confirmation** (owner auth only; contract does not mandate Touch ID) |

**Rule:** Touch ID is required to **create or loosen** rules and schedules, and for any payment above
the user's auto-approve limit. Actions inside the rules run without Touch ID. Tightening is allowed by
voice with read-back and the lighter confirmation.

---

## 4. JSON examples (RESERVED shapes)

> ⚠️ **RESERVED — provisional names, docs-only.** None of the shapes below exist in
> `interfaces/src`. They are the fixed target for the T1/T2/T5 work and must be coordinated with
> Owner A before touching the shared seam (see `docs/interfaces.md` §6).

### 4.1 `ApprovalProfile` value

```json
{
  "profile": "auto_under_limit",
  "autoApproveLimit": "25",
  "dailyLimit": "100",
  "asset": "USDC",
  "knownRecipientsOnly": true,
  "allowance": {
    "amount": "700",
    "liveUntilLedger": 518400
  }
}
```

### 4.2 `RuleDraft` (seam) → `RulePayload` (chain-client internal)

`RuleDraft` is **exactly** the flat camelCase seam shape (`docs/interfaces.md` §6.1, mirroring PR #8
`docs/rule-types-and-decisions` §6.2); it is speech-derived and never signed directly. The chain client
maps it to `RulePayload`, the snake_case payload that mirrors the contract `Rule` struct and is
**internal to the chain client** (not part of the seam). The agent emits an `Intent` of kind `set_rule`
carrying this `RuleDraft`; `kind` is not part of the draft.

`RuleDraft` (seam shape; decimal strings in **display units**):

```json
{
  "autoApproveLimit": "25",
  "perTxLimit": "50",
  "dailyLimit": "100",
  "assets": ["USDC"],
  "knownRecipientsOnly": true,
  "source": "don't ask me for payments under 25 USDC"
}
```

Mapping `RuleDraft` (camelCase, decimal display units) → `RulePayload` (snake_case, raw i128 token
units, 7 decimals for USDC):

| `RuleDraft` field | `RulePayload` field | Conversion |
|---|---|---|
| `autoApproveLimit` | `auto_approve_limit` | decimal → raw units (`25` → `"250000000"`) |
| `perTxLimit` | `per_tx_limit` | decimal → raw units |
| `dailyLimit` | `daily_limit` | decimal → raw units |
| `assets` | `allowed_assets` | alias/asset → SAC contract address |
| `knownRecipientsOnly` | `known_recipients_only` | passthrough |
| `source` | — | draft provenance only; never on-chain |

Resulting `RulePayload` (chain-client internal, sent to `set_rule`):

```json
{
  "auto_approve_limit": "250000000",
  "per_tx_limit": "500000000",
  "daily_limit": "1000000000",
  "allowed_assets": ["CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"],
  "known_recipients_only": true
}
```

*(The chain client resolves `assets` locally and never passes through an agent-supplied address —
`contracts/DEPLOYED.md` limitation F-06. `readBack` is not a field of `RuleDraft`; the client composes
the read-back sentence from the draft — exact example in §3.1.)*

### 4.3 Combined approval-card summary (three actions)

```json
{
  "summary": {
    "title": "Turn on auto-pay up to 25 USDC",
    "actions": [
      { "index": 1, "title": "Approve the guard allowance", "call": "approve", "lines": ["Amount: 700 USDC", "Valid for ~30 days"] },
      { "index": 2, "title": "Publish the spending rule", "call": "set_rule", "lines": ["Per payment: 25 USDC", "Per day: 100 USDC", "Saved contacts only"] },
      { "index": 3, "title": "Register the agent key (arms auto-pay)", "call": "set_executor", "lines": ["Executor: GB3H...DYLX5", "Last step: this arms unattended payments"] }
    ],
    "estimatedFee": "~0.00003 XLM (3 transactions)",
    "privacy": { "mode": "public" }
  }
}
```

### 4.4 Auto-paid small payment result

```json
{
  "summary": {
    "title": "Paid 8 USDC to ada (auto-pay)",
    "lines": [
      "8 USDC ≤ your 25 USDC auto-approve limit — no card needed",
      "Signed by the agent key via pay_executor",
      "Daily mandate used: 8 of 100 USDC"
    ],
    "estimatedFee": "0.00001 XLM",
    "privacy": { "mode": "public" }
  },
  "status": "submitted"
}
```

### 4.5 Refusal above the threshold (falls back to the card path)

```json
{
  "summary": {
    "title": "Above your auto-approve limit — approval needed",
    "lines": [
      "This payment is 40 USDC, above your 25 USDC auto-approve limit.",
      "Auto-pay cannot run it. Asking for owner approval instead."
    ],
    "estimatedFee": "0.00001 XLM",
    "privacy": { "mode": "public" }
  },
  "fallback": "pay_owner",
  "requiresApproval": true
}
```

---

## 5. Scheduling

Schedules live on-chain in `polaris_guard`; the keeper only triggers them. The exact ABI is in
`contracts/DEPLOYED.md` and `stellar/src/keeper/README.md`.

### 5.1 Voice examples and field mapping

| Voice | `ScheduleDraft` | `create_schedule(first_run_at, interval_secs, runs)` |
|---|---|---|
| "send 50 USDC to bob tomorrow at 15:00" | converts local time + timezone to UTC epoch seconds | `interval_secs = 0`, `runs = 1` (one-shot) |
| "every Friday 10:00 for 8 weeks" | first Friday 10:00 local → UTC | `interval_secs = 604800`, `runs = 8` |
| "cancel my payment to bob" | `list_schedules(owner)`; if more than one candidate, **ask which** | `cancel_schedule(owner, id)` |

- One-shot = `interval_secs 0`, `runs 1`. A one-shot asking for many runs, or `runs == 0`, is rejected
  with `InvalidSchedule` (#112).
- Max **25 active schedules per owner** (`TooManySchedules` #114).
- The approval card shows **local time AND UTC**. The conversion helper takes an **explicit timezone
  parameter** — never assume the machine timezone silently.

### 5.2 Timing precision

| Component | Value | Note |
|---|---|---|
| Keeper poll interval | `KEEPER_POLL_SECONDS` default **15** | Due schedules are found on the next tick |
| Ledger close | ~**5 s** | Execution is included in a ledger |
| Observed delay after due time | ~**15–25 s** typical | poll remainder + ledger close + confirmation |

**Never to the second.** Precision is bounded by the poll interval and ledger close, not by the
contract. The UI must not promise second-level accuracy.

### 5.3 Keeper down / missed runs

- If the keeper (or RPC) is down for many intervals, **ONE** run settles when it returns: the contract
  moves `next_run_at` to the first slot strictly after now, and `runs_left` drops by one.
- **Missed runs are skipped, never caught up.** The keeper has no catch-up logic.

### 5.4 Funding

- The SAC allowance (not the keeper key) pays the recipient. The allowance **must cover the total** of
  all schedules; the keeper only pays the tiny network fee from its own funded testnet key.
- Default allowance `daily_limit * 7` (**PROPOSED**) must always be ≥ the largest schedule total.

### 5.5 Cancellation

| Action | Effect | Scope |
|---|---|---|
| `cancel_schedule(owner, id)` | Stops one schedule (owner auth; lighter confirmation) | One schedule |
| SAC `approve` with amount 0 | Revokes the allowance → also disables `pay_owner` and every remaining schedule | Global kill switch |

Removing the executor does **not** stop schedules (F-01).

### 5.6 Ambiguity rule

If "cancel my payment" matches more than one schedule, the agent **asks which one** and never guesses.

### 5.7 "Upcoming payments" UI contract

A list with, per row: `id`, recipient alias, amount, next-run **local time**, runs left, status
(including **"failing/retrying"**), and a **Cancel** button.

### 5.8 Limits and known caveats

- **25 active schedules per owner** (`TooManySchedules` #114).
- **F-03:** `execute_schedule` does **not** re-check `known_recipients_only`; the recipient is
  owner-authored at creation, and removing/re-pointing an alias does not stop an existing schedule.
- **F-12:** failed runs are retried indefinitely with keeper backoff; v0.2 plans auto-deactivation
  after 3 failures.
- **F-01:** no pause; the only kill switches are `cancel_schedule` or revoking the SAC allowance.

### 5.9 Confidential schedules are out of scope

Scheduled/unattended confidential payments stay out (D6): the keeper cannot produce the zero-knowledge
proof because it does not hold the sender's secret material. Public schedules via `polaris_guard` +
keeper are unchanged (`docs/confidential-payments.md` §1, §8).

---

## 6. Smart suggestions

### 6.1 Inputs

1. The **local encrypted history** (`docs/confidential-payments.md` §6, D5).
2. **Chain data** for public payments (Horizon payments for the owner account and/or guard `Paid`
   events).

### 6.2 Deterministic statistics

Over a window (default **last 30 days**): count, per-contact frequency, amount percentiles (median,
p90, max), daily totals (median/p95/max), and recurrence detection (same recipient + similar amount at
a regular cadence).

**Minimum-data rule (PROPOSED):** at least **8 payments over at least 7 days**; otherwise the app says
"not enough history yet" and produces no suggestions.

### 6.3 Suggestion kinds (PROPOSED)

| Kind | Trigger rule | Proposed change | Evidence shown |
|---|---|---|---|
| `auto_pay_threshold` | Payments to known contacts cluster under a p90 | `RuleDraft` setting `auto_approve_limit` = p90 rounded **UP** to the nearest multiple of 5 display units (**PROPOSED**) | count, median, p90, max, window |
| `daily_limit` | Daily totals have a stable p95 | `RuleDraft` setting `daily_limit` = p95 daily total × 1.5, rounded **UP** to the nearest multiple of 5 display units (**PROPOSED**) | median/p95/max daily totals |
| `schedule_from_recurrence` | Same recipient + similar amount at a regular cadence | `ScheduleDraft` | detected cadence, occurrences |
| `tighten_dormant` | Auto-pay enabled but unused > 30 days | `DisableAutoPay` | last-used date, unused days |
| `unusual_payment_alert` | A payment amount > 3× p90 | Ask for extra confirmation next time | amount, p90, ratio |

**Rounding (PROPOSED):** suggestion thresholds and daily limits are rounded **UP** to the nearest
multiple of 5 in display units (never down, never to the nearest).

### 6.4 `Suggestion` type (PROPOSED)

```ts
type SuggestionKind =
  | "auto_pay_threshold" | "daily_limit" | "schedule_from_recurrence"
  | "tighten_dormant" | "unusual_payment_alert";

interface Suggestion {
  id: string;
  kind: SuggestionKind;
  title: string;
  rationale: string;
  evidence: {
    windowDays: number;
    count: number;
    median: string;
    p90: string;
    max: string;
    // ...kind-specific aggregates only...
  };
  proposedChange: RuleDraft | ScheduleDraft | DisableAutoPay;
  confidence: "low" | "medium" | "high";
}
```

Pure function: `suggest(history, currentRule, now) -> Suggestion[]` — unit-testable offline with
fixtures.

### 6.5 User-facing wording pattern and dismissal

Plain words plus evidence, e.g.:
> "Over the last 30 days you sent **14 payments** to saved contacts, all under **20 USDC**. Allow
> automatic payments up to **20 USDC**?"

Each suggestion can be **dismissed** ("don't suggest this again").

### 6.6 Privacy rules

- Computed **on the device**.
- If an LLM phrases a suggestion, it receives **only the aggregate `evidence` object — never raw rows
  or addresses**.
- The owner must opt in before any aggregate leaves the device.

### 6.7 Never auto-applied (D11)

A suggestion is **never applied automatically**. It becomes a draft that goes through the same
read-back + card + Touch ID flow as any manual change.

### 6.8 Worked example

Statistics: 14 payments over the last 30 days to saved contacts; median 9.5 USDC, **p90 = 18.4 USDC**,
max 22.0 USDC; p95 daily total = 38 USDC.

| Suggestion | Computation | Proposed change |
|---|---|---|
| `auto_pay_threshold` | p90 = 18.4 → round **UP** to nearest 5 = 20 | threshold = **20 USDC** |
| `daily_limit` | 38 × 1.5 = 57 → round **UP** to nearest 5 = 60 | daily limit = **60 USDC** |

Card text: *"Over the last 30 days you sent 14 payments to saved contacts, all under 20 USDC; allow
automatic payments up to 20 USDC with a 60 USDC daily limit?"*

---

## 7. Keeper hosting explained

### 7.1 What a keeper is (plain words)

A blockchain has **no timers**: a contract cannot wake itself at 15:00. `polaris_guard` stores
schedules (`next_run_at`, `interval_secs`, `runs_left`). **Someone off-chain must send an
`execute_schedule(id)` transaction after the due time — that someone is the keeper.** It is a small
**untrusted** background program (`stellar/src/keeper`, run with
`npm run keeper -w @polaris/stellar`) that every `KEEPER_POLL_SECONDS` asks the contract `list_due`
and sends `execute_schedule` for each due id.

**What the keeper can and cannot do:**

- Pays the tiny network fee from its **own** funded testnet key (`KEEPER_SECRET`).
- Holds **no owner keys**. The contract itself checks due time, limits and allowance, so a malicious
  keeper can at worst do **nothing** (liveness) — it cannot move user funds or bypass a rule.
- Anyone can run one; two keepers racing on the same schedule is safe (the loser is rejected).

**Config (`.env.example`):**

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_SECRET` | required | key that pays fees (S...); testnet XLM only |
| `GUARD_CONTRACT_ID` | required | guard contract (C...) |
| `SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` | falls back to `STELLAR_RPC_URL` |
| `NETWORK_PASSPHRASE` | testnet passphrase | falls back to `STELLAR_NETWORK_PASSPHRASE` |
| `KEEPER_POLL_SECONDS` | `15` | seconds between ticks |
| `KEEPER_MAX_PER_TICK` | `5` | max executions per tick |
| `KEEPER_DRY_RUN` | `false` | simulate only (also `--dry-run`) |
| `KEEPER_TX_TIMEOUT_SECONDS` | `30` | transaction validity window |
| `KEEPER_MAX_FEE_STROOPS` | `5000000` | refuse to sign above this fee |
| `KEEPER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

### 7.2 Hosting options

| Option | Pros | Cons |
|---|---|---|
| **(a) Same Mac as the app** | Simplest; no extra setup during the demo | Stops if the Mac sleeps or the process quits; use `caffeinate -i` |
| **(b) Always-on small cloud VM/container** | Keeps working when the Mac is off | Setup time; needs `KEEPER_SECRET` funded on testnet + `GUARD_CONTRACT_ID` |
| **(c) Anyone else's machine** | Trustless by design; multiple keepers possible | Not under our control; for production, run several |
| **(d) App as opportunistic keeper** | No extra process; the app triggers due schedules on start and while it is open; the payee can also trigger one (D14) | Only runs while the app is open — not a reliable unattended keeper |
| **(e) Tip-paying v2 contract (PARKED)** | Pays a small tip to whoever triggers a due schedule, so unrelated third parties run keepers (D14) | Needs a **new crate** (`polaris_guard_v2`, D9) + incentive design; out of scope for the hackathon |

**Can the keeper live inside the contract? (D14 — no.)** Soroban has **no scheduler or timers** and a
contract cannot wake itself: every execution needs a transaction from someone. `execute_schedule` needs
**no auth**, so **(d) the app can act as an opportunistic keeper** (it runs due schedules on start and
while open) and the **payee** can trigger one too. A future **(e) tip-paying `polaris_guard_v2`** could
incentivise third-party keepers, but it is **PARKED** — a new crate per D9, not for the hackathon. The
demo keeps option (a) under D12.

**Demo recommendation (D12 — PROPOSED, awaiting user confirmation):** option **(a)**, the same Mac as
the app, wrapped in `caffeinate -i`. Production pitch: option **(b)** with **multiple independent
keepers**.

### 7.3 Rehearsal checklist

- [ ] Rename/confirm `KEEPER_SECRET` holds a little testnet XLM and **nothing else**.
- [ ] `GUARD_CONTRACT_ID` points at the deployed guard (`contracts/DEPLOYED.md`).
- [ ] `KEEPER_DRY_RUN=true` first: `npm run keeper -w @polaris/stellar -- --dry-run` simulates only.
- [ ] Run the real keeper under `caffeinate -i`: `caffeinate -i npm run keeper -w @polaris/stellar`.
- [ ] Watch one scheduled payment fire ~15–25 s after its due time.
- [ ] `npm run keeper:once -w @polaris/stellar` for a single deterministic tick.

---

## 8. Interaction with other docs

### 8.1 Privacy modes (`docs/confidential-payments.md`, D1–D8)

- `polaris_guard` enforces per-tx/daily limits on **plaintext** amounts, so confidential amounts are
  **invisible to the guard**; the guard cannot enforce limits on the confidential leg.
- **No confidential schedules** (D6) — the keeper cannot produce the ZK proof. Public schedules are
  unchanged.
- No contradiction with the approval rules: private modes always end in an approval card
  (`docs/confidential-payments.md` §5); there is no unattended private path.

### 8.2 Contract policy (D9)

- `polaris_guard` **v0.1 is frozen**; any change ships as a **new crate** (`polaris_guard_v2`,
  `polaris_privacy_gate`), never an in-place edit.
- The approval/schedule **client takes the contract id as a parameter** (`GUARD_CONTRACT_ID`), never
  hard-coded, so v0.1 and v0.2 run side by side.

---

## 9. Work items T1–T6

| ID | Task | Owner | Files/dirs | Depends on | Acceptance criteria (measurable) | Effort |
|---|---|---|---|---|---|---|
| **T1** | Approval policy + profiles: `approvalPolicy` routing (`always_ask` \| `auto_under_limit`), profile→on-chain mapping, `enableAutoPay(draft)` producing the three unsigned calls + ONE combined summary, `disableAutoPay()`, `buildBaselineSetup()`, `buildTightenRule()` | B | `stellar/src/guard/` (PLANNED) | Guard client (in progress) | Offline unit tests: `enableAutoPay` yields exactly 3 ordered unsigned calls (`approve`, `set_rule`, `set_executor` — **D13**) and one summary, the card listing them in that order and calling out the arming step; `disableAutoPay` yields `revoke_executor` (**disarm**) first, then optional `approve(0)`; routing sends > threshold to `pay_owner`; `buildBaselineSetup` yields an allowance + `set_rule` with **no executor** and `auto_approve_limit` **0 allowed** (the first-time "Always ask" setup, §11e); `buildTightenRule` **refuses loosening by default**; `invalid_asset` validation rejects an unsupported asset; card **caveats** state that revoking the executor does not stop existing schedules and that revoking the allowance disables ALL guard payments including owner-approved ones; the card shows an **"allowance old → new"** line with a warning when the new allowance is lower than the current one | M |
| **T2** | Schedule tools: `schedulePayment`, `cancelSchedule`, `listSchedules` ChainTools (unsigned XDR + summary) + explicit-timezone local→UTC helper | B | `stellar/src/payments/` or `stellar/src/guard/` (PLANNED) | Guard client | Offline tests: "every Friday for 8 weeks" → `interval_secs 604800, runs 8`; one-shot → `0,1`; ambiguous cancel → agent asks; local+UTC both in summary | M |
| **T3** | Suggestions engine: pure `suggest()` + fixtures + tests | B | `stellar/src/suggest/` (PLANNED) | — (offline) | Fixture with 14 payments yields `auto_pay_threshold` 20 and `daily_limit` 60; `< 8` payments yields none | S |
| **T4** | History readers: local encrypted history store (design `docs/confidential-payments.md` §6) + Horizon/`Paid` events reader | B | PLANNED (history store + chain reader) | T3 (shape), network for live runs | Offline: fixture history parses; live: reader returns public payments for the owner account (network run needs approval) | M |
| **T5** | UI: Settings "Security" (three profiles, threshold + daily-limit inputs), "Upcoming payments" list with Cancel, suggestions panel with Accept/Dismiss, auto-pay enable card listing the 3 actions | A | `app/` (PLANNED components) | T1, T2, T3 | Manual: enable auto-pay by voice → card lists 3 actions → small payment has no card → large payment asks; Upcoming list cancels a schedule | L |
| **T6** | Demo runbook `docs/demo-runbook.md`: keeper start/rehearse/verify, scheduled-payment demo, approval-profile demo | B | `docs/demo-runbook.md` (skeleton in this docs PR) | T1, T2, T5 | A reader can run the keeper and reproduce both demo scripts on testnet | S |

**Sequence:** T1/T2 follow the guard client; T4 after T3; T5 after T1–T3; T6 completes after T5.
This mirrors the source notes' ordering (after the headless slice).

---

## 10. Open questions & risks

| Question | Why it matters | Proposed default | Who decides |
|---|---|---|---|
| Default allowance size | Too small and schedules fail; too large and the kill-switch envelope is wide | `daily_limit * 7`, `live_until_ledger` ~30 days, user-adjustable; always ≥ largest schedule total (**PROPOSED**) | Owner A + Owner B |
| `known_recipients_only` on by default for auto-pay? | It is the only brake on *where* unstructured auto-pay goes, but it is off at contract level | **Recommend ON** for the auto-pay profile; surface it in the enable card | Owner A + user |
| Minimum-data thresholds for suggestions | Too low and suggestions are noise; too high and they never appear | ≥ 8 payments over ≥ 7 days else "not enough history yet" (**PROPOSED**) | Owner A + Owner B |
| Keeper hosting for the demo | Determines whether the demo keeps running if the Mac sleeps | **D12 (PROPOSED):** same Mac under `caffeinate -i`; production = always-on VM with multiple keepers | User |
| Daylight-saving / timezone edge cases | "tomorrow at 15:00" can shift across a DST boundary; schedules use UTC epoch seconds | Store UTC; show local + UTC on the card; conversion helper takes an explicit timezone; document DST behavior and refuse ambiguous times | Owner B (helper) + Owner A (card) |

---

## 11. Design decisions to confirm (PROPOSED defaults)

> These are the gaps found in independent review. Everything here is **PROPOSED** and awaits
> confirmation; no contract behaviour is assumed beyond `contracts/DEPLOYED.md` and
> `contracts/polaris_guard/src/lib.rs`.

| # | Question | PROPOSED default | Why | Confirmed by |
|---|---|---|---|---|
| a | Deriving `daily_limit` / `per_tx_limit` from a voice request like "don't ask under 25" | The agent must **not** invent them: it asks one question for the daily limit; the card offers `per_tx_limit = threshold`, `daily_limit = 4 × threshold` as **editable fields**; nothing is applied until the user confirms the read-back (**PROPOSED**). | Avoid inventing a daily mandate from an ambiguous utterance; keep the user in control. | Owner A + Owner B |
| b | Natural-language time ("tomorrow 15:00", "every Friday 10:00") | The **agent** resolves the phrase into explicit local date + time + **IANA timezone** before calling the chain tool; timezone source = the **device timezone**, shown on the card and editable; default `runs` when omitted for "every X" = **ask** ("for how many weeks?"), **never infinite**; one-shot when no repeat is given (**PROPOSED**). | The chain takes UTC epoch seconds; ambiguity must be resolved and shown before signing. | Owner B (helper) + Owner A (card) |
| c | `DisableAutoPay` result shape | `{ steps: [ {kind:"revoke_executor", unsignedXdr, payloadHash}, optional {kind:"approve", amount:"0", ...} ], summary, confirmation:"light" }` (mirrors the enable builder) (**PROPOSED**). | The disable flow needs a fixed type for T1/T5. | Owner B |
| d | Acceptance criteria for "app preference is never looser than the chain" | Property test: for random rules/amounts the app policy never routes to `pay_executor` when `chooseGuardedRoute` (chain-based) would not; and the combined enable card lists **exactly three** actions in the order **`approve`, `set_rule`, `set_executor`** (executor last = **arming**) (**D13**; the earlier "allowance last" order is **SUPERSEDED by D13**). | Makes the invariant and the card order testable. | Owner B |
| e | First-time setup flow (allowance before anything else) | `buildBaselineSetup` implements the first-time "Always ask" setup: `approve` allowance → `set_rule` with **no executor** and `auto_approve_limit` **0 allowed** → aliases; this is the "Always ask" baseline state (**D13**, §3). | The allowance is mandatory for every guard payment including `pay_owner` (§2). | Owner A + Owner B |
| f | Keeper hosting (D12) | Stays **PROPOSED**: same Mac for the demo. | Awaiting user confirmation; no decision recorded. | User |

---

## 12. W11b implementation note (2026-09-20)

The shell half now runs the design above (testnet only):

- **Voice/UI setup** (`guard_policy` from `set_approval_rule` or the Rules page) builds the
  D13 plan (`approve` → `set_rule` → `set_executor`, executor last = arming; executor
  create/fund first; `set_alias` per saved contact) and applies it after **ONE** batch
  approval card + **ONE** Touch ID (`approval_begin_batch` / `approval_authorize_batch`).
- **`send` routing** (`app/src/lib/chain.ts` + `autopay.ts`): the executor settles a payment
  with `pay_executor` and no card only when the cached rule allows it (armed, asset allowed,
  ≤ `auto_approve_limit`, known recipient, daily remaining) **and** `executor_sign_pay`
  accepts it; anything else falls back to the owner path (fail closed toward MORE approval).
- **Always ask** is the disable path (`revoke_executor` first); the app preference never
  widens the chain rule. Guard errors #103–#107 / #116 map to short human sentences.
- **Rust side** (`executor_*`, batch approval) ships in W11a; the TS paths feature-detect the
  commands and fall back when they are absent.

*Cross-references: `docs/confidential-payments.md` (privacy modes, D1–D8), `docs/interfaces.md`
(reserved seam), `contracts/DEPLOYED.md` (ABI, rule semantics, F-01/F-03/F-06/F-12),
`stellar/src/keeper/README.md` (keeper config/behaviour), `docs/demo-runbook.md` (demo steps),
`notes.md` (D10/D10b/D10c/D11/D12/D13/D14), `sprints.md` (M2b/M3c), `backlog.md` (T1–T6).*
