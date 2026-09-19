#!/usr/bin/env bash
#
# polaris_guard testnet demo — the whole product argument in one script.
#
# It shows that the rules live on-chain, not in the app: the agent's executor key
# settles a small payment on its own, and the identical call for a larger amount
# is rejected by the contract with NeedsOwnerApproval — the signal the desktop app
# turns into a Touch ID prompt. Then it proves the scheduler: a one-shot standing
# order that only an untrusted keeper (no signature at all) has to trigger.
#
# Usage:
#   contracts/scripts/demo.sh                 # uses contracts/scripts/demo.env
#   GUARD=C... ASSET=C... contracts/scripts/demo.sh
#
# Prerequisites: stellar-cli >= 25.2.0, the identities named in demo.env, and a
# balance of the demo asset on the owner. See contracts/DEPLOYED.md to recreate
# them from scratch.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[[ -f "$HERE/demo.env" ]] && source "$HERE/demo.env"

NETWORK="${NETWORK:-testnet}"
GUARD="${GUARD:?set GUARD to the polaris_guard contract id}"
# No apostrophes in a ${var:?message} — bash parses the message as a quoting
# context and an unpaired ' swallows the rest of the script.
ASSET="${ASSET:?set ASSET to the SAC contract id of the demo asset}"
OWNER_KEY="${OWNER_KEY:-w1}"
EXEC_KEY="${EXEC_KEY:-w1-exec}"
KEEPER_KEY="${KEEPER_KEY:-w1-iss}" # deliberately NOT the owner or the executor
PAYEE_KEY="${PAYEE_KEY:-w1-bob}"

OWNER="$(stellar keys address "$OWNER_KEY")"
EXECUTOR="$(stellar keys address "$EXEC_KEY")"
PAYEE="$(stellar keys address "$PAYEE_KEY")"

# Raw units, 7 decimals — same convention as USDC.
UNIT=10000000
AUTO_APPROVE=$((10 * UNIT))  # agent may settle up to 10 on its own
PER_TX=$((50 * UNIT))        # hard ceiling per payment
DAILY=$((200 * UNIT))        # hard ceiling per UTC day
SMALL=$((3 * UNIT))          # inside the mandate -> settles
BIG=$((25 * UNIT))           # inside the hard caps, outside the mandate -> rejected
SCHEDULED=$((7 * UNIT))

REJECT_LOG="$(mktemp -t polaris-reject)"
EARLY_LOG="$(mktemp -t polaris-early)"
trap 'rm -f "$REJECT_LOG" "$EARLY_LOG"' EXIT

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
note() { printf '    %s\n' "$*"; }

invoke() { caffeinate -i stellar contract invoke --id "$GUARD" --network "$NETWORK" "$@"; }

# The CLI reports a contract error as a bare `Error(Contract, #N)` — it does not
# resolve N against the deployed spec's error names. Keep the mapping here so the
# demo output reads like the app's error handling will.
expect_error() { # expect_error <code> <name> <logfile>
  if grep -q "Error(Contract, #$1)" "$3"; then
    note "rejected on-chain: $2 (contract error #$1)"
  else
    echo "UNEXPECTED: expected $2 (#$1) but got:" >&2
    cat "$3" >&2
    exit 1
  fi
}

step "Context"
note "network   $NETWORK"
note "guard     $GUARD"
note "asset     $ASSET"
note "owner     $OWNER ($OWNER_KEY)"
note "executor  $EXECUTOR ($EXEC_KEY)"
note "payee     $PAYEE ($PAYEE_KEY)"

