# Polaris — Team Interfaces

> **Draft v0.1 (2026-09-19).** This is the contract between the two owners:
> **Owner A — Brain & Shell** (`app/`, `agent/`): Tauri shell, hotkey, voice pipeline, agent core, approval UI.
> **Owner B — Chain** (`stellar/`, `contracts/`): anchor client, protocol integration, Soroban contracts, signing service.
> These TypeScript types are the ONLY seam. Change them only by agreement in PR review.

## 1. `Intent` — structured value-moving request

```ts
export type IntentKind =
  | "deposit" | "swap" | "send" | "guard_policy" | "raw_tx"
  | "withdraw" | "set_rule" | "schedule" | "cancel_schedule" | "p2p_offer";

export interface Intent {
  kind: IntentKind;
  asset: string;          // e.g. "USDC" (testnet)
  amount: string;         // decimal string, never float
  recipient?: string;     // address or alias
  alias?: string;         // alias book entry, e.g. "ada"
  memo?: string;
  source?: string;        // voice transcript excerpt that produced it
}
```

## 2. Chain tools exposed to the agent

Every tool returns **unsigned XDR plus a human-readable summary decoded from that XDR** — the summary is what the approval card renders.

```ts
export interface ChainToolResult {
  unsignedXdr: string;          // base64 XDR, unsigned
  summary: {
    title: string;              // "Swap 500 USDC -> XLM"
    lines: string[];            // decoded operation details
    explorerUrl?: string;       // Stellar Lab / Stellar.Expert scene
    estimatedFee: string;
  };
}

// Owner B implements; Owner A's agent core calls these:
export type ChainTool = (intent: Intent) => Promise<ChainToolResult>;
```

## 3. Signing service — Touch ID gated

```ts
// Rust-side service exposed to webview via Tauri command.
// Owner A owns the Touch ID approval flow; Owner B consumes signed envelopes.
export interface SigningService {
  /** Rejects unless Touch ID approval succeeded for this payloadHash. */
  sign(payloadHash: string): Promise<{ signedXdr: string }>;
}
```

## 4. Status / event stream for the UI

```ts
export type PolarisEvent =
  | { type: "hotkey"; state: "down" | "up" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_status"; stage: "thinking" | "tool_call" | "awaiting_approval" | "done" }
  | { type: "approval_request"; intent: Intent; summary: ChainToolResult["summary"]; payloadHash: string }
  | { type: "approval_result"; payloadHash: string; approved: boolean }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  | { type: "error"; message: string }
  | { type: "anchor_step"; step: string; what: string; why: string }        // narration of each anchor step; the agent speaks it
  | { type: "approval_required"; reason: GuardError; intent: Intent };      // guard rejected an executor action -> UI asks for Touch ID
```

## 5. Ownership & rules

| Directory | Owner |
|---|---|
| `app/` (Tauri shell, UI, Touch ID/hotkey/mic Rust side) | A |
| `agent/` (agent loop, MCP, tool orchestration) | A |
| `stellar/` (anchor SEP-10/38/6, Soroswap/DeFindex client, typed bindings) | B |
| `contracts/` (`polaris_guard`, escrow) | B |

- One task per git worktree/branch, merged by PR; never touch the other owner's directories.
- **Any change to `interfaces/` (and this file) needs the other owner's review** (Owner A reviews Owner B's seam changes and vice versa) — state it in the PR description and add the `needs-owner-a-review` label if the repo has it.
- Vertical slice target (M2): voice says "send 10 USDC to ada" → agent builds Intent → chain tool returns XDR+summary → approval card + Touch ID → signed → testnet tx.
- Each person uses their own testnet identity; never share or commit keys. Mock anchor treasury is shared (3000 TRY cap) — be gentle.

## 6. Rules, schedules & the guard contract

> Added 2026-09-19 (PR `docs/rule-types-and-decisions`). Additive to §1–§4: nothing above was removed or renamed.
> The contract ABI below is the **target ABI**. Worker W1 implements it in `contracts/` and may report deviations; this section is updated when they land.

### 6.1 Autonomy model

The user owns a normal Stellar **G account**. Four pieces make the wallet autonomous without giving anyone unbounded power:

| Piece | Role |
|---|---|
| **User's G account** | Holds the funds. The user approves the guard contract **once** as spender on the token SAC (SEP-41 `approve`). |
| **`polaris_guard` contract** | Stores the user's rules on-chain and moves funds via SEP-41 `transfer_from` with the guard contract as spender. It is the only place limits are enforced. |
| **Executor key** | A separate key held by the agent side, registered with `set_executor`. It can only call `pay_executor`; the contract rejects anything outside the rules. Revocable with `revoke_executor`. |
| **Keeper** | An untrusted bot that calls `execute_schedule(id)` when a schedule is due. It needs no auth: the contract itself validates time and limits, so a malicious keeper can at worst do nothing. |

