# macOS Notch Overlay Research for Polaris
- **Date:** 2026-09-19
- **Author/Agent:** research worker (notch-research)
- **Keywords:** macos, notch, tauri, react, transparent-window, nscreen, nswindow, hotkey, animation, accessibility

## Summary

The current project is a Tauri v2 desktop shell with a Rust core and React/Vite webview. The notch MVP should stay on that stack. Create a small, dedicated Tauri overlay window whose background is transparent, decorations are disabled, and z-order is always-on-top. Render the black shell and its shoulder curves in CSS/SVG (or a CSS `clip-path` path) and animate a single state model. This avoids a SwiftUI/AppKit rewrite while matching the supplied references.

The confirmed interaction is push-to-talk: holding Control+Option records; releasing either modifier stops capture and leaves the result in a `ready` state for a later send action. Release must not auto-send.

## Current Project Context

`README.md`, `docs/architecture.md`, and `notes.md` describe Tauri v2 + React/Vite with Rust owning global hotkey and microphone capture. The event contract already has `hotkey` `down`/`up` states. The existing A0 worktree contains the global-hotkey/mic capture implementation, so the notch UI should consume those events rather than introduce another native recording path.

## Findings

### Window and display geometry

Apple exposes `NSScreen.safeAreaInsets` for the region obscured by the menu bar, Dock, and camera housing. On notched Macs, `auxiliaryTopLeftArea` and `auxiliaryTopRightArea` expose the unobscured regions beside the camera housing in global screen coordinates. They can be used by a small macOS native geometry helper if fixed webview coordinates prove unreliable. On a display without a notch those auxiliary rectangles are `nil`; the fallback should be a centered pill with no artificial center cutout.

Apple documents `NSWindow.Level.statusBar` for status-window overlays and `NSWindowStyleMask.nonactivatingPanel` for a panel that does not activate the owning app. A native `NSPanel` host is therefore the escape hatch for pixel-accurate placement, but it is not required for the first Tauri implementation.

The Tauri v2 window configuration has the required overlay primitives: `transparent`, `decorations: false`, `alwaysOnTop`, `visibleOnAllWorkspaces`, and a controlled initial `visible` state. Tauri documents that macOS transparency requires its `macos-private-api` feature and can affect App Store eligibility; this is a distribution constraint to record before shipping. A transparent webview must also set its page background to transparent and avoid default body margins.

### Shape construction

Use a fixed top-centered shell whose top edge is flush with the screen edge. The collapsed state is a black rectangle/pill around the physical notch. The expanded state grows horizontally while retaining a black top band, two concave shoulder transitions, and rounded lower corners like the supplied second image.

Use one monotonic SVG path for the shell (coordinates in the view box, `w` × `h`) so the shoulder curves cannot self-cross. Let `r` be the lower corner radius, `xL`/`xR` the left/right inner shoulder x positions (`0 < xL < xR < w`), `yO` the outer shoulder y, and `yI` the inner shoulder y (`0 < yO < yI < h`). Construct this path:

```text
M 0 0 H w V (h-r)
Q w h (w-r) h H r Q 0 h 0 (h-r) V yO
C 0 (yO+c) (xL-c) (yI-c) xL yI
H xR
C (xR+c) (yI-c) w (yO+c) w yO
V 0 Z
```

The two cubic segments are traversed in opposite directions around the bottom boundary and remain within the shell bounds; `c` is clamped so control points stay between their adjacent endpoints. For the collapsed state, set `xL` and `xR` to the measured notch shoulders and reduce `yI-yO` toward zero. Keep these scalar parameters as the animatable data rather than swapping between unrelated paths. The exact points are a starting geometry recommendation; physical display measurements win.

### Animation

Apple’s SwiftUI `Animatable` contract confirms that a shape can expose `animatableData` and receive interpolated values on every frame. The same principle maps directly to a React/CSS implementation: animate width, height, border radius, shoulder depth, and opacity from one state transition, using a spring-like cubic-bezier or Web Animations spring polyfill.

Suggested initial timings (implementation recommendation, not an Apple specification):

- idle → recording: 180–240 ms, ease-out; expand immediately when the hotkey-down event arrives;
- recording waveform: 60 Hz visual updates driven by smoothed RMS, with a 100–150 ms attack and 250–400 ms release to avoid jitter;
- recording → ready: 220–300 ms, ease-out; keep the expanded width so the user can see that audio is ready;
- ready → idle: 180–240 ms after explicit dismissal/send completion;
- status label crossfade: 100–140 ms, with the label width included in the shell’s measured layout.

Respect `prefers-reduced-motion`: replace spring expansion with a short opacity/size transition and disable pulsing dots/waveform movement while preserving status changes.

### State mapping

```text
idle       : collapsed black notch shell, no label
recording  : expanded shell, “Listening” label, RMS waveform/dots
ready      : expanded shell, “Ready” label, stable indicator; awaiting explicit send
thinking   : expanded shell, “Thinking” label, three magenta pulsing dots
error      : expanded shell, brief error label; explicit dismissal returns to idle
```

The initial requested slice only needs `idle`, `recording`, and `ready`; `thinking` is included so the shell does not need a later visual redesign when the agent loop is wired.

### Hotkey and permissions

Apple’s `NSEvent.addGlobalMonitorForEvents(matching:)` supports `NSFlagsChanged`, but key-related global monitoring requires Accessibility trust and is observation-only. The current A0 shortcut registration is a Control+Option+Space key-code shortcut; it cannot represent the requested modifier-only gesture by itself. The notch slice therefore needs a native macOS `flagsChanged` observer (with a local monitor for events delivered to the app itself, plus the global monitor for other apps) bridged into Rust/Tauri. The handler should maintain a two-bit latch (`controlDown`, `optionDown`), start recording on the first event where both are true, and stop on the first release where either becomes false. Debounce repeated `flagsChanged` events by checking the effective pair state rather than event count.

