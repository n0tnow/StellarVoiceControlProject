//! Interactive panel windows (step W0).
//!
//! The notch overlay (`notch.rs`) is transparent, click-through and cannot take
//! focus, so it can never host a real interaction. Wallet, approval, settings,
//! debug and the milestone skeleton panels therefore live in ordinary windows,
//! created on demand and reused afterwards.
//!
//! This module is the single source of truth for those windows: a fixed
//! allow-list of [`PanelSpec`]s, one webview per panel label, and the close
//! handling that keeps a panel from taking the whole app down. The frontend
//! teammate adds a panel by adding a registry entry here, a route in
//! `app/src/panels/panelRoutes.ts` and a component under `app/src/panels/` — no
//! other Rust change is needed (`docs/ui-panels.md`).

use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// Stable names accepted by [`open`] and the `open_panel` command. These are the
/// only panels that exist; anything else is rejected.
pub const WALLET: &str = "wallet";
pub const APPROVAL: &str = "approval";
pub const SECURITY: &str = "security";
pub const SCHEDULES: &str = "schedules";
pub const SUGGESTIONS: &str = "suggestions";
pub const ANCHOR: &str = "anchor";
pub const P2P: &str = "p2p";
pub const PRIVACY: &str = "privacy";
pub const SETTINGS: &str = "settings";
pub const DEBUG: &str = "debug";

/// Window labels are namespaced so the capability glob (`panel-*`) and the close
/// handler can both recognise a panel without enumerating labels at every site.
const LABEL_PREFIX: &str = "panel-";

/// Geometry and behaviour of one panel window.
///
/// `route` is the hash the webview opens on, so one `index.html` serves the
/// overlay and every panel; `app/src/main.tsx` picks the component from the
/// hash. Keep `route` in step with `parsePanelRoute` in the frontend.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PanelSpec {
    /// Name callers use (`open_panel` payload).
    pub name: &'static str,
    /// Tauri window label. One window per label, reused across opens.
    pub label: &'static str,
    /// Window title, also exposed to assistive tech.
    pub title: &'static str,
    /// Hash route appended to `index.html` (e.g. `#/wallet`).
    pub route: &'static str,
    pub width: f64,
    pub height: f64,
    /// The approval card sits above other windows; the rest are ordinary.
    pub always_on_top: bool,
    pub resizable: bool,
}

/// The allow-list, in presentation order.
pub const PANELS: &[PanelSpec] = &[
    PanelSpec {
        name: WALLET,
        label: "panel-wallet",
        title: "Polaris Wallet",
        route: "#/wallet",
        width: 420.0,
        height: 600.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: APPROVAL,
        label: "panel-approval",
        title: "Polaris Approval",
        route: "#/approval",
        width: 440.0,
        height: 520.0,
        always_on_top: true,
        resizable: false,
    },
    PanelSpec {
        name: SECURITY,
        label: "panel-security",
        title: "Polaris Security",
        route: "#/security",
        width: 460.0,
        height: 640.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: SCHEDULES,
        label: "panel-schedules",
        title: "Polaris Schedules",
        route: "#/schedules",
        width: 460.0,
        height: 640.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: SUGGESTIONS,
        label: "panel-suggestions",
        title: "Polaris Suggestions",
        route: "#/suggestions",
        width: 460.0,
        height: 640.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: ANCHOR,
        label: "panel-anchor",
        title: "Polaris Anchor",
        route: "#/anchor",
        width: 460.0,
        height: 640.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: P2P,
        label: "panel-p2p",
        title: "Polaris P2P",
        route: "#/p2p",
        width: 460.0,
        height: 640.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: PRIVACY,
        label: "panel-privacy",
        title: "Polaris Privacy",
        route: "#/privacy",
        width: 480.0,
        height: 680.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: SETTINGS,
        label: "panel-settings",
        title: "Polaris Settings",
        route: "#/settings",
        width: 520.0,
        height: 600.0,
        always_on_top: false,
        resizable: true,
    },
    PanelSpec {
        name: DEBUG,
        label: "panel-debug",
        title: "Polaris Debug",
        route: "#/debug",
        width: 480.0,
        height: 680.0,
        always_on_top: false,
        resizable: true,
    },
];

/// Why a panel could not be opened.
///
/// Serialized straight back to the webview, so the variants are part of the
/// UI contract: `unknownPanel` is a caller bug, `window` is the OS refusing the
/// window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PanelError {
    /// The requested name is not on the allow-list.
    UnknownPanel { name: String },
    /// The OS could not create, show or focus the window.
    Window { message: String },
}

impl std::fmt::Display for PanelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownPanel { name } => write!(f, "unknown panel: {name}"),
            Self::Window { message } => write!(f, "panel window error: {message}"),
        }
    }
}

impl std::error::Error for PanelError {}

/// Looks up a panel in the allow-list. This is the whole gate: a name that is
/// not in [`PANELS`] cannot reach the window builder.
pub fn resolve(name: &str) -> Result<&'static PanelSpec, PanelError> {
    PANELS
        .iter()
        .find(|panel| panel.name == name)
        .ok_or_else(|| PanelError::UnknownPanel {
            name: name.to_string(),
        })
}

