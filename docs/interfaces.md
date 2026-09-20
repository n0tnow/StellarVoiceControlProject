# Polaris — Team Interfaces

> **Draft v0.1 (2026-09-19).** This is the contract between the two owners:
> **Owner A — Brain & Shell** (`app/`, `agent/`): Tauri shell, hotkey, voice pipeline, agent core, approval UI.
> **Owner B — Chain** (`stellar/`, `contracts/`): anchor client, protocol integration, Soroban contracts, signing service.
> These TypeScript types are the ONLY seam. Change them only by agreement in PR review.

## 1. `Intent` — structured value-moving request

```ts
export type IntentKind = "deposit" | "swap" | "send" | "guard_policy" | "raw_tx";

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
export type CaptureState = "idle" | "recording" | "ready" | "transcribing" | "error";

export interface CaptureStatus {
  state: CaptureState;
  recording: { path: string; durationMs: number } | null;
  error: string | null;   // full detail, terminal + assistive tech (never painted)
  label: string | null;   // short overlay label for step-A1 failures
}

export type PolarisEvent =
  | { type: "hotkey"; state: "down" | "up" }
  | { type: "hotkey_permission"; trusted: boolean }
  | { type: "capture_status"; status: CaptureStatus }
  | { type: "audio_captured"; path: string; durationMs: number }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_status"; stage: "thinking" | "tool_call" | "awaiting_approval" | "done" }
  | { type: "approval_request"; intent: Intent; summary: ChainToolResult["summary"]; payloadHash: string }
  | { type: "approval_result"; payloadHash: string; approved: boolean }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  | { type: "error"; message: string };
```

Step A1 reuses `transcript` for the STT result (`final: true`); it adds no new
event variant. The overlay is driven by `capture_status` alone, which is why the
`transcribing` state lives there. The transcript is **never** painted in the
notch (the ear is ~92 pt and the camera housing has no pixels); it travels on the
event stream and is printed to the Rust terminal.

## 5. Ownership & rules

| Directory | Owner |
|---|---|
| `app/` (Tauri shell, UI, Touch ID/hotkey/mic Rust side) | A |
| `agent/` (agent loop, MCP, tool orchestration) | A |
| `stellar/` (anchor SEP-10/38/6, Soroswap/DeFindex client, typed bindings) | B |
| `contracts/` (`polaris_guard`, escrow) | B |

- One task per git worktree/branch, merged by PR; never touch the other owner's directories.
- Vertical slice target (M2): voice says "send 10 USDC to ada" → agent builds Intent → chain tool returns XDR+summary → approval card + Touch ID → signed → testnet tx.
- Each person uses their own testnet identity; never share or commit keys. Mock anchor treasury is shared (3000 TRY cap) — be gentle.

## 6. Reserved — not yet in `interfaces/src`

> ⚠️ **RESERVED (decision D7, 2026-09-19).** The types below are **not** in `interfaces/src/index.ts`
> and must not be wired into product code until the seam lands by agreement in PR review. They are
> recorded here now so the private-modes work has a fixed target. The code change to the shared
> `interfaces/` workspace is being coordinated with Owner A separately.
> Design rationale: [`docs/confidential-payments.md`](confidential-payments.md) §4.

```ts
// Intent — reserved field. Absent means "public".
//   "confidential" = Confidential Token (amount hidden, addresses visible)
//   "private"      = Stellar Private Payments / shielded pool (parties + amount hidden)
export interface Intent {
  // ...existing fields...
  mode?: "public" | "confidential" | "private"; // default "public"
}

// Summary privacy state. In the shared TS seam the summary is `ChainToolResult["summary"]`;
// its Rust mirror is `TxSummary` (`app/src-tauri/src/types.rs`).
export interface TxSummary {
  // ...existing fields...
  privacy?: {
    mode: "public" | "confidential" | "private";
    recipientRegistered?: boolean; // CT/SPP precheck outcome; only set for private modes
    // ...provisionally: pool/ASP status, pending/merge state, audit/explorer refs...
  };
}

// Reserved event names — PROVISIONAL, may change before the seam lands:
//   privacy_register_required
//   privacy_balance
```

**Semantics:** `mode` absent = `"public"`; the agent never infers a private mode except from explicit
user words ("secretly" / "privately") plus the manual default setting. `TxSummary.privacy.mode` is the
**resolved** mode actually built, so the approval card renders ground truth (not the model's
description). If a private mode is requested and cannot be honoured, the request is refused — it is
**never** downgraded to public (fail-closed). Full rules, voice/manual split, approval-card checklist
and JSON examples: [`docs/confidential-payments.md`](confidential-payments.md).

