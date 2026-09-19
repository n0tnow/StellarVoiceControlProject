# Live testnet manual-testing guide

Everything in this folder (`stellar/src/live/**`) is **TESTNET ONLY** and uses
**throwaway keys**. It refuses any non-testnet host or passphrase before it
touches the network.

- Allowed hosts: `https://soroban-testnet.stellar.org`,
  `https://horizon-testnet.stellar.org`, `https://friendbot.stellar.org`.
- Secrets live only in `~/.polaris-e2e/keys.json` (dir `0700`, file `0600`).
  Nothing here reads `~/.config/stellar`, `~/.stellar`, repo `.env` or any other
  identity. Output is public data (addresses, balances, hashes) only.
- These keys are disposable. **Never reuse them on mainnet or for anything of
  value.** `--reset` destroys them.

## Prerequisites

- Node >= 22.18 (`node --version`).
- Dependencies installed at the repo root (`npm install`).
- A guard contract id: `contracts/scripts/demo.env` (`GUARD=`) already provides
  the deployed testnet one.

The commands below run from the repo root with the workspace flag
`-w @polaris/stellar`.

## 0. Provision the throwaway environment

```bash
# first time, or after a --reset
npm run e2e:setup -w @polaris/stellar -- --live
```

This funds the five throwaway accounts with Friendbot, creates their E2EUSD
trustlines, mints E2EUSD to the owner and deploys the asset's SAC. It prints the
public addresses/balances. Without `--live` it only prints the plan (no network).

```bash
# destroy the previous keys and start from scratch (no backup)
npm run e2e:setup -w @polaris/stellar -- --live --reset
```

`--reset` overwrites `~/.polaris-e2e/keys.json` with a brand-new key set and
drops the stored asset record; the old throwaway keys are unrecoverable.

## 1. Read the current state

```bash
npm run e2e:status -w @polaris/stellar -- --live
npm run e2e:status -w @polaris/stellar -- --live --json          # machine output
npm run e2e:status -w @polaris/stellar -- --live --tz UTC        # local times in UTC
```

Prints the five public addresses, E2EUSD balances, the owner's `get_rule`,
`get_executor`, `get_alias("ada")`, `spent_today`, the SAC allowance and the
active schedules with local + UTC next-run times. Without `--live` it prints the
plan and does no network I/O.

## 2. The manual-test tool

```bash
npm run e2e:tool -w @polaris/stellar -- --live <command> [options]
```

Every state-changing command follows the same safe pipeline:

1. **BUILD** with the production chain-lane tools (the same code the app uses).
2. **CARD** — the approval card is decoded from the produced XDR (title, route,
   signer, fee, payload hash, explorer link, warnings), never from the flags.
3. **CONFIRM** — an interactive `y/N` prompt (default NO; anything but `y`/`yes`
   aborts). Scripted runs pass `--yes`.
4. **SIGN** the exact displayed XDR with the correct key; the signed hash is
   re-checked against the card before submission.
5. **SUBMIT + VERIFY** — the tx hash, ledger and explorer link are printed, then
   the result is read back from chain.

`--help` works everywhere; an unknown flag is a usage error (exit code 2).

### Scenarios

**A. Read-only state.** `e2e:tool rule --live`, `e2e:tool list --live`.

**B. Direct classic payment** (bypasses the guard):

```bash
npm run e2e:tool -w @polaris/stellar -- --live pay --to ada --amount 5 --route direct
```
Expect: owner signs a classic `payment`; the `ada` E2EUSD balance rises by 5.

**C. Guarded payment, owner path** (no executor / above threshold):

```bash
npm run e2e:tool -w @polaris/stellar -- --live pay --to ada --amount 5 --route guarded --yes
```
Expect: the card shows `route: pay_owner`, `owner signs`; on-chain `spent_today`
rises by 5 and `ada` gains 5.

**D. Enable auto-pay** (one card, one confirmation, three transactions in order
`approve` → `set_rule` → `set_executor`; the card prints the D13 arming note and
marks the `set_executor` step `[ARMING]`):

```bash
npm run e2e:tool -w @polaris/stellar -- --live enable-auto --threshold 5 --daily 50 --per-tx 50 --days 30
```
Expect: `get_executor` becomes the executor and the profile becomes
`auto_under_limit`.

**E. Executor-signed small payment** (needs no owner card on-chain):

```bash
npm run e2e:tool -w @polaris/stellar -- --live pay --to ada --amount 3 --route guarded --profile auto_under_limit --yes
```
Expect: the card shows `route: pay_executor`, the executor signs, and the card
states that no owner approval card is required on this path.

**F. Tighten a limit:**

