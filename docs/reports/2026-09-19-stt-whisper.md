# STT for Polaris A1 — Binding, Model, Latency and Integration Research

- **Date:** 2026-09-19
- **Author/Agent:** research worker (opencode)
- **Keywords:** stt, whisper, whisper-rs, whisper.cpp, metal, m3, turkish, resampling, rubato, latency, tauri, polaris
- **Status:** recommendation (research only — no feature implemented)

## Summary

This report answers step A1 of the voice pipeline: turn the WAV written by A0 into a transcript.
Every number below that is not attributed to a source was **measured on the target machine**
(Apple M3, 16 GB RAM, macOS 27, arm64, Rust 1.97.1) with a throwaway probe crate under `/tmp`
compiling `whisper-rs 0.16.0` (features `["metal"]`), which links **whisper.cpp 1.8.3**. The audio
was synthetic macOS `say` TTS, not the user's real voice — see "Confidence and caveats".

**Decisions recommended:**

1. **Binding:** `whisper-rs = { version = "0.16.0", features = ["metal"] }`. Verified to compile,
   link Metal/MetalKit, and transcribe on this M3. It is the canonical, by far most-downloaded
   binding; `mutter` and `whisper-rs-2` are not competitive (`whisper-rs-2` has been dead since
   2022). Do **not** shell out to a `whisper-cli` binary.
2. **Model:** **`ggml-small.bin` (multilingual, 466 MiB)** as the default, loaded warm.
   `base` is the fallback if the 466 MiB download is a problem. `large-v3-turbo` is **too slow**
   on this M3 for the <2 s budget (measured ~1.6 s for a 1.8 s clip). `distil-*` is English-only,
   so it is disqualified by the Turkish requirement.
3. **Language:** force it (`set_language(Some("tr"))` or `"en"`), do **not** leave it to
   `set_detect_language(true)` — that flag returned **empty transcripts** in our probe. If
   auto-detect is wanted, use `set_language(Some("auto"))`.
4. **Resampling:** capture at the device's native rate (as A0 does) and resample to 16 kHz mono f32
   in Rust with a proper resampler (`rubato 5.0.0`) or, defensibly, a 3-tap box filter for the exact
   48 k→16 k case. Do not request 16 kHz from `cpal`.
5. **Threading:** run inference on a dedicated worker thread that owns a warm `WhisperContext`,
   never on the Tauri main thread or the audio callback; publish via the existing
   `PolarisEvent::Transcript { text, final: true }`.
6. **Cloud fallback:** Groq `whisper-large-v3-turbo` (≈$0.0007/min) or OpenAI
   `gpt-4o-mini-transcribe` ($0.003/min), **opt-in only**. Given local `small` already beats the
   2 s target, do not build it before the deadline — leave a trait seam.

**Bottom line on the 2 s budget: realistic with a warm `small` model (~0.55 s for a 3 s
utterance), and comfortable with `base` or `tiny`.** The one real trap is the *first* model load
after a cold start (observed 6.6–6.8 s, almost certainly Metal kernel compilation), which is why
the model must be preloaded at app startup, not on the first hotkey release.

---

## 1. Binding choice

### 1.1 `whisper-rs` (recommended)

| Fact | Value | How verified |
|---|---|---|
| Latest version | **0.16.0** (published 2026-03-12) | crates.io API |
| Downloads | 1,228,811 all-time | crates.io API |
| Repository | `https://codeberg.org/tazz4843/whisper-rs` (**Codeberg, not GitHub**) | crate metadata |
| Vendored whisper.cpp | **1.8.3** (`whisper_rs::get_whisper_version()` printed `1.8.3`) | ran the probe |
| Sys crate | `whisper-rs-sys 0.15.0`, builds whisper.cpp from source via CMake | build log |
| Metal feature | **`metal`** exists and is **not** in `default = []` — must be requested | `cargo add --dry-run` + docs.rs Cargo.toml |
| Other GPU features | `coreml`, `cuda`, `hipblas`, `vulkan`, `openblas`, `openmp`, `intel-sycl` | docs.rs feature list |
| MSRV | `rust-version = "1.88.0"` (workspace) | docs.rs Cargo.toml |

Exact dependency line:

```toml
whisper-rs = { version = "0.16.0", features = ["metal"] }
```

`cargo add whisper-rs --features metal` resolved to 0.16.0 and locked 34 packages. A release build
of a probe that loads a context, creates a state, runs `state.full(...)`, and reads segments
**compiled cleanly and executed on this M3**. The `whisper-rs-sys` build log contains:

