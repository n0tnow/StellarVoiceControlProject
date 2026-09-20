//! First-run onboarding — the native half.
//!
//! Polaris needs two macOS permissions to do its job (microphone for the
//! push-to-talk capture, Accessibility for the global modifier monitor), and a
//! first-run flow has to guide the user through both. Unlike the notch overlay
//! (`notch.rs`), which is click-through and can never take focus, onboarding is
//! an ordinary, centered, focusable window created on demand and hidden (not
//! destroyed) on close — the same lifecycle the panels use (`panels.rs`), with
//! the same "hide the last interactive window and resign active" close rule
//! (`lib.rs`).
//!
//! This module owns four things:
//! 1. the `onboarding` window (creation, centering, show/focus, hide),
//! 2. the permission commands (`onboarding_permissions`,
//!    `onboarding_request_microphone`, `onboarding_request_accessibility`),
//! 3. the System Settings deep links (`onboarding_open_settings`),
//! 4. the first-run marker file (`onboarding_state`, `onboarding_complete`,
//!    `onboarding_reset`).
//!
//! While the window is visible a 1-second thread polls the two permissions and
//! emits [`ONBOARDING_PERMISSIONS_EVENT_NAME`] whenever a status changes, so the
//! React flow reflects the user flipping a switch in System Settings without a
//! manual re-check. The thread stops when the window hides; there is no
//! permanently running timer.
//!
//! The command names, argument names and payload shapes are a contract with the
//! onboarding React entry (`app/src/onboarding/`). Do not rename them without
//! updating that side.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// The onboarding window label. The capability file
/// (`capabilities/onboarding.json`) matches exactly this string.
pub const WINDOW_LABEL: &str = "onboarding";

/// Window title, also exposed to assistive tech.
const WINDOW_TITLE: &str = "Polaris Onboarding";

/// The Vite entry the window loads; mirrored by `app/onboarding.html`.
const WINDOW_URL: &str = "onboarding.html";

/// App-wide event name carrying a [`Permissions`] payload. Kept next to
/// [`ONBOARDING_VERSION`] rather than in `events.rs` because it is an
/// onboarding-only, low-frequency channel — the same naming style as
/// `events::NOTCH_HOVER_EVENT_NAME`.
pub const ONBOARDING_PERMISSIONS_EVENT_NAME: &str = "onboarding_permissions";

/// Bump this whenever onboarding is redesigned enough that a user who already
/// finished the old flow should see the new one.
///
/// [`OnboardingState::completed`] is true only when the stored marker's
/// `version` is **greater than or equal to** this constant, so raising it
/// re-runs onboarding for everyone who stopped at an older version. It is never
/// lowered in practice; the `>=` comparison (rather than `==`) also means a
/// marker written by a newer build is not treated as stale by an older one.
pub const ONBOARDING_VERSION: u32 = 1;

/// Marker file name inside the Tauri app config dir.
const MARKER_FILE: &str = "onboarding.json";

/// Poll cadence while the onboarding window is visible.
const POLL_INTERVAL: Duration = Duration::from_secs(1);

/// How long the microphone command waits for the user to answer the TCC prompt
/// before giving up. The authoritative status is re-read afterwards, so even a
/// timeout returns the truth; this only bounds how long a blocking-pool thread
/// can be held.
#[cfg(target_os = "macos")]
const PROMPT_TIMEOUT: Duration = Duration::from_secs(120);

/// Monotonic generation for the permission poll. A poll thread exits as soon as
/// the generation is no longer the one it was started with, which both "stop"
/// and "a newer open supersedes me" reduce to; see [`start_permission_poll`].
static POLL_GENERATION: AtomicU64 = AtomicU64::new(0);

/// Whether a macOS privacy permission has been granted, denied or never asked.
///
/// Serialized lowercase: `"granted" | "denied" | "undetermined"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionStatus {
    Granted,
    Denied,
    Undetermined,
}

/// The System Settings pane `onboarding_open_settings` opens.
///
/// Deserialized from the wire names `"microphone" | "accessibility"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingsPane {
    Microphone,
    Accessibility,
}

