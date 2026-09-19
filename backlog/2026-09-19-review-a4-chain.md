# Final Review — A4 voice chain (A0–A9) vs origin/main

- Date: 2026-09-19
- Branch: `feat/a4-speak-intent`
- Reviewer note: independent review; the reviewer did not write the code under review. This file synthesizes four read-only reviewer reports (all verdict APPROVE WITH FIXES, no BLOCKER) into one deduplicated final review. No source file was modified, nothing was committed, no builds were run for this synthesis.

## Verdict: APPROVE WITH FIXES

The chain is honest: secrets stay server-side, approval ordering is pinned before any tool runs, and the single-turn stubbed demo terminates (thinking/speaking settle or watchdog). But overlapping-utterance races, the auto-approval placeholder wired to automatic dispatch, the approver-sees-only-Intent contract hole, depositTry documentation overstatement, and test gaps must be fixed before Touch ID / real tools land. No blocker for merging the stubbed demo.

## BLOCKER

None found — empty category valid. No reviewer reported a blocker.

## MAJOR

### M1 — Stale execution outcome kills a newer turn: no turn-id guard on the execution path
- Location: `app/src/App.tsx:174-192` (speech path `app/src/App.tsx:132-140` has the guard — positive example).
- Problem: an older turn's execution outcome can overwrite a newer turn's UI state because the execution path does not capture/check a turn id, while the speech path does.
- Fix: capture `turnId` at dispatch and ignore the outcome when `sessionRef.current?.id !== turnId`.

### M2 — Second utterance while a model call is in flight is dropped silently, then 60s hang on "Thinking"
- Location: `app/src/App.tsx:142-144`, `app/src/lib/turnSession.ts:106-110`, watchdog `app/src/App.tsx:107-114`.
- Problem: a second utterance arriving while the model call is in flight is dropped silently; the UI then sits on "Thinking" until the watchdog fires.
- Fix: queue the latest pending transcript, or fail fast with a Busy label.

### M3 — Superseded capture transcript still spawns a turn
- Location: `app/src-tauri/src/stt.rs:366-397`, `app/src-tauri/src/capture.rs:253-268`.
- Problem: a capture superseded by a newer push-to-talk session can still emit a transcript and spawn a turn after transcription completes.
- Fix: re-check `current_path` after transcription completes; skip the emit when superseded.

### M4 — Speaking has no watchdog
- Location: `app/src/App.tsx:105-114` (watches thinking only), `agent/src/speech.ts:160-178` (drain unbounded, `#busy` stays true).
- Problem: the watchdog covers thinking but not speaking; the speech-queue drain is unbounded, so a stuck utterance leaves `#busy` true and the turn hanging with no recovery.
- Fix: add a generous speaking watchdog (e.g. 120s → Voice error), or explicitly document the assumption that speaking always settles.

### M5 — Auto-approval placeholder + automatic dispatch = silent execution once a real tool lands
- Location: `app/src/lib/chain.ts:23` (placeholder), `agent/src/execution.ts:70-80`, `app/src/App.tsx:174` (auto dispatch), spoken confirmation after dispatch `app/src/App.tsx:177-182` gates nothing.
- Problem: today every tool is a stub, so auto-approve is harmless; the moment one real `ChainTool` lands, the current wiring executes it without any explicit user gesture, and the spoken confirmation happens after dispatch so it gates nothing.
- Fix: require a real `IntentApprover` blocking on an explicit gesture before any non-stub `ChainTool` merges, or add a kill-switch such as `POLARIS_ALLOW_AUTO_APPROVE`, plus a test pinning the placeholder's presence until it is replaced.

