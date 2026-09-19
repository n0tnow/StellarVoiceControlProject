# Report: slice-gap-analysis

- **Date:** 2026-09-19
- **Worker/Agent:** opencode-go/deepseek-v4.1-flash (L2)
- **Branch/Worktree:** `analysis/slice-gap` / `.worktrees/slice-analysis`
- **PR:** none

## TL;DR (max 10 lines)

- **Where we are:** the chain side is the strongest part. `stellar/src/anchor` is real (SEP-1/10/12/38/6, 111 unit tests, live e2e — `backlog/anchor-sep6.md:110`), and `polaris_guard` is deployed on testnet (`contracts/DEPLOYED.md:11`). The app/voice side is real too, but **only on unmerged branches**: `feat/a0-push-to-talk-notch`, `feat/a1-stt`/`feat/a1-ondevice-stt`, `feat/a2-llm`, `feat/a3-tts`.
- **The seam is half-real.** `Intent`/`ChainTool`/`PolarisEvent` are defined (`interfaces/src/index.ts`), but `SigningService` has **zero implementations**, `sendPayment` is a stub that throws (`stellar/src/index.ts:44`), and **alias resolution is missing everywhere** off-chain.
- **The single biggest gap for "send 10 USDC to ada":** there is **no payment ChainTool** and **no signing path**. The anchor tools return a SEP-10 challenge / trustline, not a plain payment, and require a multi-step session.
- **Agent runs in the webview** on `feat/a2-llm` (`app/src/lib/agent.ts`) with a real OpenAI-compatible client; on `main` it is a `MockLlm` skeleton only. No chain tool is registered anywhere.
- **Owner A's branches add exactly the missing voice half** (hotkey+mic, on-device STT, LLM intent, TTS) but none is merged; `main` has only the monorepo skeleton.
- **Shortest path:** typed-text input → agent `Intent` (exists on a2) → **build one real `sendPayment`** (unsigned XDR + summary) → approval card → Rust approval gate + key release → TS sign/submit → `tx_submitted`. Touch ID is a stretch; a dev software signer with an approval click is the demo-safe floor.
- **Voice is NOT on the critical path:** steps S2–S7 below can land with typed text while A0/A1 merge in parallel.
- **Coordinator must decide first:** merge order of the four branches that all edit `interfaces/src/index.ts` (`a0`, `a1`, `a2`, `docs/rule-types-and-decisions`) and the signer option (F).
- All claims below are cited; anything I did not run is marked **UNVERIFIED**.

---

## A. Interfaces

### A.1 `interfaces/src` vs `docs/interfaces.md` — drift

The three core types are byte-identical between the two files.

| Type | `interfaces/src/index.ts` | `docs/interfaces.md` | Drift |
|---|---|---|---|
| `IntentKind` / `Intent` | `index.ts:18-33` | `interfaces.md:10-22` | none |
| `ChainToolResult` / `ChainTool` | `index.ts:43-58` | `interfaces.md:28-41` | none |
| `SigningService` | `index.ts:68-71` | `interfaces.md:45-52` | none |
| `PolarisEvent` | `index.ts:83-95` | `interfaces.md:56-65` | none |

Extra runtime values exist **only** in `interfaces/src` and are **not documented** in `docs/interfaces.md`:

- `POLARIS_EVENT_NAME = "polaris-event"` — `interfaces/src/index.ts:78`
- `HotkeyState`, `AgentStage` named types — `interfaces/src/index.ts:80-81`
- `isPolarisEvent()` runtime guard — `interfaces/src/index.ts:101-107`
- `AppInfo` — `interfaces/src/index.ts:113-119`

Two concrete documentation bugs:

1. `interfaces/src/index.ts:10-11` says the Rust mirror lives in `app/src-tauri/src/interfaces.rs`. **That file does not exist**; the real mirrors are `app/src-tauri/src/types.rs` (`Intent` `types.rs:25-42`, `TxSummary` `types.rs:48-56`) and `app/src-tauri/src/events.rs` (`PolarisEvent` `events.rs:37-65`). (`ls app/src-tauri/src` → `commands.rs events.rs lib.rs main.rs types.rs`.)
2. `SigningService.sign(payloadHash)` (`interfaces/src/index.ts:68-71`) does **not** match the only signing abstraction that has been implemented, the anchor `Signer.signTransaction(xdr, {networkPassphrase})` (`stellar/src/anchor/types.ts:11-21`). This mismatch was already flagged by Owner B at `backlog/anchor-sep6.md:117` ("an adapter or an interface decision is needed").

A further seam mismatch: on `main`, `IntentKind` has no `"withdraw"`, so `withdrawTry` is typed with a **local structural copy** `AnchorIntent` (`stellar/src/anchor/chainTools.ts:30-36,108`), not with the shared `ChainTool` (`interfaces/src/index.ts:58`). The unmerged `docs/rule-types-and-decisions` branch adds `withdraw` plus `set_rule`/`schedule`/`cancel_schedule`/`p2p_offer`, `Rule`, `Schedule`, `ScheduleDraft`, `GuardError`, and the events `anchor_step` / `approval_required` (`git diff origin/main...origin/docs/rule-types-and-decisions -- interfaces/src/index.ts`).

