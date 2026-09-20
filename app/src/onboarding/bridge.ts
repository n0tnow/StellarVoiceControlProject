/**
 * The onboarding window's IPC seam.
 *
 * Every Tauri command this window needs lives in `app/src-tauri/src/onboarding.rs`,
 * which is owned by a different worker and **does not exist on this branch**. So
 * the one rule here is that a missing command must be indistinguishable from a
 * boring answer: `invoke` rejects, we log it once, and the caller gets a neutral
 * value it can render. The alternative — letting the rejection escape — turns the
 * very first page of the very first run into a blank window.
 *
 * That is also why this module is a flat list of thin functions rather than a
 * class or a context. There is exactly one consumer per command, the fallbacks
 * are per-command facts (a permission we cannot read is `undetermined`, not
 * `denied`), and a seam whose whole job is "do not throw" is easiest to audit
 * when each function is three lines.
 *
 * ## Why the log is deduplicated
 *
 * `onboarding_permissions()` is polled while the permissions page is visible
 * (see [`usePermissions`]). Before the native half lands that is one rejection
 * per tick, forever, and a console flooded with the same line is a console
 * nobody reads — including for the errors that matter. [`warnOnce`] keys on the
 * command name, so each missing command says so exactly once per window.
 *
 * ## Why nothing here is typed against the Rust enums
 *
 * The payloads cross an IPC boundary and are `unknown` on arrival. Narrowing
 * them here ([`asStatus`], [`asPermissions`]) rather than casting means a Rust
 * rename shows up as a neutral fallback plus one console line, not as
 * `undefined.microphone` five frames later inside React.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Tauri event carrying a fresh permission snapshot while this window is open. */
export const ONBOARDING_PERMISSIONS_EVENT_NAME = "onboarding_permissions";

/**
 * A macOS TCC answer, mirrored from the Rust `Status`.
 *
 * The three cases are genuinely different *affordances*, which is why this is
 * not a boolean: `undetermined` can still be asked for in-process,
 * `denied` can only be fixed in System Settings, and `granted` needs no control
 * at all. The permissions page switches its button on exactly this value.
 */
export type PermissionStatus = "granted" | "denied" | "undetermined";

/** Both permissions Polaris needs before it can do anything at all. */
export interface PermissionSnapshot {
  readonly microphone: PermissionStatus;
  readonly accessibility: PermissionStatus;
}

/** Which System Settings pane [`openPrivacySettings`] should reveal. */
export type SettingsPane = "microphone" | "accessibility";

/** Persisted first-run state, as `onboarding_state` reports it. */
export interface OnboardingState {
  readonly completed: boolean;
  readonly version: number;
}

/**
 * The snapshot used whenever the native side cannot answer.
 *
 * `undetermined` on purpose, and it is the safe choice in both directions: it
 * never claims a permission the user has not given (which would let them past a
 * gate into a broken app), and it never accuses them of having denied something
 * (which would send them to System Settings for no reason). It also keeps the
 * page's primary control as the in-process "Allow", which is the one that
 * becomes correct the moment the Rust half lands.
 */
export const UNKNOWN_PERMISSIONS: PermissionSnapshot = {
  microphone: "undetermined",
  accessibility: "undetermined",
};

/** Command names already reported as unavailable, so each one warns once. */
const warned = new Set<string>();

/** See the module header: one line per missing command, not one per poll tick. */
function warnOnce(command: string, error: unknown): void {
  if (warned.has(command)) return;
  warned.add(command);
  console.warn(`onboarding: ${command} is unavailable`, error);
}

/**
 * `invoke`, with the rejection turned into `fallback`.
 *
 * Deliberately swallows *every* error, not just "command not found". Tauri does
 * not give a typed code for a missing command (the rejection is a plain string),
 * and the only honest thing a first-run window can do with a backend error is
 * carry on: there is no previous screen to return to and no support channel to
 * offer yet.
 */
async function call<T>(command: string, fallback: T, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    warnOnce(command, error);
    return fallback;
  }
}

