/**
 * A tiny, read-only last-resolved snapshot for the Debug panel's "notch state"
 * readout. `useShellState` records it after each render; the check reads it. The
 * module holds no React or Tauri state, so it can be inspected from the checks
 * glob without a context provider.
 */

export interface ShellDiagnostics {
  /** The state the UI has applied (drives the CSS class). */
  applied: string;
  /** The state the sources currently resolve to. */
  target: string;
  /** Which source resolved the current target. */
  source: string;
  /** True while a pinned gate (the wallet login/unlock screen) is active. */
  pinned: boolean;
  /** The voice source's attention flag, so precedence is inspectable. */
  voiceAttention: boolean;
}

let current: ShellDiagnostics | null = null;

export function recordShellDiagnostics(next: ShellDiagnostics): void {
  current = next;
}

export function readShellDiagnostics(): ShellDiagnostics | null {
  return current;
}
