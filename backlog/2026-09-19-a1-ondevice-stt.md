# Report: A1 — On-device macOS Speech backend (on-device default)

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a1-ondevice-stt` / `.worktrees/a1-ondevice` (based on `feat/a1-stt`)
- **PR:** none (per the task: push only, no PR, no merge, no tag)

## Objective

Add a second `Transcriber` backend that runs Apple's on-device
`SFSpeechRecognizer`, make it the **default**, keep Groq as an explicit opt-in
and a configured fallback, and do so without changing the trait's call sites or
the `transcript { text, final }` event seam.

The product reason shapes every choice here: **Polaris is a wallet**. When the
user says "send 10 USDC to Ada", the audio is financial intent. Keeping it on
the machine is the architecturally correct default — on-device is also free
forever, works offline and needs no API key.

## Completed

1. **New backend behind the same trait.** `stt/ondevice.rs` implements
   `stt::Transcriber`. `stt::start`, `transcribe_verified`, the capture hand-off
   and the event seam are untouched; `lib.rs` now calls `stt::build_backend()`.
2. **On-device is the default.** `POLARIS_STT_BACKEND` (`ondevice` | `groq`,
   case-insensitive) selects the backend; missing/blank → `ondevice`; an unknown
   value still resolves to `ondevice` **and** sets a "not recognized" flag so the
   caller warns instead of silently flipping the privacy default
   (`stt::parse_backend`, unit-tested).
3. **Automatic fallback, never silent.** When on-device is requested, Groq is
   attached as a fallback only if `GROQ_API_KEY` is configured. The fallback
   fires **only** on `SttError::Unavailable` — the recognizer reporting, before
   any audio is recognized, that it cannot run for the locale. A recognition that
   starts and then fails (framework error, timeout, silence) is surfaced, not
   retried in the cloud. Any fallback prints
   `on-device STT is unavailable for <locale> — falling back to the configured
   cloud backend; the audio now leaves this machine`.
4. **Force on-device.** `requiresOnDeviceRecognition = true` is set on every
   request, and the backend refuses to run at all when
   `supportsOnDeviceRecognition()` is false, so audio cannot reach Apple's
   servers either.
5. **Domain vocabulary.** `ondevice::DOMAIN_VOCABULARY` (one named constant)
   holds `USDC`, `XLM`, `Stellar`, `Soroban`, `lumen`, `testnet`, `Polaris`, and
   is passed as `contextualStrings`. A test pins the required terms, the ≤100
   Apple cap, and the 1–2-words-per-phrase Apple guidance.
6. **Language.** `POLARIS_STT_LOCALE` overrides; otherwise a fixed `tr-TR`
   (`resolve_locale`, unit-tested). Justification below.
7. **Permission.** `requestAuthorization` is called lazily on the STT worker at
   the first transcription, never on the main thread. The worker waits, bounded
   (30 s), for the answer over an `mpsc` channel and never hangs. Denied or
   restricted → `SttError::PermissionDenied`, overlay label **"Allow speech"**,
   capture unaffected. `NSSpeechRecognitionUsageDescription` added to
   `Info.plist`.
8. **Threading.** The Speech objects are `!Send`, so they are created and dropped
   inside `OnDeviceTranscriber::transcribe`, which runs on the existing
   `polaris-stt` worker thread. The result handler is a `block2::StackBlock`; the
   framework copies it and calls it on the recognizer's queue (main by default),
   and it hands the finished `String` back over a channel. Nothing `!Send` crosses
   a thread boundary; the Tauri main thread and the audio path never block.
9. **Latency.** The existing capture-completion→event measurement is unchanged,
   but the line now names the backend: `transcript in <ms> ms (audio <ms> ms) via
   <ondevice|groq>`. `FallbackTranscriber` tracks which backend actually ran, so
   the name stays honest across a fallback.
10. **Recording lifecycle.** A1 behaviour is untouched: a recording is deleted
    only after a successful transcription and kept on every failure.

## Design decisions and why

- **`Transcriber::name()` was added with a default (`"stt"`).** This is the only
  trait change. It exists so the latency line can attribute each measurement to a
  backend — requirement 8 asks for the two to be comparable on the same scale.
  Because it has a default, no existing implementation or call site changed and
  no new capability is required of a backend.
- **Fixed `tr-TR`, overridable by `POLARIS_STT_LOCALE`, not the system locale.**
  `SFSpeechRecognizer` is single-locale per recognizer — unlike Whisper it cannot
  auto-detect. The user speaks Turkish even when the command mixes an English
  vocabulary (`send 10 USDC to ada`). Following the system locale would quietly
  pick the UI language (often `en-US` on a Turkish user's Mac set to English) and
  lose the user's actual language; a fixed, overridable `tr-TR` is predictable.
  `contextualStrings` then keeps the English entities English. **The cost, stated
  plainly:** an English-only utterance may be rendered with Turkish phonetics.
  Groq can auto-detect; on-device cannot. This is the unavoidable price of the
  privacy default, not an oversight.
- **Fallback only on `Unavailable`.** That variant is raised *before*
  `recognitionTask` is called (nil recognizer, no on-device support, or
  `isAvailable == false`), so no audio ever reached Apple. A mid-flight failure is
  never re-sent to the cloud.
- **`objc2-speech = "0.3.2"` with default features.** Same objc2 0.6.x generation
  as `objc2-app-kit 0.3.2` / `objc2-foundation 0.3.2` the project already links;
  `cargo tree -i objc2` confirms a single major. Default features pull
  `objc2-avf-audio` / `objc2-core-media` (same generation) which the project
  already transitively had via `cpal`/`objc2-audio-toolbox`.

## What the user must do on first run (they will hit this immediately)

1. **Run the app** (`npm run tauri:dev`, or a bundled `npm run tauri build`).
   Tauri embeds `Info.plist` into the binary (the microphone prompt already
   relies on this), so `NSSpeechRecognitionUsageDescription` is present in dev
   too.
2. **On the first hold-and-release**, macOS shows two prompts the first time:
   Microphone access (already true from A0) and **"Polaris would like to access
   Speech Recognition"** → click **Allow**. The first transcript waits for this
   answer (bounded to 30 s).
3. **If denied**, the ear shows **"Allow speech"**; re-enable Polaris under
   *System Settings › Privacy & Security › Speech Recognition*. Capture keeps
   working the whole time.
4. **Locale assets.** macOS may need a one-time download of the on-device
   dictation assets for `tr-TR`. If they are not installed yet, the request
   either fails or exceeds the 30 s budget; the ear shows **"Local STT off"** or
   **"STT timeout"** and the WAV is kept. Retrying after the download completes
   should succeed. The exact timing/messages are **unverified** (see below).
5. **To opt into the cloud instead:** `POLARIS_STT_BACKEND=groq` **and**
   `GROQ_API_KEY=…`.

## Verification (real output)

```
$ cd app/src-tauri && caffeinate -i cargo build
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.56s

