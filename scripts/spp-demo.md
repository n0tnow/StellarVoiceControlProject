# SPP demo (scripted, outside the app)

Stellar Private Payments (SPP) is an **unaudited testnet developer preview**. The
full loop (`register → deposit → private transfer → withdraw`) is proven with
Nethermind's deployed testnet contracts, but the client is the upstream **Rust
SDK** (`sdk/native`), not the desktop app. This script reproduces the loop with a
**throwaway identity, outside the repo**; Polaris never holds a secret key.

Pinned upstream: commit `10ffa0ecd268582f6ef80e53ac5129a33ecf5846`
(circuit bundle `circuits-v0.4`, 107,284,836 B, fetched once by the SDK).

## Prerequisites

- Rust stable and network access to `soroban-testnet.stellar.org`,
  `friendbot.stellar.org`, crates.io, and the Nethermind GitHub release host.
- Throwaway keys only. Keep them under `~/.polaris-spike-spp/keys.json`
  (`chmod 700` dir / `600` file), with `A_depositor`, `B_recipient`,
  `C_withdrawal`, each `{ "public": "G…", "secret": "S…" }`.

## Reproduce (throwaway identity)

The spike harness that performs the whole loop lives on the spike branch:

```bash
git show spike/spp:stellar/src/spike/spp/harness/run-spp-spike.sh > /tmp/run-spp-spike.sh
git show spike/spp:stellar/src/spike/spp/harness/spp_onboard.rs     > /tmp/spp_onboard.rs
```

It (a) clones `NethermindEth/stellar-private-payments` at the pinned commit into
`~/.polaris-spikes/spp/repo`, (b) copies `spp_onboard.rs` in as an example,
(c) friendbot-funds A/B/C, then (d) runs register → deposit → transfer →
withdraw through the SDK examples. Run it with `bash /tmp/run-spp-spike.sh`; expect
~10–12 s and ~110 MiB per private operation.

## What to look for

- The private transfer carries **no recipient address and no plaintext amount** —
  only the pool, nullifiers, commitments and 120-byte ciphertexts.
- Deposit/withdraw amounts and edge addresses **are public**; privacy comes from
  the pool's anonymity set, never from being "untraceable".

## In-app evidence

The Privacy panel (`app/src/panels/PrivacyPanel.tsx`) is read-only and shows the
five spike transaction hashes as `stellar.expert` testnet links. Reproduce them
independently with `getTransaction` on `soroban-testnet.stellar.org`.

## Why not in the app yet

Every `transact` needs a Soroban **auth-entry signature** in addition to the
envelope signature (`signAuthEntry` + `signTransaction`). Polaris'
wallet currently signs only an envelope, so the value-moving forms are disabled
until that signing extension lands.
