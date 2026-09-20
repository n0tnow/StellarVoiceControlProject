# Polaris — Pitch

> A push-to-talk voice assistant that lives in the MacBook notch and **can act on
> Stellar**: hold **Control+Option**, speak Turkish or English, and it answers — or
> builds a real testnet payment for you to approve. Genesis track, testnet only.
> Status source: `README.md`, `docs/architecture.md`, `contracts/DEPLOYED.md`.

## Problem
Moving stablecoins still means a browser wallet, a 56-character address and a trust
gap. Voice is the natural interface for "send 10 to Ahmet", but letting an LLM move
money unattended is unacceptable. Users need **voice speed with human control**.

## Solution
Polaris turns a spoken sentence into a decoded, unsigned transaction; the user
approves it with **Touch ID** and signs it with the **wallet inside the app**. It also
schedules payments, runs guarded auto-pay under limits, ramps TRY↔USDC through an
anchor, and trades P2P via a Soroban escrow.

## Why Stellar
- **Local payments:** SEP-1/10/12/38/6 anchor flow — TRY in, USDC out (`stellar/src/anchor`).
- **Enforceable safety:** `polaris_guard`, our Soroban contract: per-tx/daily limits, allowed assets, alias book, owner-keyed, **non-upgradeable**.
- **Unattended runs:** on-chain schedules triggered by an untrusted off-chain keeper (`stellar/src/keeper`) — the chain has no timers.
- **P2P:** a Soroban escrow (`polaris_p2p_escrow`) for TRY↔USDC peer trades.
- **Privacy:** Confidential Tokens / SPP evaluated, surfaced read-only (`docs/confidential-payments.md`).
- **Developer story:** a typed TS seam (`@polaris/interfaces`) lets two owners build in parallel and integrate without a rewrite.

## Architecture (6 bullets)
- **Tauri v2** shell: thin, trusted **Rust core** (hotkey, mic, Touch ID, signing) + React/TypeScript webview (agent loop, Stellar SDK, panels).
- **Voice:** hold-to-talk → STT (Groq multilingual, on-device opt-in) → agent loop → spoken read-back (Fish Audio + macOS `say` fallback), with a notch overlay.
- **Agent:** a swappable `AgentLlm` port (OpenAI-compatible + Anthropic); the key stays in Rust, never in the webview.
- **Chain lane:** `@polaris/stellar` (payments, guard, schedules, anchor, keeper, P2P); each tool returns an **unsigned XDR + decoded summary**.
- **Signing:** Rust Touch ID gate → **embedded wallet** in the app (seed in the macOS Keychain); no browser and no extension.
- **UI:** click-through notch overlay + tray panels (Wallet, Security, Schedules, Suggestions, Anchor, P2P, Privacy, Settings, Debug).

## Security model (5 bullets)
- **Touch ID + embedded wallet:** the user's biometric authorizes, the in-app wallet signs; the seed stays in the Keychain and never reaches the agent or webview.
- **Fail-closed:** a deny-all approver by default; `POLARIS_ALLOW_AUTO_APPROVE` is opt-in and unusable in the app.
- **On-chain limits:** a compromised agent is bounded by `polaris_guard`; the SAC allowance is the user's kill switch.
- **Card from the XDR:** the card renders the decoded transaction, not the model's text; Rust re-verifies the signed envelope.
- **Independent reviews:** every milestone is a branch + PR + separate reviewer (`backlog/`), with conformance tests.

## Live vs designed
- **Verified on testnet:** `polaris_guard`, the keeper, the anchor client, 12/12 chain-lane scenarios (`backlog/e2e-testnet.md`).
- **Wired in `integration/wallet`:** voice pipeline, panels/tray, approval card, Touch ID gate, embedded wallet, guard limits, schedules, P2P client, SPP read-only.
- **Needs a human/deployment:** live mic + Touch ID round trip, the P2P contract, the anchor payout (anchor-side), value-moving SPP.
- **Designed, not shipped:** Soroswap/DeFindex, MPP, passkey wallet, developer mode.

## Roadmap
Protocol integration and MPP; value-moving SPP once the wallet can sign auth entries;
deploy the P2P escrow; `polaris_guard_v2` hardening (per-asset budgets,
auto-deactivation); passkey wallets. **Mainnet stays out of scope until the model is audited.**
