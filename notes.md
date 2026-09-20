# notes.md — Idea & Discussion Notes

> This file is the project's memory. **Every idea** that comes up and **every discussion** held is recorded here as a dated note.
> **No note, idea, or decision is ever forgotten or deleted.** If a decision changes, an update is appended below the old note without striking it through.
> All notes are written in **English**, regardless of the conversation language.
>
> Format:
> ```
> ## YYYY-MM-DD — <Topic Title>
> - **Idea:** ...
> - **Discussion:** ...
> - **Decision:** (if any) ...
> - **Status:** [open | decided | shelved]
> ```

---

## 2026-09-19 — Project Bootstrap
- **Idea:** Project infrastructure set up: CLAUDE.md/AGENTS.md constitution, backlog system, report archive, model ladder, sprint tracking.
- **Decision:** Primary model acts as coordinator; all execution happens in parallel workers. Worktree + PR + mandatory review. Caffeinate for all long-running operations.
- **Decision:** Single-repo model — origin = `n0tnow/StellarVoiceControlProject` (shared repo), fork = personal backup only.
- **Decision:** All documentation is written in English, even when prompts/conversations are in Turkish.
- **Note:** Project topic, architecture, and technical research are being handled by another team member; results will land in `docs/reports/`.
- **Status:** decided

## 2026-09-19 — Architecture Decision (Polaris)
- **Idea:** Desktop app architecture for the Stellar Pro Hackathon (Genesis track, deadline 20 Sep 12:00).
- **Decision:** Full decision recorded in `docs/architecture.md` (registered in `docs/reports/INDEX.md`). Tauri v2 shell with thin Rust core (hotkey, audio/screen capture, Keychain + Touch ID custody) + TypeScript/React (Vite, Tailwind, shadcn/ui) webview; decision is spike-gated with Electron fallback. Soroban contract `polaris_guard` enforces spending policy on testnet.
- **Status:** decided

