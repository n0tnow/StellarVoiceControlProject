# Changelog

All notable changes to Polaris are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[SemVer](https://semver.org/) with the pre-1.0 policy from `AGENTS.md` §9
(MINOR for features, PATCH for fixes, one bump per milestone, coordinator cuts tags).

## [Unreleased]

## [0.1.0] - 2026-09-19

First code milestone: the monorepo skeleton plus a testnet-deployed on-chain guard,
the off-chain keeper that triggers its schedules, and a SEP-6 anchor client.

### Added

- Monorepo skeleton as npm workspaces — `interfaces/`, `agent/`, `app/`, `stellar/`,
  `contracts/` — including the `@polaris/interfaces` typed seam, the Tauri v2 + React
  desktop shell with its typed `polaris-event` stream, the agent skeleton (tool registry,
  `noop` tool, mock loop), `.env.example`, `VERSION` and `CHANGELOG.md`, and the
  `Makefile` / `scripts/` entry points ([#4](https://github.com/n0tnow/StellarVoiceControlProject/pull/4)).
- `polaris_guard` on-chain rule engine and scheduler, deployed to Stellar testnet at
  `CDRLSFJ5WIC5UMF2LWPF3NRVDOKE7CN3DAYGKDWQ5TJJMVB7FRHRCK4D`: per-owner spending rules
  (auto-approve, per-tx and daily limits, allowed assets, known-recipients-only), alias
  book, executor registration, owner/executor payment paths, per-owner schedules with a
  paginated `list_due`, TTL hygiene, and typed error codes 100–116
  ([#10](https://github.com/n0tnow/StellarVoiceControlProject/pull/10); deployment and
  error table in `contracts/DEPLOYED.md`).
- Off-chain keeper for `polaris_guard` schedules: paginated sweep of the global schedule
  id space, pending-transaction tracking, protocol-23 restore (`RestoreFootprint`) before
  executing, per-id backoff by error class, and missed runs skipped rather than replayed;
  verified live on testnet ([#9](https://github.com/n0tnow/StellarVoiceControlProject/pull/9);
  `stellar/src/keeper/README.md`).
- SEP-6 anchor client with SEP-1/10/12/38 as supporting standards: discovery from the home
  domain only, deposit and withdraw flows, preflight (Friendbot + USDC trustline),
  session-bound approval data and an `explain` narration log for every step
  ([#11](https://github.com/n0tnow/StellarVoiceControlProject/pull/11);
  `stellar/src/anchor/README.md`).
- Round-2 status documentation: rescued A0/model-ladder reports and the closed-PR record
  indexed in `backlog.md`, with the round-2 merge plan in
  `backlog/2026-09-19-closed-prs-and-round2-plan.md` ([#12](https://github.com/n0tnow/StellarVoiceControlProject/pull/12)).

### Fixed

- **Guard:** removed the global schedule cap — a cross-tenant DoS in which a few funded
  accounts could fill one shared list and block `create_schedule` for everyone; made
  `set_alias`/`remove_alias` maintain the `Known` markers by reference, so re-pointing an
  alias no longer leaves the old address marked as a known recipient; extended TTLs on the
  payment/read paths (`load_rule`, executor lookup) and on schedule runs (`Schedule`,
  `OwnerScheds`, `NextSchedId`).
- **Keeper:** applied the fee cap to the `RestoreFootprint` path as well as `execute`; a
  resolved restore is no longer reported as an executed schedule (new `restore_pending` /
  `restore_confirmed` events, id stays eligible in the same tick); made the sweep cursor
  persist across ticks so due ids beyond one tick's page window are no longer starved
  (cross-tenant starvation fix); aligned the guard/token error tables with the contract
  and `soroban-env-host`, plus a drift test.
- **Anchor client:** home-domain/URL policy (plain FQDN; https on the anchor's own domain;
  redirect and response-size caps); withdrawal payment bound to the session's own
  `startWithdraw` response with a signed-envelope check; issuer pinning and the asset
  issuer shown on the approval card; all anchor-authored text sanitized and carried only
  as `anchorSaid` (never in narration), with the SEP-10 JWT kept inside the session;
  `pending_*_info_update` orders stop the poll and surface the missing fields instead of
  spinning.

### Notes

- PRs ([#5](https://github.com/n0tnow/StellarVoiceControlProject/pull/5))
  (`fix/ladder-restore`) and ([#6](https://github.com/n0tnow/StellarVoiceControlProject/pull/6))
  (`feat/a0-harness`) were closed unmerged; their work is preserved on the local rescue
  branches `rescue/a0-harness` (`7a024a6`) and `rescue/model-ladder-restore` (`4ac06b0`).
- PR ([#8](https://github.com/n0tnow/StellarVoiceControlProject/pull/8)) (rule/schedule
  interface types + decision notes) is open awaiting Owner A review and is **not** part of
  this release.