/// True for any window label this module owns. The close handler uses it so a
/// panel's close button hides the panel instead of quitting the app.
pub fn is_panel_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX) && PANELS.iter().any(|panel| panel.label == label)
}

/// The `index.html` URL for a panel, with the route in the hash so the React
/// router (`app/src/main.tsx`) can choose the component.
fn panel_url(spec: &PanelSpec) -> String {
    format!("index.html{}", spec.route)
}

/// Opens a panel by name, or focuses the one that is already open.
pub fn open(app: &AppHandle, name: &str) -> Result<(), PanelError> {
    open_spec(app, resolve(name)?)
}

/// Opens a spec directly — the shared helper the command and any future Rust
/// caller go through.
///
/// One instance per label: the first call builds the window; later calls only
/// show and focus it, so panel state survives a close. Close does not destroy
/// the window (see [`handle_window_event`]), which is what makes the reuse
/// actually preserve state.
pub fn open_spec(app: &AppHandle, spec: &PanelSpec) -> Result<(), PanelError> {
    if app.get_webview_window(spec.label).is_some() {
        return show_and_focus(app, spec);
    }

    match WebviewWindowBuilder::new(app, spec.label, WebviewUrl::App(panel_url(spec).into()))
        .title(spec.title)
        .inner_size(spec.width, spec.height)
        .resizable(spec.resizable)
        .always_on_top(spec.always_on_top)
        .center()
        // Build hidden, then show: a window that appears mid-layout flashes at
        // the wrong size before its webview has painted.
        .visible(false)
        .build()
    {
        Ok(window) => {
            window.show().map_err(window_error)?;
            window.set_focus().map_err(window_error)?;
            Ok(())
        }
        // Lost a create race (two opens at once, e.g. the notch menu and
        // `open_panel`): the winner built exactly this window, so focus it
        // instead of reporting a failure.
        Err(error) if is_label_collision(&error) => show_and_focus(app, spec),
        Err(error) => Err(window_error(error)),
    }
}

/// Shows and focuses an already-built panel window.
fn show_and_focus(app: &AppHandle, spec: &PanelSpec) -> Result<(), PanelError> {
    let window = app
        .get_webview_window(spec.label)
        .ok_or_else(|| PanelError::Window {
            message: format!("panel window {} is missing", spec.label),
        })?;
    window.show().map_err(window_error)?;
    window.set_focus().map_err(window_error)?;
    Ok(())
}

/// True when a build failed only because another caller created that label
/// first. Window and webview labels are unique independently, so either kind
/// means a race — not a real failure.
fn is_label_collision(error: &tauri::Error) -> bool {
    matches!(
        error,
        tauri::Error::WindowLabelAlreadyExists(_) | tauri::Error::WebviewLabelAlreadyExists(_)
    )
}

/// Hides a panel instead of destroying it when its close button is pressed.
///
/// The overlay's `main` window is never closed, so the app would not exit
/// anyway; hiding keeps the panel's webview (and its state) alive for the next
/// open, and gives the close button the "dismiss" semantics a panel wants.
pub fn handle_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        // Only swallow the close when the hide actually worked, so a window-server
        // failure can never leave a visible panel the user cannot dismiss. If the
        // hide fails the close proceeds and the next open rebuilds the window.
        if is_panel_label(window.label()) && window.hide().is_ok() {
            api.prevent_close();
        }
    }
}

/// Maps a Tauri window error to the serializable [`PanelError`].
fn window_error(error: tauri::Error) -> PanelError {
    PanelError::Window {
        message: error.to_string(),
    }
}

