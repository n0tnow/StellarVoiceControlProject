# Report: capture-device-and-error-height-fix

- **Date:** 2026-09-19
- **Worker/Agent:** opencode worker (deepseek-v4.1-flash)
- **Branch/Worktree:** `feat/a0-push-to-talk-notch` @ `.worktrees/a0`
- **PR:** none (per task: no PR, no merge, no tag)
- **Scope:** `app/src-tauri/src/capture.rs` (BUG 1), `app/src/index.css` + `app/src/App.tsx`
  (BUG 2). The hotkey/gesture code, the event stream, the state names, and the native window
  behaviour are untouched.

---

## BUG 1 — capture dies with a buffer underrun (`cpal::StreamError::Xrun`)

### What was observed

The overlay showed `Recording unavailable — audio stream error: A buffer underrun or overrun
occurred.` and the terminal logged `polaris: capture failed: audio stream error: A buffer underrun
or overrun occurred.`. Capture worked earlier in the same session and then started failing.

### Which of the three hypotheses is the real cause

**None of the three, as written.** All three were checked against the code at HEAD (`f7b4c55`
created `capture.rs`; it has not changed since) and are contradicted by it. The code evidence:

1. **"Config chosen from `supported_input_configs()` / hardcoded / minimum rate."** False.
   `record_to_wav` calls `device.default_input_config()` (`capture.rs:212`). A repo-wide grep finds
   **no** use of `supported_input_configs`, no hardcoded rate, and no minimum-rate selection.
   The 24 kHz WAVs are explained by the device that was actually in use, not by a wrong request:
   AirPods expose a **24 kHz** input format (Bluetooth), while the `system_profiler` reading of
   `MacBook Air Microphone @ 48000 Hz` was taken with the built-in mic selected. A 24 kHz WAV from
   a 24 kHz device is correct, not a spec bug.
2. **"Device/`StreamConfig` resolved once and reused."** False. `record_to_wav` is called on
   every `Capture::start` (via the `finish_capture` worker), and it resolves `cpal::default_host()`,
   `host.default_input_device()`, and `device.default_input_config()` **inside the function**. There
   is no `OnceLock`, `lazy_static`, or cached field anywhere in the module. A default-input switch
   between recordings cannot leak into the next call.
3. **"`WavSpec` not derived from the stream config in use."** False. `spec` is built from `config`,
   and that same `config` is handed to `build_stream`. cpal 0.18.2 uses `config.sample_rate` as the
   callback clock (`coreaudio/macos/device.rs:1063` in `setup_callback_vars`), so the header rate,
   the callback frame rate, and the interleaved write are all the same value.

### The real cause (code-evidenced)

The message is cpal's `StreamError::Xrun` (`display`: "A buffer underrun or overrun occurred.",
`cpal-0.18.2/src/error.rs:127`). On macOS that variant is emitted from exactly one place for an
input stream: the `kAudioDeviceProcessorOverload` property listener
(`cpal-0.18.2/src/host/coreaudio/macos/mod.rs:191`). CoreAudio raises that notification when the
device's realtime I/O cannot service the client callback in time.

The old callback was the reason it could not keep up. It ran **on the realtime thread** and did:

```rust
move |data: &[T], _| {
    samples.fetch_add(data.len() as u64, Ordering::Relaxed);
    let mut guard = writer.lock().unwrap_or_else(...);   // std::sync::Mutex
    if let Some(writer) = guard.as_mut() {
        for &sample in data {
            writer.write_sample(i16::from_sample(sample)); // file I/O per sample
        }
    }
}
```

That is blocking disk I/O (through a `BufWriter<File>`) under a mutex lock, inside the realtime
callback. It is fine until the deadline tightens; when the default input switched to AirPods (a
smaller, differently-clocked Bluetooth buffer) the callback missed its deadline and CoreAudio
reported the overload. This matches "worked earlier in the session, then started failing after the
device changed."

### The fix

- **Nothing blocking on the realtime thread.** Samples are converted and `try_send`-ed to a
  bounded `sync_channel`; a dedicated `writer_loop` thread owns the `WavWriter` and does all
  filesystem work. If the writer falls behind, a buffer is dropped (a glitch) instead of overrunning
  the device.
- **Failure now tears the stream down promptly.** The capture thread waits in a `recv_timeout`
  loop on the release *or* a shared `AtomicBool` set by the cpal error callback. On error it drops
  the stream immediately (not on the next hotkey release), finalizes, and the engine lands in
  `error`. A subsequent `start()` proceeds normally, so the next Control+Option hold works.