/// Snapshot of both permissions the onboarding flow cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Permissions {
    pub microphone: PermissionStatus,
    pub accessibility: PermissionStatus,
}

/// The first-run state the UI reads on mount.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingState {
    /// Whether the stored marker is at (or above) [`ONBOARDING_VERSION`].
    pub completed: bool,
    /// The version the running app expects. The UI can show it and report it
    /// back if it ever needs to; `completed` already reflects the comparison.
    pub version: u32,
}

/// The persisted first-run marker. Tiny on purpose: one version number, written
/// as `{"version":1}`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    version: u32,
}

/// True when a stored marker means onboarding is done for this build.
///
/// Missing/corrupt marker (read as `None`) means "not completed"; a marker from
/// an older onboarding version is not completed either.
fn is_completed(marker: Option<Marker>) -> bool {
    marker.is_some_and(|marker| marker.version >= ONBOARDING_VERSION)
}

/// The marker's path in the app config dir, or `None` when the OS path is
/// unavailable. Never panics and never reports a filesystem error as a panic.
fn marker_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join(MARKER_FILE))
}

/// Reads the marker. Any error — missing file, unreadable, malformed JSON —
/// reads as `None`, i.e. "not completed": the safe default is to show
/// onboarding again, never to skip it on a read failure.
fn read_marker(app: &AppHandle) -> Option<Marker> {
    let path = marker_path(app)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

/// Writes the marker at `version`, creating the config dir if needed.
///
/// Errors are returned as strings (logged by the caller); nothing here panics.
fn write_marker(app: &AppHandle, version: u32) -> Result<(), String> {
    let path = marker_path(app).ok_or_else(|| "the app config directory is unavailable".to_string())?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("could not create {}: {error}", parent.display()))?;
    }
    let text = serde_json::to_string(&Marker { version })
        .map_err(|error| format!("could not serialize the onboarding marker: {error}"))?;
    std::fs::write(&path, text)
        .map_err(|error| format!("could not write {}: {error}", path.display()))
}

/// Removes the marker. A missing file is success (already reset).
fn clear_marker(app: &AppHandle) -> Result<(), String> {
    let Some(path) = marker_path(app) else {
        return Ok(());
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove {}: {error}", path.display())),
    }
}

/// Opens a URL with the macOS `open` command.
fn open_url(url: &str) -> Result<(), String> {
    std::process::Command::new("open")
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open {url}: {error}"))
}

/// The System Settings deep link for a pane. Stable Apple URL schemes; kept as
/// a pure function so the mapping is unit-tested.
fn settings_url(pane: SettingsPane) -> &'static str {
    match pane {
        SettingsPane::Microphone => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        }
        SettingsPane::Accessibility => {
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        }
    }
}

/// Maps an `AVAuthorizationStatus` raw value to the contract.
///
/// `0 = NotDetermined`, `1 = Restricted`, `2 = Denied`, `3 = Authorized`.
/// Unknown values fail closed to `Denied`; this is the pure seam the unit tests
/// exercise instead of the framework.
fn permission_from_raw_av_status(raw: isize) -> PermissionStatus {
    match raw {
        0 => PermissionStatus::Undetermined,
        1 | 2 => PermissionStatus::Denied,
        3 => PermissionStatus::Granted,
        _ => PermissionStatus::Denied,
    }
}

/// Current microphone permission, from AVFoundation.
#[cfg(target_os = "macos")]
fn microphone_status() -> PermissionStatus {
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    // SAFETY: `AVMediaTypeAudio` is a framework constant that is present once
    // AVFoundation is linked; the class method takes only that constant and has
    // no other preconditions.
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionStatus::Undetermined;
    };
    let status = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
    permission_from_raw_av_status(status.0)
}

/// Non-macOS: there is no TCC database, so nothing is ever decided.
#[cfg(not(target_os = "macos"))]
fn microphone_status() -> PermissionStatus {
    PermissionStatus::Undetermined
}

