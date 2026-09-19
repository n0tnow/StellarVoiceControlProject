# Report: stt-research (A1 spike)

- **Date:** 2026-09-19
- **Worker/Agent:** research worker (opencode)
- **Branch/Worktree:** `research/stt` @ `.worktrees/stt-research`
- **PR:** none (research only), as instructed

## Completed

A1's decision research, filed as `docs/reports/2026-09-19-stt-whisper.md`. It answers all seven
questions: binding, model choice/location, the 2 s budget, resampling, threading, failure modes and
the cloud fallback. Findings are backed by a throwaway probe crate that actually compiled
`whisper-rs 0.16.0` with Metal on this M3 and transcribed real (synthetic) audio with tiny / base /
small / large-v3-turbo-q5_0.

Headline results:

- **Binding:** `whisper-rs = { version = "0.16.0", features = ["metal"] }` (vendors whisper.cpp
  1.8.3). Verified compile + Metal link + transcription. `whisper-cli` shell-out and the `mutter` /
  `whisper-rs-2` crates are worse options; `whisper-rs-2` is abandoned (2022).
- **Model:** recommend `ggml-small.bin` (multilingual, 466 MiB) warm; `base` fallback;
  `large-v3-turbo` measured ~1.6 s for a 1.8 s clip and **fails** the budget; `distil-*` is
  English-only (disqualified by Turkish).
- **2 s budget:** comfortable with a warm model — `small` ≈ 0.6 s for a 3 s utterance. The only
  trap is the cold first load (observed 6.6–6.8 s, Metal kernel compilation) → preload at startup.
- **Language:** force it. `set_detect_language(true)` returned empty transcripts in the probe;
  `set_language(Some("auto"))` works.
- **Resampling:** keep native-rate capture; resample to 16 kHz mono f32 with `rubato` (or a 3:1 box
  filter for 48 k) — measured ~0.1 ms.
- **Cloud:** Groq whisper-large-v3-turbo ($0.04/hr) / OpenAI gpt-4o-mini-transcribe ($0.003/min);
  opt-in only, **not worth building before the deadline**.

## Verified

- `cargo add whisper-rs --features metal` resolves to 0.16.0; release build compiles and links
  `framework=Metal` / `framework=MetalKit` (build log), `get_whisper_version()` prints `1.8.3`.
- Transcribed 5 phrases × 4 models on this M3 (measured inference, warm/cold load, peak RSS).
- Model SHA-1s matched the published `ggerganov/whisper.cpp` values.
- `.env.example:28` names `models/ggml-base.en.bin` — an English-only model; **must change** for
  Turkish support.

## Unfinished (handed off to the A1 implementation)

- Implement the worker thread + model fetch; re-measure latency with the user's real voice and mic.
- Decide `POLARIS_STT_LANG` default (`tr`) and update `.env.example` to a multilingual model.
- Optional: evaluate a Turkish fine-tune (ggml conversion) after the milestone.

## Blockers

- None. The only build prerequisite found is CMake + Xcode CLT for `whisper-rs-sys` (present here:
  cmake 4.1.0).

## Suggested Next Step

Implement A1 in its own worktree: add the `whisper-rs` dependency, a `make model` target that
downloads `ggml-small.bin` with SHA-1 verification into a gitignored `models/` dir, a warm worker
thread that consumes `audio_captured` paths and emits `transcript { text, final: true }`, and the
short failure labels from §6 of the report.
