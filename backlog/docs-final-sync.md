# DOCS-FINAL — docs synced to the current product
**Date:** 2026-09-20 · **Worker:** opencode worker (deepseek-v4.1-flash) · **Branch:** `docs/final-sync` · **PR:** none (coordinator commits)
## Done
- `README.md`: status/intro, layout, anchor, notch ("⋯" menu, no tray), first-run flow, `.env` keys + `make build`/`make run` + app-support fallback, wired/open lists, 5-bullet security.
- `sprints.md`: **Milestone 5 — Wallet & UI track** (real order + open/human-verify lists); A2–A5 / V1–V7 / C5–C6 collapsed; anchor (SDF) + P2P ticked. `backlog.md`: one DOCS-FINAL row + "queue merged into `integration/wallet-login`" note.
- `docs/wallet-track.md` redesigned (embedded wallet, session, autonomy, SDF anchor, Freighter history) + `docs/architecture.md` §4.5/§5.4 addenda; `docs/demo-script.md` + `docs/pitch.md` rewritten; `contracts/DEPLOYED.md` escrow-review limits; `docs/reviews/` archive (5 reports + index).
## Verify
- `caffeinate -i npm run check` → green (interfaces/agent/stellar/app tsc). Docs only; no code/Cargo/`.env` touched. Lengths: wallet-track 103, demo-script 67, pitch 50, reviews index 15.
## Remaining / Blocked
- Human-verify unchanged (mic/STT, Touch ID, Keychain, anchor payout, `pay_executor`, real notch). W11a review MAJOR-1/2 were fixed afterwards (`backlog/w11a-executor-rust-review-fixes.md`).
