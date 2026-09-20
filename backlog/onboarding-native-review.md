# Review: PR #34 — onboarding-native (`feat/onboarding-native` → `main`)

- **Reviewer:** independent reviewer (did not write this code)
- **Date:** 2026-09-20
- **Scope checked out at:** `/Users/fatih/StellarVoiceControlProject/.worktrees/onboarding-native`
- **Diff reviewed:** `git diff main...HEAD` (10 files, +907/−20)
- **Author report read (as claims, not evidence):** `backlog/onboarding-native.md`

## Verdict: APPROVE WITH NITS

The poll lifecycle, window lifecycle, and resign accounting are all sound on
close reading: the generation counter plus the per-tick visibility backstop
correctly scope the poll to window visibility, double-open only churns (never
duplicates) the poll thread, and `resign_after_interactive_close` correctly
excludes the closing window so it neither resigns early nor fails to resign.
`cargo clippy --all-targets -- -D warnings` is clean and `cargo test` passes
(328 passed / 0 failed / 5 ignored). The three findings below are edge-case
robustness nits, not correctness or safety blockers; none involves a panic
path, a leak, or wrong permission mapping. Live macOS behavior (TCC prompt,
Accessibility prompt, deep links, centering/appearance) could not be verified
headless and remains for the human checklist.

## Verification actually run

- `cd app/src-tauri && caffeinate -i cargo clippy --all-targets -- -D warnings`
  → clean, `Finished dev profile … in 0.74s`, no warnings.
- `cd app/src-tauri && caffeinate -i cargo test`
  → `328 passed; 0 failed; 5 ignored`, including the 8 `onboarding::tests`.
- `rg` for `unwrap|expect|panic!|todo!|unimplemented!|unreachable!` in
  `app/src-tauri/src/onboarding.rs` → hits only in `#[cfg(test)]` plus two
  `unwrap_or`/`unwrap_or_else` fallbacks in production code (both sound, see
  below). No `unwrap()`/`expect()` on any filesystem or config-dir path.
- `rg` for Turkish characters across `onboarding.rs`,
  `capabilities/onboarding.json`, `onboarding.html`, `src/onboarding/main.tsx`
  → no matches; English throughout.
- GUI app deliberately not launched, per instructions.

## Findings (most severe first)

### 1. Nit — `open_if_needed` failure in `setup()` fails the whole app start
`app/src-tauri/src/onboarding.rs:426` + `app/src-tauri/src/lib.rs:171`.

`open_if_needed` returns `Err` when the window cannot be built/shown/focused,
and `setup()` propagates it with `?`. On a first-run machine where window
creation transiently fails (headless CI, WindowServer hiccup), Polaris refuses
to start even though onboarding is non-essential and the marker logic itself
fails safe. Concrete failure: one `WebviewWindowBuilder::build` error on a
fresh install = app never launches, with no retry path except fixing the
window server and relaunching. Fix: log the error and return `Ok(())` from the
startup call site (keep `open_if_needed` fallible for the command path), e.g.
`if let Err(e) = onboarding::open_if_needed(...) { eprintln!(...); }`. This
matches the module's own "never skip onboarding on failure, never crash on
failure" philosophy. Precedent note: `notch::setup(app)?` also propagates, so
this is consistent with existing style — still worth fixing for the new,
user-facing-first-run call.

### 2. Nit — concurrent double-create has no label-collision tolerance
`app/src-tauri/src/onboarding.rs:379-407` (contrast `app/src-tauri/src/panels.rs:244-246`).