/// Shows the microphone TCC prompt (only when the status is `notDetermined`)
/// and blocks until it is answered or [`PROMPT_TIMEOUT`] elapses. The status is
/// re-read afterwards, so the return value is always the system's truth.
///
/// Runs on a blocking-pool thread; never the main thread.
#[cfg(target_os = "macos")]
fn request_microphone_blocking() -> PermissionStatus {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVCaptureDevice, AVMediaTypeAudio};

    // SAFETY: see `microphone_status`.
    let Some(media) = (unsafe { AVMediaTypeAudio }) else {
        return PermissionStatus::Undetermined;
    };
    let initial = unsafe { AVCaptureDevice::authorizationStatusForMediaType(media) };
    // Only an undetermined status shows a prompt; every decided status is
    // returned as-is so asking again cannot mis-report it.
    if permission_from_raw_av_status(initial.0) != PermissionStatus::Undetermined {
        return permission_from_raw_av_status(initial.0);
    }

    let (tx, rx) = mpsc::channel();
    let handler = RcBlock::new(move |granted: Bool| {
        // The completion runs on an arbitrary dispatch queue; forwarding the
        // boolean (which we do not even need — the status is re-read) is enough
        // to release the waiting caller.
        let _ = tx.send(granted.as_bool());
    });
    // SAFETY: `media` is the live media-type constant and `handler` is copied
    // by the framework; the completion block stays valid for the call.
    unsafe {
        AVCaptureDevice::requestAccessForMediaType_completionHandler(media, &handler);
    }
    // A user who ignores the dialog must not pin this thread forever. On
    // timeout the status is still re-read below, so we never invent an answer.
    let _ = rx.recv_timeout(PROMPT_TIMEOUT);
    microphone_status()
}

/// Non-macOS: no prompt exists.
#[cfg(not(target_os = "macos"))]
fn request_microphone_blocking() -> PermissionStatus {
    PermissionStatus::Undetermined
}

/// Accessibility trust.
///
/// Accessibility is binary in the OS: `AXIsProcessTrusted` either reports
/// trusted or not, and there is no "not determined" state, so this never
/// returns [`PermissionStatus::Undetermined`].
fn accessibility_status() -> PermissionStatus {
    if crate::hotkey_flags::is_trusted() {
        PermissionStatus::Granted
    } else {
        PermissionStatus::Denied
    }
}

/// Snapshot of both permissions, as the poll and the command both read it.
fn probe_permissions() -> Permissions {
    Permissions {
        microphone: microphone_status(),
        accessibility: accessibility_status(),
    }
}

/// Emits one [`Permissions`] snapshot on the app-wide onboarding channel.
/// A lost event is logged, never fatal (same policy as `events::emit`).
fn emit_permissions(app: &AppHandle, permissions: Permissions) {
    if let Err(error) = app.emit(ONBOARDING_PERMISSIONS_EVENT_NAME, permissions) {
        eprintln!("polaris: failed to emit {ONBOARDING_PERMISSIONS_EVENT_NAME}: {error}");
    }
}

/// Starts (or supersedes) the permission poll.
///
/// A monotonic generation guards the thread: the newest `open` bumps it, and a
/// thread exits as soon as the generation it captured is no longer current.
/// `stop_permission_poll` bumps it too, so one mechanism stops the timer and
/// prevents a stale thread from outliving its window. The window is also
/// re-checked every tick as a backstop, so a hide that does not go through this
/// module still ends the thread.
fn start_permission_poll(app: &AppHandle) {
    let generation = POLL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        let mut last: Option<Permissions> = None;
        loop {
            if POLL_GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            let visible = app
                .get_webview_window(WINDOW_LABEL)
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if !visible {
                return;
            }
            let permissions = probe_permissions();
            if last != Some(permissions) {
                last = Some(permissions);
                emit_permissions(&app, permissions);
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    });
}

/// Stops the poll, if one is running. Idempotent.
fn stop_permission_poll() {
    POLL_GENERATION.fetch_add(1, Ordering::SeqCst);
}