If a future native monitor is needed, use `flagsChanged` only to observe modifier transitions and clearly surface the Accessibility permission requirement. Do not use a CGEvent tap for this MVP: it adds a separate permission and lifecycle path without improving the requested hold/release behavior.

### Spaces, fullscreen, and display changes

The overlay must be repositioned when the display topology changes and when the primary display changes. Tauri should expose a small Rust command/event for current display bounds; the webview recalculates its centered `x` and top `y` on resize/display events. Configure the overlay to remain visible on all workspaces only if the product wants it over fullscreen apps; otherwise make that a preference because a global always-on-top window can conflict with fullscreen and Stage Manager expectations.

On a multi-monitor setup, anchor to the built-in/notched display when one is available; otherwise use the active/primary display. If the display has no notch, render one centered pill and keep the same state machine. Do not infer notch geometry from a screenshot: physical camera housings are not captured in ordinary macOS screenshots.

## Recommended Implementation

1. Add a dedicated Tauri `notch` window in `app/src-tauri/tauri.conf.json` with transparent background, no decorations, always-on-top, and initial hidden visibility; grant only the window/event permissions required by the capability file.
2. Add a React `NotchOverlay` route/component with `pointer-events: none` on the shell and `pointer-events: auto` only for future explicit controls. Use an SVG path or CSS mask for the shape; keep content in a separate layer so text and indicators are not clipped by the mask.
3. Consume the existing `PolarisEvent` hotkey/audio events. Implement the `idle → recording → ready` state machine and make release stop capture without dispatching a send command.
4. Add a display-geometry command/event only if the Tauri webview cannot reliably determine the screen bounds. For notched Macs, the native helper can read `safeAreaInsets` and auxiliary areas; for non-notch displays, return the centered-pill fallback.
5. Add visual tests at fixed viewport sizes for collapsed, recording, ready, and no-notch fallback; add a state-machine test proving that any Control/Option release stops recording and never auto-sends.

## Risks and Pitfalls

- Tauri transparent windows on macOS may require the private API flag, which has App Store implications.
- A transparent webview can show a white rectangle if the HTML/body background is not explicitly transparent.
- Fixed notch dimensions break on external displays, scaled resolutions, and future Mac models; use safe-area data where available and a measured fallback.
- An always-on-top overlay can cover fullscreen content or steal pointer input. Keep the collapsed shell click-through and only enable interaction for explicit expanded controls.
- Accessibility permission is relevant to a native global `flagsChanged` monitor; the existing Tauri shortcut plugin keeps this path simpler.
- Ordinary screenshots do not prove physical notch alignment. Validate on the actual built-in display and log calculated bounds.

## Sources

- Apple, [`NSScreen.auxiliaryTopLeftArea`](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea-4ow3p) and [`auxiliaryTopRightArea`](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytoprightarea-gr2n): notch-adjacent safe rectangles and `nil` behavior on unobscured displays.
- Apple, [`NSScreen.safeAreaInsets`](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets): display safe-area insets including camera housing.
- Apple, [`NSPrefersDisplaySafeAreaCompatibilityMode`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsprefersdisplaysafeareacompatibilitymode): guidance for camera-housing Macs and auxiliary areas.
- Apple, [`NSWindow.Level.statusBar`](https://developer.apple.com/documentation/appkit/nswindow/level-swift.struct/statusbar) and [`NSWindowStyleMask.nonactivatingPanel`](https://developer.apple.com/documentation/appkit/nswindow/stylemask-swift.struct/nonactivatingpanel): native overlay host options.
- Apple, [`NSEvent.addGlobalMonitorForEvents`](https://developer.apple.com/documentation/appkit/nsevent/addglobalmonitorforevents%28matching%3Ahandler%3A%29): global event observation, `NSFlagsChanged`, and Accessibility requirement.
- Apple, [`SwiftUI Animatable`](https://developer.apple.com/documentation/swiftui/animatable): frame-by-frame interpolation of custom shape data.
- Tauri, [`WindowConfig`](https://v2.tauri.app/reference/config/#windowconfig): transparent, decorations, always-on-top, workspace visibility, and related constraints.
- Tauri, [`Window customization`](https://v2.tauri.app/learn/window-customization/): transparent/decorated window setup and permissions.
- [`MrKai77/DynamicNotchKit`](https://github.com/MrKai77/DynamicNotchKit): primary open-source SwiftUI/AppKit reference for notch-attached content and expansion API.
- [`badursun/MacCam-NotchIsland`](https://github.com/badursun/MacCam-NotchIsland): primary open-source reference describing a borderless `NSPanel`, custom animatable notch shape, and non-notch fallback.
- [`erwinzhang7/NotchApp`](https://github.com/erwinzhang7/NotchApp): primary open-source reference for status-bar-level `NSPanel`, safe-area/auxiliary-area geometry, all-Spaces behavior, and display-change repositioning.
- [`HSUNEH/Dynamac-Island`](https://github.com/HSUNEH/Dynamac-Island): primary open-source reference for native notch/non-notch branching and the warning that physical notches are absent from screenshots.

## Acceptance / Verification Plan

- Verify `idle`, `recording`, and `ready` at 1× and 2× scale factors on the built-in display.
- Verify the no-notch centered-pill fallback on an external/non-notch display or a mocked geometry provider.
- Verify display connect/disconnect and primary-display changes reposition the overlay.
- Verify holding Control+Option starts one recording, releasing either modifier stops it, and no send event is emitted.
- Verify reduced-motion mode suppresses pulsing/waveform animation while preserving state transitions.
- Run the repository’s existing typecheck/build and the Rust event/audio tests after implementation.
