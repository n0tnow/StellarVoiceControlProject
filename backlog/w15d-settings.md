# W15d — Settings page (session, status, privacy, diagnostics, quit)

**Branch:** `feat/w15d-settings` · **Status:** open (review)

## What
Replaced the `SettingsPage` stub with a single calm scrolling column (section titles + hairline
dividers, no cards): **Session** (auto-lock select via `setAutoLock`, Log out via `lock`),
**Status** (Voice / Network / Contracts / Touch ID rows with a dot), **Privacy** (3-line plain
summary + read-only SPP status), **Diagnostics** ("Run all checks" over the existing FeatureCheck
registry, pass / fail / needs-a-human + detail), **Quit Polaris** (`quitPolaris`, two-step confirm).
No mock data; empty/loading/error states are one plain line.

## Files
- NEW `app/src/notch/settings/statusModel.ts` (+ `.test.ts`) — pure Voice/Network/Contracts/Touch ID mapping.
- NEW `app/src/notch/settings/useSettingsData.ts` — reads `voice_health`/`stellar_config`/`biometric_health`/`app_info` + a 4 s Horizon probe.
- NEW `app/src/notch/settings/DiagnosticsSection.tsx`, `SettingsView.tsx`, `ui.ts`.
- REPLACED `app/src/notch/pages/SettingsPage.tsx` (now just renders `SettingsView`).

## Decisions
- Status **reuses the health commands** (SettingsPanel's sources); the live "Horizon reachable"
  dot comes from a short probe in the hook, and the full live network check also runs in Diagnostics.
- Diagnostics runs on demand (button), not on open, so opening Settings never fires network checks.
- "escrow" = `p2pContractId`; contract ids shortened with a copied `shortId` helper.
- Value movement untouched; keys never read in TS.

## Verification
- `npm run check` (all workspaces) clean; `npm run build -w @polaris/app` OK.
- `npm test -w @polaris/app`: **443 pass / 0 fail** (new `statusModel.test.ts`: 9/9).
- Not verified (needs a human): real notch rendering, the Horizon probe against a live endpoint,
  auto-lock/log-out round trip, the Touch ID prompt, and `quit_app`.

## Blocked / handoff
None. Panels under `app/src/panels/**` were only read, not edited.