### M6 — Approver sees only Intent, so the biometric drop-in claim is oversold
- Location: `agent/src/execution.ts:57-59`, `agent/src/execution.ts:21-24`, `backlog/2026-09-19-a9-execution-seam.md:124-126` vs `interfaces/src/index.ts:161-166` + `app/src-tauri/src/types.rs:44-45` (card needs summary + payloadHash post-tool).
- Problem: the approver contract passes only the `Intent`, but the confirmation card the user would biometrically approve needs post-tool material (summary + payload hash). The "Touch ID drops in" claim therefore holds only for intent-level gating, not for card-level approval.
- Fix: scope the claim to intent-level gating, or extend the seam to two-phase approve (pre-intent + post-tool card).

### M7 — `executeIntent` "Never throws" is false when the approver throws
- Location: `agent/src/execution.ts:136`, `app/src/lib/chain.ts:30-32` vs `agent/src/execution.ts:151` (outside try), `app/src/App.tsx:188-192` (generic catch).
- Problem: the contract says "Never throws", but `approve()` sits outside the try/catch, so a rejecting approver (the realistic Touch ID cancel/error shape) propagates as a throw; the App-side catch is generic and unpinned.
- Fix: wrap `approve()` so approver failure maps to a labelled `rejected`/`failed` outcome + test, or correct the contract to state the approver must never throw.

### M8 — "Every ChainTool throws NotImplementedError" is wrong: depositTry is real
- Location: `agent/src/execution.ts:65-67`, `backlog/2026-09-19-a9-execution-seam.md:114` vs `stellar/src/anchor/chainTools.ts:58`, `stellar/src/anchor/chainTools.ts:46-49`.
- Problem: overview statements claim every `ChainTool` is a stub, but `depositTry` is a real code path (unconfigured → failed/Chain error; configured → real XDR build, still no submit).
- Fix: narrow the statements to `sendPayment`/`swap`/`guardPolicy` and document the deposit path accurately.

### M9 — Confirmation spoken after execution contradicts its contract
- Location: `agent/src/speech.ts:11-15` vs `app/src/App.tsx:177-182`.
- Problem: the speech contract describes confirmation as pre-execution gating language, but the App speaks it after dispatch, where it gates nothing (today interrogative copy after a stubbed execution).
- Fix: move the spoken confirmation ahead of `approve()` when biometrics land, or correct the doc / reword to non-interrogative copy until then.

### M10 — Real-audio test runs in the default suite
- Location: `app/src-tauri/src/tts/player.rs:336` (spawns real `afplay`); neighbours `app/src-tauri/src/tts.rs:587-641` are `#[ignore]`d.
- Problem: this one test plays real audio in the default suite, so it fails on machines without `afplay`/audio output (Linux CI, headless runners) while the neighbouring live-audio tests are correctly ignored.
- Fix: add `#[ignore]` (or `cfg macos` + ignore).

### M11 — A9 caller side untested + blank-text drop without onError
- Location: `app/src/lib/speech.ts`, `app/src/App.tsx:132-140`, `agent/src/speech.ts:139-143` (unreachable today via `agent/src/loop.ts:146` coercion to `"(no answer)"`).
- Problem: `speakTurnResult` / `speakWithSettle` glue (the exact path that used to leave the notch stuck) has no test, and `SpeechQueue.enqueue` silently ignores blank text without calling `onError`, leaving the turn to watchdog-settle.
- Fix: inject a `SpeakFn` + add a `node:test` covering failure-once and blank-text, or document that blank input settles via watchdog, not via `onFailure`.

## MINOR