```
-- Metal framework found
-- Including METAL backend
[ 25%] Generate assembly for embedded Metal library
cargo:rustc-link-lib=framework=Metal
cargo:rustc-link-lib=framework=MetalKit
```

So Metal is real and selected, not a documentation claim.

**Build prerequisite:** `whisper-rs-sys` compiles whisper.cpp with **CMake** at build time
(we used cmake 4.1.0). Any CI/build machine needs CMake + Xcode Command Line Tools. This is a
real, if minor, packaging consideration.

**API drift note (verified against 0.16.0, not older tutorials):** the current API is

```rust
let mut cp = WhisperContextParameters::new();
cp.use_gpu(true);                       // field `use_gpu`, method `.use_gpu(bool)`
let ctx = WhisperContext::new_with_params(model_path, cp)?;
let mut state = ctx.create_state()?;
let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
p.set_language(Some("tr"));             // Option<&str>, NOT &str
p.set_single_segment(true);
p.set_n_threads(4);
state.full(p, &samples_f32)?;           // `full_n_segments()` returns c_int, not Result
for i in 0..state.full_n_segments() {
    if let Some(seg) = state.get_segment(i) { text.push_str(seg.to_str_lossy()?); }
}
```

Two changes that break older snippets: `convert_integer_to_float_audio(&[i16], &mut [f32])`
now writes into a caller buffer and returns `Result`, and per-segment text is
`WhisperState::get_segment(i) -> Option<WhisperSegment>::to_str_lossy()`, not
`full_get_segment_text(i)`. The probe above is the minimal compiling example.

`WhisperContext` is `Send + Sync` (docs.rs auto-trait list) — safe to keep behind an
`Arc`/worker thread. `FullParams` is `Clone + Send + Sync`.

### 1.2 Shelling out to `whisper-cli`

whisper.cpp ships `whisper-cli` (README). Shelling out means:

- **No warm context.** Each invocation re-reads and re-initialises the model. Warm disk-cache model
  load is only 90–400 ms for tiny/base/small (measured), but you also pay process spawn and
  **cold** Metal-shader cost on the first use after boot (seconds). There is no way to keep it warm.
- Packaging a second binary: compile outside cargo, distribute in the app bundle, sign and notarise
  it separately. More moving parts than one crate feature.
- stdout parsing and no typed error handling.

It is not wrong, but it is strictly worse for a latency-bound, single-machine product. **Do not
choose it.**

### 1.3 Other bindings

| Crate | Latest | Downloads | Last update | Verdict |
|---|---|---|---|---|
| `whisper-rs` | 0.16.0 | 1,228,811 | 2026-03-12 | **Canonical** |
| `mutter` | 0.3.0 | 5,648 | 2025-10-31 | Small, easy-to-use wrapper; far less adoption, keep as fallback only |
| `whisper-rs-2` | 0.2.1 | 2,802 | **2022-11-03** | Abandoned; ignore |

`tauri-plugin-whisper-rs 0.2.2` also exists (a turnkey Tauri plugin), but its adoption is tiny and
it bundles model-management opinions we would have to fight. Use the raw crate.

---

## 2. Model choice and where it lives

### 2.1 Measured comparison (this M3, whisper-rs 0.16.0 / whisper.cpp 1.8.3, release build)

All times are **best of 3 after one warm-up**, forced language, `single_segment`, 4 threads.
"RAM" is peak RSS of the probe process (`/usr/bin/time -l`), i.e. the cost of keeping the model warm.

| Model | Disk (exact bytes) | Params | Peak RSS | Warm load | Infer 2.0 s EN | Infer 1.8 s TR | RAM cost |
|---|---|---|---|---|---|---|---|
| `tiny` (multilingual) | 77,691,713 (~74 MiB) | 39 M | ~198 MB | 88 ms | 86 ms | 96 ms | ~0.2 GB |
| `base` (multilingual) | 147,951,465 (~141 MiB) | 74 M | ~296 MB | 106 ms | 126 ms | 180 ms | ~0.3 GB |
| `small` (multilingual) | 487,601,967 (~465 MiB) | 244 M | ~720 MB | 210 ms | 365 ms | 362 ms | ~0.7 GB |
| `large-v3-turbo-q5_0` | 547 MiB | 809 M | ~763 MB | 238 ms | **1611 ms** | **1597 ms** | ~0.75 GB |

