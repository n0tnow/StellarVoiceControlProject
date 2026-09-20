# Wallet track

> How Polaris holds and uses a wallet. Testnet only; no mainnet path exists.

## 1.1 Signer decision (step W10, 2026-09-20)

The default signer is a **wallet inside the app**. The earlier Freighter bridge
needed three approval surfaces (approval card + Touch ID, a browser tab, and the
Freighter popup) plus a browser with the extension installed. The owner rejected
that as the main flow: *“approve once, the wallet signs, no web page.”*

* **Create** generates a BIP-39 24-word phrase (OS entropy) and derives the
  Ed25519 seed via SEP-5 `m/44'/148'/0'` (SLIP-0010), so the same phrase works in
  Freighter/Lobstr. The phrase is shown **once**; only the seed is stored.
* **Import** accepts an `S…` Stellar secret or a 12/24-word phrase (optional
  account index). The derived address is shown before storing; the secret never
  reaches the agent, logs, URL or localStorage, and Rust zeroizes its buffers.
* Each seed lives in its own macOS login-Keychain item (service
  `dev.polaris.wallet`, account `signer-<address>`). Metadata (label, address,
  created, active) is non-secret JSON in
  `~/Library/Application Support/Polaris/wallets.json`. If the Keychain is
  unavailable the service falls back to a `0600` file store and reports
  `store: "file (testnet only)"` in status/Debug.
* `POLARIS_SIGNER` defaults to `embedded`; `POLARIS_SIGNER=freighter` keeps the
  browser bridge as an advanced, documented option.

Data-protection / biometric Keychain ACLs need entitlements an ad-hoc dev build
lacks, so the item is a plain generic password. The first time a rebuild reads an
item a previous build created, macOS shows its standard “Always Allow / Deny”
prompt; denying it makes the probe fail and the file fallback take over.

## 1.2 Command contract

`wallet_status`, `wallet_list`, `wallet_create`, `wallet_import_preview`,
`wallet_import`, `wallet_select`, `wallet_rename`, `wallet_remove`,
`wallet_sign`, `wallet_sign_challenge`, `wallet_health`. Create/import/remove are
Touch-ID gated; `wallet_sign` consumes the approval gate's one-time id; a
`wallet_changed` event fires whenever the active wallet changes. Failures are
typed `{ kind, message }` (`exists`, `invalid`, `notFound`, `cancelled`,
`keychain`, `unauthorized`).

The webview client is `app/src/lib/wallet.ts`; the Debug check is
`app/src/debug/checks/wallet.ts`. The wallet UI lives in the notch UI track.