- MCP `destructiveHint`/`idempotentHint` ignored + benign-named write residual — `agent/src/mcp/bridge.ts:98-118` (policy), `agent/src/mcp/bridge.ts:38-70` (naming). Fix docs: state hints are advisory-only and that name-based policy has a benign-name bypass residual.
- `agent_chat` unauthenticated oracle + CSP null — `app/src-tauri/src/agent.rs:119`, `app/src-tauri/tauri.conf.json:35`. Document as accepted demo posture or scope a fix before network-exposed use.
- Handoff table misdescribes depositTry — `backlog/2026-09-19-a9-execution-seam.md:254-262` vs `stellar/src/anchor/chainTools.ts:58,35-36`. Correct the table to match the real deposit path.
- Stale `speaking` comment — `interfaces/src/index.ts:155-160` vs `app/src-tauri/src/events.rs:34-46`. Update the comment to the actual event union.
- Stale `checking` stage — `app/src/App.tsx:72-77` vs turnSession union + `app/src/App.tsx:290-294`. Remove or reconcile the dead stage.
- turnSession `failed`-from-null + `settled` no-op unpinned — `app/src/lib/turnSession.ts:125-126`, test `app/src/lib/turnSession.test.ts:138-145`. Pin with one case each (stray `failed` from null; `settled` on healthy thinking is a no-op).
- Loop precedence / throwing-tool / `first.text` drops unpinned — `agent/src/loop.ts:134-136` (clarification wins), `agent/src/loop.ts:125-129` (throwing `tool.run` propagates after `error` + `done`), `agent/src/loop.ts:138-140` (`first.text` dropped on intent resolve). Pin each with a `ScriptedLlm`/throwing-noop case or document as deliberate.
- Coverage gaps: `agent/src/tools/payment.ts:69-74` (non-string asset, `".5"`/`"5."` amounts), `agent/src/llm/openai.ts:116,142,172-177` (temperature default, AbortError→timeout, 403→auth), `agent/src/llm/config.ts:45-48` (whitespace-only model env), `agent/src/mcp/bridge.ts:102-104,121-124` (deniedTools branch, onRegistered, post-truncation name collision), `agent/src/speech.ts:54-58` (future-IntentKind default fallback), `app/src-tauri/src/hotkey_flags.rs:148` (modifier mapping untested), `app/src-tauri/src/commands.rs` (secret-handling behaviour hand-tested only).
- Blank-transcript early return never settles — `app/src/App.tsx:143`. Settle or document the watchdog path.
- Whitespace-only model/transcript edges: whitespace-only transcript and whitespace-only model text should be pinned to the same treatment as empty (drop or coerce) with a test.
- Dead wires: `app/src-tauri/src/commands.rs:138-143`, `app/src-tauri/src/hotkey.rs:222-226` vs `app/src/App.tsx:203-222`. Remove or document.
- `isNotImplementedError` name-only match — `agent/src/execution.ts:112`. Acceptable for stubs; note the collision risk once real tools land.
- Module bus cross-delivery — `agent/src/agent.ts:79-87`. Pin or document the intended fan-out.
- Notch geometry failure masks turn — `app/src/App.tsx:295,341`. Ensure a geometry failure cannot hide turn state.
- Env load walks up the tree — `app/src-tauri/src/env.rs:89-119`. Document or constrain the search.
- Console PII surface — `agent/src/agent.ts:123`, `app/src/e2e-speak.ts:50`. Scrub or confirm no secret material reaches logs.
- E2E env forwarding and `setup.sh` `ANTHROPIC` reference: verify the forwarded env matches the documented provider setup; fix the stale reference.

## NIT

- Render-time `sessionRef` assignment — `app/src/App.tsx:93`. Move out of the render path.
- `describeIntent` unknown recipient — `agent/src/loop.ts:58-61`. Handle or document the fallback wording.
- `agent/src/tools/payment.ts:7` stale A5 pointer. Update the comment.
- `app/src/lib/chain.ts:23` singleton approver flag for Touch ID. Note the replacement point for the real approver.
- `withdrawTry` not a `ChainTool` (`stellar/src/anchor/chainTools.ts:108`) — recorded correctly as unmapped; keep the note so nobody misreads the ChainTool set.
- Fake MCP `JSON.parse` guard: the test fake's `readBody` + `JSON.parse` would throw on an empty POST; fine (only the client posts), but a `try/catch` → 400 would make future failures legible.
- Setup/env notes: align `setup.sh` and env docs with the actual provider variables.

## Explicitly fine (do not "fix")

