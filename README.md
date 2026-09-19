# Polaris

> **Under construction.** Working product name: **Polaris** — a push-to-talk voice
> assistant for Stellar (hackathon track: Genesis, 19–20 Sep 2026).
>
> This README is refreshed by a dedicated agent at the end of every milestone
> (see `AGENTS.md` §6). It describes the codebase as of **v0.1.0**: the chain layer
> (guard contract, keeper, anchor client) is real and tested on testnet; the voice
> pipeline in `app/` is not wired yet.

Polaris is a voice-controlled Stellar assistant: hold a global hotkey, speak, and it
answers and can act on Stellar — pay, schedule payments, move between TRY and USDC
through an anchor. Value-moving steps are designed around an explicit owner approval
gate (Touch ID) and hard on-chain limits. **Testnet only**: no mainnet, no real money,
no custom anchor; scope and non-goals are defined in `docs/architecture.md` §1.

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
agent/        @polaris/agent      — agent loop, tool registry, event bus (skeleton)
app/          @polaris/app        — Tauri v2 desktop shell: Rust core + React UI (skeleton)
  src/            React 19 + Vite 8 + Tailwind 4 panel, event log pane
  src-tauri/      Rust: window, typed event stream, (later) hotkey/audio/Touch ID
stellar/      @polaris/stellar    — anchor client (SEP-1/10/12/38/6) + keeper
contracts/    Soroban Cargo workspace: polaris_guard (spending rules + scheduler)
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

### App and agent (skeleton)

The desktop shell already carries the typed `polaris-event` stream from Rust
(`app/src-tauri/src/events.rs`) to the React log pane, and `agent/` runs a mock loop with
a `noop` tool. Not wired yet: hotkey + microphone capture, speech-to-text, the real
Anthropic tool-use model, speech output, screen reading, and the Touch ID approval gate;
`sendPayment`, `swap` and `guardPolicy` in `stellar/src/index.ts` still throw
`NotImplementedError`. Step order is tracked in `sprints.md`.

## Setup and checks

Requirements: macOS (Apple silicon), Node >= 22 (keeper requires >= 22.18), Rust stable,
`cargo-tauri` (`cargo install tauri-cli --version ^2`) or the local `@tauri-apps/cli`, and
**stellar-cli >= 25.2.0** (`brew install stellar-cli`) for contract builds — soroban-sdk v28
refuses a plain `cargo build --target wasm32v1-none`.

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

## Security & secrets

- Testnet only. No mainnet, no real money.
- Keys never enter the repository: `.env` is gitignored (`.env.example` is the template),
  signing keys live in the macOS Keychain / stellar-cli keystore, and no value-moving step
  is meant to execute without an explicit Touch ID approval once that path is wired (A5).
