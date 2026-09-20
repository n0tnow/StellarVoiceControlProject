# Wallet track

> How Polaris holds and uses a wallet. Testnet only; no mainnet path exists.

## 1.1 Signer decision (steps W4b/W10, 2026-09-20)

The signer is a **wallet inside the app**. A Freighter bridge was built and
reviewed first (a one-shot loopback Rust server plus a browser page signing
through the extension), but it needed three approval surfaces — approval card +
Touch ID, a browser tab, and the Freighter popup — plus a browser with the
extension installed. The owner rejected that as the main flow: *“approve once,
the wallet signs, no web page.”* Task W12 then **removed the bridge entirely**
(server, page, Wallets Kit dependency, the `bridge_*` commands) in favour of the
embedded wallet, keeping the reusable XDR verification helpers
(`bridge/verify.rs`, `bridge/strkey.rs`).

* **Create** generates a BIP-39 24-word phrase (OS entropy) and derives the
  Ed25519 seed via SEP-5 `m/44'/148'/0'` (SLIP-0010), so the same phrase can be
  restored in any Stellar wallet. The phrase is shown **once**; only the seed is
  stored.
* **Import** accepts an `S…` Stellar secret or a 12/24-word phrase (optional
  account index). The derived address is shown before storing; the secret never
  reaches the agent, logs, URL or localStorage, and Rust zeroizes its buffers.
* Each seed lives in its own macOS login-Keychain item (service
  `dev.polaris.wallet`, account `signer-<address>`) — the only store by default.
  Metadata (label, address, created, active, `store`) is non-secret JSON in
  `~/Library/Application Support/Polaris/wallets.json`. If the Keychain is
  unavailable the service refuses create/import/sign with an actionable
  `keychain` error and reports `store: "keychain unavailable"`; only with
  `POLARIS_WALLET_ALLOW_FILE_STORE=1` does it use a `0600` file store and report
  `store: "file (testnet only, plaintext)"`.
* The embedded wallet is the **only** signer; `POLARIS_SIGNER` no longer selects a
  path.

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

## 1.2 Command contract

`wallet_status`, `wallet_list`, `wallet_create`, `wallet_import_preview`,
`wallet_import`, `wallet_select`, `wallet_rename`, `wallet_remove`,
`wallet_sign`, `wallet_sign_challenge`, `wallet_health`. Create/import/remove are
Touch-ID gated; `wallet_sign` consumes the approval gate's one-time id; a
`wallet_changed` event fires whenever the active wallet changes. Failures are
typed `{ kind, message }` (`exists`, `invalid`, `notFound`, `cancelled`,
`keychain`, `file`, `unauthorized`).

The webview client is `app/src/lib/wallet.ts`; the Debug check is
`app/src/debug/checks/wallet.ts`. The wallet UI lives in the notch UI track.
