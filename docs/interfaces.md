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
