# Repository cleanup — branches, tags and the landing-page deployment

**Date:** 2026-09-20
**Author:** Claude Opus 5 (coordinator session)
**Trigger:** project wrap-up — "clean repo, and put the landing page on GitHub Pages"

---

## 1. Why this record exists

The cleanup deletes every branch except `main` and every `archive/*` tag. Deleting a
remote branch removes the only *named* reference to its commits; the commits themselves
stay reachable by SHA on GitHub for as long as they are not garbage-collected. This file
is the index that makes that recovery possible:

```sh
# restore any branch listed below
git fetch origin <sha>
git checkout -b <branch> <sha>
```

If `git fetch origin <sha>` is refused, the commit can still be read through the GitHub
web UI or API at `https://github.com/n0tnow/StellarVoiceControlProject/commit/<sha>`.

---

## 2. Merged before the cleanup

Three open pull requests were rebased onto `main`, conflict-resolved and squash-merged so
their work survives the branch deletion:

| PR | Title | Conflict resolved | Result |
|---|---|---|---|
| #41 | feat(ui): faster, cleaner Tasks and Rules pages | `backlog.md` (both index rows kept) | merged — `70f93e3` |
| #32 | feat(landing): dark Autonomy product landing page | `notes.md` (both notes kept) | merged — `0795a73` |
| #31 | docs: archive the PR #30 review record on main | `backlog.md` (both index rows kept) | merged — `2be25c0` |

Every conflict was an append-only documentation table where both sides had added a row;
the resolution keeps both rows. No code hunk was resolved by hand.

`bash scripts/check.sh` on the merged `main` finished with `== all checks passed`
(exit 0): JS typecheck across all workspaces, `@polaris/stellar` tests, the `@polaris/app`
vite production build, the agent smoke test, and `cargo check` on the Tauri shell.

## 3. Closed without merging — superseded, not lost

| PR | Title | Why it was not merged |
|---|---|---|
| #29 | Touch ID approval + user-configurable USD approval threshold | Its UI half edits `app/src/panels/SettingsPanel.tsx`, which W15h deleted along with the whole panel-window infrastructure. Its `approvalPolicy.ts` / `thresholdApprover.ts` / `preferences.ts` are a second implementation of the approval threshold that `app/src/lib/autopay.ts` already provides on `main` (threshold / per-tx / daily / known-recipients-only, wired to the on-chain guard and the notch Rules page). Merging it would have added duplicated, unreachable code. |
| #8 | docs: rule/schedule types, guard ABI and 2026-09-19 decisions | A draft opened 2026-09-19 that was never taken out of draft. It adds type definitions to `interfaces/src/index.ts`, which has since grown from 118 to 702 lines as rules and schedules actually shipped. Its type names no longer correspond to the implemented ones. |

Both branches are listed in §5 with their head SHA and can be restored from there. Their
design reasoning is preserved in `backlog/touchid-approval.md` and
`backlog/rule-types-docs.md` on those branches.

## 4. Landing page on GitHub Pages

`.github/workflows/pages.yml` uploads `landing/` as the Pages artifact on every push to
`main` that touches it. Actions is used rather than a branch source because a branch
source can only serve the repository root or `/docs`, never an arbitrary subdirectory.

| Repository | Pages source | Status |
|---|---|---|
| `fthsrbst/StellarVoiceControlProject` (fork) | GitHub Actions | **live** — <https://fthsrbst.github.io/StellarVoiceControlProject/> |
| `n0tnow/StellarVoiceControlProject` (origin) | GitHub Actions | **live** — <https://n0tnow.github.io/StellarVoiceControlProject/> (workflow merged in #44; the Pages source was switched to "GitHub Actions" by a repo admin, which a non-admin token cannot do — `POST /repos/.../pages` returns 404) |

Verified on both live deployments: `/` and `/style.css` return HTTP 200 (6433 B and 12027 B),
and the served page renders identically to the local `python3 -m http.server` preview.

## 5. Deleted branches