/// True when the onboarding window is currently visible.
pub fn is_visible(app: &AppHandle) -> bool {
    app.get_webview_window(WINDOW_LABEL)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// True while the onboarding window is on screen — the app is in **rehearsal**.
///
/// During the first run the user physically performs the push-to-talk hold and
/// the double-Control tap so the lesson can teach the gestures, and the product
/// decision is that this run must have **no real side effects**. The hotkey
/// pipeline is driven by process-wide monitors that fire regardless of which
/// window is focused, so a rehearsal keystroke would otherwise start a real
/// capture (a WAV written to disk, a timing trace, the downstream
/// STT/agent/TTS chain) and a rehearsal tap would open the real notch prompt
/// behind this window. The consumers therefore go inert while this predicate
/// is true — see `hotkey::apply` and `notch::tap` — because suppressing the
/// Rust consequences is the only way to guarantee no side effect. Making the
/// monitors merely "quiet" would still leave the pipeline able to fire.
///
/// ## Why total silence is correct, not partial
///
/// The onboarding UI does **not** depend on the native events for its lessons.
/// `app/src/onboarding/useShortcutProbe.ts` subscribes to both the Tauri events
/// and plain DOM `keydown`/`keyup` on the focused onboarding window as
/// redundant sources; the DOM path alone gates both lessons, and the onboarding
/// window is the key window while it is up. Suppressing the Rust side therefore
/// costs the lesson nothing. If that UI is ever "simplified" onto the native
/// events alone, this gate must be revisited — it is a non-obvious coupling.
///
/// Cheap and non-panicking because it runs on every hotkey edge: it answers
/// from the window's real visibility, and a failed visibility query reads as
/// `false` ("not rehearsing") so a window-server hiccup fails toward normal
/// behaviour and never toward a dead hotkey.
pub fn is_rehearsing(app: &AppHandle) -> bool {
    is_visible(app)
}

/// True for the onboarding window label. `lib.rs` uses it to decide which
/// window events need the hide/resign treatment.
pub fn is_onboarding_label(label: &str) -> bool {
    label == WINDOW_LABEL
}

/// Creates the window if needed, centers, shows and focuses it, and starts the
/// permission poll.
fn open(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_none() {
        match WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App(WINDOW_URL.into()))
            .title(WINDOW_TITLE)
            .inner_size(900.0, 640.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .always_on_top(true)
            // Onboarding is the one window that must take input: it is centered
            // and interactive, unlike the click-through notch overlay.
            .focusable(true)
            .center()
            // Build hidden, then show: a window that appears mid-layout flashes
            // at the wrong size before its webview has painted (see panels.rs).
            .visible(false)
            .build()
        {
            Ok(_) => {}
            // Lost a create race (two opens at once, e.g. startup racing a
            // manual open): the winner built exactly this window, so fall
            // through and focus it instead of reporting a failure. Mirrors
            // `panels::open_spec`.
            Err(error) if is_label_collision(&error) => {}
            Err(error) => {
                return Err(format!("could not create the onboarding window: {error}"))
            }
        }
    }
    show_and_focus(app)?;
    start_permission_poll(app);
    Ok(())
}

/// Centers, shows and focuses the already-built onboarding window.
fn show_and_focus(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(WINDOW_LABEL)
        .ok_or_else(|| "the onboarding window is missing".to_string())?;
    window
        .center()
        .map_err(|error| format!("could not center the onboarding window: {error}"))?;
    window
        .show()
        .map_err(|error| format!("could not show the onboarding window: {error}"))?;
    window
        .set_focus()
        .map_err(|error| format!("could not focus the onboarding window: {error}"))?;
    Ok(())
}

/// True when a build failed only because another caller created that label
/// first. Window and webview labels are unique independently, so either kind
/// means a race, not a real failure (same contract as
/// `panels::is_label_collision`).
fn is_label_collision(error: &tauri::Error) -> bool {
    matches!(
        error,
        tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_)
    )
}

