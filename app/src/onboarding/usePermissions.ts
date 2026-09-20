/**
 * The live microphone/Accessibility snapshot for the permissions page.
 *
 * ## Why it both listens and polls
 *
 * Belt and braces, and each strand covers a failure the other cannot.
 *
 * The **event** is the fast path: Rust emits `onboarding_permissions` while the
 * window is visible, so a grant made in System Settings shows up here within a
 * frame of Rust noticing it.
 *
 * The **poll** is the one that has to exist. Accessibility is not a TCC prompt
 * that returns an answer: `AXIsProcessTrustedWithOptions` is asynchronous and
 * its return value does not reflect the user's choice — `hotkey_flags.rs` says
 * so in its own doc comment — so the *only* way anybody observes that grant is
 * by asking again. If Rust's emitter is ever gated on something this window
 * cannot see (visibility, focus, a state the overlay owns), the poll is what
 * keeps the page from sitting on a stale "not yet" while the user stares at a
 * checkbox they have already ticked.
 *
 * Both write through one setter, and the snapshot is compared before it is
 * stored, so the two sources agreeing costs nothing: no re-render, and — more
 * importantly — no repeated `check` cue for a permission that turned green once.
 *
 * ## Why it stops when the page is not visible
 *
 * `active` is the permissions page being on screen. Polling a TCC database
 * twice a second for the rest of first run buys nothing, and the poll is
 * observable: every tick before the Rust half lands is a rejected `invoke`.
 *
 * ## Why the transition, not the value, drives the sound
 *
 * A permission can turn green while the user is in System Settings and not
 * looking at this window at all. The `check` cue is the only thing that tells
 * them they can come back, so it fires on the *edge* — `denied`/`undetermined`
 * to `granted` — and never on a snapshot that merely repeats good news.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  UNKNOWN_PERMISSIONS,
  listenPermissions,
  openPrivacySettings,
  readPermissions,
  requestAccessibility,
  requestMicrophone,
  type PermissionSnapshot,
  type PermissionStatus,
  type SettingsPane,
} from "./bridge.ts";

/**
 * How often the page re-reads the snapshot while it is visible.
 *
 * 800 ms is chosen against a human walking to System Settings and back, not
 * against a machine: it is fast enough that the row is already green by the time
 * their eyes return to the window, and slow enough that it is not a spin loop on
 * a system database. It only runs while the permissions page is on screen.
 */
export const PERMISSION_POLL_MS = 800;

/** The two rows the page renders, in the order it renders them. */
export const PERMISSION_KEYS = ["microphone", "accessibility"] as const;

/** One row's identity; also the System Settings pane it opens. */
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

/** Whether both permissions are granted — the permissions gate's whole test. */
export function allGranted(snapshot: PermissionSnapshot): boolean {
  return PERMISSION_KEYS.every((key) => snapshot[key] === "granted");
}

/** What the permissions page renders and calls. */
export interface PermissionsController {
  readonly snapshot: PermissionSnapshot;
  /** Whether a request for this row is in flight, so its button can say so. */
  readonly pending: PermissionKey | null;
  /** Runs the correct action for the row's current status. */
  readonly act: (key: PermissionKey) => void;
}

/**
 * Reads the permission snapshot and exposes the one action each row needs.
 *
 * `onGranted` fires once per permission, on the edge into `granted`, and hands
 * the caller the post-grant snapshot so it can tell "one more to go" from "the
 * set is complete" without re-reading it.
 */
export function usePermissions(
  active: boolean,
  onGranted: (key: PermissionKey, snapshot: PermissionSnapshot) => void,
): PermissionsController {
  const [snapshot, setSnapshot] = useState<PermissionSnapshot>(UNKNOWN_PERMISSIONS);
  const [pending, setPending] = useState<PermissionKey | null>(null);
  const latest = useRef<PermissionSnapshot>(UNKNOWN_PERMISSIONS);
  const grantedRef = useRef(onGranted);
  grantedRef.current = onGranted;

  /** The single write path for both sources; see the module header. */
  const apply = useCallback((next: PermissionSnapshot) => {
    const previous = latest.current;
    if (previous.microphone === next.microphone && previous.accessibility === next.accessibility) {
      return;
    }
    latest.current = next;
    setSnapshot(next);
    for (const key of PERMISSION_KEYS) {
      if (previous[key] !== "granted" && next[key] === "granted") grantedRef.current(key, next);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;

    const read = () => {
      void readPermissions().then((next) => {
        if (!disposed) apply(next);
      });
    };

    // Read immediately: the page must be correct on its first paint, not after
    // one poll interval of claiming nothing is granted yet.
    read();
    const timer = window.setInterval(read, PERMISSION_POLL_MS);
    void listenPermissions((next) => {
      if (!disposed) apply(next);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [active, apply]);

  /**
   * Runs the row's action for its current status.
   *
   * The status decides, not the caller: a button whose label already depends on
   * the status would otherwise be able to drift out of step with what it does,
   * and "Allow" that silently opened System Settings is a worse bug than either
   * one alone. `granted` does nothing, because a granted row has no button.
   */
  const act = useCallback(
    (key: PermissionKey) => {
      const status: PermissionStatus = latest.current[key];
      if (status === "granted" || pending !== null) return;

      if (status === "denied") {
        // The only route out of `denied`: macOS will not re-prompt in process.
        void openPrivacySettings(key satisfies SettingsPane);
        return;
      }

      setPending(key);
      const request = key === "microphone" ? requestMicrophone() : requestAccessibility();
      void request
        .then((result) => {
          // The microphone answers immediately, so its result is worth applying
          // at once rather than waiting for a tick. Accessibility's is only ever
          // a snapshot (see `requestAccessibility`), which is exactly why this
          // merges the one field rather than trusting the whole reply.
          apply({ ...latest.current, [key]: result });
        })
        .finally(() => setPending(null));
    },
    [apply, pending],
  );

  return { snapshot, pending, act };
}