$ caffeinate -i cargo test
test result: ok. 68 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out

$ caffeinate -i cargo clippy --all-targets
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 0.17s   (no warnings)

$ cargo tree -i objc2
objc2 v0.6.4
├── block2 v0.6.2
│   ├── dispatch2 v0.3.1
│   ...

$ cargo tree | grep -oE "objc2 v[0-9.]+" | sort -u
objc2 v0.6.4                       # <- only one objc2 major
$ cargo tree | grep -oE "objc2-(foundation|speech) v[0-9.]+" | sort -u
objc2-foundation v0.3.2
objc2-speech v0.3.2

$ caffeinate -i npm run typecheck      # repo root (after `npm ci` in the fresh worktree)
> @polaris/interfaces@0.1.0 check … ok
> @polaris/agent@0.1.0 check … ok
> @polaris/stellar@0.1.0 check … ok
> @polaris/app@0.1.0 check … ok

$ caffeinate -i npm run build
dist/index.html                   0.43 kB │ gzip:  0.27 kB
dist/assets/index-B5Ch6WfQ.css   18.25 kB │ gzip:  4.56 kB
dist/assets/index-CyAgEw0s.js   224.26 kB │ gzip: 70.43 kB
✓ built in 116ms
```

Test count went from 57 (A1) to 68. The new tests (all framework-free):

- `stt::parse_backend` default/blank/case-insensitivity and the typo flag;
- `FallbackTranscriber` fires on `Unavailable`, does **not** fire on
  `Speech`/`Timeout`/`Silent`, surfaces `Unavailable` when no fallback exists, and
  reports the backend that actually ran;
- `ondevice::resolve_locale` default/blank/override;
- `ondevice::DOMAIN_VOCABULARY` coverage and Apple's phrase limits;
- `ondevice::finish_transcript` trims and maps blank text to silence;
- `ondevice::map_authorization` succeeds only for `authorized`;
- every `SttError` (including the four new on-device variants) has a non-empty
  label ≤16 chars and a non-empty detail.

## Not verified (stated plainly)

- **No real recognition run was performed.** It needs the macOS permission prompt
  and a human voice; a non-interactive `cargo test` cannot do it. Calling
  `requestAuthorization` without the `<key>` in a running process is exactly what
  Apple documents as a crash, and the current status on this machine is
  `notDetermined`, so I deliberately did **not** trigger it from a test binary.
- **No latency or accuracy number is reported** for on-device. There is none to
  report; inventing one would be worse than a blank.
- **First-run asset-download behaviour is unverified.** The code bounds it with a
  timeout and maps the framework error, but what macOS actually does when the
  `tr-TR` dictation assets are missing (fast error vs. slow download) was not
  observed.
- **The end-to-end path through a bundled, permissioned app is unverified**, as is
  whether an unsigned/ad-hoc build is accepted for Speech Recognition.
- **Real recordings exist** at
  `~/Library/Application Support/dev.polaris.desktop/recordings/` (e.g.
  `polaris-1789826524101-2.wav`, 118 124 bytes), but I did not feed one to the
  recognizer because doing so requires the bundled app plus the permission
  prompt. No observation is claimed.

## Files changed

- `app/src-tauri/src/stt/ondevice.rs` (new)
- `app/src-tauri/src/stt.rs` (module wiring, error variants, selection,
  `FallbackTranscriber`, trait `name()` with default, backend-attributed log)
- `app/src-tauri/src/lib.rs` (uses `stt::build_backend()`)
- `app/src-tauri/Cargo.toml` (`objc2-speech = "0.3"`)
- `app/src-tauri/Info.plist` (`NSSpeechRecognitionUsageDescription`)
- `.env.example` (`POLARIS_STT_BACKEND`, `POLARIS_STT_LOCALE`, updated Groq note)

## Unfinished (handed off)

- The A1 report's "5-command / <2 s acceptance run" is still pending for **both**
  backends; this step adds the on-device side to that same pending run.
- A per-locale asset pre-flight (e.g. surfacing an explicit "downloading speech
  model" state) is not implemented; today it appears as a bounded timeout or a
  framework error.
- An overlay notice when a Groq fallback fires (today it is a terminal line only)
  would need a new UI affordance; the ear is too narrow and the centre column is
  off-limits.

## Suggested next step

Run the app on the real machine, click Allow on the Speech Recognition prompt,
hold Control+Option and say five mixed Turkish/English commands, and record the
terminal's `via ondevice` latency lines (then set `POLARIS_STT_BACKEND=groq` and
repeat for the comparison).
