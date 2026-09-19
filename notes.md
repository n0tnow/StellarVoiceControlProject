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
