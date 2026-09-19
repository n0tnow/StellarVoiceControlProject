# Report: A8 — remove the debug panel, one continuous notch session

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a4-speak-intent` / `.worktrees/a4`
- **PR:** none (task: push only, no PR, no merge, no tag)

## Objective

Two shell-only changes, no transport/agent/TTS work: (1) delete the debug-looking
`<AgentTrace>` box under the notch; (2) stop the shell collapsing to the idle pill
in the middle of a turn — from hotkey-down to the end of the turn it must stay
expanded and move `listening -> thinking -> checking -> speaking` with smooth
stage transitions, ending once.

---

## 1. What was removed

- **Deleted** `app/src/components/AgentTrace.tsx` (the transcript / intent /
  `glm-5.3-flash · thinking` box) and its render call in `App.tsx`.
- **Deleted** `app/src/components/EventLog.tsx` — it was already unreferenced
  (confirmed by `rg`); no importer existed.
- **Deleted the now-dead helpers** it shared: `LogLine`, `LogTone`, `nowLabel`,
  `makeLine`, `describeEvent`, `stageLabel` and the `AgentStage` import in
  `app/src/lib/polaris.ts`; `subscribeAgentEvents` and its `PolarisEvent` import
  in `app/src/lib/agent.ts` (only `AgentTrace`/`App` used them).
- **Deleted** the `.agent-trace*` CSS block in `app/src/index.css`.
- **Kept** (not ours to remove, pre-existing): `app/src/components/ui/button.tsx`
  and `app/src/lib/utils.ts` are also currently unreferenced, but they were dead
  before this task and are not debug UI; flagged here rather than swept in.

Nothing diagnostic was lost: `runAgentTurn` still logs the intent (or the labelled
failure with full detail) to the console, and Rust still prints the provider/TTS
lines. The debug surface simply moved off-screen, where the owner wants it.

## 2. How the turn is modelled now

One explicit, pure state machine: **`app/src/lib/turnSession.ts`**.

- A turn is a single `TurnSession { id, stage, failureLabel }`, held in one
  `useReducer` in `App.tsx`. It replaces `collapsed` / `dismissible` /
  `speakingVisual` / `agentFailureVisual` / `agentErrorCollapsed` and the
  separate `speaking` / `agentRun` / `agentStage` states.
- The session starts on capture `recording` (hotkey down) and ends **exactly
  once** — either `speech_finished` (the healthy end) or `settled` (a failure's
  dwell having elapsed). No other signal returns `null`.
- The pivot is capture `idle`: the STT worker returns capture to `idle`
  *before* it emits the final transcript, and that gap is what used to collapse
  the shell. The reducer now just holds the session there.

The reducer is free of React, Tauri and timers, so it is deterministic and unit-
tested (`app/src/lib/turnSession.test.ts`, 9 `node:test` cases). Timing lives in
`App.tsx` and arrives as ordinary signals:

- **failure dwell** (`FAILURE_DWELL_MS = 5000`): a `failed` session dispatches
  `settled` once; the effect is keyed on the session id so re-renders do not
  re-arm and a new failure does.
- **stuck-turn watchdog** (`TURN_STAGE_TIMEOUT_MS = 60000`): a `thinking`/
  `checking` stage that makes no progress is failed as `Timed out`. Every
  legitimate phase is far shorter (the model request itself is capped at 30 s),
  so it only fires if an upstream event is genuinely lost — the shell can never
  be left stuck expanded.

`expanded` is now simply `shellState !== "idle" || !connected || permissionHint`;
while a session exists the class is a live stage, so the shell cannot shrink.

## 3. Stage list and transitions

| Stage | Shown when | Ear label | Indicator |
|---|---|---|---|
| `listening` | capture `recording` | Listening | fast bars (unchanged) |
| `thinking` | capture `ready`/`transcribing` | Thinking | slow bars |
| `checking` | final transcript; agent turn in flight / waiting for voice | Checking | slow bars |
| `speaking` | `speech_status: speaking` | Speaking | slow bars |
| `failed` | capture `error`, agent failure, watchdog | short failure label (`status.label`, `run.failure.label`, or `Timed out`) | red bars |
| — (no session) | idle pill, `Connecting`, `Grant access` | not drawn | none |

Transitions, all folded by the reducer:

```
recording ─▶ listening ─▶ thinking ─▶ checking ─▶ speaking ─▶ (end)
                │             │            │
                └─────────────┴────────────┴──▶ failed ─▶ (settled) ─▶ end