### A.2 Who implements each type today

| Seam | Implemented by | Evidence |
|---|---|---|
| `Intent` (producer) | **No product producer on `main`.** On `feat/a2-llm` only: `sendPaymentTool.toIntent` validates model args → `Intent` | `main`: none (tests only); `origin/feat/a2-llm:agent/src/tools/payment.ts:88-118` |
| `ChainTool` | `depositTry` (`stellar/src/anchor/chainTools.ts:58`); `withdrawTry` is *almost* one (`:108`, local `AnchorIntent`) | `stellar/src/index.ts:51` |
| `sendPayment`/`swap`/`guardPolicy` | **STUB** — every one throws `NotImplementedError` | `stellar/src/index.ts:24-46` (`todo()` `:31-35`) |
| `SigningService` | **NO implementation anywhere.** No Keychain, no `LocalAuthentication`, no Rust sign command | grep for `localauthentication|SecItem|touch.?id|biometric` finds only prose/comments (`app/src-tauri/Cargo.toml:23`, `docs/architecture.md:134`) |
| `PolarisEvent` (Rust emit) | `events::emit` → Tauri channel `polaris-event`; consumed in webview by `listenPolarisEvents` | `app/src-tauri/src/events.rs:84-88`; `app/src/lib/polaris.ts:33-43` |
| `PolarisEvent` (render) | `describeEvent` switch | `app/src/lib/polaris.ts:71-107` |
| `Signer` (anchor, different type) | `EnvSigner` (test-only) | `stellar/src/anchor/types.ts:11-21`; `stellar/src/anchor/testSigner.ts`; export `stellar/src/anchor/testing.ts` |

---

## B. Chain side (`stellar/`)

### B.1 `sendPayment` / payment ChainTool — **MISSING**

- There is **no payment builder** in `stellar/`. `sendPayment` is a stub:
  `export const sendPayment = todo("sendPayment");` — `stellar/src/index.ts:44`; `todo()` throws `NotImplementedError` (`:31-35`). Same for `swap` (`:45`) and `guardPolicy` (`:46`).
- The anchor `ChainTool`s (`depositTry` `stellar/src/anchor/chainTools.ts:58-98`, `withdrawTry` `:108-127`) return the **first step of a multi-step anchor flow** (a USDC trustline or a SEP-10 login challenge), not a plain payment. The interface file itself admits `ChainToolResult` is single-step and needs a `next` discriminator (`backlog/anchor-sep6.md:133`).
- `submitSignedTx(signedXdr, expectedXdr?)` **does exist** and is real (`stellar/src/anchor/chainTools.ts:140-163`): it refuses unsigned envelopes (`:152`), refuses a sequence-0 SEP-10 challenge (`:153`), hash-checks against the expected XDR (`:156`), submits to Horizon and returns `{hash, explorerUrl}`.
- **Alias resolution is absent off-chain.** `grep -ri alias stellar/src agent/src` → nothing relevant. The only alias book is on-chain: `set_alias`/`get_alias` in `contracts/polaris_guard/src/lib.rs:369-403`. `sendPayment` must resolve `<alias>` before it can build the payment.
- `describexXdr()` decodes operation lines from the XDR (`stellar/src/anchor/describe.ts:36-45`) and is re-exported (`stellar/src/anchor/chainTools.ts:52`). It uses the Node `Buffer` global (`describe.ts:42,51`) — see G.2.

### B.2 `polaris_guard` TypeScript client — **MISSING (owner side)**

- The deployed contract exposes `set_rule`, `get_rule`, `set_executor`, `revoke_executor`, `set_alias`, `remove_alias`, `get_alias`, `is_known_recipient`, `pay_owner`, `pay_executor`, `spent_today`, `create_schedule`, `cancel_schedule`, `execute_schedule`, `get_schedule`, `list_schedules`, `next_schedule_id`, `list_due` (`contracts/polaris_guard/src/lib.rs:318-780`; ABI and demo calls in `contracts/DEPLOYED.md:153-173,295-305`).
- The **only** TS client is the keeper's `SorobanChain`, and it exposes **read + execute only**: `listDue`, `getSchedule`, `execute`, `checkPending` (`stellar/src/keeper/chain.ts:87-93,143,162,189,318`). There is **no** `set_rule`, `pay_owner`, `pay_executor`, `create_schedule`, `set_alias`, or SAC `approve` client. (Confirmed by grep: names appear only in the error table `stellar/src/keeper/errors.ts:51-80` and docs.)
- Consequence: routing a payment through the guard (`pay_executor`) needs a new client path, not just wiring.

### B.3 `stellar/src/anchor/chainTools.ts` — does it implement `ChainTool`? How are tools registered?

