# Report: NAV — voice navigation ("open my wallet", "show my rules", …)
- **Date:** 2026-09-20 · **Worker:** opencode worker (deepseek-v4.1-flash) · **Branch:** `feat/nav-voice-navigation` / `.worktrees/nav-voice`

## Completed
- `navigate` tool (`agent/src/tools/navigate.ts`): read-only, no approval/intent; strict target validation with tr/en synonym + diacritic folding; deterministic spoken confirmation; an unknown target asks.
- Additive `NavigationTarget`/`NavigationRequest` in `interfaces/src/index.ts` (`IntentKind` unchanged); threaded `toNavigation` (`tools/registry.ts`) → `AgentTurnResult.navigation` (`loop.ts`) → `AgentOutcome.navigation` (`lib/agent.ts`).
- Shell execution: `app/src/lib/navigation.ts` maps targets (notch pages vs panel windows via `open_panel`); `ShellSurface.tsx` selects the page and pins the `panel` state (Escape/close/"kapat" clears it); `App.tsx` opens panel windows.
- Prompt (`capabilities.ts`): navigate vs answer vs act, tr/en synonyms, STT garbles, and the no-navigation negatives.
- Files: `agent/src/{tools/navigate.ts,tools/navigate.test.ts,tools/registry.ts,loop.ts,runtime.ts,index.ts,capabilities.ts,capabilities.test.ts}`, `interfaces/src/index.ts`, `app/src/lib/{navigation.ts,navigation.test.ts,agent.ts}`, `app/src/App.tsx`, `app/src/notch/ShellSurface.tsx`, `scripts/e2e-prompt-eval.mjs`.

## Verification (real output)
- `npm run check` — 4/4 workspaces clean. `npm test -w @polaris/agent` — **190 pass / 0 fail**; `npm test -w @polaris/app` — **357 pass / 0 fail**.
- `npm run build -w @polaris/app` — built (pre-existing dynamic-import warnings only).
- Live `node --env-file=…/.env scripts/e2e-prompt-eval.mjs` — **54/54 = 100.0%** (21 new nav cases incl. 3 must-not-navigate; real provider, no key printed). Rust untouched → no cargo run.

## Human verify (not verified here)
- A real spoken command opens the notch page / panel window; the TTS confirmation is audible.

## Blocked / handoff
- `app/src/notch/ShellSurface.tsx` is outside the listed scope (the page controller is owned there); the edit is additive (a `navigation` prop + panel pin/close). Flagged per the worktree rule.