Approval rules (this supersedes the blanket "every value-moving step needs Touch ID" from the architecture):

- **Touch ID (owner auth) is required to CREATE or LOOSEN** rules and schedules, and for any payment **above the user's auto-approve limit** (`pay_owner`, hard caps still apply).
- Actions **inside the rules** (`pay_executor`, `execute_schedule`) run **without Touch ID**.
- When the guard rejects an executor action, the agent emits `approval_required` with the `GuardError` reason; the UI then asks for Touch ID and the payment is retried through `pay_owner`.

### 6.2 Types

```ts
// Mirror of the on-chain rule. All amounts are decimal strings, never floats.
export interface Rule {
  autoApproveLimit: string;     // executor payments up to this run without Touch ID
  perTxLimit: string;           // hard cap per payment
  dailyLimit: string;           // hard cap per day
  allowedAssets: string[];
  knownRecipientsOnly: boolean; // executor may only pay aliased recipients
}

// What the LLM produces from speech BEFORE read-back / Touch ID.
export interface RuleDraft {
  autoApproveLimit: string;
  perTxLimit?: string;
  dailyLimit?: string;
  assets?: string[];
  knownRecipientsOnly?: boolean;
  source?: string;              // transcript excerpt
}

// Mirror of an on-chain scheduled payment.
export interface Schedule {
  id: string;
  owner: string;
  to: string;                   // resolved address
  asset: string;
  amount: string;
  nextRunAt: number;            // unix seconds
  intervalSecs?: number;        // absent = one-shot
  runsRemaining: number;
  active: boolean;
}

// What the LLM produces from speech for "do X at time T".
export interface ScheduleDraft {
  to: string;                   // alias or address
  asset: string;
  amount: string;
  firstRunAt: string;           // ISO-8601 with timezone
  intervalSecs?: number;        // omit = one-shot
  runs: number;
  source?: string;
}

// String names only. The exact on-chain error codes come from the contract
// (worker W1); this union may be aligned with them later.
export type GuardError =
  | "NeedsOwnerApproval" | "PerTxLimitExceeded" | "DailyLimitExceeded"
  | "AssetNotAllowed" | "RecipientNotKnown" | "ExecutorRevoked"
  | "AllowanceMissing" | "NotDue";
```

Events added to `PolarisEvent` (§4):

- `anchor_step` — plain-English narration of each anchor step (`what` happens, `why` it happens); the agent speaks it so the user can follow what is going on in the background.
- `approval_required` — the guard rejected an executor action with `reason`; the UI must ask for Touch ID for `intent`.

`Rule`/`Schedule` are the *on-chain* shapes, `RuleDraft`/`ScheduleDraft` the *speech-derived* shapes: a draft is read back to the user, then turned into a `set_rule` / `create_schedule` call that Touch ID signs.

### 6.3 `polaris_guard` contract ABI (target)

| Function | Auth | Behaviour |
|---|---|---|
| `set_rule(owner, rule)` | owner (Touch ID) | Create or replace the owner's rule. |
| `set_executor(owner, executor)` | owner (Touch ID) | Register the executor key (loosens the wallet, so Touch ID). |
| `revoke_executor(owner[, executor])` | owner | Revoke the executor key (tightens; whether it needs Touch ID is up to the app). |
| `set_alias(owner, alias, address)` | owner | Add a known recipient to the alias book. |
| `pay_owner(owner, to, asset, amount)` | owner (Touch ID) | Payment above the auto-approve limit; **hard caps only** (per-tx, daily, asset). |
| `pay_executor(executor, owner, to, asset, amount)` | executor | Only if `amount <= auto_approve_limit` and within per-tx/daily limits, the asset is allowed and the recipient is known when required; otherwise a typed error (`GuardError`). |
| `create_schedule(owner, to, asset, amount, first_run_at, interval_secs, runs) -> id` | owner (Touch ID) | Create a scheduled payment, returns its id. |
| `cancel_schedule(owner, id)` | owner | Cancel a schedule (tightens; Touch ID not mandated). |
| `execute_schedule(id)` | none (keeper) | One run per call; the contract validates due time and limits. |
| `get_rule`, `get_executor`, `get_alias`, `get_schedule`, `list_schedules(owner)`, `list_due(limit)`, `spent_today(owner)` | none (reads) | Views for the UI and the keeper. |

Transfers use SEP-41 `transfer_from` with the guard contract as spender (the owner approves it once on the token SAC).

> **Review reminder:** any change to `interfaces/` needs Owner A's review (§5). The Rust mirror (`app/src-tauri/src/events.rs`, `types.rs`) does not yet know the new event variants / intent kinds and must be updated by Owner A in a follow-up.