- `depositTry` is declared as `ChainTool` (`chainTools.ts:58`); `withdrawTry` is declared as `(intent: AnchorIntent) => Promise<ChainToolResult>` (`:108`).
- Registration: **there is none at the agent level.** The module exposes `configureAnchor()` and `getAnchorSession()` (`chainTools.ts:41-49`), and `stellar/src/index.ts:51-52` re-exports `depositTry`, `withdrawTry`, `submitSignedTx`, and `anchor` barrel. The agent registry on `main` registers only `noopTool` (`agent/src/index.ts:24`); on `feat/a2-llm` it registers `sendPaymentTool` + `noopTool` (`origin/feat/a2-llm:agent/src/runtime.ts:20-22`). **No `@polaris/stellar` import exists in `agent/` or `app/` on any branch** (agent deps: `@polaris/interfaces` only, `agent/package.json:15-17`; app deps on a2 add `@polaris/agent`, not stellar).

### B.4 `stellar/src/index.ts` exports

`TESTNET` constants (`:16-21`), `NotImplementedError` (`:24-29`), the three stubs (`:44-46`), `depositTry`/`withdrawTry`/`submitSignedTx` (`:51`), `anchor` namespace (`:52`), `keeper` namespace (`:54`).

### B.5 Network / config surface

`.env.example`:
- Stellar: `STELLAR_NETWORK`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`, `STELLAR_NETWORK_PASSPHRASE` (`:13-16`).
- Anchor: `POLARIS_ANCHOR_HOME_DOMAIN`, `POLARIS_TEST_SECRET` (`:21-24`).
- Keeper: `KEEPER_SECRET`, `GUARD_CONTRACT_ID`, `SOROBAN_RPC_URL`, `NETWORK_PASSPHRASE`, `KEEPER_*` (`:35-46`).
- Constants default to testnet in code: `TESTNET` (`stellar/src/index.ts:16-21`), anchor `config.ts:2-8`.

---

## C. Anchor (SEP-6)

### C.1 Inventory

`stellar/src/anchor/` (44 files) implements:

| SEP | File | Status |
|---|---|---|
| SEP-1 discovery | `sep1.ts` | REAL |
| SEP-10 auth | `sep10.ts` | REAL (validate-before-sign) |
| SEP-12 KYC | `sep12.ts` | REAL (`KycRequiredError` on missing fields) |
| SEP-38 quotes | `sep38.ts` | REAL (indicative only) |
| SEP-6 deposit **and** withdraw | `sep6.ts` (status machine), `flows.ts`, `session.ts` | REAL |

Supporting roles: `explain.ts` (narration `ExplainLog`, `narrate()`, `toAnchorStepEvent()` `explain.ts:41`), `describe.ts` (approval-card text decoded from XDR), `sandbox.ts` (`simulate-bank-transfer`, mock only), `preflight.ts` (Friendbot + `changeTrust`), `session.ts` (the object the agent drives, one method per step), `horizon.ts` (reads/submit), `chainTools.ts` (`ChainTool` wiring), `e2e.ts` (live run). The README's own table: `anchor/README.md:12-26`.

### C.2 TR mock anchor vs SDF test anchor

- `DEFAULT_HOME_DOMAIN = "tr-mock-anchor.fly.dev"` (`config.ts:2`); issuer pinned for that domain (`KNOWN_ISSUERS`, `config.ts:16-18`).
- `SDF_TEST_ANCHOR_HOME_DOMAIN = "testanchor.stellar.org"` (`config.ts:4`), described as a second SEP-6 provider for dev/tests (`anchor/README.md:159-161`); it demands SEP-12 fields (`first_name`, `last_name`, `email_address`) surfaced as `KycRequiredError`.
- The home domain is the only anchor input; the asset defaults to `USDC` (`config.ts:5`; `anchor/README.md:5-6`).
- `POLARIS_ANCHOR_HOME_DOMAIN` overrides (`e2e.ts:29`; `.env.example:21`).

### C.3 `e2e.ts` — what it does and needs

- Runs `preflight → SEP-38 quote → SEP-6 deposit → (sandbox) simulate bank → completed → Horizon balance → SEP-6 withdraw` (`e2e.ts:1-14,41-64`).
- Needs a signer: `POLARIS_TEST_SECRET` or a random in-memory key (`e2e.ts:34`), plus network access to the anchor and Horizon. Testnet only. The `anchor:e2e` script is `node src/anchor/e2e.ts` (`stellar/package.json:22`).
- **I did not run it** (task forbids network). Its live results are reported in `backlog/anchor-sep6.md:34-54` and `anchor/README.md:139-161` (UNVERIFIED by me).

### C.4 SEP-24 on the TRY path — confirmed absent

`grep -ri "sep.?24"` over `stellar/src` returns **only prose** (`anchor/README.md:176-184`, "Why SEP-24 is deliberately not used in Turkey"). There is no SEP-24 endpoint constant, config, client, or call anywhere. The anchor `README.md:176-184` states the hosted/interactive model is prohibited under MASAK rules while SEP-6 is legal, and that SEP-31/SEP-45 are out of scope. **No SEP-24 on the TRY path: confirmed from code + docs.**

### C.5 Docs that exist, and what a "TRY deposit by voice" builder is missing

Existing: `stellar/src/anchor/README.md` (203 lines, flows, gotchas, verified live facts), `backlog/anchor-sep6.md` (report; unfinished items at `:115-121`).

Missing for a builder who must demo TRY deposit by voice:
- **No voice-to-anchor glue.** The agent never calls the anchor; there is no `depositTry` registration in the agent registry (B.3).
- **No explain-event on the wire.** `toAnchorStepEvent()` produces `{type:"anchor_step",...}` (`explain.ts:30-42`) but `anchor_step` is **not** in `main`'s `PolarisEvent` (`interfaces/src/index.ts:83-95`); it lives only on the unmerged `docs/rule-types-and-decisions` branch.
- **No handling of the multi-step contract.** `depositTry` returns either a trustline or a SEP-10 challenge, each needing different post-sign routing (`chainTools.ts:1-14,72-97`); `ChainToolResult` has no `next` field to express that (`backlog/anchor-sep6.md:133`).
- **No real signer** (same gap as F).

### C.6 Can the agent call anchor tools today?

**No.** Nothing imports `stellar/src/anchor/chainTools.ts` into `agent/` or `app/` (B.3). The tools are only reachable from a Node script/CLI (`e2e.ts`, `flows.ts`). `configureAnchor({signer})` must be called once at app start (`chainTools.ts:40-49`), and that call site does not exist.

---

## D. Agent (`agent/`)

### D.1 On `main` — skeleton, not noop-only

- Tool-use loop exists but is mock: `runTurn()` (`agent/src/loop.ts:55-95`), `MockLlm` (`:102-122`), `AgentLlm` port with an explicit `TODO(A2)` comment (`:21-24`).
- Registry is real and typed: `AgentTool` with `requiresApproval?`, `IntentTool` (`agent/src/tools/registry.ts:20-35`). The only tool is `noopTool` (`agent/src/tools/noop.ts:18`).
- Event bus is real (`agent/src/events.ts`). No system prompt, no provider client, no chain tool.

### D.2 On `feat/a2-llm` — A2 is substantially done (branch only)

- Real OpenAI-compatible client: `origin/feat/a2-llm:agent/src/llm/openai.ts` (`POST /chat/completions`, tools, injectable `fetch`, `x-opencode-session` header), config in `agent/src/llm/config.ts` (`POLARIS_AGENT_BASE_URL`, `POLARIS_AGENT_MODEL`, `OPENCODE_API_KEY`).
- Provider-independent system prompt `agent/src/prompt.ts`.
- `send_payment` tool validates the model's args into the shared `Intent` and **does not execute** — `requiresApproval:true`, `toIntent()` added to the registry (`origin/feat/a2-llm:agent/src/tools/registry.ts:28-36`, `agent/src/tools/payment.ts`).
- Loop stops approval-gated tools at a validated Intent and emits `agent_status: awaiting_approval` (`loop.ts` diff); `runTurn` now returns `intent`/`intentTool`.
- Webview wiring: `origin/feat/a2-llm:app/src/lib/agent.ts` (`runAgentTurn`) + `app/src/components/AgentTrace.tsx`, fed by the Rust `transcript` event (`App.tsx` diff).
- Branch report claims 28 tests pass and a live provider call (`backlog/2026-09-19-a2-llm.md`); **UNVERIFIED by me** (I ran no tests).

### D.3 What A2 (LLM roundtrip) and A5 (real chain wiring) still need

- A2 is effectively complete on the branch; the remaining A2 work is **merge + the production proxy** (`/agent-api` exists only in the Vite dev server; branch report "Unverified" section).
- A5 concretely needs:
  1. A real `sendPayment` chain tool (B.1).
  2. A registration/adapter so the shell can turn the A2 `Intent` into `ChainToolResult` (currently the loop stops at the Intent; no code calls any ChainTool).
  3. An approval card + signing/submit path (E/F).
  4. `@polaris/stellar` available to whatever process runs the chain tools (currently not a dependency of `agent` or `app`).

---

## E. App side (`app/`, plus Owner A's branches)

### E.1 What exists on `main`

- Tauri commands: `app_info` (`app/src-tauri/src/commands.rs:22-30`) and the temporary `dev_self_test` (`:38-66`), registered in `lib.rs:19-22`.
- Typed Rust event enum `PolarisEvent` (`events.rs:37-65`) + `emit()` (`:84-88`); channel `polaris-event`.
- Webview: log pane only — `App.tsx` subscribes and renders `EventLog` (`App.tsx:43-46,152`), with `getAppInfo`/`devSelfTest` helpers (`app/src/lib/polaris.ts:19-30`).
- A `shadcn` `Button` and `EventLog` component; no approval card, no registry of the agent.
- No audio capture, no hotkey, no STT, no TTS, no screen capture, no signing.

### E.2 `origin/feat/a0-push-to-talk-notch` (task says PR #14; branch report says "PR: none" — **UNVERIFIED** which holds)

Adds ~3.8k lines: `capture.rs` (cpal mic → 16-bit WAV via `hound`), `hotkey.rs` + `hotkey_flags.rs` (Control+Option modifier-only + Control+Option+Space fallback), `gesture.rs`, `notch.rs` (AppKit overlay, geometry from `safeAreaInsets`), new events `capture_status` / `audio_captured` / `hotkey_permission` (`interfaces/src/index.ts` + `types.rs` + `events.rs`), and a rewrite of `App.tsx` into the notch UI. `dev_self_test` is **deleted**, `capture_start/stop/status` commands added. Evidence: `git diff --stat origin/main...origin/feat/a0-push-to-talk-notch`; `backlog/2026-09-19-a0-push-to-talk-notch.md`. An independent review exists on `origin/review/a0` (report `backlog/2026-09-19-a0-review.md`, verdict APPROVE per commit `f283956`).

### E.3 `a1` branches

- `origin/feat/a1-stt` (commits `f263080`, `9773d18`, `3947805`): `stt.rs`, `stt/groq.rs` (cloud Groq Whisper), `stt/wav.rs`, `env.rs`; `Transcriber` seam. Report `backlog/2026-09-19-a1-stt.md`.
- `origin/feat/a1-ondevice-stt` (adds `a6dd497`, `da5daf6`, `4154ca3` on top of a1-stt): `stt/ondevice.rs` = Apple `SFSpeechRecognizer`, **on-device is the default**, Groq is explicit opt-in/fallback. Report `backlog/2026-09-19-a1-ondevice-stt.md`. State: reported complete (UNVERIFIED).
- `feat/a1-stt` is an ancestor of `feat/a1-ondevice-stt` (`git log`).

### E.4 `origin/feat/a2-llm`

See D.2. Also adds `app/src/components/AgentTrace.tsx`, `app/src/lib/agent.ts`, and a Vite `/agent-api` dev proxy that injects the provider key (`app/vite.config.ts`). Based on `feat/a1-ondevice-stt`.

### E.5 `origin/feat/a3-tts`

Adds `tts.rs`, `tts/fish.rs` (Fish Audio), `tts/local.rs` (macOS `say`), `tts/player.rs`, and a `speak(text)` command (`commands.rs`). Report `backlog/2026-09-19-a3-tts.md` claims a verified live Fish run (UNVERIFIED). Based on `feat/a1-ondevice-stt`.

### E.6 Missing on **every** branch

- **Approval card** — none (only `AgentTrace`'s one-line intent readout on a2).
- **Touch ID / Keychain / `SigningService`** — none (F).
- **Screen capture** — none.
- **Agent/chain integration** — none; the webview cannot import `@polaris/stellar` (no alias/dep; see G.2).

| Feature | main | branch | Status |
|---|---|---|---|
| hotkey + mic capture | no | `a0` | REAL (branch) |
| on-device STT | no | `a1-ondevice-stt` | REAL (branch) |
| LLM → Intent | no | `a2-llm` | REAL (branch) |
| TTS | no | `a3-tts` | REAL (branch) |
| approval card | no | no | MISSING |
| Touch ID / signing | no | no | MISSING |
| screen capture | no | no | MISSING |

---

## F. Signing (2 options)

### F.1 Today

- `SigningService` is a **type with no implementation** (`interfaces/src/index.ts:68-71`).
- The anchor side defines a *different* `Signer` interface (`stellar/src/anchor/types.ts:11-21`) whose only implementation is the **test-only** `EnvSigner` (`stellar/src/anchor/testSigner.ts`, exported only via `@polaris/stellar/anchor/testing`, `testing.ts`) — deliberately kept out of the product barrel (`anchor/README.md:100-102`).
- No Keychain access, no biometric call, and no Tauri command that signs anything (`#[tauri::command]` list: `app_info` + `dev_self_test` on main; capture/`speak` on branches).
- The architecture doc only *proposes* the mechanism: Keychain item + biometrics, because Secure Enclave cannot hold Ed25519 (`docs/architecture.md:127-134`); the crate deps are listed as "will add" in `app/src-tauri/Cargo.toml:22-23`.
- Where the secret would live: a macOS Keychain item (product) / root `.env` `POLARIS_TEST_SECRET` (test only, `.env.example:22-24`).