### 6.1 Reserved — approval profiles, scheduling & suggestions

> ⚠️ **RESERVED — docs-only, not yet in `interfaces/src`.** The shapes below are the fixed target for
> the approval/auto-pay/scheduling/suggestions work. They are **provisional**, must **not** be wired
> into product code, and must be **coordinated with Owner A before touching `interfaces/src`**.
> Design rationale and full flows: [`docs/approval-and-scheduling.md`](approval-and-scheduling.md).

```ts
// RESERVED. Approval profile selected by the user (settings or voice). D10/D10b/D10c.
export interface ApprovalProfile {
  profile: "always_ask" | "auto_under_limit" | "custom"; // default "always_ask"
  autoApproveLimit?: string; // decimal string; only for auto_under_limit / custom
  dailyLimit?: string;       // decimal string; the agent's real mandate
  asset?: string;
  knownRecipientsOnly?: boolean;
  allowance?: { amount: string; liveUntilLedger: number };
}

// RESERVED. Speech-derived rule draft, read back then signed. EXACTLY the shape agreed in
// PR #8 (`docs/rule-types-and-decisions` §6.2); flat camelCase, decimal strings.
export interface RuleDraft {
  autoApproveLimit: string;
  perTxLimit?: string;
  dailyLimit?: string;
  assets?: string[];
  knownRecipientsOnly?: boolean;
  source?: string; // transcript excerpt
}

// RESERVED. Combined multi-action approval summary (provisional). The auto-pay enable card
// lists three owner calls in safe order (SAC approve -> set_rule -> set_executor, executor last =
// arming; D13) behind ONE card + Touch ID.
// `actions[]` is NEW to `interfaces/src` only — the base `TxSummary` already exists in the Rust
// mirror (`app/src-tauri/src/types.rs`). This is a PROVISIONAL extension — field name and shape
// to be confirmed with Owner A.
export interface TxSummary {
  // ...existing fields (title, lines, explorerUrl, estimatedFee, privacy)...
  actions?: Array<{
    index: number;
    title: string;
    call: "set_executor" | "set_rule" | "approve" | "revoke_executor" | "create_schedule" | "cancel_schedule" | string;
    lines: string[];
  }>;
}

// RESERVED. Locally computed suggestion (D11). NEVER auto-applied — becomes a draft that
// goes through read-back + card + Touch ID. Only aggregate `evidence` may reach an LLM.
export interface Suggestion {
  id: string;
  kind: "auto_pay_threshold" | "daily_limit" | "schedule_from_recurrence" | "tighten_dormant" | "unusual_payment_alert";
  title: string;
  rationale: string;
  evidence: { windowDays: number; count: number; median: string; p90: string; max: string; /* ... */ };
  proposedChange: unknown; // RuleDraft | ScheduleDraft | DisableAutoPay (see approval doc)
  confidence: "low" | "medium" | "high";
}

// RESERVED Intent kinds — already drafted by PR #8 (docs/rule-types-and-decisions), not on `main`.
//   "set_rule" | "schedule" | "cancel_schedule"
// Draft shapes `RuleDraft` / `ScheduleDraft` (speech-derived, read back, then signed) are
// owned by that work; see docs/approval-and-scheduling.md §3-§5.
// `RulePayload` (the snake_case, raw-i128-unit payload the chain client builds from `RuleDraft`,
// mirroring the contract `Rule` struct) is **chain-client-internal** and is NOT part of this seam.
```

**Semantics:** `profile` absent = `"always_ask"` (D10 default). The app-side preference may only be
**stricter** than the on-chain rule, never looser. `TxSummary.actions` (provisional) renders the
combined auto-pay enable card; `actions[]` is new to `interfaces/src` only — the base `TxSummary`
already exists as the Rust mirror `app/src-tauri/src/types.rs`. `RuleDraft` here is the seam shape;
`RulePayload` (snake_case, raw units) is chain-client-internal. Intent kinds `set_rule` / `schedule` /
`cancel_schedule` are reserved by PR #8 and are not on `main` yet.

## 7. Known drift

From `backlog/2026-09-19-slice-gap-analysis.md` §A.1. Tracked, **not yet fixed**:

- **Wrong mirror path in `interfaces/src/index.ts`.** The header comment points at
  `app/src-tauri/src/interfaces.rs`; that file **does not exist**. The real Rust mirrors are
  `app/src-tauri/src/types.rs` (`Intent`, `TxSummary`) and `app/src-tauri/src/events.rs`
  (`PolarisEvent`).
