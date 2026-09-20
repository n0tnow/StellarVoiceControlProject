# Report: notch-shell-port

- **Date:** 2026-09-20
- **Worker/Agent:** opencode worker (`opencode-go/deepseek-v4.1-flash`)
- **Branch/Worktree:** `feat/notch-shell` — `.worktrees/notch-port` (base `origin/main` 91e7156)
- **PR:** none (the coordinator opens it; per task instruction)

## Objective

Re-apply this branch's two contributions — **the expandable notch shell** and the
**double-Control typed prompt** — onto current `main`, which already owns the good voice
chain (squashed as #16, A0–A14). The old `feat/a5-notch-shell` branch was cut from the
pre-squash voice branch, so a plain merge conflicts in 43 files on unrelated history; the
correct method is `main` as the base plus only our two contributions on top. Commit
`9a9b89a` (#21, accessory activation policy) must survive. Then fix the owner's two
animation bugs (task §6).

## Method — `main` is the base

Every shared file was started from `origin/main` and only our change re-applied:

| File | Reconciliation |
|---|---|
| `app/src-tauri/src/notch.rs` | `main`'s old two-state (606-line) version replaced by the data-driven `SHELL_STATES` rewrite (1676→1874 lines), **with #21 re-applied into the new structure** (below). |
| `app/src-tauri/src/lib.rs` | `main`'s registrations kept (`agent_chat`, `timing::polaris_phase`, `mod timing`) **plus** the notch commands (`notch_geometry`, `shell_request_state`, `shell_commit_state`, `shell_resize_content`), `tap::install`, hover install/teardown, and `apply_activation_policy` (#21). |
| `app/src-tauri/src/events.rs` | `main`'s A12 `language` field on `transcript` kept; added the shell-only `notch_hover` / `notch_hotkey` channels, emitters and shape tests. |
| `interfaces/src/index.ts` | `NotchGeometry` replaced by `ShellGeometry` / `ShellStateGeometry` / `NotchMetrics` + `FALLBACK_SHELL_GEOMETRY`; `transcript.language` kept from `main`. |
| `app/src/App.tsx` | `main`'s voice session (`reduceTurnSession`, stage labels, Speaking/error/dwell) and A12 language wiring kept; the shell is rendered by `ShellSurface`, the prompt state owns the surface, and the strip is not rendered in `prompt`. |
| `app/src/index.css` | `main`'s voice animation restored **verbatim** for the voice states; the `panel`/`prompt` blocks and the `.prompt-*` rules added on top (see BUG-2). |
| `app/src-tauri/tauri.conf.json` | `main`'s window widened/tallened to `900×520` so the largest state fits before the first `setFrame` (the panel is 779×420 + margins). |
| `app/src-tauri/capabilities/default.json` | Description only. |
| `app/src/lib/polaris.ts` | Removed the now-dead `getNotchGeometry` (`NotchGeometry` no longer exists); geometry moved to `app/src/notch/shellBridge.ts`. |

### `notch.rs` vs #21 (`9a9b89a`) — the activation policy is present and runs

`git show 9a9b89a` was read and its behaviour re-applied into the new structure instead of
being lost with the old file:

- `lib.rs::apply_activation_policy` sets `tauri::ActivationPolicy::Accessory` on the `App`
  **before `app.run()`** (i.e. before the config window is built) — exactly the #21 timing
  argument.
- `NotchActivationPolicy` enum + `activation_policy_of(NSApplicationActivationPolicy)` +
  `window::activation_policy()` (reads `NSRunningApplication::currentApplication()`), logged
  at startup; a loud `eprintln!` warning if the live policy is not `Accessory`.
- `OVERLAY_WINDOW_LEVEL = NSPopUpMenuWindowLevel (101)` (A14) and
  `window::overlay_collection_behavior()` = `CanJoinAllSpaces | FullScreenAuxiliary |
  Stationary | IgnoresCycle`.
- `Cargo.toml` keeps `NSRunningApplication` and adds `NSWorkspace` (the folded prompt's
  focus restore).
- #21's tests came across: `the_activation_policy_maps_from_appkit`,
  `activation_policy_serializes_as_camel_case`, and A14's
  `the_overlay_clears_a_fullscreen_window_and_joins_every_space`.

Startup trace confirms it runs:

```
polaris: notch activation policy Accessory
polaris: notch window width 827
```

### Extra file beyond the task's literal 2a/2b list (called out on purpose)

`app/src-tauri/src/hotkey_flags.rs` was modified (+237) as **required support for
`ctrl_tap.rs`**: the one existing `flagsChanged` monitor pair gains `KeyDown` observation and
adds additive *sample* / *key* observers (with panic containment and re-entrancy tests), so
the double-Control detector can tell a `Ctrl+C`/tmux `Ctrl+B` chord from a bare tap. The
change is purely additive observation — the push-to-talk latch is untouched — and without it
`ctrl_tap.rs` cannot load (it needs `add_sample_observer` / `add_key_observer`). Flagged so a
reviewer does not read it as voice-chain over-porting.

## Deliberately left on `main`

`agent/`, STT, TTS, the turn session/flow, `gesture.rs`, `hotkey.rs`, `capture.rs`, `timing.rs`
and every other voice-chain file are `main`'s copies, untouched. `app/vite.config.ts` is
`main`'s (it already dropped the dead `/agent-api` proxy); the Rust `agent_chat` transport is
kept. No voice-chain behaviour was ported from the old branch.

---

## BUG-1 — one-frame shell flash at the left edge during a transition

### Reproduction (before the fix)

Recorded the collapsed→panel hover with `screencapture -v -V 5`, stepped the frames with
`ffmpeg`, and located the transition. Scanning a 1-px row across the shell body per frame
(`ffmpeg … crop=2940:2:0:400 -f rawvideo -pix_fmt gray`) gave:

```
frame 212: black x=691..2248 len=1558 centre_pt=734.8   # panel settled, centred
frame 213: black x=691..2248 len=1558 centre_pt=734.8
frame 214: black x=691..2248 len=1558 centre_pt=734.8
frame 215: black x=697..1110 len=414  centre_pt=451.8   # <-- off-centre ~283 pt left
frame 216: black x=783..1089 len=307  centre_pt=468.0   # <-- off-centre ~267 pt left
frame 217: black x=1110..1829 len=720 centre_pt=734.8   # back on the cutout
```

The rendered frame 215 shows the shell body starting ~50 pt left of its settled left edge
(the `Ready` label and the panel's left edge both shift left) before it snaps back. That is
the owner's "sürekli duran notch anlık solda spawn olup yok oluyor".

### Root cause

The window is centred on the cutout, so a **per-state window width** moves the window's left
edge on every transition (`collapsed` window 227 pt → `panel` window 827 pt moves the origin
left by 300 pt). The webview relayouts **one frame behind** the native `setFrame`, so for
those frames the CSS-centred shell is still centred in the *old* viewport while the window
has already moved — it paints off-centre. `main` never hit this because its window is a fixed
780×120 and never resizes for the voice strip.

### Fix — one fixed window column for every state

`ShellGeometry::window_width()` returns the widest state's shell + side margins; `window_size`
uses that width for **every** state and only varies the height; `RuntimeState::target_frame`
passes it. The window's left edge and width are now constant, so the viewport-lag frame can
never paint off-centre. The voice animation (`collapsed`↔`compact`, both 32 pt tall) now
causes **no native resize at all**; the new downward states only grow the (top-anchored)
height, which does not move the shell.

The invariant is tested, not just hoped:

```
every_state_shares_one_centred_window_column
  - every SHELL_STATES row resolves to the same target_frame.width
  - every row resolves to the same target_frame.x
  - every row's frame centre == notch.cutout_center_x
```

Also added: `println!("polaris: notch window width {…}")` at startup so a future regression
that reintroduces a per-state width is visible in the trace (observed: `827`).

### After the fix

The rebuilt bundle launched and logged the fixed width. **The re-recording could not be
completed** — the machine locked its screen mid-verification
(`ioreg`: `IOConsoleLocked = Yes`, `CGSSessionScreenIsLocked = Yes`), which covers the overlay
and requires the account password / Touch ID that an agent does not have. The "after" frame
proof is therefore the one unfinished item; see *Blockers*. The before/after invariant is
nonetheless covered by the Rust test above.

---

## BUG-2 — use `main`'s Control+Option voice animation, not ours

`main`'s push-to-talk strip is the tuned reference. Comparing `git show origin/main:app/src/index.css`
with ours, the state-table rewrite (`5e586af`, "height-animating CSS") had changed the voice
`transition` and `will-change`. The voice states now use `main`'s values **verbatim**:

| Property | `main` | ours (voice states, after fix) |
|---|---|---|
| motion var | `--shell-motion: 470ms` | `--shell-motion: 470ms` |
| easing var | `cubic-bezier(0.32, 0.72, 0, 1)` | same |
| transition | `width`, `border-radius` — **no height** | same |
| `will-change` | `width` | `width` |
| radius, idle | pill top / pill bottom | `ShellShape::Pill` → `pill_top`/`pill_bottom` (same values) |
| radius, grown | top `0`, bottom `--shell-bottom-radius` | `ShellShape::Shell` → `0`/`shell_bottom` (same) |
| ear | `--ear` fixed, pseudo-elements fade via `opacity`, `--ear` **not** transitioned | `--shell-ear` static per state, pseudo-elements fade via `opacity`, not transitioned |
| content fade | `opacity var(--shell-motion) var(--shell-ease)` | same |
| label cross-fade | `stage-label-in/out 240ms var(--shell-ease)` | same |
| indicator | `listen 850ms` (recording) / `1150ms` (transcribing, speaking) | same |

`collapsed` and `compact` are both 32 pt tall, so `main`'s "height never transitions" rule is
preserved exactly — the strip moves purely left/right. The new `panel`/`prompt` states add the
`height` tween in their own rule (`.notch.shell-panel, .notch.shell-prompt`); they are
additions on top and do not modify the voice rule. Side-by-side comparison was done by reading
both `index.css` files and the matching `notch.rs` geometry; the only structural difference is
that the state table supplies the same `idle`/`expanded` values as two named rows.

---

## Test evidence

| Suite | Command | Result |
|---|---|---|
| Full static check | `caffeinate -i bash scripts/check.sh` | **passed** (JS typecheck, workspace tests, vite build, agent smoke, `cargo check`) |
| Rust unit tests | `caffeinate -i cargo test --manifest-path app/src-tauri/Cargo.toml` | **159 passed, 0 failed, 5 ignored** (main's suite + the new BUG-1 invariant test) |
| App shell tests | `npm test -w @polaris/app` | **32 passed, 0 failed** |
| Stellar tests | `npm test -w @polaris/stellar` | **112 passed, 0 failed** |
| Acceptance grep | `grep -rn "prompt_window\|prompt.html\|prompt-bar\|Speak replies" app/` | **no matches** |
| Debug bundle | `npm run tauri -w @polaris/app -- build --debug` | built `Polaris.app`; launched and hover opened the panel (screenshot captured); startup logged `activation policy Accessory`, `window width 827` |

The old branch's Rust suite was 129+; the current suite is 159 and `main`'s tests are all
retained.

## Unfinished / Blockers

- **BUG-1 "after" screen recording:** blocked by the machine locking its screen during the
  verification window. Needs the owner to unlock (password/Touch ID) and one more
  `screencapture -v` run; the fix itself and its invariant test are in place.
- The `hotkey_flags.rs` change is outside the task's literal 2a/2b file list but required by
  `ctrl_tap.rs`; a reviewer should confirm that call is acceptable.

## Suggested Next Step

Unlock the machine, re-run the collapsed→panel recording with the same `ffmpeg` frame scan,
and confirm no frame reports a non-`734.8` centre. Then open the PR (coordinator).