### F.2 Option 1 — Rust approval gate + TypeScript signing/submission (recommended, S/M)

Flow: webview builds/uses the unsigned XDR → `invoke("approval_request", {unsignedXdr, intent, summary})` → Rust stores the XDR, computes `payloadHash = sha256(XDR)`, runs **LocalAuthentication** (`objc2-local-authentication`) or, in dev mode, an approval click → on success Rust releases the testnet secret from Keychain/`.env` → webview signs with `@stellar/stellar-sdk` `Keypair` and submits via the existing `submitSignedTx(signedXdr, unsignedXdr)` (`stellar/src/anchor/chainTools.ts:140`) → emits `tx_submitted`.

- **Pros:** fastest; reuses `submitSignedTx` and all TS stellar-sdk code; keeps the biometric gate in trusted Rust; no Stellar signing crate needed.
- **Cons:** the secret transits the webview memory; only the Touch ID gate (not key custody) is native; the provider/dev proxy only exists in `make dev`.
- **Variant (better, +~1h):** Rust signs by shelling out to the installed `stellar` CLI's keystore (`stellar tx sign`) and returns signed XDR, so the secret never enters the webview; submission still goes through TS `submitSignedTx`. Adds a runtime dependency on stellar-cli.

### F.3 Option 2 — Full Rust-native signer (correct, L/XL)