# ---------------------------------------------------------------------------
# 1. Allowance — the off-contract half of the design.
# ---------------------------------------------------------------------------
# The guard never custodies funds; it spends through SEP-41 transfer_from with
# itself as the spender. `expiration_ledger` is set ~30 days out (17280 ledgers a
# day at ~5s each); revoking it (amount 0) is the user's instant kill switch.
step "1. Owner approves the guard as a SEP-41 spender"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org}"
LEDGER=$(curl -sS -X POST "$RPC_URL" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getLatestLedger"}' \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["sequence"])')
# ~30 days at 17,280 ledgers/day. The allowance lives in temporary storage whose
# TTL tracks this value, and the protocol caps any entry at ~180 days, so a
# longer window would simply be refused.
#
# The argument is `--live_until_ledger`, not SEP-41's `expiration_ledger`: the
# soroban-sdk token interface (and therefore the SAC's CLI spec) renamed it.
EXPIRY=$(( LEDGER + 30 * 17280 ))
caffeinate -i stellar contract invoke --id "$ASSET" --network "$NETWORK" --source-account "$OWNER_KEY" \
  -- approve --from "$OWNER" --spender "$GUARD" --amount "$((1000 * UNIT))" --live_until_ledger "$EXPIRY"
note "allowance set at ledger $LEDGER, expires at $EXPIRY (~30 days)"

# ---------------------------------------------------------------------------
# 2. The user's rules, published on-chain.
# ---------------------------------------------------------------------------
step "2. Owner publishes the rule (auto-approve 10, per-tx 50, daily 200)"
# i128 fields must be JSON *strings* for the CLI: a bare number is rejected
# because 128-bit values do not survive a JSON number round-trip.
invoke --source-account "$OWNER_KEY" -- set_rule --owner "$OWNER" \
  --rule "{\"auto_approve_limit\":\"$AUTO_APPROVE\",\"per_tx_limit\":\"$PER_TX\",\"daily_limit\":\"$DAILY\",\"allowed_assets\":[\"$ASSET\"],\"known_recipients_only\":false}"

step "3. Owner registers the agent's executor key"
invoke --source-account "$OWNER_KEY" -- set_executor --owner "$OWNER" --executor "$EXECUTOR"

# ---------------------------------------------------------------------------
# 4/5. The same call, two outcomes — decided on-chain.
# ---------------------------------------------------------------------------
step "4. Agent pays 3 (inside the mandate) — EXPECT SUCCESS"
invoke --source-account "$EXEC_KEY" -- pay_executor --executor "$EXECUTOR" --owner "$OWNER" \
  --to "$PAYEE" --asset "$ASSET" --amount "$SMALL"
note "settled; spent today:"
invoke --source-account "$EXEC_KEY" -- spent_today --owner "$OWNER"

step "5. Agent pays 25 (over the mandate, inside the hard caps) — EXPECT REJECTION"
if invoke --source-account "$EXEC_KEY" -- pay_executor --executor "$EXECUTOR" --owner "$OWNER" \
     --to "$PAYEE" --asset "$ASSET" --amount "$BIG" 2>&1 | tee "$REJECT_LOG"; then
  echo "UNEXPECTED: the guard allowed a payment above auto_approve_limit" >&2
  exit 1
fi
expect_error 105 NeedsOwnerApproval "$REJECT_LOG"
note "this is the signal the desktop app turns into a Touch ID prompt"

step "6. Owner signs the same payment themselves — EXPECT SUCCESS"
invoke --source-account "$OWNER_KEY" -- pay_owner --owner "$OWNER" \
  --to "$PAYEE" --asset "$ASSET" --amount "$BIG"

# ---------------------------------------------------------------------------
# 7/8. Scheduling, triggered by an untrusted keeper.
# ---------------------------------------------------------------------------
step "7. Owner creates a one-shot schedule, due ~20s from now"
DUE=$(( $(date +%s) + 20 ))
SCHED_ID=$(invoke --source-account "$OWNER_KEY" -- create_schedule --owner "$OWNER" \
  --to "$PAYEE" --asset "$ASSET" --amount "$SCHEDULED" --first_run_at "$DUE" \
  --interval_secs 0 --runs 1 | tr -d '"')
note "schedule id $SCHED_ID, first_run_at $DUE"

note "calling it early — EXPECT ScheduleNotDue"
if invoke --source-account "$KEEPER_KEY" -- execute_schedule --id "$SCHED_ID" 2>&1 | tee "$EARLY_LOG"; then
  echo "UNEXPECTED: an undue schedule executed" >&2
  exit 1
fi
expect_error 110 ScheduleNotDue "$EARLY_LOG"

step "8. Waiting for the schedule to come due, then a keeper triggers it"
while [[ "$(date +%s)" -lt "$DUE" ]]; do sleep 2; done
sleep 6 # let the ledger clock catch up with wall time
note "due schedules according to the contract (paginated scan from cursor 0):"
# list_due bounds the SCAN, not the result: it examines at most `limit` ids from
# `cursor` and hands back the next cursor (0 = end of the id space). A real keeper
# loops until the cursor comes back 0.
invoke --source-account "$KEEPER_KEY" -- list_due --cursor 0 --limit 100
# The keeper holds no authority: it signs the transaction envelope (someone has
# to pay the fee) but the contract requires no authorization from it at all.
invoke --source-account "$KEEPER_KEY" -- execute_schedule --id "$SCHED_ID"
note "post-run state:"
invoke --source-account "$KEEPER_KEY" -- get_schedule --id "$SCHED_ID"

step "Result"
note "payee balance:"
caffeinate -i stellar contract invoke --id "$ASSET" --network "$NETWORK" --source-account "$OWNER_KEY" \
  -- balance --id "$PAYEE"
note "owner spent today:"
invoke --source-account "$OWNER_KEY" -- spent_today --owner "$OWNER"
printf '\n\033[1;32mDemo complete.\033[0m\n'