- **Pure spec derivation + test.** `wav_spec(&cpal::StreamConfig) -> hound::WavSpec` is extracted
  and unit-tested (`wav_spec_tracks_the_stream_config`), proving the header follows the config
  (24 kHz mono vs 48 kHz stereo).

The `idle/recording/ready/error` state machine and the "release never sends" invariant are
unchanged.

### Verification

`cargo build`, `cargo test` (26 passed, +1 new), `cargo clippy --all-targets` (only the
pre-existing `large_enum_variant` warning in `events.rs`).

---

## BUG 2 — the shell must never grow vertically

### Root cause

Two pieces, not one:

- `app/src/index.css:236` (old): `.state-error.is-expanded { height: calc(var(--expanded-height) + 42px); }` — the only rule that made an expanded state taller than `--expanded-height`.
- `app/src/App.tsx`: the error state rendered a **second row** (`<p className="notch-error">`)
  below `.notch-copy`, which is what needed the extra 42 pt. Removing only the CSS override would
  have pushed that row outside the fixed 66 pt shell.

### The fix

- Removed `.state-error.is-expanded` entirely and the `.notch-error` rules/markup. The shell is
  now `var(--expanded-height)` in **every** expanded state.
- The error message moved into the existing `notch-detail` line: a flex row where the message
  truncates with an ellipsis (`min-width: 0; overflow: hidden; text-overflow: ellipsis`) and the
  retry hint stays pinned as a non-shrinking suffix. Both remain readable inside 66 pt; the
  `sr-only` live region still carries the full message.

### Height audit (no other rule can grow the shell)

Every `height`/`min-height`/`max-height`/`padding` rule in `index.css` was re-read:

| Rule | Effect on the shell |
|---|---|
| `html, body, #root { height: 100% }` | Window/root container; not the shell. |
| `.notch-stage { height: 100% }` | Stage fills the window; the shell is top-anchored (`align-items: flex-start`). |
| `.notch { height: var(--idle-height) }` | Resting pill only. |
| `.notch.is-expanded { height: var(--expanded-height) }` | The single expanded height. No override remains. |
| `.notch::before/::after { height: var(--ear) }` | Absolutely-positioned decorative ears; no layout contribution. |
| `.notch-content { height: var(--expanded-height) }` | Child with `overflow: hidden`; cannot grow the parent. |
| `.notch-copy { padding-top: 3px }`, `.notch-detail` margin | Internal to the fixed-height content box. |
| `.notch-indicator { height: 38px }`, dots `7px`, glow `95px` | Fixed/absolute children; no layout contribution beyond 38 px inside 66 px. |
| `line-height` values | Not box height. |
| `@media (max-width: 480px)` padding | Horizontal only. |

`prefers-reduced-motion`, the horizontal-only width expansion, the radii/ears, and the flush top
edge are untouched.

### Verification

`npm run typecheck` and `npm run build` (repo root) both pass. No visual check was possible (see
below).

---

## What I could NOT verify

- **No microphone on this machine.** I cannot reproduce the `Xrun`, confirm that a live recording
  now succeeds, or confirm the exact AirPods sample rate. The fix is justified by cpal/CoreAudio
  source evidence, not by a live capture.
- **Cannot see the screen.** The 66 pt fixed height, the ellipsis truncation, and the retry-hint
  layout were verified only by reading the CSS/DOM and by typecheck/build — not visually.

## Honesty notes

- The three hypotheses in the task are all already satisfied by the code, so I did not choose one.
  The stated 24 kHz/48 kHz "mismatch" is most likely two different default devices, not a
  derivation bug. I changed the callback architecture on the evidence of the cpal error path
  (`kAudioDeviceProcessorOverload` → `Xrun`) plus the blocking I/O in the callback. If a reviewer
  has a trace showing cpal requesting 24 kHz on a 48 kHz device, that is new evidence and would
  need a separate look; nothing in this source supports it.
- The bounded `sync_channel` still allocates one small `Vec<i16>` per callback. That is a minor
  realtime-allocation smell; it is orders of magnitude cheaper than the per-sample disk write it
  replaces, and eliminating it would need a pre-allocated buffer pool (out of scope here).

## Unfinished / handed off

- Live on-device confirmation of BUG 1 (needs the user's Mac with AirPods) and a visual check of
  the 66 pt error shell (needs a screen).
- If the reviewer rejects the "real cause" analysis, the fallback is to also pin the stream to a
  freshly chosen supported rate — but that contradicts `default_input_config` being the correct
  source and is not recommended.

## Suggested next step

- Run the built app on the user's machine: record with the built-in mic, switch to AirPods,
  record again, and confirm no `Xrun` and that both WAVs report the rate of the device that was
  active. Screenshot the error state and confirm 66 pt.