Disk sizes and SHA-1s were verified against `huggingface.co/ggerganov/whisper.cpp` after download
(all four matched the published SHA-1, e.g. `small` = `55356645c2b361a969dfd0ef2c5a50d530afd8d5`).
whisper.cpp's own README quotes ~852 MB memory for `small` and ~388 MB for `base`; our RSS numbers
are in the same band.

### 2.2 Accuracy on synthetic English and Turkish command phrases

The probe transcribed five real command-like phrases voiced by macOS `say` (Samantha for English,
Yelda for Turkish), then resampled 48 k→16 k. `USDC` is pronounced by TTS as a word, which the
models mangle — treat this as a **code-switch stress test, not a fair WER figure**.

English:

| Phrase (intended) | tiny | base | small | turbo |
|---|---|---|---|---|
| "send ten USDC to ada" | `Cent-10USDC2Aida.` | `sent 10 USD/C to ADA.` | **`Send 10 USDC to ADA.`** | `Send 10 USDC to ADA.` |
| "what is my usdc balance" | `What is my Ustke Balance?` | `What is my Ust Balance?` | `What is my Ust Balance?` | `What is my ust balance?` |

Turkish:

| Phrase (intended) | tiny | base | small | turbo |
|---|---|---|---|---|
| "ada'ya on usdc gönder" | `Adaya on usucu öncesi.` | `Adaya Londus'u gönder.` | `Adaya onu suç gönder.` | `Adaya onu gönder.` |
| "bakiyemi söyle" | `Baki'ye mi söyle?` | `Bakayım isöyle.` | `Bakıyemi söyle.` | `Bakiyemi söyle.` |
| "soroban nedir" | `soroban nedir?` | `Soru ben nedir?` | `Soraban nedir?` | `Soroban nedir.` |

Observations:

- **English:** `small` and `turbo` are correct on the sentence that matters ("Send 10 USDC to ADA");
  `tiny` is unusable for commands.
- **Turkish:** every model struggles with the mixed Turkish+`USDC` token; `turbo` is clearly best on
  pure Turkish, `small` is a clear step above `tiny`/`base`. `tiny` hallucinates Turkish words.
- Independent literature agrees Whisper is weaker on Turkish: an IEEE study evaluates
  tiny/base/small/medium on Turkish ASR, and fine-tuned Turkish checkpoints exist
  (`selimc/whisper-large-v3-turbo-turkish`) precisely because base Whisper Turkish is imperfect.
  If Turkish quality must be high, the eventual answer is a Turkish fine-tune or the cloud
  `large-v3`-class model — **not** a bigger CPU model, because `turbo` already fails the latency
  budget.

### 2.3 Auto-detect vs forced language — a verified trap

`FullParams::set_detect_language(true)` (documented as equivalent to language `"auto"`) produced
**empty transcripts for every model and both languages** in our probe, while the state reported the
correct detected language id (9 = tr, 0 = en). Repro is deterministic. Using
`set_language(Some("auto"))` instead produced correct text and correct detection, at a small cost
(`small` EN: 647 ms vs 365 ms forced).

**Recommendation: force the language.** The product has one user and a known language; a
`POLARIS_STT_LANG` setting (default `tr`, `en` for English demos) removes both the ~0.3 s detection
cost and the misdetection risk. If auto is ever wanted, use `set_language(Some("auto"))`.

### 2.4 Recommendation

**Use `ggml-small.bin` (multilingual), forced language, loaded warm.** Rationale:

- It is the smallest model whose English commands are clean and whose Turkish is meaningfully
  better than `base`/`tiny`.
- Its inference is ~0.36 s for a 2 s clip — a huge margin under 2 s.
- `turbo` is far more accurate but ~4.4× slower and **fails the acceptance budget on a 3–5 s
  utterance**; it is also the only model here whose RAM/disk (~550 MB/0.75 GB) approaches `small`
  while being slower, so it has no niche on this machine for short clips.
- `base` is a reasonable fallback if 466 MiB is considered too large; document the accuracy drop.

Model family size context (from whisper.cpp's model README and OpenAI's model card): tiny 75 MiB,
base 142 MiB, small 466 MiB, medium 1.5 GiB, large-v3-turbo 1.5 GiB full / 547 MiB q5_0.
`distil-*` (distil-small.en / distil-large-v3) is **English-only** and therefore disqualified.

### 2.5 Where the weights live

Do **not** bundle the weights in the app for the hackathon:

- Bundling `small` makes the `.app`/DMG ~500 MB+; Tauri's own bundle is ~10–20 MB.
- Weights are a separate, replaceable artifact; bundling couples model changes to app releases.

Recommended shape:

1. A `make model` target (and `scripts/fetch-model.sh`) that downloads the chosen ggml file into a
   gitignored `models/` directory and verifies the SHA-1. (`models/` is already in `.gitignore`;
   `.env.example` already names `POLARIS_WHISPER_MODEL`, see below.)
2. The app resolves the model path in this order: `POLARIS_WHISPER_MODEL` env override → app-data
   `models/ggml-small.bin` → error state. A0 already uses
   `app.path().app_data_dir()?.join("recordings")`; the model belongs in the sibling
   `.../dev.polaris.desktop/models/`.
3. If the file is missing, the overlay shows one short label (`Setup`, see §6) and the log pane
   carries the detail + the exact `make model` command. Optionally a first-run download with a
   progress line in the log pane, but for demo reliability pre-fetch with `make model`.

**Bug found in the existing config:** `.env.example` line 28 sets
`POLARIS_WHISPER_MODEL=models/ggml-base.en.bin`. `base.en` is **English-only** and will not
transcribe Turkish at all. A1 must change this to a multilingual model (`ggml-small.bin`,
`ggml-base.bin`, or `ggml-tiny.bin`).

Resulting download/app size: app bundle unchanged (~10–20 MB); a one-time **466 MiB** model fetch
(`base` = 141 MiB if that route is chosen).

---

## 3. The 2 s budget

Measured breakdown for the recommended `small` model on a **3 s** utterance (48 kHz input),
assuming the model is already warm (loaded at startup):

| Stage | Cost | Basis |
|---|---|---|
| Hotkey release → WAV finalized | ≲ 10 ms | A0 measured (worker finalise, ms-scale) |
| Read WAV + i16→f32 | < 1 ms | measured |
| Resample 48 k→16 k | **~0.1 ms** for 2 s | measured (linear); a sinc resampler is still ≪ 10 ms |
| Inference | **~0.55 s** (0.365 s × 3/2) | measured 365 ms for 2.0 s |
| `transcript` event + React render | < 5 ms | local Tauri IPC |
| **Total (warm)** | **≈ 0.6 s** | vs 2 s budget |
| **+ first-use model load / Metal compile** | **+ 6.6–6.8 s observed cold**, +0.1–0.4 s warm | measured |
| **Total (warm load, not preloaded)** | **≈ 0.8 s** | still passes |

So the target is realistic with a big margin for `small`, and even more so for `base`/`tiny`.
Extrapolating the measured per-second rates: 5 s utterance ≈ 0.9 s (`small`), 0.45 s (`base`),
0.24 s (`tiny`) of inference.

**Keeping the model warm is the difference between failing and passing only for the very first
utterance after a cold start**, where Metal kernel compilation pushed the first context load to
~6.7 s. A 2 s budget cannot absorb that, so the model must be loaded at app startup (or on the
first hotkey **press**, while the user is still speaking — the 1–5 s utterance gives a natural
masking window). Cost of staying warm: **~0.7 GB RSS for `small`** (0.3 GB `base`, 0.2 GB `tiny`)
on a 16 GB machine — acceptable.

Caveat: these are **my measurements on this exact M3 with synthetic audio**. They are the right
order of magnitude for the acceptance test but should be re-measured once with the user's real
voice and real microphone before signing off A1.

---

## 4. Resampling

whisper.cpp requires **16 kHz mono f32**. A0 writes 16-bit PCM WAV at the *device* rate (observed
48 kHz built-in mic, 24 kHz AirPods) and possibly more than one channel.

### Recommendation

**Keep capturing at the device's native rate and resample in Rust.** Do not try to force 16 kHz
through `cpal`: on macOS/CoreAudio a device advertises a set of supported configs and you must pick
one it actually supports; requesting 16 kHz can either fail (`build_input_stream` error) or silently
invoke OS sample-rate conversion with unknown quality, and it would have to be re-validated per
device (AirPods vs built-in mic). Resampling in Rust is deterministic, device-independent, and
**measured at ~0.1 ms** for a 2 s clip — there is no performance reason to avoid it.

Use **`rubato` 5.0.0** (crates.io, maintained) for the general case. It is a windowed-sinc/FFT
resampler; feed it the mono f32 buffer and the known input/output rates. This handles both the
exact-integer 48 k→16 k case and the non-integer 24 k→16 k case with one code path.

