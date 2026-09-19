# Report: A9 — honest stage reporting + the tool/MCP execution seam

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a4-speak-intent` / `.worktrees/a4`
- **PR:** none (task: push only, no PR, no merge, no tag)

## Objective

Three things: (1) make the notch stages tell the truth (the owner saw "Speaking"
before any audio); (2) build the *infrastructure* that turns an approved `Intent`
into a call to Owner B's `ChainTool`, with an explicit approval-gate seam and a
deliberate, non-crashing "chain not wired" state; (3) add read-only MCP client
scaffolding. No chain logic, no Touch ID, no `stellar/` changes.

Baseline was green: app 9/9, agent 40/40, cargo 104 passed / 2 ignored,
typecheck/build/clippy clean.

---

## 1. Stages tell the truth

Two independent lies were fixed.

### 1a. Rust: "Speaking" is emitted at real playback start

`app/src-tauri/src/commands.rs:speak` emitted `speech_status: speaking` the
moment it dispatched the blocking synthesis, so the notch read "Speaking" for the
whole Fish synthesis wait (~2-3 s before the first sample). The TTS backend seam
now carries a one-shot callback:

```rust
pub type PlaybackStart<'a> = dyn Fn() + Send + Sync + 'a;
pub trait Speaker: Send + Sync {
    fn speak(&self, text: &str, on_playback_start: &PlaybackStart<'_>) -> Result<(), TtsError>;
    fn name(&self) -> &'static str { "tts" }
}
```

Each player fires it at the honest point:

| Backend | When `on_playback_start` fires |
|---|---|
| Fish + `ffplay` (streaming) | after the first decoded chunk is written to `ffplay`'s stdin |
| Fish + `afplay` (no-ffmpeg fallback) | after `afplay` has actually spawned |
| local macOS `say` | after `say` has actually spawned |

`FallbackSpeaker` latches the callback with an `AtomicBool`, so a primary that
announces playback and *then* fails does not double-announce when the local
fallback runs. Consequence: a synthesis/HTTP failure now emits only
`speech_status: idle` — `Speaking` is never shown for audio that never played.
`Idle` keeps its "always clears the stage" guarantee.

### 1b. TypeScript: the stage machine is event-driven, not optimistic

A8's `turnSession.ts` was structurally right but its transitions were guesses:
the final transcript jumped straight to `checking`, so the whole model call wore
a "Checking" label, and "Speaking" was effectively request-driven.

- `thinking` now holds from capture release through the model call **and the TTS
  synthesis wait**. The synthesis wait is honest "working", which the task
  explicitly allows; it is not "Speaking". Entering it is driven by the agent's
  real `agent_status: thinking` event, forwarded per turn through
  `runAgentTurn(transcript, { onAgentStage })` (`app/src/lib/agent.ts`), not by a
  guess in the shell.
- `speaking` is reachable **only** from `thinking` and **only** through
  `speech_started`, raised by `App.tsx` from the Rust `speech_status: speaking`
  event described above.
- `checking` is **removed**. The `awaiting_approval` phase is a synchronous
  in-process validation (`parseSendPayment`, `agent/src/tools/payment.ts`) with
  no I/O and no `await`; measured at **~79 ns/call (0.00008 ms)** over 200k
  calls. A label for that would be a sub-frame flash nobody could read, so per
  the task it is left out rather than faked. The stage union is now
  `listening | thinking | speaking | failed`.

`turnSession.test.ts` grew from 9 to 12 cases; the new ones assert the invariant
directly: no stage is entered before its triggering event (nothing reaches
`speaking` before `speech_started`; `listening` only from `recording`; a
`speech_finished` before playback started cannot end a turn).

### 1c. A TTS failure still settles promptly

Honest ordering has one consequence: when both TTS backends fail, Rust now emits
only `speech_status: idle` (no `Speaking`), so the previous "idle ends the turn"
path is gone. `SpeechQueue.enqueue` gained an optional per-utterance `onError`,
and `App.tsx` passes a hook that settles the turn with the short label
`Voice error` — guarded by the session id, so a stale failure from a superseded
turn cannot fail a newer one. The 60 s watchdog remains the last resort, but this
is the normal path now. Pinned by two new queue tests (per-utterance hook fires
only for its own utterance; a dropped superseded utterance never reports).

---

## 2. Intent execution seam (infrastructure only)

### The path

```
runAgentTurn → Intent
   ↓  app/src/lib/chain.ts: executeApprovedIntent(intent)
   ↓  agent/src/execution.ts: executeIntent(intent, { approver, chainTools })
       1. resolve chainTools[intent.kind]      → missing: "unsupported"
       2. await approver.approve(intent)        → denied:  "rejected" (tool NOT called)
       3. await tool(intent)                    → "executed" | "unavailable" | "failed"
```

`ExecutionOutcome` never throws; every non-success carries a short `label` (the
notch line) and a full `detail` (the console/Rust log):

| status | when | label |
|---|---|---|
| `executed` | tool returned unsigned XDR + summary | — |
| `rejected` | approver said no | `Not approved` |
| `unsupported` | no tool for the intent kind (today: `raw_tx`) | `Not supported` |
| `unavailable` | tool threw `NotImplementedError` (today: `sendPayment`, `swap`, `guardPolicy`) | `Chain not wired` |
| `failed` | tool threw anything else | `Chain error` |

### Approval gate seam

`IntentApprover` is the explicit seam, and `executeIntent` calls the tool **only**
after `approve()` resolves `{ approved: true }` (pinned by a test that asserts
the call order and that a denied intent never reaches the tool). A throwing
approver is caught and returned as a labelled `failed` outcome, so the seam never
throws. Touch ID is *not* implemented.

**A10 correction (M5/M6).** The shell no longer auto-approves by default: it
selects its approver with `resolveApprover(...)`, which returns a deny-all gate
unless `POLARIS_ALLOW_AUTO_APPROVE=1` explicitly opts into the loud
`createAutoApprovalPlaceholder()`. The placeholder is a stand-in for the stubbed
demo only. It is also an **intent-level** gate: the approver sees only the
`Intent`, so a Touch ID implementation drops in for "approve/deny before any
chain work" — but *not* for the card-level approval, which needs the post-tool
`summary` + `payloadHash` (`PolarisEvent::approval_request`) and therefore a
second, post-tool phase this seam does not implement.

### `NotImplementedError` is the expected state today

Detection is structural (`error.name === "NotImplementedError"`), so the agent
core stays independent of `@polaris/stellar`; Owner B's stub class sets exactly
that name. The shell shows the short label and lets the existing failure dwell
settle the notch — never a crash, never a stuck stage. **A10 correction (M8):**
this applies to `sendPayment`, `swap` and `guardPolicy` only — `depositTry` is a
real path (unconfigured → `Chain error`; configured → a real unsigned XDR, never
submitted).

### Invariant preserved

Approval-gated tools still never run during the agent turn: the loop keeps using
`toIntent()` and the seam is invoked *after* the turn, only for a produced intent.

### Lazy chain import

`app/src/lib/chain.ts` imports `@polaris/stellar` with a dynamic `import()`,
only when an intent exists. This keeps the 578 kB chain chunk out of the shell's
startup bundle (initial JS went 819 kB → 241 kB minified); a purely conversational
voice turn never loads it.

---

## 3. MCP client scaffolding (read-only)

`agent/src/mcp/` (exported as the `mcp` namespace, plus `attachMcpToolsFromEnv`):

- **`config.ts`** — `POLARIS_MCP_SERVER_URL` (absent/blank/non-http(s) = feature
  off, no client, no request, no error) and an optional
  `POLARIS_MCP_ALLOWED_TOOLS` operator allowlist.
- **`client.ts`** — dependency-free JSON-RPC 2.0 over MCP Streamable HTTP:
  `initialize`, `tools/list` (cursor-paged, bounded), `tools/call`. Handles both
  `application/json` and `text/event-stream` responses, and echoes
  `mcp-session-id` + `mcp-protocol-version`.
- **`bridge.ts`** — discovers tools and registers the read-only ones into the
  existing `ToolRegistry` as ordinary **non-approval** tools under an `mcp_`
  namespace (so they can never shadow a local tool).

**Value movement is unreachable**, by defence in depth. A tool is exposed only if:
1. its name contains no value-moving token (`send`, `swap`, `submit`, `execute`,
   `deposit`, …; snake/kebab/camelCase tokenised, so `send_payment` is caught);
2. it does not declare `readOnlyHint: false`; **and**
3. it declares `readOnlyHint: true`, or the operator explicitly allowlisted it.

The policy is re-checked at *call* time, so a later policy tightening still binds.
Tests run against a loopback fake MCP server (no external network) and cover the
handshake, both transports, a lying `readOnlyHint: true` on `send_payment`, the
allowlist escape hatch, namespacing, local-tool protection, and the no-config
no-op.

**Left out (deliberately, and stated rather than faked):** wiring the MCP client
into the *desktop webview* at startup. The webview cannot reach a remote MCP
server directly (no CORS on those endpoints) and the architecture's MCP lane is
the headless brain, so the scaffolding is exercised through
`attachMcpToolsFromEnv(registry)` and the fake server today. Activating it in the
app is a packaging/runtime decision for a later step; no fake wiring was added.

---

## Acceptance evidence

All commands green (details in §Verification).

### Real turn, real LLM, real seam — `npm run e2e:intent -- "Ahmete 5 USDC gönder"`

```
agent: model=glm-5.3-flash tools=1 transcript="Ahmete 5 USDC gönder"
event: agent_status thinking
event: agent_status awaiting_approval
event: agent_status done
intent in 2036 ms: {"kind":"send","asset":"USDC","amount":"5","recipient":"Ahmet","source":"Ahmete 5 USDC gönder"}
[polaris] approval gate is the A9 placeholder (Touch ID is a later milestone); auto-approving a "send" intent
execution unavailable: label="Chain not wired"
  detail: sendPayment (intent: {…}) is not implemented yet (Milestone 3, Owner B)
stage order: listening -> thinking -> thinking -> thinking -> thinking -> failed
notch label after turn: "Chain not wired"
```

The `stage order` line is produced by feeding the **real** event stream through
the shell's exact reducer (`app/src/lib/turnSession.ts`), so it is the on-screen
order. The final `failed` is the deliberate terminal state; `App.tsx`'s 5 s
failure dwell then dispatches `settled` and the notch returns to the idle pill.

### Real TTS playback — `npm run e2e:speak -w @polaris/agent -- "Ahmete 5 USDC gönder"`

```
intent in 1960 ms: {"kind":"send","asset":"USDC","amount":"5","recipient":"Ahmet",…}
spoken sentence: Sending 5 USDC to Ahmet. Do you confirm?
polaris: live Fish voice reference_id=933563129e564b19a115bedd57b7406a sentence="Sending 5 USDC to Ahmet. Do you confirm?"
polaris: tts in 5713 ms via fish (40 chars)
test tts::tests::manual_live_fish_synthesises_mpeg_and_speaks ... ok
```

That live test now also asserts the playback-start callback fires **exactly
once**, and only after real audio began (`tts in 5713 ms` — the 5.7 s is
synthesis + playback, proving the "Speaking" event could only fire mid-way, not
at dispatch).

### Stage-order proof

The Rust and TS unit suites pin the contract without a screen or a mic:
`playback_start_fires_only_when_a_backend_reports_it`,
`the_fallback_announces_playback_at_most_once_across_the_handoff`,
`playback_start_fires_when_the_player_really_starts`, and the 12 turn-session
cases. The on-screen animation smoothness still needs a human eye (unchanged
from A8); the *ordering* is proven.

---

## Verification

| Command | Result |
|---|---|
| `npm run typecheck` | clean (interfaces, agent, stellar, app) |
| `npm run build` | clean; initial JS 241 kB min, chain chunk 578 kB lazy |
| `npm test -w @polaris/app` | **12/12** (was 9) |
| `npm test -w @polaris/agent` | **58/58** (was 40) |
| `caffeinate -i cargo test` | **107 passed, 2 ignored** (was 104/2) |
| `caffeinate -i cargo clippy --all-targets` | clean |
| `npm test -w @polaris/stellar` | 67 + 111 pass (untouched, no regression) |

The running dev server (vite :1420 + `tauri dev`) was left up; the Rust changes
compile cleanly under it.

---

## To Owner B (handoff)

You own `stellar/`; nothing there was touched. To make a chain action real, you
implement the bodies of these functions and change nothing else:

| Function | File | Signature | Called from |
|---|---|---|---|
| `sendPayment` | `stellar/src/index.ts` | `ChainTool = (intent: Intent) => Promise<ChainToolResult>` | `app/src/lib/chain.ts` via `executeIntent` |
| `swap` | `stellar/src/index.ts` | same | same (key `swap`) |
| `guardPolicy` | `stellar/src/index.ts` | same | same (key `guard_policy`) |
| `depositTry` | `stellar/src/anchor/chainTools.ts` | `(intent: AnchorIntent) => Promise<ChainToolResult>` | same (key `deposit`) |
| `withdrawTry` | `stellar/src/anchor/chainTools.ts` | `(intent: AnchorIntent) => Promise<ChainToolResult>` | **not mapped yet** — `withdraw` is not in `IntentKind` until PR #8 |
| `submitSignedTx` | `stellar/src/anchor/chainTools.ts` | `(signedXdr: string, expectedXdr?: string) => Promise<SubmitResult>` | the signing/approval milestone, after Touch ID |

**You do NOT need to change:** `@polaris/interfaces`,
`agent/src/execution.ts`, `agent/src/tools/registry.ts`, `app/src/lib/chain.ts`,
or the approval seam. Return a normal `ChainToolResult`; today's
`NotImplementedError` is already handled as `"Chain not wired"`. If you want a
different short label for an unimplemented path, keep throwing
`NotImplementedError`; if a tool fails for real, throw anything else and the shell
shows `Chain error`.

One product note (A10 correction): `app/src/lib/chain.ts` is **fail-closed by
default** — it installs a deny-all approver unless `POLARIS_ALLOW_AUTO_APPROVE=1`
opts into the auto-approving placeholder for the stubbed demo. Before any real
value-moving tool ships, Owner A must replace that selection with the Touch ID
approver; the seam (`IntentApprover.approve(intent)`) is the only thing it
implements, and it is intent-level only (see the approval-gate note above).

---

## Unfinished (handed off)

- **App-side MCP attachment** — the client/bridge are done and tested; the
  webview wiring is deferred (CORS + packaging), as stated in §3.
- **Touch ID approver** — replace the placeholder in `app/src/lib/chain.ts`.
- **Approval card for an executed intent** — the shell currently logs the
  unsigned XDR + summary; rendering it is part of the approval milestone.
- **On-screen verification of the stage animation** still needs a human.
- `withdraw` intent kind / `withdrawTry` mapping blocked on PR #8.

## Commits

`f967a80` feat(tts): announce Speaking at real playback start ·
`34927fa` fix(shell): drive every notch stage from its real event ·
`4326916` feat(agent): add the approved-intent execution seam ·
`1530e9c` feat(agent): add read-only MCP client scaffolding ·
`cdab5ca` chore(scripts): add headless A9 intent e2e driver

## Suggested next step

Merge this branch to `main`; Owner B pulls and implements `sendPayment` first,
then Owner A swaps the placeholder approver for Touch ID and renders the
approval card for the `executed` outcome.
