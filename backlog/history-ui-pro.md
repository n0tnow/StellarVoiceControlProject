# HISTORY-UI — professional History screen in the notch

**Branch:** `feat/history-ui-pro` · **Status:** open (review)

Rebuilt History as a wallet-grade activity timeline in the notch (outer
`HistoryPage()` signature intact): kind icon, clear title, status chip, signed
7-decimal `bigint` amount (no floats), relative time + exact-time hover, nickname,
sticky day groups; filter chips with counts (remembered), search, Copy-CSV, an
in-place detail drawer (hash+copy, explorer, fee, memo, network, voice
transcript/answer, approval mode, P2P state + next action, anchor id/status),
skeleton/empty/error+Retry/offline states and Horizon cursor paging (20/page, 200 cap).

**Files:** new `app/src/notch/history/` (`model.ts`, `group.ts`, `csv.ts`,
`p2pHistory.ts`, `anchorHistory.ts`, `history.css` + 3 tests); rewritten
`pages/HistoryPage.tsx` and `data/useHistoryData.ts`; additive `lib/turnLog.ts`
(+`recordTurnMeta`) and optional `lib/history.ts` cursor/nextCursor; extended
`debug/checks/history.ts`.

**Decisions / handoff:** P2P rows use `listOpen` (open offers of the active wallet;
settled/cancelled not read, to bound the load); anchor rows come from the session
explain log. The flows knowing `kind/route/approval/amount/counterparty` live in
`app/src/App.tsx`, outside scope, so `recordTurnMeta` is not called there yet — turns
infer best-effort until a follow-up wires it (memo/fee always `null`, not logged).

**Verification:** `npm run check` clean; `npm test -w @polaris/app` **399 pass/0 fail**;
`npm run build -w @polaris/app` OK. Not verified (human): real-notch render/animations,
sticky headers, clipboard, real Horizon paging, live P2P/anchor lanes.

## MERGE-HIST — merged `feat/history-ui-pro` into `integration/wallet-login`
Resolved 2 conflicts: `HistoryPage.tsx` (kept the pro timeline as `HistoryBody`, wrapped by `useWalletLocked`/`LoginGate` exactly like Tasks/Rules, so `useHistoryData` never mounts/reads the chain while locked) and `backlog.md` (kept both new rows). Auto-merged `useHistoryData.ts`/`turnLog.ts`/`history.ts`/`debug/checks/history.ts`/docs took the history version unchanged (integration side only edited docs) — no drift.
**Verify:** `npm run check` clean; app 418/0, agent 213/0, stellar 112/0; `npm run build -w @polaris/app` OK; cargo 375/0/5-ignored; clippy `-D warnings` clean. Human-only: real notch render/clipboard/paging.