A crate-free alternative is defensible **only for the exact ratios**:

- 48 k→16 k is exactly 3:1. A box average of 3 consecutive samples followed by decimation is a
  simple, adequate anti-alias for speech, and is a few lines.
- 24 k→16 k is 3:2 and **cannot** be integer-decimated; it needs interpolation (e.g. upsample 2×
  by linear interpolation, then 3:1 box decimate) or a real resampler. Getting this subtly wrong
  (naively dropping samples) is the classic bug that aliases and wrecks accuracy.

### Quality traps to warn about

- **Naive decimation** (taking every Nth sample without a low-pass) aliases high frequencies into
  the speech band and degrades recognition, especially for sibilants. This is the most common
  resampling bug.
- **Reading the WAV as stereo when it is mono (or vice versa)** shifts everything. A0 stores the
  device channel count; A1 must use `hound`'s `spec.channels` and downmix (average) only if > 1.
- **Converting i16 with the wrong scale.** whisper-rs' `convert_integer_to_float_audio` divides by
  32768.0 — use it rather than hand-rolling.
- **Ignoring the WAV's own rate** and assuming 16 k/48 k. Parse `spec.sample_rate` every time;
  the rate varies between recordings (AirPods 24 k).
- **Very short inputs**: whisper pads to a 30 s window internally, so a 0.3 s clip is mostly
  padding; gate on minimum duration instead of feeding noise.

---

## 5. Threading and integration shape

Inference is ~0.5 s of CPU/GPU work and must not block the Tauri main thread or the A0 realtime
audio callback. Recommended shape, consistent with A0's `capture.rs` pattern:

- **Own one warm `WhisperContext` (and a reusable `WhisperState`) on a dedicated `std::thread`
  started in `setup`**, fed by an `mpsc` channel of WAV paths. `WhisperContext` is `Send + Sync`, so
  this is sound; keeping the context alive is what makes the first-utterance load free.
- On `PolarisEvent::AudioCaptured`, the capture handler sends the path to the STT worker and
  immediately returns. The worker does: read WAV → downmix → resample to 16 k → i16→f32 →
  `state.full(...)` → collect segments → `events::emit(app, PolarisEvent::Transcript { text, final: true })`.
- **Do not** use `tauri::async_runtime::spawn_blocking` per utterance for the model load; use it
  (or a plain thread) only for the one-time warm-up. A long-lived worker thread is simpler and
  avoids re-loading.
- **Single-flight:** if a new capture starts while the worker is still transcribing, either drop the
  stale job or serialise behind the channel; don't build overlapping native contexts.
- **Partials:** `Transcript { text, final }` already supports partials, but whisper.cpp is not a
  streaming decoder and utterances are 1–5 s. Emit **one `final: true`** event; do not fake partials.
  (Optionally emit `final: false` with an empty/`…` text at start purely as a UI cue.)
- Failure (`WhisperError`) must become a value emitted on the stream, never a panic — mirror A0's
  `Inner::Error` discipline.

Latency of the event round-trip is sub-millisecond local IPC; it is not a budget concern.

---

## 6. Failure modes and overlay labels

The overlay's left ear draws exactly one short label (currently `Listening` / `Ready` /
`Mic error` / `Grant access` / `Connecting`). All A1 failures must map to a label of that length;
the full reason goes to the log pane / `aria-label`.

| Failure | Detection | Suggested label | Log-pane detail |
|---|---|---|---|
| Empty / silent recording | RMS below a small threshold over the buffer, or whisper returns empty | **`No speech`** | "no speech detected in <path>" |
| Recording too short | `durationMs` < ~300 ms (or sample count below threshold) | **`Too short`** | "clip 0.2 s, minimum 0.3 s" |
| Unsupported / odd rate | `hound` spec rate 0, or resampler rejects it | **`Audio err`** | "unsupported sample rate 0 Hz" |
| Missing model file | path resolution fails at startup or on first use | **`Setup`** (log shows `make model`) | "model not found: <path>; run `make model`" |
| Inference failure | `state.full(...)` / `create_state()` returns `WhisperError` | **`STT err`** | the underlying error string |
| Model still warming (cold load) | first utterance before warm-up completes | **`Warming`** | "loading model, first run may take a few seconds" |

Design notes:

- Reuse `CaptureStatus`/`CaptureState` where it fits (A0 already emits `error`), or add an STT
  status variant additively — do not rename existing seam fields.
- An empty successful transcript should be `No speech`, not an empty `transcript` event that the
  agent loop then tries to parse into an `Intent`.

