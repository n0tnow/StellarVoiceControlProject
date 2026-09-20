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
remembers the conversation, sets spending rules by voice, runs guarded auto-pay under
limits, ramps dollars through the SDF test anchor, and trades P2P via a Soroban escrow.

## Why Stellar
- **Safety that runs on-chain:** `polaris_guard`, our Soroban contract: per-tx/daily limits, allowed assets, alias book, executor key, non-upgradeable (`contracts/DEPLOYED.md`).
- **Local payments:** SEP-1/10/12/38/6 against Stellar's SDF test anchor, verified live both directions (`docs/anchor-sdf-flow.md`).
- **Unattended runs:** a registered executor key signs only `pay_executor`; schedules are triggered by an untrusted off-chain keeper (`stellar/src/keeper`).
- **P2P:** a deployed Soroban escrow (`polaris_p2p_escrow`) for USD↔TRY peer trades — with **no arbiter**, stated plainly.
- **Privacy:** Confidential Tokens / SPP evaluated, surfaced read-only (`docs/confidential-payments.md`).
- **Developer story:** a typed TS seam (`@polaris/interfaces`) let two owners build in parallel and integrate without a rewrite.

## Architecture
- **Tauri v2** shell: thin, trusted **Rust core** (notch, hotkey, mic, Touch ID, Keychain, signing) + React/TypeScript webview (agent loop, Stellar SDK, panels).
- **Voice:** hold-to-talk → STT (Groq multilingual; on-device opt-in) → agent loop with short dialogue memory → spoken read-back (Fish Audio + macOS `say` fallback).
- **Agent:** a swappable `AgentLlm` port (OpenAI-compatible via OpenCode + Anthropic); the key stays in Rust, never in the webview.
- **Chain lane:** `@polaris/stellar` (payments, guard, schedules, anchor, keeper, P2P); each tool returns an **unsigned XDR + decoded summary**.
- **Signing:** Rust Touch ID gate → **embedded wallet** (BIP-39/SEP-5 seed in the macOS Keychain, Rust session lock); no browser, no extension.
- **UI:** the click-through notch is the only surface (no tray); the "⋯" menu opens Wallet, Security, Schedules, Suggestions, Anchor, P2P, Privacy, Settings, Debug.

## Security model (5 bullets)
- **Touch ID + embedded wallet:** the user's biometric authorizes, the in-app wallet signs; the seed stays in the Keychain and never reaches the agent or webview.
- **Fail-closed:** a deny-all approver by default; `POLARIS_ALLOW_AUTO_APPROVE` is opt-in and unusable inside the shell.
- **On-chain limits:** a compromised agent is bounded by `polaris_guard`; the SAC allowance is the user's kill switch.
- **Card from the XDR:** the card renders the decoded transaction, not the model's text; Rust re-verifies the signed envelope before submission.
- **Independent reviews:** every milestone is a branch + PR + separate reviewer; reports are archived under `docs/reviews/` and `backlog/`.

## Live vs designed
- **Verified on testnet:** `polaris_guard`, the keeper, the anchor client, the P2P escrow contract + demo, and the autonomous-pay loop (`e2e:autopay`).
- **Built in `integration/wallet-login`:** voice pipeline + dialogue, notch pages/panels, approval card, Touch ID gate, embedded wallet + session, guard limits, schedules, bank↔anchor panel, P2P client, SPP read-only, pro History.
- **Needs a human:** live mic + Touch ID round trip, real notch windows, the anchor payout leg.
- **Designed, not shipped:** Soroswap/DeFindex integration, Trade page, MPP, passkey wallet, value-moving SPP, screen reading, developer mode.

## Roadmap
Protocol integration and MPP; value-moving SPP once the wallet can sign auth entries;
`polaris_guard_v2` hardening. **Mainnet stays out of scope until the model is audited.**