/** Narrows an IPC value to a [`PermissionStatus`], or `undetermined`. */
function asStatus(value: unknown): PermissionStatus {
  return value === "granted" || value === "denied" || value === "undetermined"
    ? value
    : "undetermined";
}

/** Narrows an IPC value to a [`PermissionSnapshot`]; missing fields read unknown. */
export function asPermissions(value: unknown): PermissionSnapshot {
  if (typeof value !== "object" || value === null) return UNKNOWN_PERMISSIONS;
  const record = value as Record<string, unknown>;
  return {
    microphone: asStatus(record.microphone),
    accessibility: asStatus(record.accessibility),
  };
}

/** Whether first run has already been completed. Unknown reads as "not yet". */
export async function readOnboardingState(): Promise<OnboardingState> {
  const value = await call<unknown>("onboarding_state", null);
  if (typeof value !== "object" || value === null) return { completed: false, version: 0 };
  const record = value as Record<string, unknown>;
  return {
    completed: record.completed === true,
    version: typeof record.version === "number" ? record.version : 0,
  };
}

/** Shows the onboarding window. Present for symmetry; the window opens itself. */
export async function openOnboarding(): Promise<void> {
  await call<null>("onboarding_open", null);
}

/**
 * Closes the window without marking first run done.
 *
 * The quiet close affordance and Escape both land here. It is deliberately *not*
 * [`completeOnboarding`]: a user who closes the window has not finished, and
 * silently recording that they had would cost them the one chance to be taught
 * the shortcuts.
 */
export async function closeOnboarding(): Promise<void> {
  await call<null>("onboarding_close", null);
}

/** Marks first run done and closes the window. The final page's only action. */
export async function completeOnboarding(): Promise<void> {
  await call<null>("onboarding_complete", null);
}

/** Clears the completion flag so first run happens again (used from Debug). */
export async function resetOnboarding(): Promise<void> {
  await call<null>("onboarding_reset", null);
}

/** The current TCC snapshot. Falls back to [`UNKNOWN_PERMISSIONS`]. */
export async function readPermissions(): Promise<PermissionSnapshot> {
  return asPermissions(await call<unknown>("onboarding_permissions", UNKNOWN_PERMISSIONS));
}

/**
 * Asks macOS for the microphone, in process.
 *
 * Returns the status *after* the prompt. On macOS the answer is immediate for
 * this one (unlike Accessibility), so the caller can use the return value rather
 * than waiting for a poll tick.
 */
export async function requestMicrophone(): Promise<PermissionStatus> {
  return asStatus(await call<unknown>("onboarding_request_microphone", "undetermined"));
}

/**
 * Opens the Accessibility consent dialog.
 *
 * Apple's `AXIsProcessTrustedWithOptions` prompt is asynchronous and its return
 * value does not reflect the user's choice (`hotkey_flags.rs` says so in its own
 * doc comment), so the returned status here is a *snapshot*, not an answer. This
 * is precisely why the permissions page polls as well as listening: for
 * Accessibility, polling is the only thing that ever observes the grant.
 */
export async function requestAccessibility(): Promise<PermissionStatus> {
  return asStatus(await call<unknown>("onboarding_request_accessibility", "undetermined"));
}

/** Reveals the relevant Privacy & Security pane — the only route out of `denied`. */
export async function openPrivacySettings(pane: SettingsPane): Promise<void> {
  await call<null>("onboarding_open_settings", null, { pane });
}

/**
 * Subscribes to the push-based permission snapshot.
 *
 * Never rejects: if the event channel is unavailable the caller gets a no-op
 * unsubscribe and keeps its polling fallback, which is the whole reason the page
 * has both. Malformed payloads are narrowed rather than dropped — a snapshot
 * missing one field still carries the other, and `asPermissions` reads the
 * missing one as unknown.
 */
export async function listenPermissions(
  handler: (snapshot: PermissionSnapshot) => void,
): Promise<UnlistenFn> {
  try {
    return await listen<unknown>(ONBOARDING_PERMISSIONS_EVENT_NAME, (message) => {
      handler(asPermissions(message.payload));
    });
  } catch (error) {
    warnOnce(ONBOARDING_PERMISSIONS_EVENT_NAME, error);
    return () => {};
  }
}
