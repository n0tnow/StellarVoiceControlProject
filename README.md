# Autonomy

> **Project link (live demo):** _to be added_ <!-- TODO: replace this line with the public project/demo URL before submission -->

Autonomy is a **push-to-talk voice assistant for Stellar that lives in the MacBook notch.** Hold `Control+Option`, speak Turkish or English, and Autonomy answers — or turns the request into a real Stellar transaction: a payment, a spending rule, a scheduled transfer, a bank on/off-ramp, or a peer-to-peer trade. Every value-moving step is rendered as a decoded transaction card and gated by Touch ID; anything that runs unattended is bounded by an on-chain Soroban guard.

**Stellar Testnet only — no mainnet, no real money.**

| | |
|---|---|
| Hackathon | Genesis track — 19–20 September 2026 |
| Repository | https://github.com/n0tnow/StellarVoiceControlProject |
| Deployed contracts | [`polaris_guard`](https://stellar.expert/explorer/testnet/contract/CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D) · [`polaris_p2p_escrow`](https://stellar.expert/explorer/testnet/contract/CBMXLTXS76S72SIPLVMCQOSS6SN2CR4V3Q73GZPRA4GRIBEM7RE5OLJW) |
| Deployment record | [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md) — IDs, transactions, wasm hashes, error codes |
| Version | `0.1.0` (see [`VERSION`](VERSION) and [`CHANGELOG.md`](CHANGELOG.md)) |

---

## Narrative: why Autonomy

### The problem
Moving stablecoins still means opening a browser wallet, copying a 56-character address and approving a signature prompt most people cannot read. Voice is the natural interface for "send 10 to Ahmet" — but giving an LLM unsupervised control of money is unacceptable. Users need **voice-level speed with human-level control.**

### Target users
- Stablecoin users who want hands-free payments without handing custody to a web app or a bot.
- Turkish users in particular: Autonomy understands code-switched Turkish/English commands ("Ahmet'e 10 dolar gönder") and supports a TRY leg through a peer-to-peer escrow.
- Builders looking for a reference implementation of **safe agentic payments** on Stellar: the approval model, the failure modes and the on-chain enforcement are all in this repo.

### Why this problem is worth solving
The UX gap — not liquidity or speed — is what keeps stablecoins out of everyday use. Letting an agent act on the user's behalf makes the gap worse: an agent must be powerful enough to be useful and constrained enough to be safe. Autonomy demonstrates one concrete answer: **the model proposes, the user disposes, and the chain bounds what runs unattended.**

### Value proposition
- **Voice-first Stellar.** Speak; get a decoded transaction card, not a hex blob.
- **Touch ID + embedded wallet.** No browser extension and no web page holding keys: the seed lives in the macOS Keychain and signing happens inside the app.
- **On-chain spending rules.** A non-upgradeable Soroban contract enforces per-transaction, daily and recipient limits for unattended payments; revoking one token allowance is the kill switch.
- **Local by default.** Transcripts, the wallet and the agent configuration stay on the device; Autonomy has no account and no backend.

---

## MVP: what shipped for this hackathon

### The application
A native **macOS app** (Tauri v2: trusted Rust core + React/TypeScript webview) whose only surface is a click-through notch panel — no menu-bar tray, no popup windows. It implements the full voice loop and the wallet/approval/signing stack:

- **Voice pipeline:** hold `Control+Option` to talk → STT → agent loop with short dialogue memory → spoken read-back.
- **Embedded wallet:** BIP-39/SEP-5 key derivation, seed in the macOS Keychain, Touch ID unlock, multi-account, Friendbot funding, contacts.
- **Approval gate:** the card is rendered from the **decoded XDR**, never from the model's text; Touch ID authorizes, the in-app wallet signs behind the unlocked session.
- **Notch pages:** History, Tasks, Rules, Wallet, Trade, Settings — all voice-navigable.
- **Chain lane** (`@polaris/stellar`): payments, guard client, schedules + keeper, SDF anchor client (SEP-6), P2P client, and live testnet E2E tooling.

Autonomy is a desktop application, so there is no hosted web front-end URL. The project link at the top of this README is the submission entry point for the demo; the timed scene-by-scene script is [`docs/demo-script.md`](docs/demo-script.md). The on-chain half of the MVP can also be verified headlessly from this repository — see **Headless proof** below.

### Deployed contracts (Stellar Testnet)

All contracts are built with the Soroban SDK (`soroban-sdk` v28) and deployed on Stellar Testnet. The contract IDs below were verified against the network on 2026-09-20: deploy transactions return `SUCCESS`, and `stellar contract fetch` reproduces the wasm sizes and sha256 hashes from the deployed code. Full deployment history, initialization steps and limitations: [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md).

#### `polaris_guard` — spending rules, alias book and schedules

| Field | Value |
|---|---|
| Contract ID | `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D |
| Deploy tx | `f6017b43cef06047b6c3bc04e2f88a2e9fb0b3ee3b3aa5a0261a0c43dfacaf59` |
| Wasm artifact | `polaris_guard.wasm`, 23,787 bytes, sha256 `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6` (re-derived from the deployed code) |
| Verified live | 2026-09-19 demo run: agent payment settled, over-limit payment rejected on-chain with `#105 NeedsOwnerApproval`, owner re-sent it, an unrelated keeper executed a due schedule |

The guard is multi-tenant with **no admin, no `init` and no upgrade path**: every function is keyed by the owner address that authorizes it. It enforces per-owner rules (auto-approve ceiling, per-tx and daily limits, allowed assets, known-recipients-only), keeps an owner-scoped alias book, and stores per-owner schedules that anyone can trigger via the permissionless `execute_schedule`.

**Entry points:** `set_rule` / `get_rule` · `set_executor` / `revoke_executor` / `get_executor` · `set_alias` / `remove_alias` / `get_alias` / `is_known_recipient` · `pay_owner` / `pay_executor` / `spent_today` · `create_schedule` / `cancel_schedule` / `execute_schedule` / `get_schedule` / `list_schedules` / `next_schedule_id` / `list_due`. Two earlier guard deployments are **deprecated — do not use them**; they are listed with their replacement in the inventory below.

Read-only check from the CLI (a funded source account must be configured in stellar-cli):

```bash
stellar contract invoke \
  --id CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D \
  --network testnet --source-account <FUNDED_IDENTITY> --send=no \
  -- next_schedule_id
```

#### `polaris_p2p_escrow` — USD ↔ TRY peer trades

| Field | Value |
|---|---|
| Contract ID | `CBMXLTXS76S72SIPLVMCQOSS6SN2CR4V3Q73GZPRA4GRIBEM7RE5OLJW` |
| Explorer | https://stellar.expert/explorer/testnet/contract/CBMXLTXS76S72SIPLVMCQOSS6SN2CR4V3Q73GZPRA4GRIBEM7RE5OLJW |
| Deploy tx | `14f1523307963e96d91a002875e38e6b395e7ebd06255d4fd79f4eaa756ce384` |
| Wasm artifact | `polaris_p2p_escrow.wasm`, 12,663 bytes, sha256 `59822484ade82fcdff342c378cc316fee0e8e8c76e829887e9e8b787e095ff16` |
| Verified live | 2026-09-20 demo run: offer `Open → Accepted → Settled` with correct balance moves (seller `2000.0001000 → 1900.0001000`, escrow `100 → 0`, buyer `0 → 100`) |

A seller locks a token on-chain and asks a TRY price; a buyer accepts within the pay window; the seller confirms fiat and the escrow releases. **There is no arbiter** — the seller alone decides whether fiat arrived, and the UI states this plainly.

**Entry points:** `create_offer` · `accept` · `confirm_fiat` · `cancel` · `reclaim` · `get_offer` · `next_offer_id` · `list_open` (8 exported functions).

### Complete contract ID inventory

Every contract ID this project has deployed on Stellar Testnet — current, superseded, and the demo assets' SAC wrappers. All rows were re-verified against the chain on 2026-09-20; full wasm hashes and deployment history are in [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md).

| Contract | Contract ID | Status | Deployed | Notes |
|---|---|---|---|---|
| `polaris_guard` | `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` | **live** | 2026-09-19 | Current deployment: rules, aliases, schedules |
| `polaris_p2p_escrow` | `CBMXLTXS76S72SIPLVMCQOSS6SN2CR4V3Q73GZPRA4GRIBEM7RE5OLJW` | **live** | 2026-09-20 | USD ↔ TRY escrow |
| `polaris_guard` | `CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY` | deprecated | 2026-09-19 | Global schedule cap → cross-tenant DoS |
| `polaris_guard` | `CDIWQTYA7OBF2FKLLHQWYZ2Q2L4PAEBLLMFRXVY4R7MAM45LX7Q2R2XB` | deprecated | 2026-09-19 | Alias re-pointing left the old wallet agent-payable |
| PGUSD SAC — demo asset | `CC2V2R6JLMVGXQOXMZLATCNOVNS2QEOKSNZYO7DATCWJNJTUPCI5QX3E` | live | — | SEP-41 wrapper used by the guard demo; 7 decimals |
| W8USD SAC — escrow demo asset | `CD5PXNKTSAEOVHXJCZTY5CVVDYEPDZCE7XFSBZGVBITY5NGP425BLNZ7` | live (throwaway) | — | SEP-41 wrapper used by the escrow demo; 7 decimals |

Verification performed on 2026-09-20: all four deploy transactions return `SUCCESS` from Soroban RPC; `stellar contract fetch` reproduces the documented wasm sizes and sha256 hashes for the four `polaris_*` deployments; both SACs answer `decimals = 7` in simulation. The canonical testnet **USDC SAC** (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`) used by the anchor path is an ecosystem contract, not deployed by this project.

### Live demo and how to run it

The app is fully functional on a Mac, and the public project link at the top of this README is the demo entry point. The five demo scenes — wallet creation, voice payment, rules-by-voice + autonomous payment, bank ⇄ anchor, P2P + History — are scripted beat by beat with fallbacks in [`docs/demo-script.md`](docs/demo-script.md).

Run it from source:

```bash
make setup    # npm install + .env from .env.example + icons
make build    # builds Autonomy.app (macOS, Apple silicon)
make run      # launches it (from the repo root so .env is found)
# or: make dev   — Tauri dev mode with Vite HMR
```

Requirements: macOS (Apple silicon), Node >= 22 (keeper >= 22.18), Rust stable, `cargo-tauri` (`cargo install tauri-cli --version ^2`) or the local `@tauri-apps/cli`, and `stellar-cli >= 25.2.0` (`brew install stellar-cli`) for contract builds. `make setup` creates `.env` from `.env.example`; fill the keys you need (`OPENCODE_API_KEY` for the LLM, `GROQ_API_KEY` for STT, `FISH_AUDIO_API_KEY` for TTS, `GUARD_CONTRACT_ID`, `POLARIS_P2P_CONTRACT_ID`). The shell loads the repo-root `.env`; a Finder-launched bundle falls back to `~/Library/Application Support/Polaris/.env`.

### Headless proof (no Mac required)

Judges can verify the Stellar side of the MVP without the desktop app:

```bash
# Full contract demo (needs the demo identities + PGUSD balance from contracts/DEPLOYED.md):
# allowance -> rule -> executor -> payment -> #105 rejection -> owner re-send -> keeper run
contracts/scripts/demo.sh

# Autonomous-payment loop on testnet: 1 XLM settles unattended, 15 XLM fails with #105
npm run e2e:autopay

# Anchor client against the SDF test anchor (plan, then live both directions)
npm run anchor:check -w @polaris/stellar -- --live --payout-check
npm run anchor:e2e   -w @polaris/stellar -- --home-domain testanchor.stellar.org

# Keeper: one tick against the guard's paginated list_due
export KEEPER_SECRET=$(stellar keys show keeper)   # never commit this
export GUARD_CONTRACT_ID=CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D
npm run keeper:once -w @polaris/stellar            # add -- --dry-run to simulate only
```

---

## Technical documentation

### Architecture

```
┌──────────────────────── app/ — Tauri v2 desktop shell ────────────────────────┐
│                                                                               │
│  Rust core (trusted)                       React/TypeScript webview (brain)   │
│  · notch window (AppKit)                   · agent loop + tool registry       │
│  · Control+Option hold-to-talk             · Stellar SDK transaction builders │
│  · mic capture, STT/TTS transport          · approval card from decoded XDR   │
│  · Touch ID gate, embedded wallet          · notch pages + event stream       │
│  · signs and submits                                                          │
└──────────┬─────────────────────────────────────────────────────┬──────────────┘
           │ unsigned XDR + decoded summary                      │ signed envelope
           ▼                                                     ▼
  @polaris/stellar (chain lane)                        Stellar Testnet
  payments · guard · schedules · keeper                Soroban RPC + Horizon
  anchor SEP-1/10/12/38/6 · P2P                        polaris_guard · polaris_p2p_escrow
```

The typed seam between the layers is `@polaris/interfaces` (`interfaces/src/index.ts`), mirrored in Rust (`app/src-tauri/src/types.rs`, `events.rs`). It pins the event stream (`PolarisEvent`) and the tool/signing contracts (`Intent`, `ChainTool`, `ChainToolResult`, `SigningService`).

### Main components and responsibilities

| Component | Path | Responsibility |
|---|---|---|
| Typed seam | `interfaces/` | `@polaris/interfaces` — the only typed contract between shell, agent and chain lane |
| Agent | `agent/` | `@polaris/agent` — LLM loop, tool registry, dialogue memory, reply-language resolution, spoken-sentence builder |
| Desktop shell | `app/` | `@polaris/app` — Tauri v2: Rust core (notch, hotkey, mic, STT/TTS, Touch ID, Keychain wallet, submission) + React 19 notch UI |
| Chain lane | `stellar/` | `@polaris/stellar` — payments, guard client, schedules, keeper, anchor client, P2P client, live E2E tooling |
| Guard contract | `contracts/polaris_guard/` | Soroban: per-owner rules, limits, alias book, schedules (`execute_schedule` is permissionless) |
| Escrow contract | `contracts/polaris_p2p_escrow/` | Soroban: non-custodial offer/accept/confirm with a pay window and reclaim path |
| Keeper | `stellar/src/keeper/` | Off-chain poller that submits `execute_schedule` for due ids; untrusted by design |

### Voice payment, end to end

1. **Trigger.** A native `NSEvent` monitor detects the `Control+Option` hold (modifier-only, 300 ms arming, Accessibility-gated with a fallback shortcut). Release stops capture — it never sends.
2. **Capture + STT.** The mic records 16-bit PCM WAV; Groq `whisper-large-v3-turbo` transcribes with bilingual handling (on-device `SFSpeechRecognizer` is opt-in). The STT language is only a hint — the model's reading of the transcript text wins.
3. **Agent.** The agent loop picks a tool (`send_payment`, `schedule_payment`, `p2p_offer`, `deposit`, `set_approval_rule`, …) from a fixed registry. The LLM key lives in Rust; it is never exposed to the webview.
4. **Intent → unsigned XDR.** The chain lane builds the unsigned transaction and a decoded summary. Execution never throws; failures become typed outcomes.
5. **Approval.** The notch shows a card rendered from the **decoded XDR** (recipient, asset, amount, fees). The default approver is deny-all. Touch ID (LAContext, device-owner auth) authorizes the exact XDR digest.
6. **Sign + submit.** The embedded wallet signs in Rust inside the unlocked session; the signed envelope is re-verified before submission via Soroban RPC / Horizon. `tx_submitted` events update the notch, and History records the turn.
7. **Read-back.** A short confirmation sentence (capped at 120 characters for latency) is spoken via Fish Audio with a local macOS `say` fallback.
8. **Autonomous path (opt-in).** A spoken rule arms one batch card (`approve → set_rule → set_executor`); within limits the registered executor key settles payments unattended via `pay_executor`, bounded on-chain by `polaris_guard`. Above the limit the chain returns `#105` and Autonomy falls back to the owner approval card.

### Stellar integrations and protocols

- **Soroban smart contracts** — `polaris_guard` and `polaris_p2p_escrow`, built with `soroban-sdk` v28 and deployed on Testnet (IDs and artifacts above).
- **SEP-41 / Stellar Asset Contract (SAC)** — the guard never custodies funds; it settles with `transfer_from(spender = guard)` under the owner's allowance (`approve --live_until_ledger`). Allowed assets are SAC contract addresses, and the allowance is the user's kill switch.
- **Anchors (SEP-1/10/12/38/6)** — discovery, web auth, KYC, quotes and deposit/withdraw against the **SDF test anchor** (`testanchor.stellar.org`, SRT/USD, TEST-DATA KYC), verified live in both directions ([`docs/anchor-sdf-flow.md`](docs/anchor-sdf-flow.md)); a simulated bank automates the bank leg. SEP-24 is deliberately not used (regulatory constraints), and SEP-45 is skipped (contract accounts excluded).
- **Schedules + keeper** — Soroban has no timers. Schedules are stored per owner and triggered by a permissionless off-chain keeper that pays fees only; it cannot move funds or bypass a rule. Discovery is a paginated `list_due` scan, deliberately with no global index.
- **RPC / Horizon / tooling** — `https://soroban-testnet.stellar.org` for simulation and submission, `https://horizon-testnet.stellar.org` for balances and payments, Friendbot for funding, stellar.expert links throughout.
- **Embedded wallet** — BIP-39 seed with SEP-5 derivation (`m/44'/148'/index'`), seed stored in the macOS Keychain, Rust-enforced `none/locked/unlocked` session with idle auto-lock.
- **Privacy (evaluated, read-only)** — SPP is surfaced read-only; Confidential Tokens are designed but not shipped. The public-boundary limit model is in [`docs/confidential-payments.md`](docs/confidential-payments.md).

### Key design decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| The model proposes, the user disposes | LLM output is untrusted input | One approval step on every first-time value move |
| Embedded wallet instead of Freighter / Wallets Kit | No extension, seed never reaches a web page | Keychain ACL work; no hardware-wallet support |
| Approval card built from the decoded XDR | What is signed must be what is shown | Extra decoding/formatting work on the client |
| Guard is non-upgradeable, no admin | Nothing upgradeable to attack | A fix means a new contract ID and every owner re-publishing |
| `daily_limit` is the real mandate | `auto_approve_limit` is only a per-transaction ceiling | Rule semantics must be stated carefully in UI copy |
| Untrusted keeper, permissionless `execute_schedule` | No privileged keeper key to steal | Sweep cost grows with ids ever created (no global index) |
| Groq STT default, on-device opt-in | Code-switched Turkish/English needs bilingual recognition | Cloud recognition sends mic audio off-device by default |
| SDF test anchor as primary ramp | Verified live in both directions | TEST-DATA KYC only; the TR mock payouts stalled |
| P2P escrow without an arbiter | Deliberate scope decision | Buyer can lose the fiat race; the UI must say so |

### Technical challenges and how they were solved

- **WKWebView `fetch` receiver bug** — provider calls from the webview failed in packaged builds (`Can only call Window.fetch on instances of Window`). Solved by moving the LLM transport into Rust (`agent_chat`), which also keeps API keys out of the webview.
- **Modifier-only global hotkey** — a hold with no letter key is unusual; implemented with a native `NSEvent` monitor pair, 300 ms arming, Command/Shift exclusion and an Accessibility consent flow with a graceful fallback shortcut.
- **Cross-tenant DoS in the guard** — the first deployment had a global 200-schedule cap anyone could fill far in the future, blocking scheduling for everyone. Redesigned to a per-owner cap (25) plus a paginated scan, and redeployed; because there is no upgrade path, the fix shipped as a new contract ID with the old one marked deprecated.
- **Alias re-pointing bug** — moving an alias to a new wallet left the old wallet marked as a known recipient, making it agent-payable. Fixed with reference-maintained `Known` markers and verified; again shipped as a redeploy.
- **ABI encoding defects caught by independent review** — `scvString`/`scvU64` vs `scvSymbol`/`scvI128` mismatches and a `minTime = now` that caused `tx_too_early`; fixed and re-verified with 12/12 live scenarios on testnet.
- **Turn-lifecycle races** — overlapping transcripts could interleave approvals. Solved with one continuous turn session, latest-wins supersede, thinking/speaking watchdogs and a fail-closed approver.
- **TTS latency** — capping the spoken text at 120 characters cut a 311-character answer from ~20.3 s to ~4.3 s of speech.
- **Anchor hardening** — home-domain policy, sanitised untrusted text, withdrawal payout bound to the session's own response, JWT never logged.

---

## Security model

- **Testnet only.** No mainnet deployment exists and none is planned for this milestone.
- **No secrets in the app, webview or repo:** `.env` is gitignored (`.env.example` is the template); wallet seeds live in the macOS Keychain and are zeroized in Rust.
- **Fail-closed approvals:** the default approver is deny-all; `POLARIS_ALLOW_AUTO_APPROVE` is never enabled by the app itself.
- **On-chain bounds:** a compromised agent is limited by `polaris_guard`; the SAC allowance is the user's kill switch.
- **Card from the XDR:** the approval card renders the decoded transaction, not the model's text, and Rust re-verifies the signed envelope before submission.
- **Independent review:** every milestone goes through a branch + PR + separate reviewer; verdicts are archived under [`docs/reviews/`](docs/reviews/) and [`backlog/`](backlog/).

## Project status

**Wired and testnet-verified:** the notch voice pipeline (hotkey → STT → agent → read-back), embedded wallet (create/import, Keychain, Touch ID, session lock), approval + autonomous payments via `polaris_guard`, SEP-6 anchor deposit/withdraw against the SDF test anchor with a simulated bank, P2P escrow contract + client, schedules + keeper, and the History timeline. Live evidence: the guard demo run (2026-09-19), the escrow run (2026-09-20), and the autonomous-pay E2E (1 XLM unattended success, 15 XLM `#105`).

**Needs a human on a real Mac:** live microphone + STT round trip, real Touch ID, real notch windows/hover, and the live anchor payout leg.

**Designed, not shipped:** value-moving SPP (needs wallet `signAuthEntry`), Confidential Tokens, MPP, passkey/smart wallet, protocol integration (Soroswap/DeFindex), screen reading, developer mode, and mainnet.

## Build and test

```bash
make setup                                        # npm install + .env from .env.example + icons
npm test -w @polaris/stellar                      # keeper (node:test) + anchor/guard/P2P (vitest)
npm run check                                     # typecheck all JS workspaces
bash scripts/check.sh                             # + vite build + agent smoke + cargo check
bash scripts/check.sh --chain                     # also cargo test + build the Soroban crates
cargo test --manifest-path contracts/Cargo.toml   # polaris_guard (38 unit tests) + escrow (20 host tests)

make check | make check-chain | make check-contracts   # make wrappers for the same checks
make build-contracts                              # stellar contract build (wasm)
```

Long operations run under `caffeinate -i` per the project rules in [`AGENTS.md`](AGENTS.md).

## Documentation map

- [`docs/architecture.md`](docs/architecture.md) — scope, stack and security model; [`docs/interfaces.md`](docs/interfaces.md) — the owner-to-owner typed contract.
- [`contracts/DEPLOYED.md`](contracts/DEPLOYED.md) — deployments, demo identities, initialization, error-code table and known limitations.
- [`docs/wallet-track.md`](docs/wallet-track.md) — wallet, session and autonomy design; [`docs/notch-ui.md`](docs/notch-ui.md) — notch surfaces.
- [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) — approval and scheduling decisions; [`docs/confidential-payments.md`](docs/confidential-payments.md) — privacy designs.
- [`docs/anchor-sdf-flow.md`](docs/anchor-sdf-flow.md) — the verified SDF anchor flow; [`docs/demo-script.md`](docs/demo-script.md) — the live demo script.
- [`notes.md`](notes.md) — decision history; [`sprints.md`](sprints.md) — milestones; [`backlog.md`](backlog.md) + [`backlog/`](backlog/) — open work and worker reports; [`docs/reports/`](docs/reports/) — research archive.