/// Hides the window without destroying it and stops the poll.
fn hide_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(WINDOW_LABEL) else {
        // No window is nothing visible; stopping the poll keeps the command
        // idempotent after a close that already tore it down.
        stop_permission_poll();
        return Ok(());
    };
    // Hide first, stop the poll only after a successful hide: a failed hide
    // would otherwise strand a visible window whose permission poll is dead,
    // so the React flow would silently stop updating until the next open.
    window
        .hide()
        .map_err(|error| format!("could not hide the onboarding window: {error}"))?;
    stop_permission_poll();
    Ok(())
}

/// Opens onboarding now, regardless of the marker. Used by the command and by
/// startup when the marker says it is due.
pub fn open_if_needed(app: &AppHandle) -> Result<(), String> {
    if is_completed(read_marker(app)) {
        return Ok(());
    }
    open(app)
}

/// Hides the window instead of destroying it when its close button is pressed.
///
/// The poll is stopped here too; `lib.rs` then resigns active if this was the
/// last interactive window (the callback never runs the command path, so the
/// resign is done by the caller, exactly as for panels).
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        if is_onboarding_label(window.label()) && window.hide().is_ok() {
            stop_permission_poll();
            api.prevent_close();
        }
    }
}

/// The first-run state: whether the marker is current, and the version the app
/// expects.
#[tauri::command]
pub fn onboarding_state(app: AppHandle) -> OnboardingState {
    OnboardingState {
        completed: is_completed(read_marker(&app)),
        version: ONBOARDING_VERSION,
    }
}

/// Creates if needed, centers, shows and focuses the onboarding window.
#[tauri::command]
pub fn onboarding_open(app: AppHandle) -> Result<(), String> {
    open(&app)
}

/// Hides the onboarding window without destroying it.
#[tauri::command]
pub fn onboarding_close(app: AppHandle) -> Result<(), String> {
    hide_window(&app)?;
    crate::resign_after_interactive_close(&app, WINDOW_LABEL);
    Ok(())
}

/// Persists `completed = true` at [`ONBOARDING_VERSION`], then hides the window.
#[tauri::command]
pub fn onboarding_complete(app: AppHandle) -> Result<(), String> {
    write_marker(&app, ONBOARDING_VERSION)?;
    hide_window(&app)?;
    crate::resign_after_interactive_close(&app, WINDOW_LABEL);
    Ok(())
}

/// Clears the marker so onboarding runs again (menu action, or a test).
#[tauri::command]
pub fn onboarding_reset(app: AppHandle) -> Result<(), String> {
    clear_marker(&app)
}

/// Current permission snapshot.
#[tauri::command]
pub fn onboarding_permissions() -> Permissions {
    probe_permissions()
}

/// Requests microphone access, showing the TCC prompt when it is still
/// undecided, and resolves to the status after the user answers.
///
/// Async so the blocking wait happens on the blocking pool, never the Tauri
/// main thread (the same shape as `approval::approval_authorize`).
#[tauri::command]
pub async fn onboarding_request_microphone() -> PermissionStatus {
    tauri::async_runtime::spawn_blocking(request_microphone_blocking)
        .await
        .unwrap_or_else(|error| {
            eprintln!("polaris: the microphone permission task did not finish: {error}");
            // Never invent a result: report what the system says right now.
            microphone_status()
        })
}

/// Requests Accessibility access. Shows the standard, non-modal consent dialog
/// and returns the trust state as it is immediately after.
///
/// Apple documents the prompt's return value as **not** reflecting the user's
/// answer, so the authoritative status is `AXIsProcessTrusted`, which the poll
/// keeps refreshing while this window is visible.
#[tauri::command]
pub fn onboarding_request_accessibility() -> PermissionStatus {
    let _ = crate::hotkey_flags::prompt_for_trust();
    accessibility_status()
}

