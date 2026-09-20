/**
 * Page 2 — the two permissions, and the only page that can genuinely fail.
 *
 * Autonomy needs exactly two things from macOS and cannot fake either one: the
 * microphone, or there is nothing to transcribe; and Accessibility trust, or the
 * modifier-only Control+Option gesture is invisible to it
 * (`hotkey_flags.rs` gates its global `flagsChanged` monitor on
 * `AXIsProcessTrusted`). Both are explained in one plain sentence each, because
 * a permission a user does not understand is a permission they deny.
 *
 * ## The button is a function of the status
 *
 * `undetermined` gets "Allow", which prompts in process — the good path, and the
 * one the page is shaped around. `denied` gets "Open Settings", because macOS
 * will not re-prompt once refused and the in-process call would do nothing at
 * all. `granted` gets no button: there is nothing left to do, and a disabled
 * control left behind would say the opposite.
 *
 * That mapping lives in [`usePermissions`], not here — this page renders a
 * label and calls `act(key)`. A page that chose the label *and* the action could
 * drift between them, and "Allow" that quietly opened System Settings is a worse
 * bug than either half.
 *
 * ## Skipping
 *
 * Continue is disabled until both are granted, and there is a muted "Continue
 * without them" underneath. That link is not a hedge: a user who has hit a
 * managed-device policy, or who simply wants to look around first, must not be
 * stranded on page two of a window that is the only thing standing between them
 * and the app. The skip is recorded (see `steps.ts`), and the final page says
 * something different because of it.
 */
import { useEffect } from "react";

import {
  PERMISSION_KEYS,
  allGranted,
  usePermissions,
  type PermissionKey,
  type PermissionsController,
} from "../usePermissions.ts";
import type { PermissionSnapshot, PermissionStatus } from "../bridge.ts";
import { CheckIcon } from "../icons.tsx";

/** The row copy. One sentence each, and each one says *why*, never *what*. */
const ROWS: Record<PermissionKey, { name: string; why: string }> = {
  microphone: {
    name: "Microphone",
    why: "So Autonomy can hear you while you hold the keys. Audio is only captured during a hold.",
  },
  accessibility: {
    name: "Accessibility",
    why: "So Autonomy can notice Control and Option being held, even while you are in another app.",
  },
};

function PermissionRow({
  permission,
  status,
  controller,
}: {
  permission: PermissionKey;
  status: PermissionStatus;
  controller: PermissionsController;
}) {
  const { name, why } = ROWS[permission];
  const busy = controller.pending === permission;

  return (
    <div className="ob-row">
      <div className="ob-row-main">
        <span className="ob-row-name">{name}</span>
        <span className="ob-row-why">{why}</span>
        {status === "denied" ? (
          <span className="ob-row-denied">
            Turned off. macOS only lets this be changed in System Settings.
          </span>
        ) : null}
      </div>
      <div className="ob-row-action">
        {status === "granted" ? (
          /* Not a live region: the window announces the change once, centrally,
             so a screen reader hears "Microphone granted" rather than both this
             and the page's own announcement. */
          <span className="ob-granted">
            <CheckIcon />
            Granted
          </span>
        ) : (
          <button
            type="button"
            className="ob-button ob-button-quiet"
            disabled={controller.pending !== null}
            onClick={() => controller.act(permission)}
          >
            {status === "denied" ? "Open Settings" : busy ? "Waiting…" : "Allow"}
          </button>
        )}
      </div>
    </div>
  );
}

export interface PermissionsPageProps {
  /** Whether this page is on screen — gates the poll. See `usePermissions`. */
  readonly active: boolean;
  /** Whether this gate is already recorded as satisfied in the flow. */
  readonly passed: boolean;
  /** Records the gate as satisfied once both permissions read as granted. */
  readonly onPass: () => void;
  readonly onAdvance: () => void;
  readonly onSkip: () => void;
  /**
   * Called on each permission's edge into `granted`, for the `check` cue. The
   * post-grant snapshot rides along so the caller can stay quiet when this
   * grant completes the set — the gate's own cue covers that moment.
   */
  readonly onGranted: (key: PermissionKey, snapshot: PermissionSnapshot) => void;
  /** Whether the user already walked past this gate. */
  readonly skipped: boolean;
}

export function PermissionsPage({
  active,
  passed,
  onPass,
  onAdvance,
  onSkip,
  onGranted,
  skipped,
}: PermissionsPageProps) {
  const controller = usePermissions(active, onGranted);
  const ready = allGranted(controller.snapshot);

  // A gate whose precondition already holds must still be *recorded* as
  // satisfied, or `canAdvance` refuses to move while Continue sits there
  // enabled: the snapshot says granted but the flow never hears about it,
  // because `onGranted` fires on the edge into `granted` and a Mac that was
  // set up before this run never produces one. Firing on `ready` covers that
  // case and the moment the second permission lands; `passStep` is
  // idempotent, so a repeat costs nothing.
  useEffect(() => {
    if (active && ready && !passed) onPass();
  }, [active, ready, passed, onPass]);

  return (
    <>
      <h1 className="ob-title">Two permissions</h1>
      <p className="ob-body">
        Autonomy asks for as little as it can. These two are the ones it cannot work
        without.
      </p>

      <div className="ob-rows">
        {PERMISSION_KEYS.map((key) => (
          <PermissionRow
            key={key}
            permission={key}
            status={controller.snapshot[key]}
            controller={controller}
          />
        ))}
      </div>

      {ready ? (
        <p className="ob-granted-note">Already granted on this Mac — nothing to do here.</p>
      ) : null}

      <div className="ob-actions">
        <button
          type="button"
          className="ob-button ob-button-primary"
          disabled={!ready && !skipped}
          onClick={onAdvance}
        >
          Continue
        </button>
        {/* Hidden once the gate is genuinely satisfied: an escape hatch next to
            a door that is already open is just clutter. */}
        {ready ? null : (
          <button type="button" className="ob-skip" onClick={onSkip}>
            Continue without them
          </button>
        )}
      </div>
    </>
  );
}