```

Smoothness: stage changes cross-fade only the label (`StageLabel`, two
absolutely-overlaid layers fading out/in over 240 ms), and `thinking` /
`checking` / `speaking` now share **one** indicator animation rule, so the bars
never restart or jump between those stages. The shell width is constant across
stages (`--expanded-width`), so there is no width jump; the only width change is
the single open at turn start and the single close at turn end. Failure label
keeps the existing error treatment and collapses once.

## 4. Exact commands and REAL output

```
$ caffeinate -i npm run check -w @polaris/app
> tsc -p tsconfig.json                          # clean

$ caffeinate -i npm run test -w @polaris/app
# tests 9
# pass 9
# fail 0

$ caffeinate -i npm run typecheck               # interfaces, agent, stellar, app — clean
$ caffeinate -i npm run build
vite v8.3.0 building client environment for production...
✓ 47 modules transformed.
dist/index.html                   0.43 kB │ gzip:  0.27 kB
dist/assets/index-ICazTTKQ.css   16.60 kB │ gzip:  4.24 kB
dist/assets/index-aFrtZmEu.js   238.20 kB │ gzip: 75.53 kB
✓ built in 288ms

$ caffeinate -i npm test -w @polaris/agent
# tests 40
# pass 40
# fail 0

$ caffeinate -i cargo test --manifest-path app/src-tauri/Cargo.toml
test result: ok. 104 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out

$ caffeinate -i cargo clippy --all-targets --manifest-path app/src-tauri/Cargo.toml
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.28s
```

The 9 stage-machine tests:

1. a successful turn never collapses between the hotkey and the end of speech
2. a failing turn shows one label and settles exactly once
3. an STT failure settles a single failed session
4. a mic error outside any turn still gets the generic label
5. a stale speech event cannot move or end a newer turn
6. a new take supersedes a failed session
7. capture chatter outside a turn never opens the shell
8. speech only starts from the checking phase
9. a late capture event cannot pull a speaking turn backwards

Build artifact check: `rg -c agent-trace app/dist` → no matches;
`stage-label-in`, `notch-label-stack`, `state-checking` all present in the
built CSS.

## 5. Running instance (left up for the visual check)

The owner's `tauri dev` / Vite / `polaris-app` were already running from this
worktree and were **not** restarted. After the edit the dev server still serves
the new modules (Vite HMR picks them up):

```
$ lsof -nP -iTCP:1420 -sTCP:LISTEN
node  39866 fatih  IPv6 [::1]:1420 (LISTEN)

$ curl -o /dev/null -w '%{http_code}' http://localhost:1420/src/App.tsx
200
$ ... /src/lib/turnSession.ts 200   /src/components/StageLabel.tsx 200
$ ps -o pid,etime,comm -p 43371
43371  45:28  target/debug/polaris-app
```

## 6. What still needs a human eye (stated plainly)

- **I cannot see the screen, and I am not claiming the animation looks right.**
  The state machine is proven by the 9 unit tests; the *visual* — the label
  cross-fade, the bars not jumping, and above all that the shell no longer snaps
  to the pill between "recording finished" and audio — is **outstanding and needs
  the coordinator to watch a real turn**.
- The watchdog path (`Timed out`) and the failure dwell are unit-tested at the
  reducer level; neither was exercised against a live forced outage this round.
- The label cross-fade was not observed in the running webview (only built and
  typechecked); reduced-motion behaviour is code-reviewed, not visually checked.

## 7. Files changed

- **New:** `app/src/lib/turnSession.ts`, `app/src/lib/turnSession.test.ts`,
  `app/src/components/StageLabel.tsx`, `backlog/2026-09-19-a8-notch-session.md`
- **Modified:** `app/src/App.tsx`, `app/src/index.css`, `app/src/lib/polaris.ts`,
  `app/src/lib/agent.ts`, `app/package.json` (adds `test`), `backlog.md`,
  `notes.md`
- **Deleted:** `app/src/components/AgentTrace.tsx`, `app/src/components/EventLog.tsx`
- **Not touched / not committed:** `TASK-A4..A8.md`; `agent/**`, `stellar/**`,
  `contracts/**`, all Rust.

## 8. Suggested next step

The coordinator watches one real push-to-talk turn and confirms the shell stays
expanded `Listening → Thinking → Checking → Speaking` and collapses once. If the
label fade is too subtle or too slow at this size, tune the 240 ms in
`StageLabel.tsx` / the `stage-label-*` keyframes — the geometry and the session
logic do not need to change.
