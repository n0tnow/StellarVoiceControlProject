# polaris_guard — testnet deployment

Testnet only. No mainnet deployment exists and none is planned for this milestone.

## Current deployment

| | |
|---|---|
| Contract | `polaris_guard` |
| Network | Stellar **testnet** (`Test SDF Network ; September 2015`) |
| Contract ID | `CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY` |
| Deployer / demo owner | `GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E` (CLI identity `w1`) |
| Deploy tx | [`72746951…`](https://stellar.expert/explorer/testnet/tx/72746951ee191dae8ee8822ef3e2bd11d10132b857c6c9acde3e74466dd9386a) |
| Wasm | `contracts/target/wasm32v1-none/release/polaris_guard.wasm`, 22,367 bytes |
| Explorer | https://stellar.expert/explorer/testnet/contract/CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY |

Demo identities (all testnet, all created with `stellar keys generate --fund`; the
secrets live in the stellar-cli keystore and are never committed):

| Role | CLI identity | Address |
|---|---|---|
| Owner (the user) | `w1` | `GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E` |
| Executor (the agent) | `w1-exec` | `GB3HO3WGM273M2OZLE5DVRN5WNCNSART6H6SAHP4CXGK34MMGNNDYLX5` |
| Demo asset issuer / keeper | `w1-iss` | `GB7YX7MYCIGU6DRSBACQ4HJHQAVUP4K7BHT7NP5VP6IYVACDSEF3F2EE` |
| Payee | `w1-bob` | `GARXWVNCJ22U2OR23LAB5Z5RWI2XFIJZA2R3TRPFUKKY65JQZZOEWWCO` |

## Assets

### Demo asset `PGUSD` (used by `scripts/demo.sh`)

| | |
|---|---|
| Classic asset | `PGUSD:GB7YX7MYCIGU6DRSBACQ4HJHQAVUP4K7BHT7NP5VP6IYVACDSEF3F2EE` |
| SAC contract ID | `CC2V2R6JLMVGXQOXMZLATCNOVNS2QEOKSNZYO7DATCWJNJTUPCI5QX3E` |
| Decimals | 7 (same convention as USDC) |

A throwaway issuer, deliberately: the Circle testnet USDC faucet is gated behind a
web Captcha and cannot be scripted, so the on-chain demo would otherwise depend on
a manual step. `PGUSD` behaves identically for every code path the guard touches.

### Real testnet USDC (for the anchor path)

| | |
|---|---|
| Classic issuer | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5` |
| SAC contract ID | `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` |

Derived locally with

```bash
stellar contract id asset --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --network testnet
```

**This matches the `USDC_TESTNET_ADDRESS` constant published in the Stellar
`agentic-payments` skill exactly** — the derivation and the ecosystem constant agree,
so either source can be trusted for the anchor work. (The `G...` issuer and the
`C...` SAC are different things: the issuer goes into a `changeTrust`, the SAC is
what the guard's `allowed_assets` and `--asset` arguments take.)

## Build

```bash
cd contracts
caffeinate -i stellar contract build          # -> target/wasm32v1-none/release/polaris_guard.wasm
caffeinate -i cargo test                      # 27 unit tests
```

stellar-cli **>= 25.2.0** is required: since soroban-sdk v28 a plain
`cargo build --target wasm32v1-none` is refused on purpose.

## Deploying from scratch

```bash
# 1. Identities
for k in w1 w1-exec w1-iss w1-bob; do stellar keys generate "$k" --network testnet --fund; done

# 2. A demo asset: trustlines, then issue to the owner
ISS=$(stellar keys address w1-iss)
for a in w1 w1-bob; do
  stellar tx new change-trust --source-account "$a" --network testnet \
    --line "PGUSD:$ISS" --limit 9000000000000
done
stellar tx new payment --source-account w1-iss --network testnet \
  --destination "$(stellar keys address w1)" --asset "PGUSD:$ISS" --amount 100000000000

# 3. The asset's SAC (the contract the guard actually calls)
stellar contract asset deploy --asset "PGUSD:$ISS" --source-account w1 --network testnet

# 4. The guard
stellar contract deploy \
  --wasm target/wasm32v1-none/release/polaris_guard.wasm \
  --source-account w1 --network testnet --alias polaris_guard
```

Then record the two contract IDs in `contracts/scripts/demo.env`.

## Initialisation

The guard has **no `init` and no admin**. It is multi-tenant by construction: every
function is keyed by an `owner` address that must authorise its own calls, so a
single deployment serves every user and there is nothing to front-run at deploy
time. "Setting it up" means three owner-signed calls.

### Step 0 (off-contract, mandatory): the SEP-41 allowance

The guard never custodies funds. It settles with
`transfer_from(spender = <guard>, from = <owner>, to, amount)`, which only works if
the owner has approved the guard as a spender on the asset's SAC:

```bash
LEDGER=$(curl -sS -X POST https://soroban-testnet.stellar.org \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["sequence"])')

stellar contract invoke --id <ASSET_SAC> --network testnet --source-account w1 \
  -- approve \
     --from <OWNER_G...> \
     --spender <GUARD_C...> \
     --amount 10000000000 \
     --live_until_ledger $(( LEDGER + 30 * 17280 ))
```

Notes that cost time to discover:

* The parameter is **`live_until_ledger`**, not SEP-41's `expiration_ledger` — the
  soroban-sdk token interface renamed it and the SAC's CLI spec follows the SDK.
* `30 * 17280` ≈ 30 days at ~5s per ledger. The allowance entry lives in temporary
  storage whose TTL tracks this value; the protocol refuses anything beyond the
  network's maximum entry TTL (~180 days), so pick a renewal cadence rather than a
  maximal expiry.
* **This allowance is the real ceiling and the user's kill switch.** Re-running
  `approve` with `--amount 0` disables the guard instantly, without touching
  contract state and without needing the contract to cooperate. The rules bound
  what the *agent* may do; the allowance bounds what the *contract* can do at all.
* Re-approving overwrites rather than adds, and the classic allowance race applies
  (a spender can front-run a reduction). Approve to `0` first when lowering it.

### Steps 1–3 (owner-signed contract calls)

```bash
# 1. Publish the rule. i128 fields must be JSON *strings*.
stellar contract invoke --id <GUARD> --network testnet --source-account w1 \
  -- set_rule --owner <OWNER> --rule '{
       "auto_approve_limit":"100000000",
       "per_tx_limit":"500000000",
       "daily_limit":"2000000000",
       "allowed_assets":["<ASSET_SAC>"],
       "known_recipients_only":false}'

# 2. Register the agent's key.
stellar contract invoke --id <GUARD> --network testnet --source-account w1 \
  -- set_executor --owner <OWNER> --executor <EXECUTOR_G...>

# 3. Optional: the alias book (also the known-recipient allowlist).
stellar contract invoke --id <GUARD> --network testnet --source-account w1 \
  -- set_alias --owner <OWNER> --alias ada --address <G...>
```

## Contract error codes

The guard numbers its errors from **100** on purpose. A Soroban contract error
crosses the wire as a bare `u32` with no record of which contract raised it, and a
generated client decodes whatever arrives into the guard's own enum — so if the
guard started at 1, the SAC's `AllowanceError = 9` would surface as a confident,
wrong policy error. Anything below 100 that reaches the app came from the token or
the host, not from policy.

| Code | Name | Meaning for the app |
|---|---|---|
| 100 | `NotConfigured` | No rule published for this owner yet |
| 101 | `InvalidAmount` | Zero or negative amount |
| 102 | `InvalidRule` | Limits out of order, non-positive, or too many assets |
| 103 | `OverPerTxLimit` | Hard stop — the rule itself must change |
| 104 | `OverDailyLimit` | Hard stop until the UTC day rolls over |
| 105 | `NeedsOwnerApproval` | **Ask for Touch ID and retry via `pay_owner`** |
| 106 | `AssetNotAllowed` | Asset missing from `allowed_assets` |
| 107 | `NoExecutor` | No agent key registered |
| 108 | `NotExecutor` | Caller is not the registered agent key |
| 109 | `ScheduleNotFound` | |
| 110 | `ScheduleNotDue` | Keeper called too early |
| 111 | `ScheduleInactive` | Cancelled or exhausted |
| 112 | `InvalidSchedule` | `runs == 0`, or a one-shot asking for many runs |
| 113 | `NotScheduleOwner` | |
| 114 | `TooManySchedules` | 25 active per owner, 200 globally |
| 115 | `Overflow` | Checked arithmetic refused |
| 116 | `InsufficientAllowance` | The owner revoked or under-funded the SAC allowance |

The CLI prints these as `Error(Contract, #105)` — it does **not** resolve the name
from the deployed spec, so keep this table next to whatever reads the errors.

## Demo

```bash
contracts/scripts/demo.sh        # reads contracts/scripts/demo.env
```

It approves the allowance, publishes the rule, registers the executor, settles a
small agent payment, gets the larger one **rejected on-chain with `#105`
NeedsOwnerApproval**, re-sends it as the owner, then creates a one-shot schedule,
shows the early call rejected with `#110 ScheduleNotDue`, and has an unrelated
keeper account execute it once it comes due.

Verified run (2026-09-19): payee ended at `38.0000000 PGUSD`, owner
`spent_today` at `380000000` raw units.