Keychain + `objc2-local-authentication` in Rust, sign the XDR with a Rust Stellar crate, submit from Rust (Horizon HTTP).

- **Pros:** matches `docs/architecture.md:127-134`; secret never leaves the trusted process; no webview secret.
- **Cons:** needs a Rust Stellar XDR/signing dependency (not in `Cargo.toml` today), XDR assembly and Horizon client in Rust; realistic estimate **L–XL**, likely not finishable alongside the remaining integration in the hackathon window.

**Recommendation:** Option 1 (or its CLI variant) for the demo; Option 2 as the post-hackathon path. This also resolves the `SigningService.sign(payloadHash)` vs `Signer.signTransaction(xdr)` mismatch (A.1) by standardising on XDR, per Owner B's request (`backlog/anchor-sep6.md:117,133-135`).

---

## G. Minimal slice design

### G.1 Message shapes at each boundary

All payloads below use the existing wire conventions (snake_case `type` tags, camelCase fields — pinned by `app/src-tauri/src/events.rs:90-144`).

**(1) transcript → agent** (Tauri event, already on `main`)

```json
{"type":"transcript","text":"send 10 USDC to ada","final":true}
```
`interfaces/src/index.ts:85`; emitted `events.rs:41-45`; dispatched to the agent on a2 (`App.tsx` diff, `runFromTranscript`).
Typed-text alternative (no voice): the webview calls `runAgentTurn("send 10 USDC to ada")` directly (`origin/feat/a2-llm:app/src/lib/agent.ts`).

