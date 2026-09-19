# polaris_guard — testnet deployment

Testnet only. No mainnet deployment exists and none is planned for this milestone.

## Current deployment

| | |
|---|---|
| Contract | `polaris_guard` |
| Network | Stellar **testnet** (`Test SDF Network ; September 2015`) |
| Contract ID | `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D` |
| Deploy tx | `f6017b43cef06047b6c3bc04e2f88a2e9fb0b3ee3b3aa5a0261a0c43dfacaf59` (create-contract tx; wasm upload tx `002d438ea8a684b8cdbfa86e840ba0cd4dd2e52fc5948018d13cc99cf2836e60`) |
| Deployer / demo owner | `GCLBGU2PR36SFHKPSI5WPHD3ZNPZRIXJYQGUVIR6PR4R6R6U3XNNG46E` (CLI identity `w1`) |
| Wasm | `contracts/target/wasm32v1-none/release/polaris_guard.wasm`, 23,787 bytes |
| Wasm sha256 | `c4f65e6542bb5d7e512d4417c1b71b20d7210ca7e665992b4e3cc27f04be98e6` — re-derived from `stellar contract fetch` of the deployed code, so artifact and chain agree |
| Explorer | https://stellar.expert/explorer/testnet/contract/CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D |

### Superseded deployments

| Contract ID | Status | Deploy tx | Wasm sha256 | Why |
|---|---|---|---|---|
| `CDIWQTYA7OBF2FKLLHQWYZ2Q2L4PAEBLLMFRXVY4R7MAM45LX7Q2R2XB` | **DEPRECATED — do not use** | `6602c070cd369dfc694b724e794ce38943266a4f158888fd136ce98e33ceea8f` | `7198230218d1c5af574f1f5cdd7f7bd12d8329dabf4d9c155e0d0993d8b7cce4` | `set_alias` re-pointing left the **previous** destination marked as a known recipient, so with `known_recipients_only` on, moving an alias to a new wallet left the old wallet agent-payable without owner approval. A running schedule also never extended the TTLs of `OwnerScheds` and `NextSchedId`. Same ABI as the current deployment. |
| `CB5CQHV6OK6AF5ANTE7YHJ6UPG5QAIPHB6UVLRLDKNQ22VEQOHU22RYY` | **DEPRECATED — do not use** | `72746951ee191dae8ee8822ef3e2bd11d10132b857c6c9acde3e74466dd9386a` | `fae6d7619cec9a7bf363b3cde4de656dc0d21b4b8e24ac309f393425c2f51e29` | Carried a global cap of 200 active schedules backed by one shared `ActiveScheds` list. A handful of funded accounts could fill it with far-future schedules only they could cancel, permanently blocking `create_schedule` for everyone else; with no admin and no upgrade path the only remedy was a redeploy. Its `list_due(limit)` ABI is also gone. |

Because the guard has no upgrade entrypoint, a fix means a new contract ID and every
owner re-publishing their rule and allowance against it. That is the cost this
milestone accepts in exchange for having nothing upgradeable to attack; it is also
the reason to get the storage layout right before anyone depends on it.

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
caffeinate -i stellar contract build              # -> target/wasm32v1-none/release/polaris_guard.wasm
caffeinate -i cargo test -p polaris_guard         # 38 unit tests
caffeinate -i cargo clippy --all-targets          # must stay warning-free
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
#    `allowed_assets` currently accepts at most ONE asset — see below.
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

## What the rule actually promises — read before writing app copy

Three things about the rule are easy to state wrongly to a user, and two of them
place a hard requirement on the client.

### 1. `daily_limit` is the agent's real mandate, not `auto_approve_limit`

`auto_approve_limit` is a **per-transaction** ceiling. Nothing in the contract caps
how *many* payments the agent makes. With the demo rule (auto-approve 10, daily
200), a compromised or misbehaving executor key can settle **twenty** payments of 10
to an address of its choosing, every day, indefinitely — each one individually
inside the mandate.

So a user told *"auto-approve under 10 USDC"* will not infer *"the agent can move
200 a day unattended"*, but that is the truth. **App copy must present `daily_limit`
as the agent's real spending mandate**; `auto_approve_limit` is only "how big a
single unattended payment may be". `known_recipients_only` is the only brake on
*where* the money goes, and it is off by default — recommend turning it on.

A per-day transaction-count cap is a sensible follow-up and is tracked in the
backlog.

### 2. Never forward an agent-supplied `asset` into `pay_owner`

`pay_owner` deliberately does **not** check `asset` against `allowed_assets`, so the
owner can never be locked out of their own guard by a misconfigured list. The
consequence is that `pay_owner` will call whatever contract address it is handed.