/// Opens the matching System Settings privacy pane.
#[tauri::command]
pub fn onboarding_open_settings(pane: SettingsPane) -> Result<(), String> {
    open_url(settings_url(pane))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_round_trips() {
        let marker = Marker {
            version: ONBOARDING_VERSION,
        };
        let json = serde_json::to_string(&marker).unwrap();
        assert_eq!(json, r#"{"version":1}"#);
        assert_eq!(serde_json::from_str::<Marker>(&json).unwrap(), marker);
    }

    #[test]
    fn completed_requires_a_current_or_newer_marker() {
        // No marker (or an unreadable one) means onboarding is due.
        assert!(!is_completed(None));
        // A marker from a previous design is due again — this is what makes
        // bumping `ONBOARDING_VERSION` re-run onboarding.
        assert!(!is_completed(Some(Marker { version: 0 })));
        assert!(is_completed(Some(Marker {
            version: ONBOARDING_VERSION
        })));
        // A marker written by a newer build is still considered complete.
        assert!(is_completed(Some(Marker {
            version: ONBOARDING_VERSION + 1
        })));
    }

    #[test]
    fn permission_status_serializes_lowercase_and_round_trips() {
        let cases = [
            (PermissionStatus::Granted, "\"granted\""),
            (PermissionStatus::Denied, "\"denied\""),
            (PermissionStatus::Undetermined, "\"undetermined\""),
        ];
        for (status, wire) in cases {
            assert_eq!(serde_json::to_string(&status).unwrap(), wire);
            assert_eq!(
                serde_json::from_str::<PermissionStatus>(wire).unwrap(),
                status
            );
        }
    }

    #[test]
    fn raw_av_status_maps_to_the_contract() {
        assert_eq!(
            permission_from_raw_av_status(0),
            PermissionStatus::Undetermined
        );
        assert_eq!(permission_from_raw_av_status(1), PermissionStatus::Denied);
        assert_eq!(permission_from_raw_av_status(2), PermissionStatus::Denied);
        assert_eq!(permission_from_raw_av_status(3), PermissionStatus::Granted);
        // Unknown values fail closed.
        assert_eq!(permission_from_raw_av_status(99), PermissionStatus::Denied);
    }

    #[test]
    fn settings_panes_map_to_the_expected_deep_links() {
        assert_eq!(
            settings_url(SettingsPane::Microphone),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
        );
        assert_eq!(
            settings_url(SettingsPane::Accessibility),
            "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        );
    }

    #[test]
    fn settings_pane_deserializes_from_the_wire_names() {
        assert_eq!(
            serde_json::from_str::<SettingsPane>("\"microphone\"").unwrap(),
            SettingsPane::Microphone
        );
        assert_eq!(
            serde_json::from_str::<SettingsPane>("\"accessibility\"").unwrap(),
            SettingsPane::Accessibility
        );
        assert!(serde_json::from_str::<SettingsPane>("\"camera\"").is_err());
    }

    #[test]
    fn permissions_serialize_with_the_contract_field_names() {
        let permissions = Permissions {
            microphone: PermissionStatus::Granted,
            accessibility: PermissionStatus::Denied,
        };
        assert_eq!(
            serde_json::to_string(&permissions).unwrap(),
            r#"{"microphone":"granted","accessibility":"denied"}"#
        );
    }

    #[test]
    fn onboarding_state_serializes_camel_case_fields() {
        let state = OnboardingState {
            completed: true,
            version: ONBOARDING_VERSION,
        };
        assert_eq!(
            serde_json::to_string(&state).unwrap(),
            r#"{"completed":true,"version":1}"#
        );
    }

    #[test]
    fn concurrent_create_label_collisions_are_recognized() {
        // Window and webview labels are unique independently, so either kind
        // means another caller won the create race and we should focus, not
        // fail (mirrors `panels::is_label_collision`).
        assert!(is_label_collision(
            &tauri::Error::WindowLabelAlreadyExists(WINDOW_LABEL.into())
        ));
        assert!(is_label_collision(
            &tauri::Error::WebviewLabelAlreadyExists(WINDOW_LABEL.into())
        ));
        // A genuine build failure is not mistaken for a race.
        assert!(!is_label_collision(&tauri::Error::AssetNotFound(
            WINDOW_URL.into()
        )));
        assert!(!is_label_collision(
            &tauri::Error::CannotReparentWebviewWindow
        ));
    }
}
