# Report: 2026-09-19-modifier-only-hotkey-research
- **Date:** 2026-09-19
- **Worker:** research worker (modifier-research)
- **Worktree:** `.worktrees/modifier-research` — branch `research/modifier-only-hotkey`
- **Scope:** research only. `app/` untouched. No feature code written.

## Objective
Answer, with verified symbols and primary-source citations, how to implement the modifier-only
default gesture (hold Control+Option = record, release either = stop) via native macOS
`flagsChanged` monitoring bridged into the Tauri v2 Rust core.

## What was done
- Verified the exact dependency generation Tauri 2.11.5 links: `objc2` 0.6.4,
  `objc2-app-kit` 0.3.2, `objc2-foundation` 0.3.2, `block2` 0.6.2 (from
  `app/src-tauri/Cargo.lock`).
- Verified every Rust symbol in a throwaway probe crate (`/tmp/objc2probe`, not committed)
  that runs `cargo check` clean against those exact versions: both monitor registration fns
  (global = safe, local = `unsafe`), `NSEventMask::FlagsChanged`, `NSEventModifierFlags::{Control,
  Option, DeviceIndependentFlagsMask}`, `modifierFlags()`, `modifierFlags_class()`,
  `removeMonitor`, and the `RcBlock`/`DynBlock` block types.
- Confirmed `objc2-app-kit` default features already include `NSEvent` + `block2`
  (vendored crate `Cargo.toml`) — no feature wiring needed.
- Confirmed from Apple docs that a `flagsChanged` global monitor requires Accessibility trust,
  with the verbatim quote in the report.
- Confirmed the VoiceOver collision (default VO modifier = Control+Option) from Apple Support
  and recommended: 300 ms arm delay + Command/Shift exclusion + cancel-on-activity.
- Found real open-source Rust precedent (`fluor` crate global-monitor pattern; a global-hotkey
  gist; an objc2 migration rename table confirming `NSAlternateKeyMask → ::Option`).

## Deliverable
- `docs/reports/2026-09-19-modifier-only-hotkey.md` (registered in `docs/reports/INDEX.md`).

## Key recommendations for the implementing worker
1. Subscribe to `NSEventMask::FlagsChanged` only (global + local monitors); state-based
   two-bit latch, never event counting.
2. Register on the main thread via `AppHandle::run_on_main_thread`; retain both
   `Retained<AnyObject>` tokens for app lifetime; `removeMonitor` on teardown.
3. Gate on `AXIsProcessTrusted()`; prompt with `kAXTrustedCheckOptionPrompt`; degrade to the
   fallback shortcut, never block or crash. No Info.plist key needed.
4. 300 ms hold gate (`ARM_DELAY_MS`), ignore when Command/Shift held, cancel on other activity.
5. 1 s watchdog polling `NSEvent::modifierFlags_class()` + force-stop on sleep/screen-lock.
6. **Keep Control+Option+Space permanently** as the secondary trigger.
7. Four flagged uncertainties the implementer must close: callback thread assertion,
   token-vs-trust gating, Secure Input behavior, compile-check of the AX extern block.

## Remaining work (not mine — for implementer/reviewer)
- Implement per `docs/reports/2026-09-19-modifier-only-hotkey.md` §8 ordering.
- Manual test matrix: VoiceOver on/off, password dialog, sleep, Space switch, revoked permission.
- No PR opened (per task instructions); branch pushed for coordinator review.