---

## 7. Cloud fallback

Concrete options (prices as of September 2026):

| Provider / model | Price | Notes |
|---|---|---|
| **Groq `whisper-large-v3-turbo`** | **$0.04 / hour ≈ $0.00067 / min** (10 s minimum billing) | Very cheap, LPU-fast; multilingual Whisper turbo. Best cost/latency fallback. |
| Groq `whisper-large-v3` | $0.111 / hour ≈ $0.00185 / min | Higher accuracy, slower. |
| OpenAI `gpt-4o-mini-transcribe` | $0.003 / min ($0.18/hr) | Cheapest OpenAI option. |
| OpenAI `gpt-4o-transcribe` / `whisper-1` | $0.006 / min | Higher accuracy / classic Whisper endpoint. |
| Deepgram / AssemblyAI / Cartesia | ~$0.004–0.013 / min class | Streaming-capable alternatives; not evaluated here. |

Rough latency: network + inference is typically **~0.5–2 s** for a few-second clip, with much higher
variance than local inference (mobile network, provider queue). It can *meet* the 2 s budget, but
not reliably, and it adds a network dependency to the demo.

**Privacy consequence, stated plainly: the user's raw audio leaves the machine and is processed by
a third party.** For a voice-controlled wallet, that is exactly the class of data you should not
ship by default. Therefore: **opt-in only**, off by default, with an explicit yes/no in settings and
a clear indicator when it is active. Do not send audio silently on failure.

**Should it be built before the deadline? No.** `small` already meets the acceptance criterion
locally at ~0.6 s; the cloud path adds a secret-management surface, a network failure mode, a
privacy decision, and provider integration for a fallback the demo does not need. Leave a trait
seam (e.g. `trait Transcriber`) with only the local implementation wired, so a cloud backend can be
slotted in after the milestone without rewriting call sites.

---

## Confidence and caveats

- **High confidence (directly verified on the target machine):** `whisper-rs 0.16.0` + `metal`
  compiles and links; vendored whisper.cpp is 1.8.3; the API shape in §1.1; model disk sizes and
  SHA-1s; per-model inference times, warm/cold load times, and RSS; the `set_detect_language(true)`
  empty-output trap; `set_language(Some("auto"))` works; `.env.example` points at an English-only
  model.
- **Medium confidence (measured but on synthetic TTS):** Turkish/English accuracy ordering. The
  `say` voices and the TTS pronunciation of "USDC" are not the user's voice; real-voice accuracy
  should be re-measured before signing off A1.
- **Estimates (labelled):** the 3 s / 5 s extrapolations in §3 scale the measured per-second rate
  linearly; they are estimates, not measurements.
- **Not verified here:** whether a Turkish fine-tune (`selimc/whisper-large-v3-turbo-turkish`)
  can be converted to ggml and would run within budget; CMake availability on other machines;
  notarisation behaviour of the vendored Metal library inside a signed Tauri bundle. These are
  flagged as open items, not assumptions.

## Sources

- whisper-rs crate docs, v0.16.0 — https://docs.rs/whisper-rs/0.16.0/
- whisper-rs on crates.io (version, downloads, repo) — https://crates.io/crates/whisper-rs
- whisper-rs repository (Codeberg) — https://codeberg.org/tazz4843/whisper-rs
- whisper.cpp repository (README, `whisper-cli`, model list, memory table) — https://github.com/ggml-org/whisper.cpp
- whisper.cpp ggml model files + SHA-1s — https://huggingface.co/ggerganov/whisper.cpp
- OpenAI Whisper (model table, turbo notes, MIT licence) — https://github.com/openai/whisper
- Distil-Whisper (English-only) — https://github.com/huggingface/distil-whisper
- `rubato` resampler — https://crates.io/crates/rubato
- `mutter` / `whisper-rs-2` (alternatives, adoption) — https://crates.io/crates/mutter, https://crates.io/crates/whisper-rs-2
- OpenAI transcription pricing — https://developers.openai.com/api/docs/models/gpt-4o-transcribe
- Groq audio pricing (Whisper per hour) — https://www.usagepricing.com/blueprint/groq
- Turkish Whisper evaluation (IEEE) — https://ieeexplore.ieee.org/document/10773523
- Turkish Whisper fine-tune (context for quality ceiling) — https://huggingface.co/selimc/whisper-large-v3-turbo-turkish
- Apple `say` / `afconvert` used to generate test audio (local tooling)