The 49 branches below were deleted from `origin` in the first pass on 2026-09-20. Three more
were deleted in a second pass once their pull requests landed: `chore/pages-deploy` (#44),
`chore/release-0.2.1-signing` (#47) and `docs/repo-cleanup` (#45, this report) — 52 in total. "Commits ahead" counts commits
not reachable from `main`; a squash-merged branch shows a non-zero count even though its
*content* is already on `main`, which is why this table records the SHA rather than a
merged/unmerged verdict.

| Branch | Head SHA | Commits ahead of `main` | Last commit |
|---|---|---|---|
| `audit/rules-ruleset-check` | `956e8e1fca5b248ff54df86961eb19497d76f01b` | 2 | docs: independent review of the ruleset audit (accept with corrections) |
| `chore/remove-freighter-bridge` | `0d8861ad632f8fb8bd0c3e3b2db8d0bbe9cc936d` | 35 | docs: Freighter bridge removal report |
| `codex/dark-landing` | `19866be8788a89953c69ddfdc47612d9264d5e3b` | 7 | Merge remote-tracking branch 'origin/main' into codex/dark-landing |
| `docs/blobatar-review` | `48896ac073474fb5f4390867bd2fd403970a3e6c` | 2 | Merge remote-tracking branch 'origin/main' into docs/blobatar-review |
| `docs/branch-cleanup` | `e628daeb207059e08060c93f6908e88d10d83f19` | 2 | docs: branch audit report row |
| `docs/final-sync` | `f45d96103ef1cc29a9ff736473bd261c42f49316` | 47 | docs: sync README, sprints, wallet track, demo and pitch with the embedded-wallet product |
| `docs/onboarding-merge-round` | `4339b8943d23b3eb73f5b5122ddff7f104220fdb` | 1 | docs(notes): record the first-run round — #34 rehearsal, #35 rebased and merged |
| `docs/rule-types-and-decisions` | `81639cb232568e253d00e8ce9f02f07fad3f0a14` | 7 | docs(sprints): link PR #8 on the Rule/Schedule types item |
| `docs/wallet-track-plan` | `bdba7fc4cff83873ee972139ac3c1725a15db84a` | 2 | docs: milestone 5 checklist and docs worker report |
| `feat/a5-notch-shell` | `dcf925c824c9de85156afc979d2d76dbe1759534` | 102 | docs(backlog): record the inline voice indicator, the co-active rule and the tap decision |
| `feat/bank-sim-automation` | `5f32eb4363501e182bba319b99abadab5cedf738` | 2 | docs: bank simulation notes |
| `feat/history-ui-pro` | `de0a83f91da871dcb3c8eb9c3d938266d801ad38` | 11 | docs: history UI notes |
| `feat/notch-shell` | `a44eff5146ba9ba2cfb7ffd75ac1293f6a15e032` | 2 | fix(shell): match the open and close motion to the growth animation |
| `feat/onboarding-native` | `e4ed67911359ec2c56f632d9d71e7164d1833fab` | 7 | feat(onboarding): rehearsal mode — the first run has no real side effects |
| `feat/onboarding-ui` | `106e20ad2c14ced4e878c1673583f447852c98af` | 6 | chore(onboarding): record the merge resolution and drop the spent merge note |
| `feat/touchid-approval` | `8cd0def11598b02b9b206e3ee2660ec9c7c8b138` | 7 | docs: refresh backlog index row for the review round 1 state |
| `feat/tr-anchor-default` | `a56d1a5e4b101e2ba4442c1f2f2911352fe30417` | 1 | feat(anchor): prefer the TR mock anchor (TRY/USDC) by default; SDF stays the fallback |
| `feat/ui-sfx` | `48e15c3a68d6e6e2e1aa58d7d5fbf822b25a07ed` | 13 | docs(backlog): record the ui-sfx review outcome and applied fixes |
| `feat/ui-tasks-rules-pro` | `6b1e7bdc4434e9af1f635058821744998c707dab` | 9 | Merge remote-tracking branch 'origin/main' into feat/ui-tasks-rules-pro |
| `feat/voice-dialog` | `b0319b76734b2b704f3a2607c8b390ff10931463` | 11 | docs: voice dialog notes |
| `feat/w10-embedded-wallet` | `ddd6a7370919b2f970f87e301c86a6b34b27ca85` | 2 | docs: embedded wallet decision and report |
| `feat/w10b-wallet-notch-ui` | `8a390e31a48c19ea0f0e24c7388c0b4efd079b91` | 5 | docs: W10b final notes |
| `feat/w11a-executor-rust` | `1153643de6ed15807db347c8164307fe4782ee80` | 32 | docs: W11a notes |
| `feat/w11b-autopay-ui` | `fbf4a0ed2fa6e874a1e31de7eee5bf8a79fd5b74` | 32 | docs: W11b notes |
| `feat/w13a-wallet-session` | `bb0f2efa37f001f0c86f0043911dac723a2ad616` | 11 | docs: W13a notes |
| `feat/w13b-wallet-experience` | `d38370e2fe3d573408ead05ed245008da82af7d6` | 11 | docs: W13b notes |
| `feat/w14-connect-wallet` | `77cb2cb5c2fb7362a058d4aaa4ced8185ed1f9fc` | 48 | feat(wallet): make connecting an existing wallet the primary first-run path |
| `feat/w15a-shell` | `848ef11fe5f46e1088103df2d3da93f66da24b30` | 56 | feat(notch): closable panel after logout, remove the ⋯ menu, route voice navigation into |
| `feat/w15b-wallet` | `3cf1d2d4f8c1b397fc394ef81f28a92e1a837e7b` | 56 | feat(notch): radically simpler Wallet page (balance, in-app funding, two-field send, compa |
| `feat/w15c-trade` | `d36d0632854bf06eb9fe7d4faa3ca34149e1e41e` | 56 | feat(notch): Trade page with anchor deposit/withdraw and P2P inside the notch |
| `feat/w15d-settings` | `54a680219be979da9dce14c887c5b1c398d58c2b` | 56 | feat(notch): Settings page with session, status, privacy, diagnostics and quit |
| `feat/w15e-rules` | `cfef1b8fd18d2cd744353687930c25038eec65d9` | 56 | feat(notch): simple Rules and Tasks pages (autopay threshold, new schedule) |
| `feat/w15f-contact` | `84a0141b89a9dece65a190ac253bcb6ac47c909a` | 56 | feat(agent): save, list and delete contacts from the typed prompt or voice |
| `feat/w15g-approval` | `70b6185a3b9b1e9cc2d1b75fcaa14fedcbcfdab6` | 56 | feat(notch): approval card inside the notch, no approval popup window |
| `feat/w15h-cleanup` | `194b591ee1283df697dde830f6b04f0cc294750c` | 70 | refactor: remove the panel-window layer; the notch is the only surface |
| `feat/w16-links` | `2a59100ee06012e857adf1c6ef41f5fad03db1e5` | 74 | feat(notch): explorer links open in the default browser across wallet, history, trade, rul |
| `feat/w17a-anchor` | `c528a830b2a589ca85d5a0528192078cb575754a` | 79 | fix(anchor): derive the Trade session from the active scenario and pick a healthy anchor b |
| `feat/w17b-p2p` | `53ce43f20edd0fc9b5a1837cebc0ba212e800588` | 79 | fix(p2p): preflight the seller's trustline and balance, plain-language contract errors, he |
| `feat/w18-trustline` | `2e3bb810d1b68f29d36e47e51f879798b7f18f9f` | 83 | feat(wallet): Add asset (trustline) flow so faucet USDC and anchor SRT can be received |
| `feat/w19-accounts` | `cd66f4cb5a5aee9bcbc0c64c70d0140f48b0bf0c` | 87 | feat(wallet): account switcher, add an account with a nickname while unlocked |
| `fix/anchor-sdf-primary` | `589edcc1ae94dd98c7287b5211df5830bff403df` | 4 | docs: SDF anchor verified both directions |
| `fix/notch-panel-clipped` | `654307808df0eab7832bc2c612f32f85d1db716a` | 20 | docs: notch clip root cause |
| `fix/notch-theme-integration` | `0154e1fc230d191142a8b2aa9c6e10ce7b2d94a1` | 95 | fix(notch): unlock card spacing collapsed because unlayered rules cancelled space-y margin |
| `fix/notch-theme-wallet-approval` | `3a79ad8d6878557c1b9eaf336721f70f77bad6f8` | 2 | docs(backlog): notch theme report for the unlock and approval cards |
| `fix/onboarding-permissions-gate` | `9837aff97903e532d03689008f356ea1c4d35335` | 1 | fix(onboarding): the granted permissions gate never recorded a pass; the window could not  |
| `fix/w10-review` | `532e7e0208f80d1dda2190e96339d8fa9b5da7ce` | 11 | docs: wallet review fixes |
| `fix/w11a-review` | `e826a1b794617ee3832e80727f26b36fd1663623` | 47 | fix(wallet): apply the executor security review (fee/resource/time bounds, bounded XDR dec |
| `resolve/pr38-merge` | `1969742bfa1d3786e87d2582ff3972e3ba85b11e` | 89 | docs(backlog): record PR #39 conflict resolution review |
| `revert/notch-theme-42` | `4c2dcc471502265fb0a4b1a04aeedfa5d626ff0b` | 1 | Revert "fix(notch): unlock and approval cards use the notch theme; approval keeps rounded  |

## 6. Deleted tags

The three release tags `v0.1.0`, `v0.2.0` and `v0.2.1` were **kept**. Only the `archive/*`
scratch tags were removed:

| Deleted tag | SHA | Points at |
|---|---|---|
| `archive/local/test-ui` | `a3dcacedd6f03eb1e039f23ba105ad38b9f763ab` |  |
| `archive/local/test-ui-pk` | `1ff93b6651df0b15381a6a158ebcfc6e813385ad` |  |
| `archive/review/spike-ct` | `f2185c1ccdd1f6fc4e711f0e9a2e2ed9c08b6659` |  |
| `archive/review/spike-passkey` | `f38d4eae43a02edb87a8612b7da8d9ea6360e8fe` |  |
| `archive/review/spike-spp` | `5170e66f38a890fa33f140529f511d129938fbca` |  |
| `archive/review/test-ui` | `35575f8026b4c6fc6130eb98d58559112e2d94fd` |  |
| `archive/review/test-ui-2` | `6c95e726f59c1a710ede2effad44827189ad80d2` |  |
| `archive/review/test-ui-pk` | `ed00da61e43a3a41beb69dd5b7cee4c47cf7f7b2` |  |
| `archive/spike/ct` | `3499efba93ef9045b2d46ec53b2be9022c978ad0` |  |
| `archive/spike/passkey` | `db9ff6d39bf76c13d614dbc8060f503138cd1236` |  |
| `archive/spike/spp` | `a63f16d7f0aeecfcb56e27af8fe6f328250fa3be` |  |

---

## 7. What `main` looks like afterwards

- One branch: `main`.
- Three tags: `v0.1.0`, `v0.2.0`, `v0.2.1`.
- No open pull requests. #29 and #8 were closed as superseded (see §3); #41, #32 and #31
  were merged (see §2).
- `landing/` published to GitHub Pages through `.github/workflows/pages.yml`, live on both
  remotes.
- Local `.worktrees/` removed.

### Known loose end

The `v0.2.1` tag points at `c56df23`, but the commit that actually sets `VERSION` to `0.2.1`
is `52efb77` ("chore(release): 0.2.1", merged as #47 after the tag was cut). The tag is one
release commit behind what it names. Re-pointing it is a release decision, so it was left
alone here rather than moved silently.
