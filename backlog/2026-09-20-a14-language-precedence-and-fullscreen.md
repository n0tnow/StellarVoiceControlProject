# A14 — Language precedence inverted, and the notch floats over fullscreen apps

- **Task:** `TASK-A14.md`
- **Branch:** `feat/a12-language-detection` (continued)
- **Worker:** opencode worker (`opencode-go/deepseek-v4.1-flash`)
- **Date:** 2026-09-20
- **Status:** pushed, no PR, no merge, no tag

## 1. The language rule was backwards — inverted

### Evidence

A12 made the STT-detected language win over the model's judgement. The owner's
real run (`reports/logs/a12-app-dev.log`) shows that is the wrong way round:

```
polaris: transcript in 479 ms (audio 2560 ms) via stt [lang tr]: Can you send 400$ to Bilal?
polaris: transcript in 511 ms (audio 3605 ms) via stt [lang tr]: Bilal'e 400 BTC'ye gönderin mi?
```

The first line is decisive: Whisper transcribed **correct English text** and still
tagged it `tr`. The detector is an audio-level guess, and the owner's short,
code-switched utterances full of names and currency symbols are exactly where
that guess is weakest. The transcript text is the stronger evidence.

### Change

- `agent/src/language.ts` — `resolveTurnLanguage` now returns the **model's
  report** as `language`/`source: "model"` when the model reported one; the STT
  label is the fallback (`source: "stt"`) only when the model reports nothing.
  `disagreed` still reports a base-language mismatch.
- `agent/src/prompt.ts` — `withDetectedLanguage` no longer orders the model to
  use the detected language. It states the recogniser's **guess** and explicitly
  tells the model to judge from the transcript text and override the guess.
- `agent/src/loop.ts` — the disagreement log now says the model's report won:
  `using the model's report (judged from the transcript text)`.
- `app/src-tauri/src/stt.rs` — the worker log tag is `[stt-lang hint …]` (was
  `[lang …]`) so the terminal never reads as if the label were decisive.

### Is the STT label still worth keeping? Yes.

Reasoning:

1. It is the **fallback** when the model reports nothing — a provider that
   ignores the language instruction (or a text-only turn) still gets a sane
   reply/voice language instead of the English default.
2. It is a useful **hint** in the prompt; the disagreement log is now a real
   measurement of how often Whisper's audio ID is wrong, which is diagnostic.
3. It costs nothing: the normalisation and event plumbing already exist.

What it must **not** be, and no longer is: the decision. That was the A12
mistake.

### Tests

- `agent/src/language.test.ts` — the old precedence test was replaced:
  `the model's report wins over the STT label (step A14)`.
- A test built from the **real failing transcript**: input
  `resolveTurnLanguage("tr", "en")` (the 479 ms line) must resolve to English.
- `the STT label is the fallback only when the model reports nothing`.
- `agent/src/loop.test.ts` — `the model's report wins over the STT label` runs
  the exact A14 transcript `"Can you send 400$ to Bilal?"` with
  `transcriptLanguage: "tr"` and asserts `language === "en"`,
  `languageSource === "model"`, and that the prompt still carries the `tr` hint.

## 2. The notch now floats over a fullscreen app

`tauri.conf.json`'s `alwaysOnTop` / `visibleOnAllWorkspaces` are not sufficient
for fullscreen Spaces. `notch.rs` already reached the `NSWindow`; two things
changed there:

- **Window level** raised from `NSStatusWindowLevel` (25, above the menu bar only)
  to **`NSPopUpMenuWindowLevel` (101)** — above the window a fullscreen app is
  promoted to.
- The collection behaviour is now one named value
  (`overlay_collection_behavior`): `CanJoinAllSpaces | FullScreenAuxiliary |
  Stationary | IgnoresCycle`, so the overlay joins every Space **and** is allowed
  to float above a fullscreen window instead of being swallowed by it. The window
  stays click-through and cannot become key, so it never activates Polaris.

### What is verified

The live flags are read straight off the real `NSWindow` (not the config), logged
at startup, and exposed through the new `notch_window_flags` command. Running the
built binary from this worktree (macOS, 14" notched display):

```
polaris: notch geometry NotchGeometry { idle_width: 179.0, idle_height: 32.0, expanded_width: 399.0, expanded_height: 32.0, ... }
polaris: notch window flags NotchWindowFlags { level: 101, collection_behavior: 337, full_screen_auxiliary: true, can_join_all_spaces: true, focusable: false }
```

`collection_behavior: 337` = `0x151` = `CanJoinAllSpaces(1) | Stationary(16) |
IgnoresCycle(64) | FullScreenAuxiliary(256)`. A Rust test
(`the_overlay_clears_a_fullscreen_window_and_joins_every_space`) pins level > 25
and both behaviour bits, and the bit readback matches the constants so the
diagnostic cannot claim a flag that was not set. Geometry on the normal desktop is
unchanged (`179x32` pill, `399x32` shell — identical to A12).

### What is outstanding

**The final visual check over a real fullscreen app is outstanding for the
owner.** This worker did not see the overlay float over a fullscreen app; it
verified the window flags only. The owner should open a fullscreen app and
confirm the pill stays visible on the active Space without stealing focus.

## Acceptance

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm test -w @polaris/app` | 19 passed |
| `npm test -w @polaris/agent` | 109 passed (was 108) |
| `caffeinate -i cargo test` | 121 passed / 5 ignored (was 120 / 5) |
| `caffeinate -i cargo clippy --all-targets` | clean |

### Real run: English text mislabelled `tr` answers in English

The e2e driver gained an optional `POLARIS_E2E_STT_LANG` override so the owner's
exact failing case is reproducible without a microphone
(`reports/logs/a14-e2e-mislabel-english.log`):

```
STT language hint handed to the agent: tr
language disagreement: STT detected "tr" but the model reported "en" — using the model's report (judged from the transcript text)
spoken sentence: Sending 400 USDC to Bilal. Do you confirm?
language: en (source model)
polaris: tts in 6283 ms via fish (42 chars, lang en)
```

A live Groq STT pass on a synthesised English clip (the same sentence) labelled
it `en` correctly, and the full audio → STT → agent → Fish path answered in
English:

```
polaris: e2e-stt {"text":"Can you send $400 to Bilal?","language":"en","ms":1102}
spoken sentence: Sending 400 USDC to Bilal. Do you confirm?
language: en (source model)
polaris: tts in 6695 ms via fish (42 chars, lang en)
```

The Turkish direction also still works (hint `en`, Turkish text → `language: tr`,
`Bilal adresine 400 USDC gönderiyorum. Onaylıyor musun?`).

## Files touched

- `agent/src/language.ts`, `agent/src/language.test.ts`
- `agent/src/prompt.ts`, `agent/src/loop.ts`, `agent/src/loop.test.ts`
- `agent/src/e2e-speak.ts` (opt-in `POLARIS_E2E_STT_LANG` reproduction aid)
- `app/src-tauri/src/notch.rs`, `app/src-tauri/src/lib.rs`
- `app/src-tauri/src/stt.rs`
- `app/src/lib/agent.ts`, `.env.example`

## Remaining work

- Owner visual check of the overlay over a real fullscreen app (the only
  unverified claim).
- Owner in-app mic run for the language precedence (the e2e proof is a real
  provider + real TTS run, but not the in-app mic path).