`open()` does `match get_webview_window { Some → reuse, None → build }`. Two
concurrent `onboarding_open` invokes can both observe `None`; the loser gets
`WindowLabelAlreadyExists` as an `Err(String)` instead of focusing the
winner's window. Panels handle exactly this race with `is_label_collision →
show_and_focus`. Concrete failure: user double-clicks a "show onboarding"
entry (or startup races a manual open) and gets a spurious error dialog while
the window is in fact open. Rare and self-healing (next open reuses), but the
fix is three lines: mirror `panels.rs` and fall back to show-and-focus on
`WindowLabelAlreadyExists`/`WebviewLabelAlreadyExists`.

### 3. Nit — `hide_window` stops the poll before hiding; a failed hide strands a visible window with no poll
`app/src-tauri/src/onboarding.rs:414-422`.

`stop_permission_poll()` runs first; if `window.hide()` then returns `Err`,
the function propagates the error with the poll already dead while the window
is still visible — so the React flow stops receiving `onboarding_permissions`
updates until the next open. Concrete failure: transient hide failure (the
same WindowServer class of failure finding 1 guards against) leaves a visible,
silent onboarding window. Fix: hide first, stop the poll only after a
successful hide (or re-start the poll on the error path when the window is
still visible).

## Smaller observations (not blocking, no change strictly required)

- **Poll overlap on rapid open→hide→open is bounded and safe.**
  `onboarding.rs:320-344`: each `open` bumps `POLL_GENERATION` and spawns one
  thread; the superseded thread exits on its next tick (≤1 s). Two threads can
  briefly coexist but only the current generation emits, and the old one always
  exits — no unbounded thread growth however fast the user toggles.
- **`RcBlock` lifetime follows the house precedent.**
  `onboarding.rs:259-270`: the completion block is dropped after
  `recv_timeout`, but this is the same "framework copies the block at
  registration" contract `notch/hover.rs` relies on (`drop(global_block)` after
  `addGlobalMonitor…`). Post-timeout firing only hits `tx.send` on a dropped
  receiver, whose `Err` is ignored — no panic, no UB by construction. The
  "Apple copies async completion handlers" premise itself is documentary, not
  statically verified here.
- **`PROMPT_TIMEOUT` hold is bounded and honest.**
  `onboarding.rs:273-274,498-506`: at most one blocking-pool thread per
  concurrent request for ≤120 s, and both the timeout and the `JoinError` path
  re-read the authoritative status instead of inventing an answer.
- **`permission_from_raw_av_status` mapping is correct**
  (`onboarding.rs:205-212`: 0→undetermined, 1|2→denied, 3→granted, unknown
  fails closed to denied) and `settings_url` deep links match the two
  `Privacy_*` panes (`onboarding.rs:189-198`).
- **Capability file is minimal and consistent.**
  `capabilities/onboarding.json` grants exactly `core:default` +
  `core:window:allow-close` scoped to `windows: ["onboarding"]` — the identical
  set as `capabilities/panels.json`, which is all an event-listening,
  command-invoking window needs (app-defined commands are not ACL-gated).
- **Marker I/O never panics and fails toward showing onboarding.**
  `onboarding.rs:135-176`: `marker_path` maps a missing config dir to `None`,
  `read_marker` maps any error to `None` (= not completed), writes/removes
  return `Err(String)`. `is_completed` (`129-131`) implements `>=` as
  documented. No `unwrap`/`expect` on these paths (verified by search).
- **Doc comments explain why, per house standard.**
  The module docs, `ONBOARDING_VERSION` re-run semantics, the `visible(false)`
  then show rationale, and the Accessibility prompt-return-value note all give
  reasons, not restatements — comparable to `ctrl_tap.rs`/`BlobatarFace.tsx`
  style. No `// what`-only filler found.
- **Frontend placeholder is honest.**
  `app/src/onboarding/main.tsx` + `app/onboarding.html` + `vite.config.ts`
  onboarding entry are minimal wiring owned by the parallel UI worker; the
  `throw` on missing `#root` is placeholder-appropriate. I did not run
  `tsc`/`vite build` (outside the assigned verification commands); the
  author's claim of clean `tsc` and emitted `dist/onboarding.html` is
  unverified by me.

## Explicitly not checked (said plainly, not guessed)

- Real macOS runtime: TCC microphone prompt appearance/threading, the
  Accessibility consent dialog, the two System Settings deep links, window
  centering/size/appearance on a Retina display, and the poll reacting to a
  switch flipped in System Settings. No GUI was launched; there is no headless
  substitute for these.
- `objc2-av-foundation` feature-set minimality beyond reading `Cargo.toml`
  (the `std, AVCaptureDevice, AVMediaFormat, block2` set is plausible and
  `Cargo.lock` is updated, but I did not audit the dependency tree).
- The parallel worker's React UI — out of scope for this diff.