- Secrets stay server-side: `app/src-tauri/src/agent.rs`, `app/src-tauri/src/stt/groq.rs`, `app/src-tauri/src/tts/fish.rs`, Vite `envPrefix` config, empty `apiKey` client-side — verified by inspection.
- Approval ordering pinned: `agent/src/execution.ts:137-175` + test `agent/src/execution.test.ts:59-79`, `agent/src/loop.ts:103-123` — tool never runs before approval.
- MCP fails closed + unwired in production: `agent/src/mcp/bridge.ts:98-177`, `agent/src/llm/config.ts:46-58` — read-only policy, deny-by-default, no production wiring.
- Hotkey latch: `app/src-tauri/src/gesture.rs:102-199` — overlapping presses handled.
- Capture stop 1.5s cap holds.
- depositTry is `ChainTool`-typed and `withdrawTry` unmapped — honest as-typed; only the surrounding prose overstated (see M8).
- Pluggability for Owner B: `ChainToolSet` as `Partial<Record<…>>`, `app/src/lib/chain.ts:36-41` tool map, `raw_tx` unsupported is honest.
- Placeholder is loud (not silent): auto-approve is clearly marked as a placeholder.
- `stellar/` and `contracts/` untouched: `git diff --stat` empty for those dirs (beyond the reviewed depositTry signature surface).
- Suites pin behaviour: ScriptedLlm / FakeSpeaker / loopback MCP / real WAV fixtures, with regression pins (STT-gap collapse, synthesis-failure settle, latest-wins speech, read-only MCP policy, approval-before-tool ordering).
- Comment quality high throughout (why-not-what; error label/detail split).

## What was checked

Per reviewer reports, collectively:

- Full `git diff origin/main...HEAD --stat` plus focused reads: `app/src/App.tsx`, `app/src/lib/turnSession.ts` + tests, `app/src/lib/speech.ts`, `app/src/lib/chain.ts`, `agent/src/loop.ts`, `agent/src/speech.ts`, `agent/src/execution.ts` + tests, `agent/src/mcp/bridge.ts` + `client.ts`, `agent/src/tools/payment.ts`, `agent/src/llm/openai.ts` + `config.ts`, `app/src-tauri/src/stt.rs`, `capture.rs`, `tts/player.rs` + `tts.rs`, `gesture.rs`, `agent.rs`, `commands.rs`, `hotkey*.rs`, `env.rs`, `notch.rs`, `events.rs`, `types.rs`, `interfaces/src/index.ts`, `stellar/src/anchor/chainTools.ts` (depositTry surface), `backlog/2026-09-19-a9-execution-seam.md` (handoff claims), e2e `e2e-speak.ts`, `setup.sh`.
- Test-quality pass: no tautological asserts found; fakes exercise real paths; regression tests fail on regress.
- Readability/conventions pass: naming, comment why-vs-what, error label/detail split, log-secret hygiene by inspection.
- Security posture spot-check: server-side secrets, MCP fail-closed, approval-before-tool ordering.

## What was NOT checked

- Live mic capture / hotkey feel / notch visuals / on-device STT permission flow / Fish timing / packaged (signed) build behaviour.
- Test/build counts relied on coordinator reports; suites were not rerun for this synthesis.
- `stellar/` and `contracts/` internals beyond the depositTry signature surface referenced above.
- Performance claims (e.g. 79ns figures), TTS latency figures, and bundle-size figures.
- Provider request shapes against vendor docs beyond code comments.
- Capture/hotkey audio paths beyond key-grep sampling.

## Handoff note

Safe to merge for the stubbed demo. Fix M1–M11 before Touch ID / the first real `ChainTool` lands: the turn-id guard, utterance-while-busy, superseded-capture, and speaking-watchdog races (M1–M4), the auto-approval-to-dispatch wiring and approver contract holes (M5–M7, M9), the depositTry prose overstatement (M8), and the real-audio-test plus caller-side test gaps (M10–M11).