- **Signer mismatch.** `SigningService.sign(payloadHash)` (`interfaces/src/index.ts:68-71`) does not
  match the only implemented signing abstraction, the anchor
  `Signer.signTransaction(xdr, { networkPassphrase })` (`stellar/src/anchor/types.ts:11-21`).
  **Proposal: standardise on XDR** (`signTransaction(xdr)`), per Owner B's request in
  `backlog/anchor-sep6.md`. Status: **PROPOSED — needs Owner A agreement.**
- **Missing `withdraw` kind.** On `main`, `IntentKind` has no `"withdraw"`, so `withdrawTry` is typed
  with a local structural copy (`AnchorIntent`, `stellar/src/anchor/chainTools.ts`) instead of the
  shared `ChainTool`. The unmerged `docs/rule-types-and-decisions` branch adds `withdraw` (plus
  `set_rule` / `schedule` / `cancel_schedule` / `p2p_offer`, `Rule`, `Schedule`, `ScheduleDraft`,
  `GuardError`, and events `anchor_step` / `approval_required`).

## 8. Approval gate (step W3)

> Mirrors `interfaces/src/index.ts` §8 and the W2 approval-card client
> (`app/src/lib/approval.ts`). The Rust implementation is
> `app/src-tauri/src/approval.rs`.

Every value-moving action needs one human approval before its unsigned XDR may
leave the gate. The webview never receives the XDR: `ApprovalSnapshot`,
`ApprovalStatus` and the `approval_request` / `approval_result` events carry only
the `payloadHash`, the decoded `summary` and the `intent`.

```ts
export type ApprovalMode = "touch_id" | "wallet_only";
export type ApprovalState = "pending" | "authorized" | "denied" | "expired" | "consumed";

export interface ApprovalRequestInput {
  id?: string;              // assigned by the gate; the webview may omit it
  payloadHash: string;      // lowercase hex SHA-256 of the UTF-8 bytes of unsignedXdr
  unsignedXdr: string;      // base64, unsigned
  summary: ChainToolResult["summary"];
  intent: Intent;
  mode?: ApprovalMode;      // defaults to "touch_id"
  origin?: string;          // reserved for W5; NOT an authorization signal
}

export interface ApprovalSnapshot {
  id: string;
  payloadHash: string;
  summary: ChainToolResult["summary"];
  intent: Intent;
  mode: ApprovalMode;
  state: ApprovalState;
  expiresAtMs: number;
}

export interface ApprovalStatus { id: string; state: ApprovalState; reason?: string; }

export type ApprovalErrorKind =
  | "cancelled" | "failed" | "unavailable" | "timeout" | "expired" | "notPending";

export interface ApprovalCommandError { kind: ApprovalErrorKind; message: string; }
```

### Command contract

| Command | Input | Success | Failure |
|---|---|---|---|
| `approval_begin` | `ApprovalRequestInput` | `id: string` | `ApprovalCommandError` |
| `approval_authorize` | `{ id: string }` | `ApprovalSnapshot` (state `authorized`) | `ApprovalCommandError` |
| `approval_deny` | `{ id: string }` | `ApprovalSnapshot` (state `denied`) | `ApprovalCommandError` |
| `approval_status` | `{ id: string }` | `ApprovalStatus \| null` | — |
| `approval_current` | — | `ApprovalSnapshot \| null` | — |
| `biometric_health` | — | `FeatureHealth` | — |
| `biometric_selftest` | — | `FeatureHealth` | — |

- Errors serialise as `{ kind, message }` (camelCase `kind`). User cancel →
  `cancelled`, 60 s auth timeout → `timeout`, missing biometry/passcode →
  `unavailable`, elapsed TTL → `expired`, unknown/wrong-state request →
  `notPending`, everything else → `failed` (fail-closed).
- `take_authorized(id)` is **in-process Rust only** (`pub(crate)`) and is never a
  Tauri command; the embedded wallet (`wallet_sign`, W10) calls it to release the
  XDR. It returns the payload once, then marks the request `consumed`.
- **`wallet_only` is unreachable from the webview.** `approval_begin` rejects it
  unconditionally; the only way to create such a request is the in-process
  `begin_wallet_only`, and the webview `approval_authorize` refuses to authorize
  it. The anchor milestone (W5) must land the Rust-side anchor check before any
  `wallet_only` request is released; **W4b must not enable `wallet_only`.**
- `FeatureHealth` / `HealthStatus` (mirrors `index.ts` §9) remain the Debug-panel
  contract.