**(2) agent tool call → ChainTool**

Model tool call (OpenAI-compatible shape) → validated shared `Intent`:
```json
{"name":"send_payment","input":{"amount":"10","asset":"USDC","recipient":"ada"}}
```
→
```json
{"kind":"send","asset":"USDC","amount":"10","recipient":"ada","source":"send 10 USDC to ada"}
```
(`interfaces/src/index.ts:20-33`; producer `origin/feat/a2-llm:agent/src/tools/payment.ts:88-118`.)
Then the shell calls the ChainTool: `sendPayment(intent) -> ChainToolResult` (`interfaces/src/index.ts:58`).

**(3) ChainTool result → approval card**

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
    "explorerUrl": "https://stellar.expert/explorer/testnet/account/GARXWVN...",
    "estimatedFee": "0.00001 XLM"
  }
}
```
(`interfaces/src/index.ts:43-55`.)
The webview then asks Rust to open the gate:
```
invoke("approval_request", { intent, summary, unsignedXdr })
```
Rust computes `payloadHash`, stores the exact XDR, and emits:
```json
{"type":"approval_request","intent":{...},"summary":{...},"payloadHash":"<64 hex sha256 of unsignedXdr>"}
```
(`interfaces/src/index.ts:87-92`; `events.rs:49-53`.)

**(4) approval decision → signing → submit → result**

```
invoke("approve", { payloadHash: "<hex>", approved: true })
```
Rust: verify `payloadHash` matches the stored XDR → Touch ID / dev click → emit
```json
{"type":"approval_result","payloadHash":"<hex>","approved":true}
```
(`events.rs:54-57`) → release the key / sign.
Then sign (TS) and submit:
```ts
submitSignedTx(signedXdr, unsignedXdr)   // stellar/src/anchor/chainTools.ts:140
```
→ emit
```json
{"type":"tx_submitted","hash":"<64 hex>","explorerUrl":"https://stellar.expert/explorer/testnet/tx/<64 hex>"}
```
(`events.rs:58-61`). Denial path: `{"type":"approval_result","payloadHash":"<hex>","approved":false}` and nothing is signed or submitted.

### G.2 Which process runs the agent and the chain tools — **the webview (TypeScript)**

**Pick: webview**, for the agent *and* the payment ChainTool; Rust keeps only the approval gate, key release, and event plumbing.

Justification from what exists:
- The A2 agent already runs in the webview (`origin/feat/a2-llm:app/src/lib/agent.ts`), with a working LLM path through the same-origin `/agent-api` proxy; moving it creates the most work.
- The whole seam and the Stellar SDK path are TypeScript; `submitSignedTx` and `describeXdr` are TS already (`stellar/src/anchor/chainTools.ts:140`, `describe.ts:36`).
- Rust has **no** Stellar signing/stellar-sdk dependency (`app/src-tauri/Cargo.toml:17-20`), so Rust cannot build/sign a payment quickly.
- A Node sidecar would duplicate the agent runtime and add process management; it is the right long-term answer for the provider key in production, but not the minimal path.

Constraints to handle (not blockers):
- `@polaris/stellar` is **not** a dependency of `app` and has no Vite alias (only `@polaris/interfaces` plus `@/`; a2 adds `@polaris/agent` — `app/vite.config.ts`, `app/tsconfig.json`). The payment path must be added as `@polaris/stellar` (alias + dep).
- The anchor/keeper code uses the Node `Buffer` global (`describe.ts:42,51`; `sep6.ts:235`; `sep10.ts:98,120`) which the browser lacks. The **payment summary must be built without `Buffer`** (payment op fields are strings; convert `tx.hash()` with a hex helper), or add a polyfill. Do **not** pull the SEP-10/SEP-6 paths into the webview for this slice.

### G.3 Ordered checklist (S = ≤1h, M = 1–3h, L = >3h)

| # | Step | Owner | Files touched | Acceptance test | Effort | Parallel / depends | Voice needed? |
|---|---|---|---|---|---|---|---|
| S1 | Merge A0 (+ A1) into `main` | A | merge only | `make dev` runs; hold hotkey → `transcript` event | S | parallel with S2–S4 | — |
| S2 | Text-input dev path: a webview input that calls `runAgentTurn(text)` | A | `app/src/App.tsx`, `app/src/components/DevInput.tsx` | type "send 10 USDC to ada" → `Intent` in `AgentTrace` | S | parallel with S3/S4; needs a2 merged | no |
| S3 | Real `sendPayment` ChainTool (alias map → unsigned USDC payment XDR + decoded summary) | B | `stellar/src/payments.ts` (new), `stellar/src/index.ts:44`, test | unit test + Node script prints XDR + summary for `{send,USDC,10,ada}` | M | parallel with S1/S2/S5 | no |
| S4 | Register/adapt the ChainTool for the shell (Intent → `sendPayment`), expose `@polaris/stellar` to webview | B/A | `agent/src/runtime.ts`, `app/vite.config.ts`, `app/tsconfig.json`, `app/package.json` | `npm run cli -- "send 10 USDC to ada"` then ChainTool prints XDR+summary | M | depends S3 | no |
| S5 | Approval card component renders `summary` + Approve/Deny | A | `app/src/components/ApprovalCard.tsx`, `App.tsx`, `lib/polaris.ts` | card shows title/lines/fee; buttons emit events | M | depends S3 (needs a summary); parallel with S6 | no |
| S6 | Rust approval gate + key release: `approval_request` / `approve` commands; dev software signer | A | `app/src-tauri/src/commands.rs`, `lib.rs`, new `sign.rs`, `Cargo.toml` | commanded twice; emits `approval_request`/`approval_result`; deny → no sign | M | depends S5; parallel with S7 | no |
| S7 | Submit path: sign in TS, `submitSignedTx(signedXdr, unsignedXdr)`, emit `tx_submitted`; explorer link | A/B | `app/src/lib/chain.ts`, `App.tsx`, `stellar/src/index.ts` | tx visible on stellar.expert testnet | S/M | depends S6 | no |
| S8 | Replace text input with the merged voice path (A0+A1 transcript) | A | `App.tsx` (remove DevInput) | hold hotkey, say command, same result as S2 | S | depends S1+S2 | yes (now) |
| S9 | *(stretch)* Route through `polaris_guard` `pay_executor` + owner-side TS client (`set_rule`/`set_alias`/SAC `approve`) | B | `stellar/src/guard/**` (new) | over-limit payment rejected `#105` on testnet | L | after S7 | no |
| S10 | *(stretch)* Touch ID (LocalAuthentication) behind the S6 gate | A | `app/src-tauri/src/sign.rs` | biometric prompt; deny cancels | M | after S6 | no |

**Critical path:** S3 → S4 → S5 → S6 → S7. **S1/S2/S8 are the voice lane and never block the chain lane.** S3, S4, and the S5/S6 UI/Rust work can run in three worktrees with non-overlapping file scopes (`stellar/` vs `agent/`+`app` config vs `app/src-tauri/`).

---

## H. Risks / recommended defaults

| # | Risk / decision | Recommended default |
|---|---|---|
| 1 | Four branches edit `interfaces/src/index.ts` (`a0`, `a1`, `a2`, `docs/rule-types-and-decisions`) → merge conflicts | Merge A-line in dependency order (`a0` → `a1-stt` → `a1-ondevice` → `a2` → `a3`), then rebase `docs/rule-types-and-decisions` last (it is the broadest change). Freeze the seam after `a0` lands. |
| 2 | Agent/webview dependency: `/agent-api` proxy exists only in the Vite dev server; a packaged app cannot reach the LLM | Demo via `make dev` (Vite running). Do not attempt a packaged build for the money slice. Accept "dev demo" scope. |
| 3 | `Buffer` is a Node global used by `describeXdr`/SEP-10/SEP-6 (`describe.ts:42,51`) and is absent in the browser | Build the payment summary without `Buffer` (string op fields + a hex helper); do not import the SEP-6/SEP-10 path into the webview. Polyfill only if unavoidable. |
| 4 | Touch ID/Keychain is unimplemented and time is short | Ship the dev-mode software signer gated by an approval click first; add LocalAuthentication behind the same command only if time remains. Testnet key only. |
| 5 | Signing secret in the webview (Option 1) | Accept for testnet demo only; never mainnet; prefer the `stellar tx sign` CLI variant if +1h is available. Document the trade-off in the PR. |
| 6 | No alias resolver; on-chain `get_alias` is unread | Ship a committed `aliases.json` (testnet addresses) for the demo; wire the guard's `get_alias` read as a stretch. Never accept an agent-supplied raw address unchecked. |
| 7 | USDC payment fails with `op_no_trust` if the recipient has no trustline | Pre-create recipient testnet account + USDC trustline in setup; document in the demo runbook. |
| 8 | Anchor/SEP-6 is not needed for the "send" slice but is a handbook requirement | Do not block the send slice on the anchor. Land the send slice first; then reuse the same approval/sign/submit seam for `depositTry`. |

(Also worth deciding, but lower priority: whether `submitSignedTx`'s Node/Horizon dependency is acceptable in the webview, and whether `docs/rule-types-and-decisions` should land before or after the send slice. Recommended: after, as a docs-only PR.)

---

## I. Status matrix

| Component | Where (main/branch/missing) | Status | Evidence |
|---|---|---|---|
| `Intent` / `IntentKind` type | main | REAL | `interfaces/src/index.ts:18-33` |
| `Intent` producer (LLM → validated Intent) | branch `feat/a2-llm` | REAL | `origin/feat/a2-llm:agent/src/tools/payment.ts:88-118`; loop diff |
| `Intent` producer on main | main | MISSING | only `noopTool` registered (`agent/src/index.ts:24`) |
| `ChainTool` / `ChainToolResult` types | main | REAL (types) | `interfaces/src/index.ts:43-58` |
| `depositTry` / `withdrawTry` anchor tools | main | REAL | `stellar/src/anchor/chainTools.ts:58,108` |
| `sendPayment` payment tool | main | STUB | `stellar/src/index.ts:44` (`todo`, throws) |
| `swap` / `guardPolicy` | main | STUB | `stellar/src/index.ts:45-46` |
| `submitSignedTx` | main | REAL (TS, unwired) | `stellar/src/anchor/chainTools.ts:140-163` |
| Alias resolution (off-chain) | missing | MISSING | grep `alias` in `stellar/src`, `agent/src` → none |
| `polaris_guard` owner/executor TS client | missing | MISSING | only keeper reads/execute (`stellar/src/keeper/chain.ts:87-93`) |
| Keeper (`list_due`/`get_schedule`/`execute`) | main | REAL | `stellar/src/keeper/chain.ts:143,162,189`; report `backlog/keeper.md` |
| `polaris_guard` contract | main | REAL, deployed | `contracts/polaris_guard/src/lib.rs:318-780`; `contracts/DEPLOYED.md:11` |
| Anchor SEP-1/10/12/38/6 (deposit + withdraw) | main | REAL | `stellar/src/anchor/*`; 111 tests per `backlog/anchor-sep6.md:110` (UNVERIFIED by me) |
| SEP-24 on TRY path | missing (by design) | CONFIRMED ABSENT | only prose `stellar/src/anchor/README.md:176-184` |
| `SigningService` type | main | REAL (type) | `interfaces/src/index.ts:68-71` |
| `SigningService` implementation | missing | MISSING | grep `LocalAuthentication|Keychain|SecItem` → comments only; `Cargo.toml:22-23` |
| Anchor `Signer` interface | main | REAL (interface) | `stellar/src/anchor/types.ts:11-21` |
| Product signer | missing | MISSING | only test-only `EnvSigner` (`anchor/testSigner.ts`) |
| `PolarisEvent` TS union | main | REAL | `interfaces/src/index.ts:83-95` |
| `PolarisEvent` Rust mirror + emit | main | REAL | `app/src-tauri/src/events.rs:37-65,84-88` |
| Agent loop (tool-use) | main | PARTIAL (mock) | `agent/src/loop.ts:55-95,102-122` |
| Agent loop (real LLM) | branch `feat/a2-llm` | REAL | `origin/feat/a2-llm:agent/src/llm/openai.ts`, `runtime.ts` |
| Agent runs in webview | branch `feat/a2-llm` | REAL | `origin/feat/a2-llm:app/src/lib/agent.ts` |
| Approval card UI | missing | MISSING | only `AgentTrace` one-liner (`a2`), no card component |
| Touch ID / Keychain | missing | MISSING | no impl anywhere |
| Tauri shell (window, event stream, `app_info`) | main | REAL | `app/src-tauri/src/lib.rs:17-31`; `App.tsx` |
| `dev_self_test` command | main | REAL (temporary) | `app/src-tauri/src/commands.rs:38-66` |
| Hotkey + mic capture + notch overlay | branch `feat/a0-push-to-talk-notch` | REAL | `git diff --stat origin/main...origin/feat/a0-push-to-talk-notch`; a0 report |
| STT (Groq) | branch `feat/a1-stt` | REAL (branch) | `stt/groq.rs`, `stt.rs`; a1 report |
| STT (on-device, default) | branch `feat/a1-ondevice-stt` | REAL (branch) | `stt/ondevice.rs`; report |
| TTS (Fish + local) | branch `feat/a3-tts` | REAL (branch) | `tts/fish.rs`, `tts/local.rs`; report (live run UNVERIFIED) |
| Screen capture | missing | MISSING | no code on any inspected branch |
| Rule/Schedule/GuardError seam additions | branch `docs/rule-types-and-decisions` | PARTIAL (unmerged) | `git diff origin/main...origin/docs/rule-types-and-decisions -- interfaces/src/index.ts` |
| README / sprints / notes reflect reality | main | PARTIAL | `README.md:126-133` still calls A2 "mock/Anthropic"; branch work not yet reflected |
