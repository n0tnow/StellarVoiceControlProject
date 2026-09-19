//! Tauri commands the prompt panel calls back into (step A6).
//!
//! The panel owns the sheet's animation and its measured height; Rust owns the
//! native frame. These two commands are the whole seam between them. The panel
//! never touches the window directly, so the top-flush geometry lives in one
//! place ([`crate::prompt_window`]).

use tauri::AppHandle;

use crate::prompt_window;

/// Reports the panel's measured content height in CSS pixels (which are AppKit
/// points here, so Retina scaling never leaks in) and resizes the window to it.
#[tauri::command]
pub fn prompt_resize(app: AppHandle, height: f64) -> Result<(), String> {
    prompt_window::resize(&app, height)
}

/// Hides the prompt window. The panel calls this once its collapse animation
/// has finished so the animation is not cut off.
#[tauri::command]
pub fn prompt_hide(app: AppHandle) -> Result<(), String> {
    prompt_window::hide(&app)
}
