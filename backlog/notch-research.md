# Report: notch-research

- **Date:** 2026-09-19
- **Worker/Agent:** notch-research
- **Branch/Worktree:** `codex/notch-research` / `.worktrees/notch-research`
- **PR:** https://github.com/n0tnow/StellarVoiceControlProject/pull/7 (`codex/notch-research` → `main`)

## Completed

- Researched Apple AppKit display safe areas, auxiliary notch rectangles, status-bar window level, non-activating panels, global `NSFlagsChanged` monitoring, and SwiftUI custom-shape animation.
- Researched current Tauri v2 transparent-window configuration and permissions.
- Reviewed primary open-source notch implementations: DynamicNotchKit, MacCam-NotchIsland, NotchApp, and Dynamac-Island.
- Wrote implementation-ready geometry, state, timing, fallback, permission, and verification guidance in [`docs/reports/2026-09-19-notch-overlay-research.md`](../docs/reports/2026-09-19-notch-overlay-research.md).
- Corrected the geometry section to use a valid monotonic SVG path and clarified that modifier-only Control+Option requires native local/global `flagsChanged` monitoring in the current A0 implementation.

## Recommendation

Keep the current Tauri + React + Rust architecture. Implement the notch as a dedicated transparent Tauri overlay with CSS/SVG shape animation and consume the existing Rust hotkey/audio event stream. The first interaction slice is `idle → recording while Control+Option are both held → ready on release`, with no automatic send.

## Remaining Work

- Coordinator should commit the report and index entry on the active implementation branch/worktree.
- Implement the dedicated notch window and React state/shape in a separate code task.
- Validate physical alignment on the built-in Mac display; screenshots alone cannot prove camera-housing alignment.

## Sources

See the report’s source list; all cited references are Apple/Tauri documentation or primary open-source repositories.