A contract that merely mimics SEP-41 can return `i128::MAX` from `allowance`, do
nothing at all in `transfer_from`, and the guard will still record the spend and
publish a `Paid` event. **`Paid` and `spent_today` are therefore evidence that the
guard authorised a payment, not that value moved.** Confirm real movement by reading
the token's own `transfer` event or the recipient's balance.

The exposure is bounded — the owner signs the call, and they hold no allowance on a
token they never approved — but in this product the *agent* proposes the parameters
and the user approves with Touch ID, so a compromised agent chooses the asset
address. **Required of the client: resolve `asset` from the owner's own allowlist
locally and never pass through an agent-supplied address.** The approval card must
render the asset it is actually about to sign, taken from the transaction XDR.

### 3. One asset per rule, for now

`set_rule` rejects `allowed_assets.len() > 1` with `InvalidRule` (#102). The daily
budget is a single cross-asset counter, and raw units are not comparable across
decimals: a 2-decimal token beside 7-decimal USDC would make `daily_limit`
meaningless, since 200 raw units of the former would consume the same budget as
0.00002 USDC. The limit lifts when a per-asset `Spent(owner, asset)` counter lands.

## Keeper notes — scanning for due schedules

There is **no global index of schedules**, deliberately: the earlier revision had one
and it was a cross-tenant DoS (see *Superseded deployments*). Discovery is a
paginated scan over the id space instead.

```
cursor = 0
loop {
    (ids, cursor) = list_due(cursor, 100)     // scans <= 100 ids per call
    for id in ids { execute_schedule(id) }
    if cursor == 0 { break }                  // one full sweep done
}
```

* `list_due(cursor, limit)` bounds the **scan**, not the result: it examines at most
  `limit` ids (clamped to 100, comfortably under the ~200 ledger-entry read ceiling)
  starting at `cursor`, and returns `(due_ids, next_cursor)`. `next_cursor == 0`
  means the sweep reached the end of the id space.
* `next_schedule_id()` reports the upper bound of that space.
* Ids are never reused. Cancelled and exhausted schedules leave **holes** that the
  scan skips, so a full sweep costs `ceil(next_schedule_id / limit)` read-only
  simulations — proportional to schedules *ever created*, not currently active.
  Someone creating throwaway schedules raises the keeper's polling cost; they cannot
  block anyone from scheduling, which is the tradeoff this layout chooses. A keeper
  that cares can remember the lowest still-active id and start its cursor there.
* `execute_schedule` needs no authorization and no registration — any funded account
  can call it. Treat `#110 ScheduleNotDue` and `#111 ScheduleInactive` as benign
  races (another keeper won), and `#104 OverDailyLimit` as "retry after UTC
  midnight".
* **TTL hygiene.** Protocol 23 auto-restores archived persistent entries, so an
  expiring entry is a restore bill rather than lost data. A schedule run extends
  the TTLs of the `Schedule` entry, its owner's `OwnerScheds` index and the shared
  `NextSchedId` counter, so the untrusted keeper never has to pay to restore the
  entries its own `list_due`/`get_schedule` path depends on. The cost of extending
  the shared counter on the run path is that two runs landing in the same ledger
  contend on that one entry — accepted deliberately (a bounded rent bump, not a
  lock held across the transfer).

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
| 102 | `InvalidRule` | Limits out of order or non-positive, or more than one allowed asset |
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
| 114 | `TooManySchedules` | 25 active schedules per owner. Per-owner only — no global cap |
| 115 | `Overflow` | Checked arithmetic refused |
| 116 | `InsufficientAllowance` | The owner revoked or under-funded the SAC allowance |

The CLI prints these as `Error(Contract, #105)` — it does **not** resolve the name
from the deployed spec, so keep this table next to whatever reads the errors.

## Known limitations (v0.1)

Findings from `backlog/contracts-audit.md` (audit) and `backlog/contracts-audit-review.md` (independent
review). No Critical or High findings; these are product/liveness and documentation-level caveats. The
batched v0.2 fix plan is in [`backlog/guard-v0.2-hardening.md`](../backlog/guard-v0.2-hardening.md).

**Contract evolution (D9, 2026-09-19):** `polaris_guard` v0.1 is **frozen** and stays the reference
deployment. Any future change or addition ships as a **new contract crate under `contracts/`** (own Cargo
package, own tests, own testnet deployment and its **own section in this file**, e.g.
`polaris_guard_v2`), so old and new contracts run side by side. Nothing below re-deploys v0.1 in place:
the "fixed in v0.2" column means "fixed in the new `polaris_guard_v2` contract", not an edit of the
frozen v0.1 source.

| ID | Severity | Limitation | Consequence for the demo | fixed in v0.2 (new contract `polaris_guard_v2`)? |
|---|---|---|---|---|
| F-01 | Medium | No pause / emergency stop; `revoke_executor` does not stop schedules. | Only kill switches for a schedule are `cancel_schedule` or revoking the SAC allowance (which also disables `pay_owner`). State it, don't hide it. | Y |
| F-02 | Medium | Schedule id space is never reused; keeper `list_due` sweep cost grows with ids ever created. | Accepted tradeoff; a busy day does not break the demo, it only makes the keeper scan a few more pages. | N |
| F-03 | Low | `execute_schedule` does not re-check `known_recipients_only`; removing/re-pointing an alias does not stop an existing schedule (recipient is owner-authored at creation). | Product decision to keep + document; revisit in v0.2. | Y |
| F-04 | Low | `Known` vs `KnownRefs` TTL divergence. | A long-untouched but still-aliased recipient can archive independently (restore bill under Protocol 23); no demo impact. | Y |
| F-05 | Low | Insufficient balance surfaces as the token's error `#10`, not a guard error. | The app/keeper must range-route errors (`< 100` = token/host), not assume every rejection is guard policy. | N |
| F-06 | Low | `pay_owner` forwards an unvalidated `asset` address. | Client must resolve `asset` from the owner's allowlist and never pass an agent-supplied address; card renders the XDR's real asset. | N |
| F-07 | Info | Unauthenticated reads expose schedule data. | Acceptable for a public testnet demo; note the privacy implication for mainnet. | N |
| F-08 | Info | `MAX_ALLOWED_ASSETS` check is unreachable while `allowed_assets.len() > 1` is rejected. | Dead documentation; keep for when per-asset budgets land. | Y |
| F-09 | Info | `contracts/scripts/demo.sh:81` comment says `expiration_ledger` while the flag is `--live_until_ledger`. | Documentation only — fixed in this docs PR. | N (doc-only) |
| F-10 | Info | `stellar/src/keeper/README.md:146` log example shows `AllowanceMissing` code 5; code 5 is `SacAuthentication`, code 9 is `SacAllowanceError`. | Documentation only — fixed in this docs PR. | N (doc-only) |
| F-11 | Info | No upgrade path (deliberate). | A fix means a new contract ID and every owner re-publishing rule + allowance. | N (by design) |
| F-12 | Low | Failed schedules are retried forever with no auto-deactivation. | Simulation failures cost no fee; owner can always cancel manually. | Y |
| N-01 | Info | `list_due(cursor, 0)` returns `([], 0)`, indistinguishable from end-of-space. | Latent only — the keeper always requests `>= 1`. | Y |
| N-02 | Info | Rule / executor / alias mutations emit no events. | Off-chain monitoring must diff storage; no demo impact. | Y |
| N-03 | Info | Keeper's `execute_schedule` bumps the owner's `Rule` TTL (third party pays rent). | Rent-transfer nuance — documented only; keeper pays the rent, bounded (~120 days); no demo impact. | N |

### Demo talking points

- `known_recipients_only` does **not** bind schedules (F-03).
- The only kill switch for an existing schedule is `cancel_schedule` or revoking the SAC allowance
  (which also disables `pay_owner`) (F-01).
- The contract is **non-upgradeable by design** (F-11).
- **Testnet only** — no mainnet deployment exists and none is planned for this milestone.

### Privacy modes note

`polaris_guard` enforces its per-tx/daily limits on **plaintext** amounts, so it cannot enforce them on
the confidential leg of a private payment — the contract never sees the amount. The envelope is instead
enforced at the **public boundary** (capping the deposit into the CT wrapper / SPP pool, whose amounts
are public) plus a client-side per-transfer limit gated by the approval card. Design:
[`docs/confidential-payments.md`](../docs/confidential-payments.md) §7.

## Demo

```bash
contracts/scripts/demo.sh        # reads contracts/scripts/demo.env
```

It approves the allowance, publishes the rule, registers the executor, settles a
small agent payment, gets the larger one **rejected on-chain with `#105`
NeedsOwnerApproval**, re-sends it as the owner, then creates a one-shot schedule,
shows the early call rejected with `#110 ScheduleNotDue`, and has an unrelated
keeper account execute it once it comes due.

Verified run against `CDRLSFJ5W…` (2026-09-19): the 3 PGUSD agent payment settled,
the 25 PGUSD one was refused with `#105`, the owner re-sent it, the early keeper call
was refused with `#110`, `list_due --cursor 0 --limit 100` returned `[[1],0]`, and the
keeper settled the schedule. Payee ended at `108.0000000 PGUSD` (the asset carries
balances from the superseded deployments' demo runs too); `spent_today` for the owner
read `350000000` raw units — 3 + 25 + 7 PGUSD through this contract.
