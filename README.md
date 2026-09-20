# Polaris

> **Under construction.** Working product name: **Polaris** — a push-to-talk voice
> assistant for Stellar (hackathon track: Genesis, 19–20 Sep 2026).
>
> This README is refreshed by a dedicated agent at the end of every milestone
> (see `AGENTS.md` §6). It describes the codebase as of **v0.1.0** on
> `main`: PR #38 (wallet, notch-only UI and autonomous payments) merged
> 2026-09-20 via PR #39 (squash commit `2157504`). Live runs need a human on a Mac.

Polaris is a voice-controlled Stellar assistant: hold a global hotkey, speak, and it
answers and can act on Stellar — pay, set spending rules by voice, schedule payments,
ramp through an anchor or trade P2P. Value-moving steps go through an explicit owner
gate (Touch ID) and are bounded by hard on-chain limits; the signer is an embedded
wallet whose seed lives in the macOS Keychain. **Testnet only**: no mainnet, no real
money; scope and non-goals are in `docs/architecture.md` §1.

| Where things stand | |
|---|---|
| Milestones | see `sprints.md` |
| Architecture & decisions | `docs/architecture.md`, `notes.md` |
| Owner-to-owner contract | `docs/interfaces.md` (= `interfaces/src/index.ts`) |
| Work handoff queue | `backlog.md` + `backlog/*.md` |
| Research archive | `docs/reports/` |
| Guard deployment & error codes | `contracts/DEPLOYED.md` |
| Version | `VERSION` + `CHANGELOG.md` (`0.1.0`) |

## Repository layout

```
interfaces/   @polaris/interfaces — the ONLY typed seam between owners (source-only pkg)
agent/        @polaris/agent      — agent loop, tool registry, event bus        (Owner A)
app/          @polaris/app        — Tauri v2 desktop shell: Rust core + React UI
  src/            React 19 + Vite 8 + Tailwind 4 — notch overlay and pages
  src-tauri/      Rust: notch/AppKit, Control+Option hold, mic→WAV, Touch ID, embedded wallet, typed event stream
stellar/      @polaris/stellar    — anchor client (SEP-1/10/12/38/6) + keeper      (Owner B)
contracts/    Soroban Cargo workspace: polaris_guard (spending rules + scheduler)  (Owner B)
scripts/      setup / check / dev / icon generation
docs/         architecture, interfaces, research reports
```

Ownership rules and the worktree/PR workflow are in `AGENTS.md` / `CLAUDE.md`.
Directory ownership is fixed by `docs/interfaces.md` §5: never edit the other owner's
layer without agreeing in PR review.

## What runs today

### `polaris_guard` — on-chain rules and schedules (testnet)