/// Opens a panel by name (any name in [`PANELS`]). The frontend calls this
/// through `app/src/lib/panels.ts`; unknown names come back as
/// [`PanelError::UnknownPanel`].
#[tauri::command]
pub fn open_panel(app: AppHandle, name: String) -> Result<(), PanelError> {
    open(&app, &name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend `parsePanelRoute` and the notch menu both rely on exactly
    /// these names; a rename here is a breaking change to both.
    #[test]
    fn the_allow_list_is_exactly_the_known_panels() {
        let names: Vec<&str> = PANELS.iter().map(|panel| panel.name).collect();
        assert_eq!(
            names,
            vec![
                WALLET,
                APPROVAL,
                SECURITY,
                SCHEDULES,
                SUGGESTIONS,
                ANCHOR,
                P2P,
                PRIVACY,
                SETTINGS,
                DEBUG,
            ]
        );
    }

    #[test]
    fn resolve_finds_known_panels() {
        assert_eq!(resolve(WALLET).unwrap().name, WALLET);
        assert_eq!(resolve(APPROVAL).unwrap().name, APPROVAL);
        assert_eq!(resolve(SECURITY).unwrap().name, SECURITY);
        assert_eq!(resolve(SCHEDULES).unwrap().name, SCHEDULES);
        assert_eq!(resolve(SUGGESTIONS).unwrap().name, SUGGESTIONS);
        assert_eq!(resolve(ANCHOR).unwrap().name, ANCHOR);
        assert_eq!(resolve(P2P).unwrap().name, P2P);
        assert_eq!(resolve(PRIVACY).unwrap().name, PRIVACY);
        assert_eq!(resolve(SETTINGS).unwrap().name, SETTINGS);
        assert_eq!(resolve(DEBUG).unwrap().name, DEBUG);
    }

    #[test]
    fn resolve_rejects_unknown_names_without_touching_a_window() {
        assert_eq!(
            resolve("bogus"),
            Err(PanelError::UnknownPanel {
                name: "bogus".into()
            })
        );
        // Empty and case-sensitive: the allow-list is exact, not fuzzy.
        assert!(resolve("").is_err());
        assert!(resolve("Wallet").is_err());
    }

    /// Specs are sanity-checked here because the window builder can only be
    /// exercised on a real event loop; these invariants are what a bad entry
    /// would otherwise only reveal at runtime.
    #[test]
    fn every_spec_has_sane_geometry_and_a_route() {
        for panel in PANELS {
            assert!(
                (320.0..=1200.0).contains(&panel.width),
                "{} width out of range: {}",
                panel.name,
                panel.width
            );
            assert!(
                (320.0..=1200.0).contains(&panel.height),
                "{} height out of range: {}",
                panel.name,
                panel.height
            );
            assert_eq!(panel.route, format!("#/{}", panel.name));
            assert!(panel.title.contains("Polaris"));
        }
    }

    /// The capability file targets `panel-*`, and [`is_panel_label`] must agree
    /// with it; a label that escaped the prefix would have no IPC permissions.
    #[test]
    fn every_label_is_namespaced_and_recognised() {
        for panel in PANELS {
            assert!(
                panel.label.starts_with(LABEL_PREFIX),
                "{} label is not namespaced: {}",
                panel.name,
                panel.label
            );
            assert!(is_panel_label(panel.label));
        }
        assert!(!is_panel_label("main"));
        assert!(!is_panel_label("panel-unknown"));
    }

    #[test]
    fn panel_url_carries_the_route_in_the_hash() {
        assert_eq!(panel_url(resolve(WALLET).unwrap()), "index.html#/wallet");
        assert_eq!(panel_url(resolve(APPROVAL).unwrap()), "index.html#/approval");
        assert_eq!(panel_url(resolve(SECURITY).unwrap()), "index.html#/security");
        assert_eq!(panel_url(resolve(SCHEDULES).unwrap()), "index.html#/schedules");
        assert_eq!(
            panel_url(resolve(SUGGESTIONS).unwrap()),
            "index.html#/suggestions"
        );
        assert_eq!(panel_url(resolve(ANCHOR).unwrap()), "index.html#/anchor");
        assert_eq!(panel_url(resolve(P2P).unwrap()), "index.html#/p2p");
        assert_eq!(panel_url(resolve(PRIVACY).unwrap()), "index.html#/privacy");
        assert_eq!(panel_url(resolve(SETTINGS).unwrap()), "index.html#/settings");
        assert_eq!(panel_url(resolve(DEBUG).unwrap()), "index.html#/debug");
    }

    /// The approval card must float above other windows; the others must not.
    #[test]
    fn only_the_approval_panel_is_always_on_top() {
        assert!(resolve(APPROVAL).unwrap().always_on_top);
        assert!(!resolve(WALLET).unwrap().always_on_top);
        assert!(!resolve(SECURITY).unwrap().always_on_top);
        assert!(!resolve(SCHEDULES).unwrap().always_on_top);
        assert!(!resolve(SUGGESTIONS).unwrap().always_on_top);
        assert!(!resolve(ANCHOR).unwrap().always_on_top);
        assert!(!resolve(P2P).unwrap().always_on_top);
        assert!(!resolve(PRIVACY).unwrap().always_on_top);
        assert!(!resolve(SETTINGS).unwrap().always_on_top);
        assert!(!resolve(DEBUG).unwrap().always_on_top);
    }

    /// A create race (two opens) must be invisible: the loser focuses the
    /// winner's window instead of surfacing a spurious window error.
    #[test]
    fn a_label_collision_is_recognised_but_other_errors_are_not() {
        assert!(is_label_collision(&tauri::Error::WebviewLabelAlreadyExists(
            "panel-wallet".into()
        )));
        assert!(is_label_collision(&tauri::Error::WindowLabelAlreadyExists(
            "panel-wallet".into()
        )));
        assert!(!is_label_collision(&tauri::Error::InvalidWindowHandle));
    }

    #[test]
    fn panel_error_serializes_with_a_camel_case_kind() {
        let json = serde_json::to_string(&PanelError::UnknownPanel {
            name: "nope".into(),
        })
        .unwrap();
        assert_eq!(json, r#"{"kind":"unknownPanel","name":"nope"}"#);
    }
}
