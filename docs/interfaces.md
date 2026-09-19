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
export type PolarisEvent =
  | { type: "hotkey"; state: "down" | "up" }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_status"; stage: "thinking" | "tool_call" | "awaiting_approval" | "done" }
  | { type: "approval_request"; intent: Intent; summary: ChainToolResult["summary"]; payloadHash: string }
  | { type: "approval_result"; payloadHash: string; approved: boolean }
  | { type: "tx_submitted"; hash: string; explorerUrl: string }
  | { type: "error"; message: string };
```

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
