//! Per-turn phase timing (step A11).
//!
//! The owner reported that a whole spoken turn still feels slow, but there was
//! no breakdown of *where* the time goes. This module records one timestamped
//! checkpoint per phase of a turn and prints them as a single readable block to
//! the Rust terminal — the webview console is invisible to the owner, so every
//! number has to arrive here.
//!
//! ## Why a process-global trace
//!
//! A turn crosses three runtimes: Rust capture/STT, the TypeScript agent loop in
//! the webview, and the Rust provider/TTS transport. There is no object that
//! already spans them, and push-to-talk is serial by construction, so one
//! process-global open turn is the honest model. The webview contributes its own
//! phases through the `polaris_phase` command.
//!
//! ## Phases
//!
//! ```text
//! hotkey release → WAV ready → transcript → [agent] request built → first byte
//!   → full response → intent parsed → sentence built → [tts] request sent
//!   → first audio byte → playback start → playback end
//! ```
//!
//! `begin_turn` opens the trace at the hotkey release; `finish_turn` closes and
//! prints it once playback ends (or synthesis fails). A turn that never speaks
//! is flushed — with whatever phases it reached — when the next one begins, so a
//! failed turn can never silently swallow the numbers.
//!
//! ## Flag
//!
//! `POLARIS_TIMING` disables it (`0`, `false`, `off`, `no`). It is **on by
//! default** while the breakdown is being established. Reading is cached once.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Set to `0`/`false`/`off`/`no` to silence the per-turn block.
pub const TIMING_ENV: &str = "POLARIS_TIMING";

/// One checkpoint, relative to the turn's start.
#[derive(Debug, Clone)]
struct Phase {
    /// Display name. Owned because the webview supplies some of them.
    name: String,
    at: Instant,
}

/// The open turn.
#[derive(Debug)]
struct Turn {
    id: u64,
    started: Instant,
    phases: Vec<Phase>,
}

static ENABLED: OnceLock<bool> = OnceLock::new();
/// `Mutex::new(None)` is const, so no lazy initialisation is needed.
static TURN: Mutex<Option<Turn>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn enabled() -> bool {
    *ENABLED.get_or_init(|| {
        match std::env::var(TIMING_ENV) {
            Ok(value) => !matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            ),
            Err(_) => true,
        }
    })
}

/// Opens a new turn trace. If a previous turn is still open (it never reached
/// playback end, e.g. a chain failure), it is printed first so its numbers are
/// not lost.
pub fn begin_turn() {
    if !enabled() {
        return;
    }
    let mut guard = match TURN.lock() {
        Ok(guard) => guard,
        Err(error) => error.into_inner(),
    };
    if let Some(previous) = guard.take() {
        print_turn(&previous);
    }
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    *guard = Some(Turn {
        id,
        started: Instant::now(),
        phases: Vec::new(),
    });
}

/// Records one checkpoint on the open turn. A no-op when no turn is open (e.g. a
/// unit test or the headless driver), so instrumenting a shared module never
/// creates noise.
pub fn mark(name: impl Into<String>) {
    if !enabled() {
        return;
    }
    let mut guard = match TURN.lock() {
        Ok(guard) => guard,
        Err(error) => error.into_inner(),
    };
    if let Some(turn) = guard.as_mut() {
        turn.phases.push(Phase {
            name: name.into(),
            at: Instant::now(),
        });
    }
}

/// Closes the open turn and prints its block. A no-op when none is open.
pub fn finish_turn() {
    if !enabled() {
        return;
    }
    let mut guard = match TURN.lock() {
        Ok(guard) => guard,
        Err(error) => error.into_inner(),
    };
    if let Some(turn) = guard.take() {
        print_turn(&turn);
    }
}

/// Renders and prints one turn as a single block, so concurrent terminal lines
/// cannot interleave inside the table.
fn print_turn(turn: &Turn) {
    // The webview reports its phases from another thread, so insertion order is
    // not guaranteed to be chronological. Sort by the recorded instant.
    let mut phases: Vec<&Phase> = turn.phases.iter().collect();
    phases.sort_by_key(|phase| phase.at);

    let total = turn.started.elapsed().as_millis();
    let mut block = String::new();
    block.push_str(&format!(
        "\npolaris: ── turn #{} timing (total {total} ms; {} phases) ──\n",
        turn.id,
        phases.len()
    ));
    let mut previous = turn.started;
    for phase in phases {
        let at = phase.at.saturating_duration_since(turn.started).as_millis();
        let delta = phase.at.saturating_duration_since(previous).as_millis();
        block.push_str(&format!("polaris:   {:<22} {at:>6} ms  (+{delta})\n", phase.name));
        previous = phase.at;
    }
    block.push_str(&format!(
        "polaris:   {:<22} {total:>6} ms  (total)\n",
        "playback end / close"
    ));
    block.push_str("polaris: ────────────────────────────────────────────────────────");
    println!("{block}");
}

/// The `polaris_phase` Tauri command: the webview reports a phase that happened
/// inside the agent loop (request built, intent parsed, sentence built).
#[tauri::command]
pub fn polaris_phase(name: String) {
    mark(name);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timing_is_on_unless_explicitly_disabled() {
        // Pure check of the env grammar; the process-global `ENABLED` cache is
        // deliberately not exercised here (other tests share the process).
        for value in ["0", " false ", "OFF", "no"] {
            assert!(matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            ));
        }
        for value in ["1", "true", "on", ""] {
            assert!(!matches!(
                value.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            ));
        }
    }

    #[test]
    fn marking_without_an_open_turn_is_a_noop() {
        // No `begin_turn` here: this must not panic or create a trace.
        mark("standalone");
        finish_turn();
    }
}