## 2026-09-19 — Owner A UX Vision: Notch Companion UI
- **Idea:** Polaris lives in the MacBook notch as an always-present companion. Six core UX features (Owner A's part; reference screenshots provided, visually similar to "HeyClickey"-style notch assistants):
  1. **Idle notch pill:** A black, rounded, pixel-perfect area flush with the notch, always visible even in idle state. (Ref: plain black bar hugging the notch.)
  2. **Hold-to-talk hotkey (Ctrl+Option):** While held, the assistant listens; the notch area expands horizontally (left + right) with an animated state. A short status label is shown — e.g. `Listening`, `Thinking`, `Sending`, `Speaking` — with a small animated indicator (Ref: "Thinking" state with purple gradient + pulsing dots; "Speaking" state with orange waveform bars).
  3. **Mouse-following caption pill:** When an operation runs, a button/pill appears next to the user's mouse cursor and smoothly follows it, showing the transcript of the spoken conversation. (Ref: green "YouTube Premium" pill.)
  4. **Companion cursor:** The AI has its OWN cursor, used to point at / highlight relevant spots on the screen. (Ties into M2 A4 — computer use / screen awareness.)
  5. **Expandable notch workspaces:** For required operations the notch can expand into larger in-notch interfaces (cards, controls). The concrete list of these interfaces is TBD — **to be discussed in a follow-up session.** (Ref: "Your Mac is muted — answer on clipboard, ⌘V to paste" card with an Unmute action button and close button.)
  6. **Text input mode (double-tap Ctrl):** Double-pressing Ctrl expands the notch into a text input field so the user can type to the AI instead of speaking. Includes mute toggle, attach (📎) and send buttons, close button. (Ref: "Ask HeyClickey…" input bar.)
- **Discussion:** These define the visual/interaction layer of the voice pipeline track (M2 A0–A5 harness UI evolves into this notch companion). Research tasks will be requested in a new session (native macOS notch window approach vs Tauri overlay, expansion animation, cursor-following window, companion cursor rendering).
- **Status:** open (concept recorded; research pending)


## 2026-09-19 — Two-Person Review & Merge Workflow (Main Branch Strategy)
- **Idea:** With only two collaborators and no capacity for continuous, synchronous code review, define a lightweight but mandatory PR review workflow for merging into `main`.
- **Discussion:** The constitution's mandatory-review rule (author never reviews own code) is satisfiable in a 2-person team: each person reviews the other's PRs. Review must be asynchronous and timeboxed rather than blocking, especially under the hackathon deadline (20 Sep 12:00). A fast-track path is needed for urgent fixes so review never becomes the bottleneck.
- **Decision:**
  1. **Async review with SLA:** Open a PR for every change; the other person reviews at fixed checkpoints (morning / evening) or within ~12 hours, whichever comes first. No real-time availability required.
  2. **Small PRs:** One logical change per PR (code + its doc updates together), so a review takes minutes, not hours. Draft PRs are opened early so the reviewer can follow along while work is in progress.
  3. **Merge style:** Squash-merge into `main` (one clean commit per PR), delete the feature branch after merge. `main` must always be green/deployable: CI passing + at least 1 approval (the other person) before merge.
  4. **Fast-track (deadline exception):** For urgent bug fixes or time-critical changes, the author may self-merge with the `review-after-merge` label + a short written risk note in the PR description; the other person reviews it post-merge within the next checkpoint. Not allowed for new features or anything touching secrets/key handling.
  5. **Trivial changes (docs, typos, comments):** May be merged without approval, but still via PR so history stays traceable.
  6. **Conflict avoidance:** As per constitution, parallel work stays in separate worktrees/branches with non-overlapping file scopes; rebase onto `main` before requesting review if the branch has drifted.
- **Status:** decided

## 2026-09-19 — Research: Genesis prior-art + Raven/Stellar feasibility (two reports archived)
- **Idea:** Two research reports completed and archived in `docs/reports/` (registered in `docs/reports/INDEX.md`): `2026-09-19-raven-stellar-feasibility.md` and `2026-09-19-hackathon-prior-art.md`.
- **Findings (Raven / Stellar feasibility):**
  - Raven is SDF-operated; canonical endpoint is now `raven.stellar.org` (both hosts work). OAuth PKCE + dynamic client registration accepts a loopback redirect → ~2–4h Tauri integration, or the `npx mcp-remote` sidecar.
  - LumenLoop MCP is no longer auth-free (WorkOS OAuth), so it is not a simpler fallback; Scout MCP (stdio) has no auth.
  - Mock anchor is live and the treasury is funded (~26.6k USDC). SEP-6 `/sep6/info` shows 0.5–300 vs the guide's 50–3000 units — discrepancy must be reconciled. SEP-38 uses `sell_asset`/`buy_asset`.
  - Both Soroswap and DeFindex SDKs require API keys → protocol integration is cuttable.
- **Findings (prior art / hackathon reality check):**
  - Prior art is crowded except voice-first: no voice-first build found in 1,348 indexed Stellar hackathon builds (search-based evidence). SpendGuard ≈ `polaris_guard` concept; Verbex ≈ conversation-to-DeFi; MPP was the previous hackathon's theme.
  - Recommended MVP: voice → anchor TRY→USDC → guard-routed payment → Touch ID → explorer link + one deliberate on-chain over-limit rejection. Ordered cut list: P2P, dev mode, screen control, notch polish, MPP, premium TTS, passkeys.
  - Reconcile/verify the 20 Sep 12:00 deadline and shortlist criteria with organizers.
- **Follow-ups (docs):** `docs/architecture.md` facts to correct: Raven ownership/canonical host, `skills.*` family missing from the MCP catalog list, LumenLoop auth, Scout tool count, SEP-38 field names, SEP-6 amount units.
- **Status:** open (follow-ups: deadline/criteria verification, architecture.md corrections)

## 2026-09-19 — Monorepo Skeleton Landed (first code)
- **Idea:** Land the first code in the repository: the monorepo skeleton for all layers, so both owners can start their step-by-step tracks (M2 A0–A5 for Owner A, chain work for Owner B) without waiting on each other.
- **Discussion:** Done directly by the coordinating agent in one worktree (`feat/monorepo-skeleton`) instead of parallel workers — the two-person async review workflow (§notes 2026-09-19) still applies: one branch, one PR, one review. The skeleton had to be *verifiable*, not empty folders: every layer typechecks/builds, and the shell already carries the typed event stream end to end.
- **Decision:**
  1. **Workspaces:** root npm workspaces (`interfaces`, `agent`, `stellar`, `app`); npm (not pnpm/bun) so one toolchain covers the repo; Node 22 pinned via `.nvmrc`.
  2. **Pinned versions:** TypeScript 7.0.2, React 19.3.0, Vite 8.3.0, Tailwind 4.3.3 (`@tailwindcss/vite`), Tauri crates 2.11.5 / `tauri-build` 2.6.3, `@tauri-apps/api` 2.11.1, `@tauri-apps/cli` 2.11.4, Soroban SDK 28.0.0.
  3. **`@polaris/interfaces` is source-only** (`exports` → `src/index.ts`, no build step); Vite + tsconfig alias it. It carries the seam types plus exactly two runtime values: `POLARIS_EVENT_NAME` and `isPolarisEvent`.
  4. **Rust mirror of the seam:** `app/src-tauri/src/types.rs` (`Intent`, `TxSummary`) and `events.rs` (`PolarisEvent`). Wire shape is pinned by unit tests — snake_case type tags, camelCase fields (`rename_all_fields = "camelCase"`), e.g. `{"type":"hotkey","state":"down"}`.
  5. **Event channel name is `polaris-event`** (alphanumerics + dash only) to stay clear of Tauri's event-name validation rules.
  6. **`contracts/` is a separate Cargo workspace** from `app/src-tauri`, so a Soroban wasm build never pulls the desktop dependency tree (and vice versa).
  7. **Step A0 harness is partly pre-wired:** the shell window, log pane and `dev_self_test` command exist so the stream can be exercised by hand; the command is explicitly temporary and is deleted when the real hotkey + microphone land.
  8. **No CI yet** (hackathon): `make check` / `scripts/check.sh` is the gate (typecheck all workspaces → vite build → agent smoke test → `cargo check`), with `caffeinate -i` for the long parts per AGENTS.md §4.
  9. **Icons are generator-produced** (`scripts/generate-icons.py`, stdlib only): the PNG set + `.icns` are committed because Tauri needs them at compile time, but the script is the source of truth — never hand-edit the binaries (`--check` verifies presence).
- **Gotcha found (worth remembering):** Vite 8 is rolldown/Oxc-based and **no longer bundles esbuild** — an explicit `build.minify: "esbuild"` fails with `Cannot find package 'esbuild'`. Leave the minifier at its default (Oxc) or install esbuild deliberately.
- **Gotcha found (worth remembering):** as of soroban-sdk v28 a plain `cargo build --target wasm32v1-none` is **refused on purpose** ("soroban-sdk requires stellar-cli v25.2.0+ to build a contract"). Contract builds must go through `stellar contract build` (stellar-cli v28.0.0 is installed on the dev machine; it sets `SOROBAN_SDK_BUILD_SYSTEM_SUPPORTS_SPEC_SHAKING_V2=1`). Two follow-on requirements: `[profile.release]` must set **`overflow-checks = true`** (stellar-cli rejects the profile otherwise) and host-side `cargo test` is unaffected.
- **Status:** decided
- **Idea:** Make the version-control usage explicit for agents: commit/push intervals, when to update `main`, and when real-time coordination between the two collaborators is needed.
- **Decision:** Documented as §9 in AGENTS.md/CLAUDE.md:
  1. **Commit** after every completed logical step (atomic, single-topic) — no timer-based commits.
  2. **Push** the working branch at the end of every task/session; work never stays local-only.
  3. **`main` is PR-only** (squash-merge per the async review decision); every agent pulls/rebases `main` at task start.
  4. **SemVer starts when code lands:** root `VERSION` + `CHANGELOG.md`, `v0.x.y` tags per milestone (MINOR = feature, PATCH = fix); coordinator cuts tags, agents never tag.
  5. **No real-time coordination for routine commits/pushes** — face-to-face/DM only for scope changes, merge conflicts, milestone completion, or touching files someone else is actively editing.
  6. `.gitignore`-d files stay clone-local; `.gitignore` itself must be identical across all clones.
- **Status:** decided

## 2026-09-19 — A0: Push-to-Talk + Notch Overlay (decisions)
- **Idea:** Implement step A0 as the notch-companion shell (not the skeleton dashboard): a
  transparent always-on-top overlay at the physical notch, a global hold-to-talk hotkey, and
  microphone capture to a WAV, all driven by the typed `PolarisEvent` stream.
- **Discussion:** The design reference's `notch-design.md` says "Replace the A0 dashboard",
  so the skeleton's log pane is no longer rendered; the overlay's state is the harness. The
  task's claim that `audio_captured` "already exists on main" was wrong — `main` only had the
  `hotkey` variant — so `capture_status` and `audio_captured` were both added.
- **Decision:**
  1. **Hotkey:** `control+option+space` via `tauri-plugin-global-shortcut` (Carbon supports the
     Released event on macOS). The modifier-only Ctrl+Option gesture is a separate follow-up
     needing a native `flagsChanged` observer + Accessibility permission.
  2. **Capture:** `cpal` on a dedicated thread (avoids `Stream: Send` per-platform questions),
     normalized to 16-bit PCM and written with `hound`; `stop` waits briefly for finalization
     so release yields a final `ready`.
  3. **`ready` is not a send.** Release only stops/lands the WAV; no submit path exists in A0.
     The wire `ready` state persists for A1, while the overlay collapses after a 6 s dwell.
  4. **Overlay geometry from AppKit** (`safeAreaInsets` / auxiliary top areas), main-thread
     only, with a centered-pill fallback; display changes are caught by a 2 s UI poll.
  5. **Version pairing:** objc2 crates pinned to the generation tauri 2.11.5 already links
     (objc2 0.6.4 / app-kit 0.3.2 / foundation 0.3.2) — verified with `cargo tree -i objc2`.
- **Status:** decided

## 2026-09-19 — Notch shape fix (idle must coincide with the cutout)
- **Idea:** The A0 overlay was visible but did not match the physical camera housing; it read as a
  separate black blob. Make the idle pill coincide with the cutout and make the expanded shell grow
  out of it with correct asymmetric corners (step after A0 on the same branch).
- **Discussion:** Two causes. (1) `notch.rs` inflated the measured housing: 179x32 became 199x36
  (`housing + 20`, `safe_top + 4`). (2) `index.css` hardcoded `border-radius: 0 0 25px 25px` and an
  18 px shoulder that was present even at rest. Research: hardware cutout corners are ~4 pt (top) /
  ~8 pt (bottom) and the bottom flares wider (notchbay.com); boring.notch's `NotchShape` defaults
  to a 6 pt concave top ear and 14 pt convex bottom.
- **Decision:**
  1. Idle geometry is the measured cutout, no inflation. **Do not overdraw the ~5 pt menu-bar
     margin**: macOS already draws that strip behind our transparent window; painting black into a
     light menu bar is the blob failure we are removing.
  2. Four radii (`pillTop`, `pillBottom`, `shellEar`, `shellBottom`) are derived in Rust from the
     measured heights and flow through `NotchGeometry` → React → CSS custom properties; no CSS px
     constants decide the shape.
  3. Keep the CSS radial-gradient ears (parameterised by a registered `@property --ear`, zero while
     idle) rather than a single SVG path: CSS transitions width/height/radius together without
     per-frame JS, and reproduces the top-concave / bottom-convex silhouette.
  4. Do not regress A0: capture, hotkey, event stream, state machine, and the native window
     placement/level/collection/click-through are untouched.
- **Status:** decided (user visual check on the real display still pending)

## 2026-09-19 — A1: Cloud-first STT (Groq), retention, and the language choice
- **Idea:** Implement step A1 (speech-to-text) under a hard deadline: turn the A0 WAV into a
  transcript, show "Thinking" in the notch while it runs, and never paint the transcript in the
  overlay.
- **Discussion:** The A1 checklist originally said "local `whisper.cpp` (Metal) first; cloud API
  fallback only if quality fails". The user overrode that for the deadline: **cloud first**
  (Groq `whisper-large-v3-turbo`), with the code shaped so a local backend drops in later without
  touching call sites. The A0 review also assigned the missing WAV retention policy (MAJOR-3) to
  A1.
- **Decision:**
  1. **Cloud-first, one trait.** `stt::Transcriber` (`transcribe(&Path) -> Result<Transcription,
     SttError>`) is the seam; `GroqTranscriber` is the only impl today. A `WhisperCpp` impl needs
     no changes outside `lib.rs`. `Transcriber` is deliberately one method — not a plugin system.
  2. **Auto-detect the language.** No `language` param by default, even though Groq's docs say an
     explicit hint improves accuracy/latency. Commands are code-switched (Turkish sentence +
     English entities like `USDC`), and forcing `tr` would phoneticise those entities, which are
     exactly what the chain parser needs. `POLARIS_STT_LANGUAGE=tr` overrides.
  3. **The transcript is not UI.** It travels on the existing `transcript { text, final }` event
     and is printed to the Rust terminal; the overlay shows only "Thinking". The ear is ~92 pt and
     the camera housing has no pixels, so text visual design waits for A2.
  4. **Key handling.** `GROQ_API_KEY` from the environment, with an optional gitignored `.env`
     walked up from the working directory. Real environment variables win; the value is never
     logged or written. Missing key is a runtime state, not a crash: overlay "No STT key",
     terminal instructions, capture unaffected.
  5. **Retention = delete-on-success + cap 10.** A successfully transcribed WAV is deleted; a
     failed one is kept (only copy); the directory is pruned to 10 newest otherwise.
  6. **`CaptureStatus` gains `label`.** A short, overlay-safe label for A1 failures ("No STT
     key", "Net error", …). A0 microphone errors keep `label: null` and the generic "Mic error".
- **Status:** decided (implemented on `feat/a1-stt`; real-provider latency and the 5-command
  acceptance run still need a key and the user's voice — see
  `backlog/2026-09-19-a1-stt.md`)

<!-- New notes are appended chronologically at the bottom. -->

## 2026-09-19 — A1: On-device STT becomes the default (privacy rationale)
- **Idea:** Replace "cloud-first" as the A1 default with Apple's on-device
  `SFSpeechRecognizer`, keeping Groq as an explicit opt-in and a configured fallback.
- **Discussion:** The user overrode the earlier cloud-first choice. The decisive argument is not
  cost or latency but the product: **Polaris is a wallet**. A spoken command ("send 10 USDC to
  Ada") is financial intent, so the architecturally correct default is to keep the audio on the
  machine. On-device is also free forever, works offline and needs no API key. The verified
  machine facts (macOS 27, M3): `tr-TR` and `en-US` report `supportsOnDeviceRecognition = true`,
  `SFSpeechURLRecognitionRequest` accepts a file URL, and `requiresOnDeviceRecognition` /
  `contextualStrings` / `taskHint = .dictation` are all accepted; Speech permission is currently
  `notDetermined`, so the user will see a prompt on first use.
- **Decision:**
  1. **On-device is the default.** `POLARIS_STT_BACKEND` (`ondevice` | `groq`) selects; blank or
     unknown resolves to `ondevice` (unknown also raises a warning). `POLARIS_STT_LOCALE` overrides
     the locale, default fixed `tr-TR`.
  2. **The fallback is narrow and loud.** Groq is attached only when a key is configured, and it
     fires only when the recognizer reports `Unavailable` *before* any audio was recognized. A
     mid-flight failure is surfaced, never silently uploaded. Every fallback prints that the audio
     left the machine.
  3. **Force on-device.** `requiresOnDeviceRecognition = true` so audio cannot reach Apple's
     servers either; if `supportsOnDeviceRecognition()` is false the backend refuses to run.
  4. **The locale is a conscious cost.** `SFSpeechRecognizer` is single-locale (no Whisper-style
     auto-detect), so `tr-TR` is fixed and overridable; the known cost is that English-only
     utterances may be phoneticised as Turkish. `contextualStrings` (USDC, XLM, Stellar, Soroban,
     lumen, testnet, Polaris) keeps the wallet entities correct.
  5. **Permission is requested lazily** on the STT worker at first transcription, bounded, never on
     the main thread; denial degrades to the short overlay label "Allow speech" and capture keeps
     working.
- **Status:** decided (implemented on `feat/a1-ondevice-stt`; a real permissioned recognition run
  and the on-device latency/accuracy numbers are still pending a human — see
  `backlog/2026-09-19-a1-ondevice-stt.md`)

## 2026-09-19 — A2: LLM roundtrip, provider port, and keeping the key out of the webview
- **Idea:** Turn the A1 transcript into a structured, validated `Intent` with a real LLM, behind a
  swappable port, without executing anything on-chain.
- **Discussion:** The owner fixed the provider: **OpenCode Zen Go** (OpenAI-compatible,
  `deepseek-v4.1-flash`). Probing it revealed two things that shaped the design. (1) The endpoint
  sends **no CORS headers** (an `OPTIONS` preflight is a 404), so a webview `fetch` is blocked.
  (2) A naive system prompt backfires: with "Ahmet" treated as an unknown person it asks for a
  wallet address and never calls the tool; a prompt that says address-book names are valid
  recipients produces the correct `send_payment` call. The architecture diagram puts the agent
  core in the webview, but `lib.rs` is owned by A3 this round, so no Rust proxy/command could be
  added.
- **Decision:**
  1. **Port over vendor.** `OpenAiCompatibleLlm` implements the existing `AgentLlm` port; the only
     provider inputs are `POLARIS_AGENT_BASE_URL`, `POLARIS_AGENT_MODEL`, `OPENCODE_API_KEY`.
     Groq/OpenRouter are a `.env` change. The system prompt is passed through the port, so it is
     provider-independent too.
  2. **A2 stops at the intent.** `send_payment` is approval-gated and adds `toIntent()`: the loop
     validates the model's arguments and returns the shared `Intent`; `run()` is never called for
     it. A rejected argument set becomes a clarification, not a bogus intent; `tool_choice:"auto"`
     is kept so off-topic commands produce no call.
  3. **Key never in the webview.** `OPENCODE_API_KEY` is read only in Node: the agent CLI uses it
     directly, and the webview calls a same-origin `/agent-api` path that the Vite dev server
     proxies to the provider with `Authorization` injected server-side. Verified the built bundle
     contains neither the key nor the provider URL. (Production moves this proxy into Rust.)
  4. **Errors mirror A1.** A short UI label plus a full detail (`agent/src/errors.ts`), so the
     console keeps the provider's status/body while the trace stays one line.
  5. **The intent is not a new wire event.** `interfaces/` and the Rust event mirror are untouched
     (no new `PolarisEvent` variant); `runTurn` returns the intent in `AgentTurnResult` and the UI
     renders it from React state below the notch.
- **Status:** decided (implemented on `feat/a2-llm`; real-provider CLI verified — `Ahmete 5 USDC
  gönder` → `send_payment(5, USDC, Ahmet)` in ~2.1 s, `bugün hava nasıl` → clarification; the
  in-app Rust→React→agent path still needs a human with a mic — see
  `backlog/2026-09-19-a2-llm.md`)

## 2026-09-19 — A3: TTS provider and voice-stability decisions
- **Idea:** Add spoken output. Provider chosen by the owner: **Fish Audio**
  `s2.1-pro-free` as primary (free tier, Turkish, no card), with **local macOS
  `say`** as a mandatory fallback.
- **Discussion:** The free Fish tier is time-limited (available until 2026-11-30)
  and explicitly has **no SLA**, so a silent assistant is a real demo risk. The
  fallback is therefore broader than A1's: it fires on any Fish failure, not just
  a narrow pre-flight one, at the cost of a different voice for that utterance.
- **Decisions:**
  1. **Mirror A1's seam.** A `Speaker` trait with `fish.rs` + `local.rs` behind it
     and `build_backend()` selecting from `POLARIS_TTS_BACKEND` (`fish` default,
     `local` opt-in); unknown values warn and use `fish`.
  2. **One fixed voice, enforced.** Fish selects the engine with the `model`
     header and the voice with body `reference_id`. `POLARIS_TTS_REFERENCE_ID` is
     therefore required; if it is missing the request is never sent and local
     speech is used, so the voice can never drift between requests.
  3. **Playback stays dependency-free.** Fish audio bytes go to a temp file and
     macOS `afplay` plays them; the local backend's `say` synthesizes and plays in
     one step.
  4. **No TS seam change.** Failures reuse the existing `error` event with a short
     label; a dedicated `speech_status` event is left to A2 if the UI wants one.
- **Status:** implemented on `feat/a3-tts` (96 tests, clippy clean). Correction:
  the live Fish call **was** verified in the A3b follow-up — the `.env` did hold a
  real key, and `manual_live_fish_synthesises_mpeg_and_speaks` produced non-empty
  MPEG audio and played it (`polaris: tts in 8743 ms via fish`) — see
  `backlog/2026-09-19-a3-tts.md` §A3b.

## 2026-09-19 — A4: the agent answers out loud (intent/clarification → speech)
- **Idea:** A2 produced an `Intent` and A3 could `speak`, but they never touched.
  Close the loop: whatever the agent says back to the user is spoken.
- **Decisions:**
  1. **The sentence is built in TypeScript, not Rust.** `agent/src/speech.ts` owns
     `confirmationSentence(intent)` and `spokenText(result)`; the shell passes the
     finished string to the existing `speak` command. An `Intent` is therefore
     formatted in exactly one place, and Rust stays a dumb player.
  2. **What is spoken.** A produced intent → a short confirmation
     (`Sending 5 USDC to Ahmet. Do you confirm?`). A turn with no intent → the
     answer text (the clarification). An internal error → **nothing** (it is
     already a short UI label). Blank text is dropped.
  3. **Non-blocking.** The visible result is set before speech is queued, and
     `speakTurnResult` returns immediately; a slow (~3–9 s) Fish call never delays
     the transcript or the intent, and a TTS failure is swallowed into a console
     warning, never the UI.
  4. **Overlap: never overlap; one in flight + one pending; latest-wins.** A newer
     pending utterance replaces an older one; in-flight audio is not interrupted
     (no cancellation seam in the Rust player). This is the `SpeechQueue` policy in
     `agent/src/speech.ts`, unit-tested.
  5. **No seam change.** No new `PolarisEvent`; only a new TS module, its export, a
     webview helper and one call in `App.tsx`.
- **Verification:** an opt-in E2E (`npm run e2e:speak -w @polaris/agent -- "…"`)
  ran the **real** LLM → intent → `spokenText` → real Rust Fish path with the pinned
  voice `933563129e564b19a115bedd57b7406a` (`polaris: tts in 8743 ms via fish (40
  chars)`). An earlier attempt with `--exact` matched no test and falsely passed;
  the driver now fails unless the output contains `via fish`. The in-app
  mic→speech path still needs a human — `backlog/2026-09-19-a4-speak-intent.md`.
- **Status:** implemented on `feat/a4-speak-intent` (agent 38 tests, TS typecheck +
  build green, Rust 96 passed / 2 ignored, clippy clean).

## 2026-09-19 — A5: the conversational turn speaks, "Speaking" notch, faster audio
- **Owner-observed bugs (real run):** saying "hello can you hear me" produced no
  answer and no speech — the model answered fine, downstream dropped it — and a
  full run took 14.9 s to audio (`intent 4538 + speak 10336 ms`).
- **Root cause of bug 1:** nothing was dropped in the app; the failure was that
  **all three consumers of a turn treated "no intent" as "nothing to say."**
  `agent/src/e2e-speak.ts` exited non-zero before ever reaching TTS on a valid
  conversational turn, and the app had no `speak` call on that path. `spokenText()`
  already handled the no-intent case correctly (A4 had tested it in isolation), so
  the bug was in the *decision*, not the formatter. The fix makes the predicate
  explicit (`isSpeakable`) so "no intent" can never again mean "silent", and the
  conversational path is now exercised live.
- **Decisions:**
  1. **A `speech_status` event, emitted by the Rust `speak` command.** `speaking`
     is emitted as the sentence is handed to the backend; `idle` is emitted on
     **both** the success and failure paths, and the overlay additionally clears on
     a new recording. The notch therefore tracks real playback, not the request,
     and cannot get stuck.
  2. **"Speaking" reuses the Thinking animation verbatim** (`.state-speaking` shares
     the `listen` keyframes) — the owner asked for the same treatment, not a second
     style. It is only shown while capture is idle, so a live recording/ready/error
     state always wins.
  3. **Fish audio is streamed, not buffered.** The body is piped into `ffplay`'s
     stdin (`-autoexit -nodisp … -f mp3 -i pipe:0`), so playback starts at roughly
     the provider TTFB. `ffplay` is resolved from PATH + the two Homebrew prefixes
     (a GUI launch does not inherit the shell PATH); when it is absent the pre-A5
     `afplay` + temp-file path is used, so nothing regressed on a machine without
     ffmpeg. `afplay` was tested with a FIFO and rejected: it needs a seekable file.
  4. **Model default → `glm-5.3-flash`** (owner benchmark: median 1857 ms vs 2085 ms,
     both always correct, 0 reasoning tokens). Still env-driven; no bare literal in
     product logic — only the last-resort default constant moved.
  5. **The prompt and tool payload were trimmed for tokens, not latency.** `noop`
     (the demo round-trip probe) left the default registry — it was serialised into
     *every* request — and the system prompt was shortened. Estimated request
     payload ~466 → ~366 tokens. The median model latency did **not** move beyond
     noise (it is network-bound); no false speed-up is claimed.
- **Verification:** both live E2E paths pass with the real LLM + real Fish +
  pinned voice `933563129e564b19a115bedd57b7406a` — conversational
  ("yes, I can hear you" → spoken), intent (`Ahmete 5 USDC gönder` → confirmation).
  Rust test count rose 96 → 100 (new player/event tests). The in-app
  mic→notch→speech path still needs a human with a microphone.
- **Status:** implemented on `feat/a4-speak-intent` (agent 39 tests, TS typecheck +
  build green, Rust 100 passed / 2 ignored, clippy clean) —
  `backlog/2026-09-19-a5-latency-and-speaking.md`.

## 2026-09-19 — A6: the webview could not reach the provider (WebKit receiver bug)
- **Owner-observed bug (real run):** after a correct transcript, the notch showed
  `NET ERROR could not reach the model provider at /agen…` and the trace stayed on
  `glm-5.3-flash · thinking`.
- **Actual cause (quoted from the live app):**
  `could not reach the model provider at /agent-api: Can only call Window.fetch on
  instances of Window`, at `latencyMs: 1`. It is not a network failure: the client
  stored `globalThis.fetch` in a field and called it as `this.#fetch(...)`, making
  the client instance the receiver; WebKit enforces the WebIDL receiver for
  `Window.fetch` and rejects the call before any request. Node (undici) and a
  direct `fetch(...)` call are both fine, which is why the CLI and the
  coordinator's browser check passed. Reproduced in a bare WKWebView: an unbound
  call returns 200, `{ f: fetch }.f('/')` returns the exact TypeError.
- **Decision — move the transport into Rust, not just patch the receiver.** A
  one-line receiver fix would only have repaired the dev proxy path; the Vite
  `/agent-api` proxy was dev-only (flagged in A2), so a packaged Polaris would still
  have had no provider route. `agent_chat` in `app/src-tauri/src/agent.rs` now owns
  the URL and the key, and the webview only sends the JSON body + session id. The
  TypeScript client keeps request building, the error taxonomy and parsing — only
  the transport moved. The `/agent-api` proxy and the key loading were deleted from
  `app/vite.config.ts`; the receiver bug was also fixed in `openai.ts` so the shared
  client is safe in any browser. This closes the A2 packaging handoff.
- **Stuck notch:** `loop.ts` emitted `agent_status: done` only on success, so a
  failure left the stage on `thinking`; it now emits `done` in a `finally`, and
  `App.tsx` shows the agent failure's short label in the notch for the A1 dwell then
  collapses. Both have regression tests.
- **Verification:** live in-app turn through the Rust command —
  `polaris: agent → provider HTTP 200 in 2029 ms`, intent `{send 5 USDC Ahmet}` in
  `2039 ms`; a forced transport failure produced notch `label "Net error"`,
  `class "notch is-expanded state-error"`, trace `· done`. Agent tests 39 → 40,
  Rust 100 → 104; typecheck, build and clippy clean.
- **Status:** implemented on `feat/a4-speak-intent` — packaged launch and the human
  mic run are still unverified. `backlog/2026-09-19-a6-webview-agent-transport.md`.

## 2026-09-19 — A8: one continuous notch session, no debug panel
- **Owner feedback:** the shell collapses to the idle pill in the middle of a turn,
  and the `<AgentTrace>` box under the notch looks like debug UI and should not be
  on screen.
- **Root cause (already traced):** capture returns to `idle` *before* the final
  transcript is emitted, and `speakingVisual` could not appear until capture was
  idle again; with the `ready` dwell collapsing the shell too, nothing held it
  open between "recording finished" and "audio starts" — it shrank, then re-expanded.
- **Decision — model a turn as one explicit session, not several overlapping
  visuals.** `app/src/lib/turnSession.ts` is a pure reducer: a session starts at
  capture `recording` (hotkey down) and ends exactly once, at `speech_finished` or
  after a failure's `settled` dwell. Capture `ready`/`transcribing`/`idle` only
  advance or hold the stage, so `idle` (the STT gap) no longer collapses the shell.
  Stages: `listening → thinking → checking → speaking`; `checking` is the owner's
  suggested name for the intent-validation phase. Timing (5 s failure dwell, 60 s
  stuck-turn watchdog) stays in `App.tsx` and arrives as signals, keeping the
  machine deterministic.
- **Decision — cross-fade the label and share one indicator treatment.** A plain
  text swap is a hard cut; `StageLabel` keeps the outgoing label on top for 240 ms
  while the incoming one fades in. Thinking/checking/speaking now share a single
  CSS rule for the bars so they never restart between stages. No width change per
  stage: one open at turn start, one close at turn end.
- **Removed:** `AgentTrace.tsx`, the already-unused `EventLog.tsx`, their CSS, and
  the dead `LogLine`/`describeEvent`/`makeLine`/`nowLabel` helpers plus
  `subscribeAgentEvents`. Diagnostics stay in the console and the Rust terminal.
- **Verification:** app stage-machine tests 0 → 9 (`node:test`; a successful turn
  never yields an idle/collapsed visual, a failing turn settles exactly once);
  agent 40, Rust 104 passed / 2 ignored, clippy clean, typecheck + build green.
  The dev app is left running for the coordinator.
- **Status:** implemented on `feat/a4-speak-intent`. **The visual animation was not
  observed** (no screen) — the state machine is proven by tests; the on-screen
  smoothness still needs a human eye. `backlog/2026-09-19-a8-notch-session.md`.

## 2026-09-19 — A9: honest stages, the intent execution seam, read-only MCP
- **Owner-observed bug:** the notch showed **"Speaking" before any audio started**.
- **Root cause:** `commands.rs::speak` emitted `speech_status: speaking` the moment
  it dispatched the blocking synthesis, so the whole Fish synthesis wait (~2–3 s)
  read as speaking. Two more impostors in the A8 turn session: `transcribed`
  jumped straight to `checking`, so the entire model call wore a "Checking" label,
  and the "Speaking" transition was effectively request-driven.
- **Decisions:**
  1. **The Rust backend owns the real start event.** The `Speaker` seam gained a
     one-shot `PlaybackStart` callback; Fish/ffplay fires it after the first
     decoded chunk reaches the player, afplay/`say` after a successful spawn, and
     `FallbackSpeaker` latches it so the primary→fallback handoff cannot
     double-announce. A synthesis failure emits only `idle` — never `Speaking`.
  2. **`thinking` is the honest home for every wait.** The stage holds from
     capture release through the model call and the TTS synthesis wait; it is
     entered by the agent's real `agent_status: thinking` event (forwarded per
     turn), not a shell guess. "Speaking" is reachable only via the real
     playback-start event.
  3. **`checking` is removed.** The `awaiting_approval` phase is a synchronous,
     I/O-free validation (`parseSendPayment`) measured at **~0.00008 ms/call**;
     the task says leave out a stage nobody can read. The union is now
     `listening | thinking | speaking | failed`.
  4. **One execution path, injected, never throwing.** `executeIntent(intent,
     { approver, chainTools })` resolves the tool → asks the gate → calls the
     tool, returning `executed | rejected | unsupported | unavailable | failed`.
     `NotImplementedError` is matched by name → `unavailable`/`Chain not wired`,
     the expected state today, so the notch says so and settles. The chain tools
     are injected, so the agent core imports none of Owner B's package.
  5. **Approval gate seam, not Touch ID.** `IntentApprover.approve(intent)` sits
     between "intent produced" and "chain tool called"; the shell passes a loud
     `createAutoApprovalPlaceholder()` that is the single object the biometric
     milestone replaces. Approval-gated tools still never run during the turn.
  6. **MCP scaffolding is read-only by construction.** A config-driven client
     (`POLARIS_MCP_SERVER_URL`; absent = off, no error) speaks JSON-RPC over
     Streamable HTTP (JSON + SSE), and `registerReadOnlyMcpTools` exposes only
     tools that pass a tokenised write-verb denylist **and** do not declare
     `readOnlyHint: false` **and** carry `readOnlyHint: true` or an operator
     allowlist — re-checked at call time. Tests use a loopback fake server. The
     webview wiring is deliberately left out (CORS/packaging) and said so.
- **Verification:** app 9→12 tests, agent 40→58, cargo 104→107 passed / 2 ignored,
  clippy + typecheck + build clean, stellar 178 pass untouched. Live runs pasted
  in the report: real LLM → intent → placeholder gate → `sendPayment` stub →
  `Chain not wired` (stage order `listening → thinking ×4 → failed`), and real
  Fish `tts in 5713 ms via fish` with the playback-start assertion. The initial
  JS bundle stayed small (819→241 kB) because `@polaris/stellar` is a lazy import.
- **Status:** implemented on `feat/a4-speak-intent`; the on-screen animation still
  needs a human eye. `backlog/2026-09-19-a9-execution-seam.md`.

## 2026-09-20 — A10: the demo-critical review findings closed
- **Context:** an independent review of the whole voice chain (A0–A9) returned
  APPROVE WITH FIXES — no blockers, 11 majors. The owner is demoing shortly, so
  the four races and the dangerous approval wiring were fixed first, each with a
  test that fails without it. `stellar/` and `contracts/` were not touched.
- **Decisions:**
  1. **A second utterance while the model is in flight now supersedes the
     in-flight turn (latest-wins).** The old `agentBusyRef` boolean silently
     dropped it and the shell then sat on "Thinking" until the 60 s watchdog. The
     policy is the same one the speech queue already uses, and it is a pure,
     unit-tested module (`app/src/lib/turnFlow.ts`). Refusing with a Busy label
     was rejected: it is a dead end at the exact moment the demo shows.
  2. **The approval default is fail-closed (M5).** `resolveApprover(false)`
     returns a deny-all gate; only an explicit `POLARIS_ALLOW_AUTO_APPROVE=1`
     installs the auto-approving placeholder. Rationale: the reviewer's most
     dangerous finding was that auto-approval + automatic dispatch would execute
     the first real `ChainTool` with no gesture — and `depositTry` is already
     real. The stubbed demo can opt back in, but the safe wiring is the default.
  3. **Both non-terminal stages are watchdogged (M4).** `turnSession.stageWatchdog`
     bounds `thinking` (60 s) and `speaking` (120 s); previously playback was
     trusted to end itself and a wedged player held the shell open forever.
  4. **One shared cross-turn guard (M1).** The speech path's session-id check
     became `isCurrentTurn` and the execution path now uses it too, so a stale
     execution outcome cannot overwrite a newer turn.
  5. **The biometric drop-in is scoped honestly (M6).** The approver sees only
     the `Intent`, so the seam supports intent-level gating — not the card-level
     approval that needs the post-tool `summary` + `payloadHash`. Said so in the
     seam, the shell and the A9 handoff doc.
  6. **`depositTry` is real (M8).** Corrected the "every `ChainTool` throws
     `NotImplementedError`" prose to name `sendPayment`/`swap`/`guardPolicy`, and
     documented the deposit path (unconfigured → `Chain error`; configured → real
     unsigned XDR, never submitted).
  7. **A throwing approver no longer escapes (M7).** It maps to a labelled
     `failed` / "Approval error" outcome, so the "never throws" contract is true.
- **Verification:** app 12→19, agent 58→61, cargo 107/2→107/3 ignored, clippy +
  typecheck + build clean (initial JS 242.67 kB, chain chunk lazy). Real command
  output in `backlog/2026-09-20-a10-review-fixes.md`.
- **Still open (deliberately):** M9 (confirmation spoken after dispatch) and M11
  (A9 caller-side glue untested; blank text drops without `onError`).
- **Status:** implemented on `fix/a10-review-majors`; pushed, no PR.
  `backlog/2026-09-20-a10-review-fixes.md`.

---

## 2026-09-20 — A11: measure the turn before optimising, Anthropic behind the port, reply language

- **Context:** the owner still found the whole turn slow but had no breakdown, wants
  to compare Claude Sonnet 5 / Haiku 4.5 against `glm-5.3-flash`, and reported that
  an English command was answered in Turkish by an English voice. `stellar/` and
  `contracts/` were not touched.
- **Decisions:**
  1. **Instrument first, and make it a single terminal block.** A process-global
     turn trace in Rust (`timing.rs`) is opened at the hotkey release and closed at
     playback end; the webview's phases arrive through a `polaris_phase` command, so
     the owner's terminal sees everything (the webview console does not). Behind
     `POLARIS_TIMING`, on by default while the breakdown is being established.
     Reason: the coordinator's earlier numbers were provider-side, not the app's.
  2. **Streaming playback is confirmed, not assumed.** In every real Fish run the
     `tts first audio byte` and `playback start` marks are the same millisecond and
     far before `playback end` — the app is not buffering the body before playing.
     The mark is a lower bound (ffplay's own ~0.4 s startup is not captured).
  3. **The provider's cost is time-to-first-byte.** `first byte → full response` was
     3 ms; streaming the body would buy nothing. The dominant remaining term is the
     Fish free-tier tail, which spiked to 17.6 s on one run (reported, not hidden).
  4. **Anthropic is a second implementation of the same `AgentLlm` port**, selected
     by `POLARIS_AGENT_PROVIDER`; `POLARIS_AGENT_MODEL` stays the model id. It gets
     its **own** base URL variable (`POLARIS_ANTHROPIC_BASE_URL`) because the shared
     `POLARIS_AGENT_BASE_URL` points at OpenCode Zen Go. Thinking is off for latency
     (Sonnet 5: `thinking:{type:"disabled"}`, no `budget_tokens`; Haiku 4.5: omit
     the field, never `output_config.effort`).
  5. **Rust hand-rolls the wire format, Node uses the official SDK.** The Rust
     transport is provider-aware (`x-api-key` + `anthropic-version` + `/v1/messages`
     vs Bearer + `x-opencode-session` + `/chat/completions`); the Node benchmark uses
     `@anthropic-ai/sdk`. `ANTHROPIC_API_KEY` stays in Rust/Node, never in the bundle.
  6. **The model reports the language; no detection library is added.** A `language`
     field on a tool call, or a leading `[xx]` tag on a text answer, is normalised
     and forwarded to TTS. The confirmation sentence is now localised (tr/en); before
     this it was hard-coded English, which is exactly how an English voice read
     Turkish text.
  7. **Voice choice stays the owner's.** `Speaker::speak` takes the language and
     looks up an optional `POLARIS_TTS_REFERENCE_ID_<LANG>` / `..._LOCAL_VOICE_<LANG>`
     override, falling back to the pinned voice. The pinned voice is required, so a
     language with no override can never silently change it. Fish's `/v1/tts` body
     has no language field (re-read from the API reference) — the voice is the only
     language lever.
  8. **The STT locale is the likely real root cause and needs an owner decision.**
     `POLARIS_STT_LOCALE` is unset → fixed `tr-TR`; Apple's recognizer is
     single-locale, so English speech is transcribed with Turkish orthography and the
     model answers Turkish. There is no bilingual locale and no on-device audio
     language ID; Groq's auto-detect is the cloud alternative (audio leaves the
     machine). The default was left unchanged rather than guessed.
- **Verification:** app 19, agent 91 (was 61), cargo 118/3 ignored (was 107/3),
  clippy + typecheck + build clean. Real runs: GLM bench (tr 2131 / en 1235 / chat
  1767 median, 9/9 correct), English and Turkish `e2e:speak` turns with agent-phase
  timelines and Rust TTS blocks, and a live per-language override run. No Anthropic
  numbers exist — `ANTHROPIC_API_KEY` is absent, and none were invented.
- **Still open:** Anthropic comparison (needs the key), a full in-app mic-run trace,
  the STT locale decision, and confirmation templates only for `tr`/`en`.
- **Status:** implemented on `feat/a11-anthropic-and-language`; pushed, no PR.
  `backlog/2026-09-20-a11-anthropic-and-language.md`.

---

## 2026-09-20 — A12: detected language end to end, and a hard cap on what gets spoken

- **Context:** the owner's English command was answered in Turkish by an English
  voice. A11 had made the model *report* a language and left the real root cause
  as an owner decision: the on-device recogniser is pinned to one locale, so it
  cannot identify the language at all. `stellar/` and `contracts/` were not
  touched.
- **Root cause (confirmed):** `SFSpeechRecognizer` was fixed to `tr-TR`; English
  audio was phoneticised as Turkish, so the transcript — and everything after it —
  was poisoned. Not a model or TTS bug.
- **Decisions:**
  1. **The detected language is the authority.** `Transcription.language` carries
     it, the `transcript` event forwards it (`language: string | null` on the seam),
     and `resolveTurnLanguage` reconciles it with the model's self-report: the
     **detected** language wins because it is measured from the audio, while the
     model's report is an inference and can be dragged wrong by a bad transcript.
     Disagreement is logged with the winner and why; the comparison is on the
     **base** language (`en-US` vs `en` is agreement). The detected language is
     pinned into the prompt and keys the per-language TTS voice.
  2. **Groq's `verbose_json` is the detector.** `whisper-large-v3-turbo` returns
     `language` only with `verbose_json` (the A11 `json` format did not). Rust
     normalises Groq's language *names* and Apple's *locales* to one BCP-47 shape
     (`normalize_detected_language`); an unmapped name is `None`, never a guess.
  3. **The default backend flips to Groq.** It is the one that makes the demo
     correct for both languages, at the cost of the audio leaving the Mac — which
     the startup line states. On-device stays selectable
     (`POLARIS_STT_BACKEND=ondevice`, audio never leaves, single-locale) and its
     line now says so too. A typo still warns and falls back loudly.
  4. **The parallel on-device idea is not shipped.** Two recognisers
     (`tr-TR` + `en-US`) picking the higher confidence is mechanically possible
     (Apple exposes per-segment `confidence`), but the value is a fit within one
     locale's model, not a cross-locale likelihood — a Turkish recogniser fed
     English audio is still confident. It is also unmeasurable here: the probe
     aborts with `SIGABRT` (exit 134) from a bare `cargo test` binary because TCC
     needs `NSSpeechRecognitionUsageDescription` in a bundle. Kept as an ignored
     harness, not shipped. Refusing to ship a coin flip is the honest outcome.
  5. **Cap what gets spoken, at both ends.** The prompt demands one or two short
     sentences; `capSpokenText` (`MAX_SPOKEN_CHARS = 120`, applied in `spokenText`)
     enforces it in code, cutting at the last sentence boundary, else the last word
     boundary (`…`), never mid-word. This is the biggest latency win available:
     the same answer went from `tts in 20280 ms` (311 chars) to `4325 ms`
     (36 chars).
- **Verification:** real audio→STT→agent→Fish for both languages with the
  coordinator's sample files — EN: detected `en`, English answer, Ethan voice,
  39-char confirmation; TR: detected `tr`, Turkish answer, pinned voice, 48 chars.
  App 19, agent 91→100, cargo 118/3→120/5, typecheck/build/clippy clean. Full
  outputs in `backlog/2026-09-20-a12-language-detection.md`.
- **Still open:** the owner's `.env` selects Anthropic and `claude-sonnet-5`
  currently rejects the request (`HTTP 400: temperature is deprecated for this
  model`) — a pre-existing A11 issue outside this task; the runs forced the
  OpenAI-compatible model. The in-app mic run still needs a human. Confirmation
  templates remain tr/en only.
- **Status:** implemented on `feat/a12-language-detection`; pushed, no PR.
  `backlog/2026-09-20-a12-language-detection.md`.

## 2026-09-20 — A13: unblock Sonnet 5 (drop `temperature`) and stop the model inventing assets
- **Idea:** Two demo-blocking fixes. (1) The A12 report's `HTTP 400: temperature is
  deprecated for this model` on `claude-sonnet-5` — the Anthropic client still set
  and sent `temperature`. (2) The model guessed assets: "send 400 dollar" produced
  `asset: "USD"`, which the demo does not support, because nothing told it which
  assets exist.
- **Discussion:** Sampling parameters (`temperature`, `top_p`, `top_k`) are removed
  on the current Claude models (Sonnet 5, Opus 5, Opus 4.8/4.7, Fable 5) and
  sending one is a 400; they survive on Haiku 4.5. We do not need a non-default
  temperature for deterministic-ish short intent extraction, so the honest fix is
  to send none at all rather than special-case a model list that will only grow.
  For assets, the gap was the prompt plus validation: the model must be told the
  list, and an unsupported code must become a clarification, not an intent.
- **Decision:** Anthropic never sends a sampling parameter (option deleted, not
  left as a trap); the OpenAI-compatible client keeps `temperature`. Supported
  assets live in ONE place, `agent/src/assets.ts`, read by both the system prompt
  and `parseSendPayment` — there is no second list to keep in sync. The ceiling is
  `USDC` (the demo stablecoin and default) and `XLM` (the native asset); colloquial
  money words — dollar/dollars/dolar/`$`/`USD` — canonicalise to USDC. A genuinely
  unsupported code (EUR, BTC, …) is an `input` error the loop speaks as a
  clarification.
- **Verification:** real `claude-sonnet-5` (via the shipped client, `npm run cli`):
  "Ahmet'e 5 USDC gönder" → `{kind:send, asset:"USDC", amount:"5", recipient:"Ahmet"}`
  in 1868 ms; "can you send 400 dollar to bilal" → `asset:"USDC"` in 3225 ms (the
  bug fixed); "hello can you hear me" → no tool call, "Yes, I can hear you. What
  would you like to do?" in 2241 ms; "can you send 400 euro to bilal" → no intent,
  "Sorry, I can only send USDC or XLM, not euros." in 2586 ms. App 19, agent
  100→108, cargo 120/5, typecheck/build/clippy clean.
- **Still open:** the in-app mic→notch run still needs a human. XLM is advertised
  as supported but the guard MVP allowlists one asset per owner; the asset list is
  the agent-side ceiling, not an on-chain promise.
- **Status:** implemented on `feat/a12-language-detection`; pushed, no PR.
  `backlog/2026-09-20-a12-language-detection.md` (A13 section appended).

## 2026-09-20 — A14: the language rule was backwards, and the notch must clear fullscreen
- **Idea:** Two owner-observed defects. (1) Whisper's language label was made
  authoritative in A12, but the owner's real run logged `[lang tr]: Can you send
  400$ to Bilal?` — correct English text tagged Turkish. (2) The notch overlay
  only appeared on the normal desktop; it vanished as soon as an app went
  fullscreen (`"sadece ana ekranda geliyor bu arayüz tam ekran uygulamalarda da
  gözükmeli"`).
- **Discussion:** The STT label is an audio-level guess and is weakest exactly on
  short, code-switched utterances full of names and currency symbols — the
  owner's speech. The transcript text is the better evidence of which language to
  answer in, so the model's assessment of the text must win and the STT label
  must become a hint/fallback. For the overlay, `alwaysOnTop` /
  `visibleOnAllWorkspaces` in `tauri.conf.json` do not express Space or
  fullscreen behavior; the `NSWindow` needs a level above the fullscreen window
  plus `FullScreenAuxiliary | CanJoinAllSpaces`.
- **Decision:** Invert `resolveTurnLanguage`: the model's report wins, the STT
  label is the fallback and is still passed as an explicit prompt hint the model
  may override. Keep the STT label (fallback + diagnostic hint) rather than
  delete it. Raise the overlay window level to `NSPopUpMenuWindowLevel` (101)
  over `NSStatusWindowLevel` (25) and name the collection behaviour in one place
  so `configure` and the diagnostics command cannot disagree. No new
  language-detection library; Whisper is not "fixed".
- **Verification:** app 19, agent 108→109, cargo 120/5→121/5,
  typecheck/build/clippy clean. Real e2e with `POLARIS_E2E_STT_LANG=tr` on the
  owner's transcript answers in English (`language: en (source model)`, Fish
  `lang en`); the Turkish direction still resolves to `tr`. Overlay flags read
  off the live `NSWindow` at startup: `level: 101`,
  `full_screen_auxiliary: true`, `can_join_all_spaces: true`, `focusable: false`.
- **Still open:** the owner's visual check of the overlay over a real fullscreen
  app (only the flags are verified, not the pixels), and the in-app mic run.
- **Status:** implemented on `feat/a12-language-detection`; pushed, no PR.
  `backlog/2026-09-20-a14-language-precedence-and-fullscreen.md`.
## 2026-09-20 — A15: the notch floats over fullscreen only as an accessory app
- **Idea:** A14's fix (window level `NSPopUpMenuWindowLevel` + `CanJoinAllSpaces
  | FullScreenAuxiliary | Stationary | IgnoresCycle`) was verified at the flag
  level and the owner still could not see the overlay over another app's
  fullscreen Space. The coordinator's strong hypothesis: Polaris is a *regular*
  app, and macOS does not layer a regular app's windows into another app's
  fullscreen Space at any window level.
- **Discussion:** The hypothesis was tested before changing anything.
  `lsappinfo` reported a running Polaris of `type="Foreground"` (the
  WindowServer's label for a regular app), and `tao` hardcodes
  `ActivationPolicy::Regular` at delegate construction — nothing in the app ever
  changed it, and there is no `LSUIElement` key. Apple's documented mechanism for
  HUD overlays over other apps' fullscreen Spaces is the accessory (agent)
  policy; `FullScreenAuxiliary` alone mainly governs floating over *your own*
  fullscreen window. A placement subtlety decided the implementation: Tauri
  builds the config window **before** the `setup` closure runs, so setting the
  policy in `setup` (the Tauri docs' example) is too late; the correct sequence is
  policy → window → flags, achieved by calling `App::set_activation_policy`
  before `run()` (tao applies it at `applicationDidFinishLaunching`, before any
  window exists).
- **Decision:** Make Polaris an accessory app (`tauri::ActivationPolicy::Accessory`)
  before the run loop, keep the A14 level/collection flags, and keep the overlay
  click-through and non-focusable. Accepted product cost: **no Dock icon and no
  app menu bar**; no menu-bar status item yet (flagged as follow-up). Expose the
  live policy in `notch_window_flags` and the startup log so the state is
  inspectable, and warn loudly if it is not `Accessory`.
- **Verification:** app 19, agent 109, cargo 121/5 → **123/5** (policy-mapping
  test incl. unknown raw value + camelCase serialization), typecheck/build/clippy
  clean. Running the built binary: startup line now reads
  `activation_policy: Accessory`; `lsappinfo` for that pid reads
  `type="UIElement"` where the unmodified binary read `type="Foreground"`.
  Geometry unchanged (`179x32` pill, `399x32` shell).
- **Still open:** the owner's **visual** check over a real fullscreen app — the
  process-level evidence is complete but no pixels were observed by this worker.
- **Status:** implemented on `fix/a15-fullscreen-overlay`; pushed, no PR.
  `backlog/2026-09-20-a15-fullscreen-overlay.md`.
## 2026-09-19 — Round-3 Decisions: Contracts Frozen, Privacy Modes, Work Order
- **Decision (D8):** `polaris_guard` is **frozen for the slice**. The v0.1 audit findings go into
  `contracts/DEPLOYED.md` ("Known limitations (v0.1)") + demo talking points, and the fixes are batched
  into a single `polaris_guard` v0.2 redeploy **only after the slice works** — any change = new contract
  ID = every owner re-publishes rule + allowance + keeper env update. Spec:
  [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

## 2026-09-19 — Integration Paused; Chain Lane Headless First
- **Decision:** Integration between the UI/voice lane (Owner A) and the chain lane (Owner B) is
  deliberately **paused until both sides are done**. The chain lane stays **headless** (Node scripts,
  typed input) and touches only `stellar/` and `contracts/`. Voice is not on the critical path.
- **Pointer:** `backlog/2026-09-19-slice-gap-analysis.md` §G.3; `sprints.md` "Milestone 2b".
- **Status:** decided

## 2026-09-19 — Privacy Modes: CT then SPP (Testnet Only)
- **Decision (D2–D6):** Confidential/private payments are **in scope** as "privacy modes" because the
  project is **testnet only**, so the unaudited developer-preview status of Confidential Tokens (CT) and
  Stellar Private Payments (SPP) is not a blocker (still labelled testnet-only/unaudited). Order: **CT
  first, SPP second**, each gated by a 2h spike.
- **Decision:** voice expresses the mode as intent ("secretly"/"privately"); registration, contacts,
  address entry, default-mode changes are **manual-tab only**; addresses are never dictated by voice;
  **fail-closed** (never downgrade a private request to public). **Instant payroll is in**, **scheduled
  confidential payments are out** (keeper has no sender secret material).
- **Pointer:** [`docs/confidential-payments.md`](docs/confidential-payments.md).
- **Status:** decided

## 2026-09-19 — D1: Chain-Lane Work Order
- **Decision (D1):** chain lane order — (1) real `sendPayment` ChainTool (`Intent` → unsigned XDR +
  decoded summary; alias via committed `aliases.json`), (2) `polaris_guard` owner-side TS client
  (`set_rule`, `set_alias`, SAC `approve`, `pay_executor`, `direct`/`guarded` modes), (3) headless
  end-to-end script (over-limit rejected with guard error **#105**), and **only then** (4) the privacy
  spikes. Workers run sequentially.
- **Pointer:** `docs/confidential-payments.md` §9; `sprints.md` "Milestone 2b".
- **Status:** decided

## 2026-09-19 — Worker Ladder: DeepSeek v4.1 Flash via opencode
- **Decision:** round-3 workers run as **DeepSeek v4.1 Flash** via opencode under the Claude-based
  coordinator. The worker ladder table is **local-only** and never committed, so the ladder was simply
  updated locally for this round (no repo change).
- **Pointer:** `AGENTS.md` §2 (worker architecture); `docs/model-ladder.md` (local-only).
- **Status:** decided

## 2026-09-19 — Idea: Guard Limits at the Public Boundary for Privacy Modes
- **Idea:** because a confidential transfer hides its amount, `polaris_guard` cannot enforce per-tx/daily
  limits on the confidential leg. Move the enforceable guarantee to the **public boundary**: cap the
  amount moved *into* the CT wrapper / SPP pool (deposit amounts are public), enforce a per-transfer
  limit client-side (the app knows the amount before encrypting), and use the approval card as the gate.
  Keeper is excluded from confidential schedules.
- **Open question:** whether `polaris_guard` can gate `deposit`/`withdraw` **on-chain** (executor calls
  the wrapper) — for the spike.
- **Pointer:** `docs/confidential-payments.md` §7; `contracts/DEPLOYED.md` "Privacy modes note".
- **Status:** open (resolved by the CT/SPP spikes)

## 2026-09-19 — PROPOSED: Mixed-Mode Payroll Batch Policy
- **Idea:** A single payroll batch may mix public and private (CT/SPP) recipients, which can leak intent
  or confuse the single approval card.
- **Proposed policy (needs owner confirmation):** refuse mixed-mode batches unless every line resolves
  cleanly to one mode; otherwise split the batch into two cards (one public, one private).
- **Pointer:** `docs/confidential-payments.md` §11 risk R7.
- **Status:** open (PROPOSED — needs owner confirmation)

## 2026-09-19 — Decision: Contract Evolution = New Crates, v0.1 Frozen
- **Decision (D9):** `polaris_guard` v0.1 (deployed, id in `contracts/DEPLOYED.md`) is **frozen** and
  stays the reference deployment; its source under `contracts/polaris_guard/` is never edited again
  except for a critical owner-decided fix.
- **Decision:** every future contract change/addition is a **new crate** under `contracts/` (own Cargo
  package, own tests, own testnet deployment, own `DEPLOYED.md` section, registered as a workspace
  member), so old and new contracts are tested and run side by side. This supersedes the D8 wording of a
  single in-place v0.2 redeploy: v0.2 = new crate `polaris_guard_v2`; any on-chain privacy gate = new
  crate `polaris_privacy_gate`; client/keeper take the contract id as a parameter.
- **Pointer:** [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

<!-- New notes are appended chronologically at the bottom. -->

## 2026-09-19 — D10/D10b/D10c: Approval Profiles & Auto-Pay
- **Decision (D10):** default approval profile = **"Always ask"** — every money-out shows an approval
  card (+ Touch ID); nothing is auto-approved at first start.
- **Decision (D10b):** the user can later enable **auto-pay under a threshold** by settings OR voice
  ("don't ask me for payments under 25 USDC"); payments ≤ threshold run via `pay_executor`
  (agent-signed) without a card, above the threshold still ask.
- **Decision (D10c):** enabling/loosening is never silent — a voice request creates a **draft** that is
  read back and applied only after **ONE card + Touch ID**; tightening/disabling may be done by voice
  with read-back and the lighter confirmation; the **app preference can only be STRICTER than the
  chain, never looser**.
- **Execution order:** fixed later by **D13** — `approve` → `set_rule` → `set_executor` (executor last
  = arming); any earlier "allowance last" ordering is **SUPERSEDED by D13**.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §2–§4.
- **Status:** decided

## 2026-09-19 — D11: Local Deterministic Smart Suggestions
- **Decision (D11):** the app analyses the user's payment history and proposes changes (auto-pay
  threshold, daily limit, recurring → schedule); suggestions are computed **locally and
  deterministically** (statistics) and an LLM may only phrase them.
- **Decision:** raw history never leaves the device — only aggregates, and only if the owner allows. A
  suggestion is **never applied automatically**; it becomes a draft through the same read-back + card +
  Touch ID flow.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §6.
- **Status:** decided

## 2026-09-19 — D12 (PROPOSED): Keeper Hosting for the Demo
- **Proposed decision (D12, awaiting user confirmation):** keeper hosting for the demo = the **same
  Mac** as the app (`npm run keeper -w @polaris/stellar`, wrapped in `caffeinate -i`); production path
  = an always-on small server with multiple independent keepers.
- **Note:** the user asked what "keeper hosting" means, so the docs must explain the keeper in plain
  words.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7.
- **Status:** open (PROPOSED — needs user confirmation)

## 2026-09-19 — D13: Safe Execution Order of the Enable-Auto-Pay Flow
- **Decision (D13):** the SAC allowance is mandatory for every guard payment, so a baseline allowance
  already exists in the "Always ask" profile; what **arms** unattended payments is registering the
  executor together with a positive `auto_approve_limit`. The enable flow therefore executes as
  **1) `approve` (allowance), 2) `set_rule`, 3) `set_executor`** — registering the executor is the
  **last, arming** step.
- **Card:** the approval card lists the same three actions in the same order and calls out the arming
  step; it is still **ONE card and ONE Touch ID**.
- **State after a failure:** after step 1 only the allowance changed; after step 2 the new rule is
  stored but no executor exists so nobody can auto-pay; after step 3 auto-pay is armed.
- **Disable order:** `revoke_executor` first (**disarm**), then the optional `approve(0)`.
- **Supersedes:** every earlier statement that the "allowance is last" or that the execution order is
  `set_executor, set_rule, approve` — all **SUPERSEDED by D13** (D10c note; `docs/approval-and-scheduling.md` §3, §9, §11d; the JSON
  card example; `docs/interfaces.md` §6.1; `docs/demo-runbook.md`; `sprints.md`; `backlog.md` T1 row).
- **New T1 deliverables:** `buildBaselineSetup` (allowance + `set_rule` with no executor and
  `auto_approve_limit` 0 allowed) implements the first-time "Always ask" setup (§11e); `buildTightenRule`
  refuses loosening by default; `invalid_asset` validation; card caveats (revoking the executor does not
  stop existing schedules; revoking the allowance disables ALL guard payments including owner-approved
  ones); an "allowance old → new" line with a warning when the new allowance is lower than the current.
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §3, §9, §11.
- **Status:** decided

## 2026-09-19 — D14: Can the Keeper Live Inside the Contract?
- **Decision (D14):** **No.** Soroban has no scheduler or timers; a contract cannot wake itself — every
  execution needs a transaction from someone.
- **What is possible:** (a) `execute_schedule` needs no auth, so anyone can trigger it — the **app can
  act as an opportunistic keeper** (on start and while open it runs due schedules) and the **payee** can
  trigger it too; (b) a future contract (**a NEW crate, per D9**, e.g. `polaris_guard_v2`) could pay a
  small **tip** to whoever triggers a due schedule so third parties run keepers — **PARKED**, not for
  the hackathon; (c) the demo keeps **D12** (keeper on the same Mac, **PROPOSED**).
- **Pointer:** [`docs/approval-and-scheduling.md`](docs/approval-and-scheduling.md) §7; parked idea in
  [`backlog/guard-v0.2-hardening.md`](backlog/guard-v0.2-hardening.md).
- **Status:** decided

## 2026-09-20 — Chain Lane Completed and Verified Live on Testnet
- **Idea:** The chain lane (`sendPayment`, guard client, approval T1, schedules T2, suggestions T3, live adapters) is complete and verified end to end.
- **Evidence:** **922** offline tests green across 8 suites (`backlog/final-gate-chain-lane.md`); **12/12** live scenarios S0–S11 on Stellar TESTNET, independently re-read on-chain (`backlog/e2e-testnet-review.md`, all hashes `SUCCESS`); manual tool `e2e:tool` (`backlog/e2e-polish.md`).
- **Bugs the live run found:** `sendPayment` set a lower time bound (`minTime = now`) → `tx_too_early` on testnet; fixed to `minTime = 0`. Earlier rounds, independent review caught the `setRule` ABI encoding defect (`scvString`/`scvU64` instead of `scvSymbol`/`scvI128`) and the suggestions outlier threshold.
- **Status:** decided

## 2026-09-20 — Review Process Finding: Independent Review Catches What Fake-RPC Tests Cannot
- **Idea:** Every chain-lane module had a separate independent reviewer (author never reviews own code).
- **Finding:** The reviewers caught **real defects in every module** (a reject on guard-client, blocking fixes in send-payment, approval, schedule, suggest, and the e2e tooling). Offline fake-RPC tests cannot catch ABI-encoding or clock/timing bugs — those only surfaced through independent XDR/spec analysis and the live run.
- **Decision:** Keep mandatory per-module independent review before merge; treat a live testnet run as required evidence for chain-lane work.
- **Status:** decided

## 2026-09-20 — Decision: Approval Gate Is STRICT
- **Decision:** The manual `e2e:tool` approval gate is **STRICT**: it approves only the exact lowercase `y` or `yes` (at most one trailing `\n` removed); no trimming, no case folding, so `Y`, `Y `, ` y`, `YES`, `Yes`, `yes please`, `1` and EOF all abort.
- **Rationale:** approval must be explicit and default-deny; the prompt times out (120 s) and signs only the exact XDR that was displayed.
- **Pointer:** `stellar/src/live/confirm.ts`; `backlog/e2e-polish.md` (B3) and `backlog/e2e-polish-review-2.md`.
- **Status:** decided

## 2026-09-20 — Local-Only Artefacts Intentionally Not in the PR
- **Idea:** Some exploratory artefacts stay local only and are deliberately **not** part of the chain-lane PR.
- **What/where:** the test UI branch (`local/test-ui`) and the privacy/passkey spikes on local branches `spike/ct`, `spike/spp`, `spike/passkey`. Their reports live on those branches (local-only), not under `backlog/` in this PR.
- **Pointer:** chain-lane scope check in `backlog/final-gate-chain-lane.md` (Step 1: no `stellar/src/spike` or live-UI code in the diff).
- **Status:** decided

## 2026-09-20 — Notch Shell Ported onto `main`; a Per-State Window Width Was the Left-Edge Flash
- **Idea:** The expandable notch shell and the double-Control typed prompt are re-applied on top of current `main` (which already owns the good voice chain, #16). `main` is the base; only our two contributions cross; #21 (`9a9b89a`, accessory activation policy) is preserved inside the new `SHELL_STATES` structure.
- **BUG-1 root cause:** the OS window was sized per state and centred on the cutout, so its left edge moved on every transition. The webview relayouts one frame behind the native `setFrame`, so the CSS-centred shell painted off-centre for those frames — a one-frame flash at the left. Reproduced with `screencapture -v` + `ffmpeg` frame scan (frame 215 centre ~452 pt instead of 735 pt).
- **Fix:** one fixed window width for every state (`ShellGeometry::window_width`); only the height varies, and the shell is top-anchored, so the voice animation now resizes nothing and the new states only grow downward. Pinned by the `every_state_shares_one_centred_window_column` test.
- **BUG-2:** the voice-strip transition (`width` + `border-radius`, 470 ms, `cubic-bezier(0.32,0.72,0,1)`, `will-change: width`, ear fade, no height tween) is taken from `main` verbatim; the new `panel`/`prompt` states add the height tween in their own rule.
- **Pointer:** `backlog/2026-09-20-notch-shell-port.md`; `app/src-tauri/src/notch.rs`; `app/src/index.css`.
- **Status:** decided (BUG-1 "after" recording still pending — machine screen locked mid-verification)