```bash
npm run e2e:tool -w @polaris/stellar -- --live tighten --per-tx 1
npm run e2e:tool -w @polaris/stellar -- --live pay --to ada --amount 5 --route guarded --yes
```
Expect: the second command is refused (`OverPerTxLimit #103`) because the owner's
`per_tx_limit` is now 1. Loosening is refused unless `--allow-loosening`.

**G. Alias book:**

```bash
npm run e2e:tool -w @polaris/stellar -- --live alias-add --name bob --address <G...>
npm run e2e:tool -w @polaris/stellar -- --live alias-remove --name bob
```
Only valid `G...` keys are accepted. Added aliases are stored locally
(`~/.polaris-e2e/aliases.json`) so `pay --to bob` works.

**H. Schedule a payment and watch the keeper fire it** (the headline scenario):

```bash
# pick a time ~3 minutes ahead, in Europe/Istanbul (or any IANA zone)
npm run e2e:tool -w @polaris/stellar -- --live schedule \
  --to ada --amount 2 --date 2026-09-20 --time 00:30 --tz Europe/Istanbul --yes

# start the existing keeper CLI in the foreground (max 300 s)
npm run e2e:tool -w @polaris/stellar -- --live keeper-watch --seconds 240
```
Expect: the keeper logs an `executed` event with the tx hash roughly **15–25 s
after the due time** (poll interval ~5 s plus ledger skew), and `ada` gains 2.
For a single tick instead, use `keeper-once --live`.

**I. Cancel a future schedule:**

```bash
npm run e2e:tool -w @polaris/stellar -- --live cancel --to ada --yes
# or explicitly by id:
npm run e2e:tool -w @polaris/stellar -- --live cancel --id 16 --yes
```
Expect: `get_schedule(id).active = false`; `list --live` no longer shows it.
(`cancel --to` only works when exactly one active schedule pays that alias.)

**J. Disable auto-pay:**

```bash
npm run e2e:tool -w @polaris/stellar -- --live disable-auto
# also revoke the SAC allowance (kill switch):
npm run e2e:tool -w @polaris/stellar -- --live disable-auto --revoke-allowance
```
Expect: `get_executor` becomes null; with `--revoke-allowance` the SAC allowance
drops to 0.

### Inspecting on stellar.expert

Every successful submission prints
`https://stellar.expert/explorer/testnet/tx/<hash>`. The payload hash shown on
the card is also that hash for the first (or only) step. Open the link to see
the contract invocation, the source account (owner vs executor vs keeper) and
the ledger close time.

## Reset

```bash
npm run e2e:setup -w @polaris/stellar -- --live --reset
```
Generates a fresh key set and asset record. The previous throwaway accounts and
balances are abandoned (they remain on testnet but you no longer hold the keys).

## Safety notes

- Testnet only. The run refuses any other RPC/Horizon/friendbot host or network
  passphrase.
- Keys stay in `~/.polaris-e2e/keys.json`; the tools never print a secret seed.
- These keys are throwaway: never reuse them anywhere real.
- `e2e:setup --reset` overwrites the key file with no backup.
- `e2e:run --live` is **not idempotent**: it asserts the fresh baseline and must
  be followed by a `--reset` setup before it is run again.

## Troubleshooting

- **`tx_too_early`** — the client clock was ahead of the ledger clock. The
  direct payment path already sends `minTime: 0`; if you see it elsewhere, retry
  and/or sync your system clock.
- **`allowance_missing` / `InsufficientAllowance #116`** — the SAC allowance to
  the guard is too small or revoked. Re-approve with
  `enable-auto` (which runs `approve`) or `disable-auto --revoke-allowance` then
  `enable-auto` again. `e2e:status --live` shows the current allowance.
- **`TooManySchedules #114`** — the owner already has 25 active schedules
  (`MAX_SCHEDULES`). Cancel one with `cancel` first.
- **`OverPerTxLimit #103` / `OverDailyLimit #104`** — the payment or schedule run
  exceeds the owner's rule. Raise the limits via `enable-auto` (full card) or
  check `rule`.
- **`OverDailyLimit`** — the daily cap is per UTC day; it resets at 00:00 UTC.
- **keeper down** — scheduled payments only fire while a keeper is running. Start
  `keeper-watch --live --seconds 300` and watch for the `executed` log event; a
  schedule that is long `delayed` in `list` may mean no keeper is online.
- **`NoExecutor #107`** — auto-pay was disabled; `pay --profile auto_under_limit`
  falls back to `pay_owner` until you `enable-auto` again.
- **`unknown alias`** — `pay`/`schedule` only accept aliases from the local book
  (seeded with `ada`). Add one with `alias-add`.
