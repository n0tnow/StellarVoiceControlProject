/**
 * Polaris' UI sound layer: one quiet, synthesized cue per interaction.
 *
 * `uisfx` synthesizes every cue in-process with WebAudio — no bundled audio
 * files, no network fetch — which is why it is the only sound library this
 * app could use at all. Polaris ships as a packaged Tauri binary that must
 * work fully offline; a library that shipped `.mp3`/`.ogg` assets would mean
 * either bundling them (bigger binary, another asset pipeline to keep in
 * sync) or fetching them (a network dependency for a menu click). Synthesis
 * sidesteps both: the cue is a few numbers turned into a buffer at play time.
 *
 * The player itself is built lazily, on first use, never at import time.
 * Browsers refuse to run an `AudioContext` before a real user gesture, so
 * there is nothing useful an eager construction could do at import: the
 * context would sit suspended until the first interaction anyway. Instead
 * `unlockSfx` is armed once against the first `pointerdown`/`keydown` the
 * document sees, so by the time anything tries to play a cue the context is
 * already unlocked. Building on first use also keeps `node --test` (no DOM)
 * from ever constructing a player at all.
 *
 * Every entry point here fails silent: a construction error, a disabled
 * preference, or a missing `window` all degrade to "nothing played" rather
 * than a thrown error. A sound effect is decoration — a shell that throws
 * because its click noise could not be synthesized would be a strictly worse
 * shell than one that stayed quiet. `cooldownMs: 40` exists for the same
 * reason a volume cap does: a fast repeated action (arrow-key list scrubbing,
 * a held key) must not machine-gun the same cue into a buzz.
 *
 * The on/off preference is persisted through `uisfx`'s own `preferences`
 * option (a thin `localStorage` wrapper it reads back on construction), not
 * hand-rolled here, so there is exactly one place that decides the stored
 * shape. The default is enabled, except when the OS reports
 * `prefers-reduced-motion` and nothing has been stored yet — reduced motion
 * is usually chosen by people who want less ambient stimulus, and a first
 * run should respect that guess without overriding a preference the user
 * later sets explicitly.
 */
import { createUISFX, type CueName, type PlayOptions, type UISFXPlayer } from "uisfx";

const STORAGE_KEY = "polaris.sfx.enabled";

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/** The stored `enabled` flag, if `uisfx` has ever persisted one under our key. */
function readStoredEnabled(): boolean | null {
  if (!hasWindow()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { enabled?: unknown };
    return typeof parsed.enabled === "boolean" ? parsed.enabled : null;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  if (!hasWindow()) return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The `enabled` value handed to `createUISFX`. `uisfx` resolves its enabled
 * state as `options.enabled ?? stored.enabled ?? true` — the constructor
 * option wins over its stored value — so the stored preference is honoured
 * here by reading it first and only falling back to the reduced-motion guess
 * when nothing is stored. Removing that read would silently ignore an existing
 * preference, because `uisfx` would then use the value we pass unconditionally.
 */
function initialEnabled(): boolean {
  const stored = readStoredEnabled();
  if (stored !== null) return stored;
  return !prefersReducedMotion();
}

// A test seam, not part of the public contract: it lets `sfx.test.ts` inject
// a fake player and exercise the enabled gate / no-op behaviour without ever
// constructing a real `AudioContext`. `undefined` means "no override, use the
// lazily-constructed real player"; `null` is a legitimate override meaning
// "construction failed."
let playerOverride: UISFXPlayer | null | undefined;
let player: UISFXPlayer | null | undefined;

function getPlayer(): UISFXPlayer | null {
  if (playerOverride !== undefined) return playerOverride;
  if (player !== undefined) return player;
  if (!hasWindow()) {
    player = null;
    return player;
  }
  try {
    player = createUISFX({
      pack: "minimal",
      volume: 0.35,
      cooldownMs: 40,
      enabled: initialEnabled(),
      preferences: { key: STORAGE_KEY, storage: window.localStorage },
    });
  } catch {
    // WebAudio can refuse to construct (locked-down environments, exhausted
    // context limits); degrade to silence rather than take the caller down.
    player = null;
  }
  return player;
}

/** Play a cue. Silent no-op when sound is off or the player could not start. */
export function playSfx(cue: CueName, options?: PlayOptions): void {
  const instance = getPlayer();
  if (!instance) return;
  try {
    instance.play(cue, options);
  } catch {
    // Never let a decorative sound take down the caller's interaction.
  }
}

/**
 * Call from a real user gesture (pointerdown/keydown); safe to call
 * repeatedly. Armed automatically on module load against the first such
 * event the document sees, so ordinary call sites never need to think about
 * unlocking at all.
 */
export function unlockSfx(): Promise<boolean> {
  const instance = getPlayer();
  if (!instance) return Promise.resolve(false);
  try {
    return instance.unlock().catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

export function setSfxEnabled(enabled: boolean): void {
  const instance = getPlayer();
  if (!instance) return;
  try {
    instance.setEnabled(enabled);
  } catch {
    // Silent, per module contract.
  }
}

export function isSfxEnabled(): boolean {
  const instance = getPlayer();
  if (!instance) return false;
  try {
    return instance.isEnabled();
  } catch {
    return false;
  }
}

/**
 * React helper: returns a stable `playSfx`. `playSfx` is already a plain
 * module-level function with no closed-over render state, so "stable" needs
 * no `useCallback` — the same reference is simply handed back every render.
 */
export function useSfx(): typeof playSfx {
  return playSfx;
}

if (hasWindow() && typeof document !== "undefined") {
  const arm = (): void => {
    document.removeEventListener("pointerdown", arm);
    document.removeEventListener("keydown", arm);
    void unlockSfx();
  };
  document.addEventListener("pointerdown", arm, { once: true });
  document.addEventListener("keydown", arm, { once: true });
}

export const __testing = {
  /** Force `getPlayer()` to return `fake` (or `null`) without touching WebAudio. */
  setPlayer(fake: UISFXPlayer | null): void {
    playerOverride = fake;
  },
  /** Drop the override and the lazily-built real player, for test isolation. */
  reset(): void {
    playerOverride = undefined;
    player = undefined;
  },
  readStoredEnabled,
  prefersReducedMotion,
  initialEnabled,
  STORAGE_KEY,
};
