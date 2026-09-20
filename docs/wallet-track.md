# Wallet track

> How Polaris holds, gates and uses a wallet. Testnet only; no mainnet path exists.
> This is the design record for the decisions W10–W13 made. Code lives in
> `app/src-tauri/src/wallet/`, `app/src/lib/wallet.ts` and the notch Wallet page.

## 1. The embedded wallet (decision, 2026-09-20)

The signer is a **wallet inside the app**. A Freighter bridge was built and
reviewed first (a one-shot loopback Rust server plus a browser page signing
through the extension), but it needed three approval surfaces — approval card +
Touch ID, a browser tab, and the Freighter popup — plus a browser with the
extension installed. The owner rejected that as the main flow: *“approve once,
the wallet signs, no web page.”* Task W12 then **removed the bridge entirely**
(server, page, Wallets Kit dependency, the `bridge_*` commands) in favour of the
embedded wallet, keeping only the reusable XDR verification helpers
(`bridge/verify.rs`, `bridge/strkey.rs`). The bridge is history, not a fallback.

* **Create** generates a BIP-39 24-word phrase (OS entropy) and derives the
  Ed25519 seed via SEP-5 `m/44'/148'/0'` (SLIP-0010), so the same phrase can be
  restored in any Stellar wallet. The phrase is shown **once**; only the seed is
  stored.
* **Import** accepts an `S…` Stellar secret or a 12/24-word phrase (optional
  account index). The derived address is shown before storing; the secret never
  reaches the agent, logs, URL or localStorage, and Rust zeroizes its buffers.
* Multi-account: each seed lives in its own macOS login-Keychain item (service
  `dev.polaris.wallet`, account `signer-<address>`) — the only store by default.
  Metadata (label, address, created, active, `store`) is non-secret JSON in
  `~/Library/Application Support/Polaris/wallets.json`.
* If the Keychain is unavailable the service refuses create/import/sign with an
  actionable `keychain` error and reports `store: "keychain unavailable"`; only
  with `POLARIS_WALLET_ALLOW_FILE_STORE=1` does it use a `0600` file store and
  report `store: "file (testnet only, plaintext)"`. That flag is never a default.
* There is **one signer**: the embedded wallet. `POLARIS_SIGNER` no longer
  selects a path.

First-run UX (W14): the Wallet page leads with **"Connect existing wallet"** —
the secret-key mode by default, with "Create new wallet" as the secondary
action — so connecting a Freighter/Lobstr/xBull account reads as the primary
path. Import stays Touch-ID gated and, like create, leaves the session unlocked,
so the user lands on the dashboard with the connected account instead of the
Connect screen.

Data-protection / biometric Keychain ACLs need entitlements an ad-hoc dev build
lacks, so the item is a plain generic password. The first time a rebuild reads an
item a previous build created, macOS shows its standard “Always Allow / Deny”
prompt; denying it makes the probe fail, so the wallet stays locked unless the
opt-in file flag is set.

## 2. Session model (W13a)

`wallet/session.rs` enforces a `none → locked → unlocked` state machine in Rust:

* **`none`** — no wallet configured. **`locked`** — a wallet exists but secrets
  are sealed. **`unlocked`** — signing allowed until lock/auto-lock/quit.
* Commands: `wallet_session`, `wallet_unlock`, `wallet_lock`,
  `wallet_set_auto_lock`. Idle auto-lock runs on an injected clock (tests never
  sleep); a restart is **always** locked. Create/import leave the session
  unlocked.
* Locked is fail-closed: secret-touching paths (`wallet_sign`, `remove`, the
  approval path) refuse with `not_authorized`/`"locked"`, `stellar_config`
  withholds `ownerAddress`, and **the previous session's approval is invalidated
  on lock**. Every change emits `wallet_session_changed` on `polaris-event`.

## 3. Command contract

`wallet_status`, `wallet_list`, `wallet_create`, `wallet_import_preview`,
`wallet_import`, `wallet_select`, `wallet_rename`, `wallet_remove`,
`wallet_sign`, `wallet_sign_challenge`, `wallet_health`; session commands in §2.
Create/import/remove are Touch-ID gated; `wallet_sign` consumes the approval
gate's one-time id; `wallet_changed` fires whenever the active wallet changes.
Failures are typed `{ kind, message }` (`exists`, `invalid`, `notFound`,
`cancelled`, `keychain`, `file`, `unauthorized`, `locked`).

The webview client is `app/src/lib/wallet.ts`; the Debug check is
`app/src/debug/checks/wallet.ts`. The wallet UI is the notch Wallet page
(Connect / Unlock / Dashboard), with a `LegacyWalletView` fallback.

## 4. Autonomy design (W11a/W11b)

Autonomous payments are bounded **on-chain** by `polaris_guard`, never by trust
in the agent:

* The owner registers an **executor key** on `polaris_guard` (`set_executor`)
  and publishes `auto_approve_limit` (`set_rule`). Enabling auto-pay is several
  transactions, so **one Touch ID authorises a batch** (`approval_begin_batch` /
  `approval_authorize_batch`), not one prompt per step. The safe order is
  `approve → set_rule → set_executor` (executor last = arming).
* `executor_sign_pay` is the **only** unprompted signer. It decodes the
  transaction itself and signs exactly one shape: an unlocked session, a v1
  envelope, the registered executor as source, one `invoke-contract` of
  `GUARD_CONTRACT_ID` calling `pay_executor`, args matching the active owner,
  amount > 0 and ≤ `POLARIS_AUTOPAY_HARD_CAP` (default 100 XLM, independent of
  the rule). Anything else is refused.
* A payment **within** the rule (`pay_executor`) settles with no card. A payment
  **above** `auto_approve_limit` fails on-chain with `#105 NeedsOwnerApproval`
  and falls back to the normal approval card + Touch ID (`pay_owner`).
* Verified live on testnet: `npm run e2e:autopay` (unattended 1 XLM SUCCESS,
  15 XLM `#105`). Error mapping `#103–#107`/`#116` is in `app/src/lib/autopay.ts`.

## 5. Anchor decision

The primary local-payment scenario is **Stellar's SDF test anchor
`testanchor.stellar.org`** (SEP-1/10/12/38/6; SRT/USD quotes; clearly-fake
TEST-DATA KYC), verified live in both directions and documented in
`docs/anchor-sdf-flow.md`. A simulated **demo bank** (`bank.rs` + `bankFlow.ts`)
automates bank → anchor → wallet → anchor → bank for the panel and voice. The
**TR mock anchor is secondary** — its deposit payouts stalled 2026-09-20. SEP-10
challenges are signed wallet-only (`wallet_sign_challenge`, sequence 0); all
value-moving anchor steps go through the approval/Touch ID pipeline.
