# Report: A10 — close the demo-critical review findings

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `fix/a10-review-majors` / `.worktrees/a10` (based on `feat/a4-speak-intent`)
- **PR:** none (task: push only, no PR, no merge, no tag)
- **Source review:** [`backlog/2026-09-19-review-a4-chain.md`](2026-09-19-review-a4-chain.md) (APPROVE WITH FIXES, 11 majors, no blockers)

## Objective

Fix the eight majors the independent reviewer required before Touch ID / the first
real `ChainTool` (M1–M8, M10), in the order the task gave (demo risks first),
each with a test that fails without it. Record M9 and M11 as still open. Do not
touch `stellar/` or `contracts/`. All artifacts English.

Baseline was green: app 12, agent 58, cargo 107 passed / 2 ignored.

---

## M2 — a second utterance while the model is in flight was dropped silently

**Policy chosen: latest-wins supersede** (the same policy the speech queue already
uses). The owner speaks twice in a row; a newer utterance is the one they still
care about. Refusing with a Busy label was rejected because it is a dead end at
exactly the moment the demo shows; queueing would let a stale first answer speak
over the new turn and is harder to coordinate with the session machine.

- **What changed:** `agentBusyRef` (a boolean that silently dropped the second
  transcript) is replaced by `app/src/lib/turnFlow.ts`, a pure `TurnFlow` class.
  An identical re-emit of the in-flight transcript is still ignored (the old
  StrictMode protection), but a genuinely different utterance is admitted at
  once as a newer generation; every async result is gated on `isCurrent(ticket)`,
  so the superseded turn can neither advance the UI nor clear the newer turn's
  in-flight guard when it settles late. `App.tsx` drives the whole path from it.
- **Test:** `app/src/lib/turnFlow.test.ts` — blank ignored, duplicate ignored,
  second utterance supersedes (first no longer current), late settle does not
  clear the newer guard, same words after settle start a fresh turn. 5 cases.

## M4 — `speaking` had no watchdog

- **What changed:** the watchdog policy moved into
  `app/src/lib/turnSession.ts` as `stageWatchdog(stage)`. It now bounds **both**
  non-terminal stages: `thinking` 60 s → "Timed out", `speaking` 120 s → "Voice
  error"; `listening`/`failed` return `null`. `App.tsx` schedules whatever the
  policy returns, so a wedged player can no longer hold the shell open forever.
- **Test:** `turnSession.test.ts` — "speaking is watchdogged…": asserts speaking
  has a positive bound, thinking keeps its own, and the self-recovering stages
  have none. Fails before the fix (speaking was trusted to end itself).

## M1 — a stale execution outcome could kill a newer turn

- **What changed:** extracted the speech path's inline session-id check as
  `turnSession.isCurrentTurn(session, turnId)` and applied it to the execution
  path too. `executeApprovedIntent` now captures the session id at dispatch and
  drops the outcome (resolve **and** reject) when the on-screen turn has changed;
  the speech path uses the same helper.
- **Test:** `turnSession.test.ts` — "an async result is dropped once its turn id
  is no longer current": matching id true, stale id against a newer session
  false, no live session false, unbound result false.
- **Honesty:** there is no React component-test harness in the repo, so the test
  pins the shared guard rather than rendering `App.tsx`. The wiring is a direct
  application of the helper on both paths.

## M3 — a superseded capture transcript still spawned a turn

- **What changed:** added `Capture::is_current(recording)` (true only while the
  engine still holds that exact recording as `Transcribing`). `stt::handle` now
  re-checks it after transcription — the supersede can land while the worker is
  blocked on the backend — and discards the transcript instead of emitting a
  `transcript` event; the superseded WAV is still deleted.
- **Test:** `capture.rs` — "a superseded recording is not current": transcribing
  `older` is current, `newer` is not; once a new take supersedes it, `older` is
  no longer current. Fails before the predicate exists.
- **Honesty:** `stt::handle` itself needs a live `AppHandle` to emit, so the test
  pins the decision predicate that `handle` now branches on, not the emit call.

## M10 — a real-audio test ran in the default suite

- **What changed:** `#[ignore]`d
  `tts::player::tests::playback_start_fires_when_the_player_really_starts` (it
  spawns a real `afplay`), matching its `#[ignore]`d live-audio neighbours in
  `tts.rs`. `cargo test` is silent and offline again.
- **Effect:** cargo is now **107 passed / 3 ignored** (was 107 / 2; the +1
  ignored is this test, the +1 passed is the M3 test). Run it with
  `cargo test playback_start_fires -- --ignored --nocapture`.

## M8 — "every `ChainTool` throws `NotImplementedError`" was wrong

- **What changed:** narrowed the claim to `sendPayment`, `swap`, `guardPolicy` in
  `agent/src/execution.ts` (module header **and** the placeholder doc, which also
  wrongly said "every `ChainTool` on `main` still throws"), and documented
  `depositTry` accurately: unconfigured → plain error → `failed` / `Chain error`;
  configured → a real unsigned trustline/SEP-10 XDR → `executed`; never submits.
  The same correction is recorded in the handoff doc
  (`backlog/2026-09-19-a9-execution-seam.md`) at the outcome table and the
  `NotImplementedError` section.
- **Test:** doc/comment-only; no code path changed, so no test (stated honestly).

## M7 — `executeIntent` "never throws" was false for a throwing approver

- **What changed:** `approve()` was outside the `try`. It is now wrapped; a
  throwing approver (the realistic Touch ID cancel/error shape) maps to a
  labelled `failed` / "Approval error" outcome with the full detail, and the tool
  is never reached. The contract now matches the code.