Deployed on Stellar testnet at
`CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`
([explorer](https://stellar.expert/explorer/testnet/contract/CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D)).

The contract is multi-tenant with no admin and no upgrade path: every function is keyed
by an owner address. It enforces per-owner rules (auto-approve, per-tx and daily limits,
allowed assets, known-recipients-only), keeps an owner-scoped alias book, and stores
per-owner schedules that anyone can trigger via the permissionless `execute_schedule`.

Inspect it on the explorer, or read-only from the CLI (a funded source account must be
configured in stellar-cli):

```bash
stellar contract invoke \
  --id CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D \
  --network testnet --source-account <FUNDED_IDENTITY> --send=no \
  -- next_schedule_id
```

`contracts/scripts/demo.sh` runs the full live demo (agent payment, `#105`
NeedsOwnerApproval rejection, owner re-send, schedule executed by an unrelated keeper);
it needs the demo identities and PGUSD balance described in `contracts/DEPLOYED.md`.
Earlier deployment IDs `CDIWQTYA…` and `CB5CQHV6…` are deprecated — do not use them.

### Keeper — triggers due schedules (off-chain)

`stellar/src/keeper` polls the guard's paginated `list_due` and submits
`execute_schedule` for due ids. It is untrusted by design: its key pays fees and cannot
move user funds or bypass a rule.

```bash
stellar keys generate keeper --network testnet --fund   # a few XLM is plenty
export KEEPER_SECRET=$(stellar keys show keeper)        # never commit this
export GUARD_CONTRACT_ID=C...                           # see contracts/DEPLOYED.md

npm run keeper       -w @polaris/stellar                # poll forever
npm run keeper:once  -w @polaris/stellar                # one tick, then exit
npm run keeper       -w @polaris/stellar -- --dry-run   # simulate only, submit nothing
```

Configuration is read from the environment (repo-root `.env` is loaded automatically):
`KEEPER_SECRET` and `GUARD_CONTRACT_ID` are required; `SOROBAN_RPC_URL`,
`NETWORK_PASSPHRASE`, `KEEPER_POLL_SECONDS`, `KEEPER_MAX_PER_TICK`, `KEEPER_DRY_RUN`,
`KEEPER_TX_TIMEOUT_SECONDS`, `KEEPER_MAX_FEE_STROOPS` and `KEEPER_LOG_LEVEL` have
defaults. Full behaviour (trust model, backoff classes, log lines) and the variable
table: `stellar/src/keeper/README.md`.

### Anchor client — SEP-6 on/off-ramp

The primary scenario is **Stellar's SDF test anchor `testanchor.stellar.org`** (SRT/USD
quotes, TEST-DATA KYC), verified live in both directions and documented in
`docs/anchor-sdf-flow.md`; a simulated **demo bank** automates bank → anchor → wallet →
anchor → bank. The TR mock anchor is secondary (deposit payouts stalled 2026-09-20).

`stellar/src/anchor` implements the programmatic SEPs — SEP-1 discovery, SEP-10 auth,
SEP-12 KYC, SEP-38 quotes, SEP-6 deposit/withdraw — with preflight and an `explain`
narration log. The home domain is the only anchor input; no keys are handled (signing is
injected through the `Signer` interface).

```ts
import { anchor } from "@polaris/stellar";

const session = new anchor.AnchorSession({ signer });   // Touch ID signer plugs in here
session.explain.subscribe((r) => speak(`${r.what} ${r.why}`));

const quote = await session.quoteDeposit("500");
await session.prepareAccount();                         // Friendbot + USDC trustline
const dep = await session.startDeposit("500");
const done = await session.waitForTransaction(dep.data.id);
```

Entry points:

```bash
npm test -w @polaris/stellar                    # unit tests (mocked HTTP, no network)
npm run anchor:e2e -w @polaris/stellar -- --amount-try 50 --withdraw-usdc 1
# live testnet run; POLARIS_TEST_SECRET=S... reuses one throwaway wallet
```

Details, verified live anchor behaviour, safety hardening and the mock-vs-mainnet table:
`stellar/src/anchor/README.md`.

### App and Diagnostics

The **click-through notch is the only surface**: there is no menu-bar tray, no "⋯" menu and
no popup windows. Every screen — History, Tasks, Rules, Wallet, Trade, Settings — is a page
inside the notch, and the approval card renders inline. The Settings page's Diagnostics runs
per-feature checks (`FeatureChecks`). See `docs/notch-ui.md`; the wallet, session and autonomy
design is `docs/wallet-track.md`.

**First run:** launch → the Wallet gate opens → **Create** (phrase shown once) or **Import**
→ **Friendbot** funds the account → add a **contact** (recipient) → hold **Control+Option**
and speak a payment; approve the card with Touch ID.

## Setup and checks

Requirements: macOS (Apple silicon), Node >= 22 (keeper requires >= 22.18), Rust stable,
`cargo-tauri` (`cargo install tauri-cli --version ^2`) or the local `@tauri-apps/cli`, and
**stellar-cli >= 25.2.0** (`brew install stellar-cli`) for contract builds — soroban-sdk v28
refuses a plain `cargo build --target wasm32v1-none`.

`make setup` creates `.env` from `.env.example`; fill the keys you need: `OPENCODE_API_KEY`
(LLM), `GROQ_API_KEY` (STT), `FISH_AUDIO_API_KEY` (TTS), `POLARIS_OWNER_ADDRESS` /
`POLARIS_ALIASES`, `GUARD_CONTRACT_ID` and `POLARIS_P2P_CONTRACT_ID`. The shell loads the
repo-root `.env`; a Finder-launched bundle falls back to
`~/Library/Application Support/Polaris/.env`. `make build` bundles the macOS app and
`make run` launches it from the repo root.

```bash
make setup                                        # npm install + .env from .env.example + icons
npm install                                       # JS workspaces only

npm test -w @polaris/stellar                      # keeper (node:test) + anchor (vitest)
npm run test:keeper -w @polaris/stellar           # keeper suite only
npm run test:anchor -w @polaris/stellar           # anchor suite only (vitest)
npm run check                                     # typecheck all JS workspaces
bash scripts/check.sh                             # + vite build + agent smoke + cargo check
bash scripts/check.sh --chain                     # also cargo test + build the Soroban crate
cargo test --manifest-path contracts/Cargo.toml   # polaris_guard unit tests
```

`make check`, `make check-chain` and `make check-contracts` wrap the same commands, and
long operations run under `caffeinate -i` per `AGENTS.md` §4. The desktop shell runs with
`make dev`; the agent smoke test with `npm run agent`; the contract wasm builds with
`make build-contracts`.

## Documentation map

- `docs/architecture.md` — scope, stack, security model; `docs/interfaces.md` — the
  owner-to-owner typed contract.
- `contracts/DEPLOYED.md` — deployment, demo identities, build steps, keeper notes and
  the contract error-code table.
- `backlog.md` + `backlog/` — open work and worker reports; `notes.md` — decision history.
- `docs/reports/` — research archive (`INDEX.md`).
- `VERSION` + `CHANGELOG.md` — SemVer with the pre-1.0 policy from `AGENTS.md` §9
  (coordinator cuts tags after merge; agents never tag).

### What is wired today (and what is not)

**Wired**
- **Notch voice pipeline**: hold Control+Option → STT → agent loop with short dialogue memory
  → spoken read-back; the typed `polaris-event` stream (`app/src-tauri/src/events.rs` →
  `app/src/lib/polaris.ts`) drives the UI (shape pinned by Rust tests and `interfaces/`).
- **Wallet (connect/unlock)**: create/import (BIP-39/SEP-5) or connect an existing wallet,
  seed in the macOS Keychain, unlock via Touch ID, `none`/`locked`/`unlocked` session with
  auto-lock, multi-account, Friendbot funding, contacts, assets/QR/network.
- **Approval + autonomous payments**: card built from the decoded XDR + Touch ID; rules by
  voice and fail-closed auto-pay via the executor key, bounded on-chain by `polaris_guard`.
- **Anchor deposit/withdraw (SEP-6)**: SDF test anchor + demo bank loop, preflighted before
  any value moves; Trade page (Deposit·Withdraw·P2P) in the notch.
- **P2P escrow**: `polaris_p2p_escrow` contract + client/panel (create/accept/confirm/cancel),
  trustline ("Add asset") flow for USDC/SRT.
- **History timeline**: local turn log + Horizon payments merged, filters/search/detail drawer.
- **Chain lane** (`@polaris/stellar`): payments, guard, schedules + keeper, SDF anchor + demo
  bank, P2P client, read-only SPP.

**Open:** value-moving SPP (needs wallet `signAuthEntry`), the Swap/Trade page and protocol
integration (Soroswap/DeFindex), screen reading (A4), developer mode, MPP, passkey wallet.
Live mic, Touch ID, real windows and the anchor payout leg need a human.

## Security & secrets

- **Testnet only.** No mainnet, no real money.
- **No secret keys in the app, webview or repo:** `.env` is gitignored (`.env.example` is the
  template); wallet seeds live in the macOS Keychain and are zeroized in Rust.
- **Fail-closed approvals:** the default approver is deny-all; `POLARIS_ALLOW_AUTO_APPROVE` is
  never enabled by the app.
- **On-chain bounds:** `polaris_guard` limits what an unattended executor key may spend; the
  SAC allowance is the user's kill switch.
- **Card from the XDR:** the approval card renders the decoded transaction, and Rust
  re-verifies the signed envelope before submission.