- **Test:** `agent/src/execution.test.ts` — "a throwing approver becomes a
  labelled failure and never reaches the tool": asserts `status === "failed"`,
  label `Approval error`, detail carries the message, and the tool call count is
  0. Fails before the fix (the throw escaped).

## M6 — the biometric drop-in claim was oversold

- **What changed (honest-doc option):** scoped the claim everywhere it appeared.
  `IntentApprover` and the `execution.ts` module header now say it is an
  **intent-level** gate: the approver sees only the `Intent`, which is enough for
  approve/deny before any chain work, but a card-level approval needs the
  post-tool `summary` + `payloadHash` (`PolarisEvent::approval_request`) and
  therefore a second, post-tool phase this seam does not implement. The same
  scope note is in the A9 handoff doc and in `app/src/lib/chain.ts`.
- **Test:** doc/comment-only; no test (stated honestly).

## M5 — the placeholder auto-approved and dispatch is automatic (most dangerous)

- **What changed:** the default is now **fail closed**. Added
  `createDenyApprover(reason)` and `resolveApprover(autoApprove)` in
  `agent/src/execution.ts`; `resolveApprover(false)` returns a deny-all gate, and
  only `resolveApprover(true)` installs the loud
  `createAutoApprovalPlaceholder()`. `app/src/lib/chain.ts` selects with
  `resolveApprover(import.meta.env.POLARIS_ALLOW_AUTO_APPROVE === "1")`, so the
  auto-approver is unreachable unless explicitly opted into. The non-secret
  kill-switch is exposed via the Vite `envPrefix` (and typed in
  `vite-env.d.ts`) and documented in `.env.example`.
- **Test:** `agent/src/execution.test.ts` — the default approver rejects and the
  tool never runs; the deny gate carries its reason; auto-approval requires the
  explicit opt-in. Fails before the fix (the default approved).
- **Demo note for the owner:** with stubs, an intent now settles as `Not approved`
  ("Not approved") unless `POLARIS_ALLOW_AUTO_APPROVE=1` is set, which restores
  the previous "Chain not wired" demo output. That is the intended trade: the
  dangerous wiring must be an explicit choice.

---

## Deferred (recorded, not fixed)

- **M9 — confirmation spoken after execution contradicts its contract.** The
  confirmation sentence is still spoken after dispatch (it gates nothing today).
  Moving it ahead of `approve()` belongs with the Touch ID / approval-card
  milestone; the copy is interrogative. Still open.
- **M11 — A9 caller side untested + blank-text drop without `onError`.**
  `speakTurnResult`/`speakWithSettle` glue still has no `node:test`, and
  `SpeechQueue.enqueue` still ignores blank text without calling `onError`
  (a blank answer settles via the M4 watchdog, not via `onFailure`). Still open.

---

## Verification

All commands run in `.worktrees/a10`; long ones wrapped with `caffeinate -i`.

| Command | Result |
|---|---|
| `npm run typecheck` | clean (interfaces, agent, stellar, app) |
| `npm run build` | clean; initial JS 242.67 kB min, chain chunk 577.69 kB lazy |
| `npm test -w @polaris/app` | **19/19** (was 12; +5 turnFlow, +1 watchdog, +1 turn guard) |
| `npm test -w @polaris/agent` | **61/61** (was 58; +3 approval-seam) |
| `caffeinate -i cargo test` | **107 passed / 3 ignored** (was 107 / 2) |
| `caffeinate -i cargo clippy --all-targets` | clean |

Raw tails:

```
# app:   tests 19  pass 19  fail 0  skipped 0
# agent: tests 61  pass 61  fail 0  skipped 0
cargo: test result: ok. 107 passed; 0 failed; 3 ignored; 0 measured; 0 filtered out
clippy: Finished `dev` profile [unoptimized + debuginfo] target(s) in 25.09s  (no warnings)
```

### Commits

`b4ee69d` fix(shell): supersede an in-flight turn instead of dropping a second
utterance · `f024a9b` fix(shell): watchdog the speaking stage so a wedged player
cannot hang the turn · `cda6ad9` fix(shell): guard the execution path with the
dispatched turn id · `8a96b88` fix(stt): drop the transcript of a capture
superseded by a newer take · `d0c0df9` test(tts): ignore the real-audio playback
test in the default suite · `ca7b7ec` fix(agent): fail closed by default and
never throw from the approval seam · `b41e72b` docs(a9): correct the depositTry
and biometric handoff claims.

One deviation from "one finding per commit": M5, M6, M7 and M8 all edit
`agent/src/execution.ts` in interleaved regions, so the code findings (M5, M7)
and their shared-file comment corrections (M6, M8) land in `ca7b7ec`, with the
handoff-doc corrections (M6, M8) in `b41e72b`.

---

## Honest limitations

- **No React component tests.** M1/M2/M4 are pinned through the pure modules
  (`turnFlow.ts`, `turnSession.ts`) that `App.tsx` now delegates to; the JSX
  wiring itself is not rendered in a test. Adding a jsdom/RTL harness was out of
  scope for this pass.
- **M3's `handle` emit path** is pinned via `Capture::is_current`, not by driving
  `stt::handle` (it needs a live `AppHandle` to emit).
- **M6 and M8** are documentation/comment corrections; the M8 code change is the
  corrected comment only — no behaviour changed, so no test was added for them.
- **Observed, not changed:** `package-lock.json` on this branch is out of sync
  with `app/package.json` (`@polaris/stellar` is a dependency but missing from
  the lock). `npm install` rewrote it; it was reverted to keep this branch
  focused. A lockfile-sync commit is worth a separate one-liner.
- The on-screen animation and the live mic/hotkey path still need a human; the
  ordering and the races are proven by the suites, not the screen.
