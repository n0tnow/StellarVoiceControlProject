import assert from "node:assert/strict";
import { test } from "node:test";

import type { PlayingSFX, UISFXPlayer } from "uisfx";

import { __testing, isSfxEnabled, playSfx, setSfxEnabled, unlockSfx, useSfx } from "./sfx.ts";

/**
 * A minimal fake `UISFXPlayer`. Every call is recorded so a test can assert
 * on it without ever touching WebAudio — this suite must never construct a
 * real `AudioContext` (there is none in `node --test`).
 */
function fakePlayer(overrides: Partial<UISFXPlayer> = {}): UISFXPlayer & { calls: string[] } {
  const calls: string[] = [];
  let enabled = true;
  const base: UISFXPlayer = {
    unlock: async () => true,
    play: (cue) => {
      calls.push(`play:${cue}`);
      return null as unknown as PlayingSFX;
    },
    preload: async () => {},
    setPack: () => {},
    getPack: () => "minimal",
    setVolume: () => {},
    getVolume: () => 0.35,
    setEnabled: (value) => {
      calls.push(`setEnabled:${value}`);
      enabled = value;
    },
    isEnabled: () => enabled,
    stopAll: () => {},
    destroy: async () => {},
  };
  return Object.assign(base, overrides, { calls });
}

test.afterEach(() => {
  __testing.reset();
});

test("playSfx forwards to the injected player", () => {
  const fake = fakePlayer();
  __testing.setPlayer(fake);

  playSfx("hover");

  assert.deepEqual(fake.calls, ["play:hover"]);
});

test("playSfx is a silent no-op when construction failed (player is null)", () => {
  __testing.setPlayer(null);

  assert.doesNotThrow(() => playSfx("hover"));
});

test("playSfx is a silent no-op when the player's play() throws", () => {
  const fake = fakePlayer({
    play: () => {
      throw new Error("synthesis exploded");
    },
  });
  __testing.setPlayer(fake);

  assert.doesNotThrow(() => playSfx("error"));
});

test("setSfxEnabled/isSfxEnabled delegate to the injected player", () => {
  const fake = fakePlayer();
  __testing.setPlayer(fake);

  assert.equal(isSfxEnabled(), true);
  setSfxEnabled(false);
  assert.equal(fake.calls.includes("setEnabled:false"), true);
  assert.equal(isSfxEnabled(), false);
});

test("isSfxEnabled is false, not throwing, when the player is null", () => {
  __testing.setPlayer(null);

  assert.equal(isSfxEnabled(), false);
});

test("setSfxEnabled on a null player is a silent no-op", () => {
  __testing.setPlayer(null);

  assert.doesNotThrow(() => setSfxEnabled(true));
});

test("unlockSfx resolves false without throwing when the player is null", async () => {
  __testing.setPlayer(null);

  assert.equal(await unlockSfx(), false);
});

test("unlockSfx resolves the injected player's unlock() result", async () => {
  __testing.setPlayer(fakePlayer({ unlock: async () => true }));

  assert.equal(await unlockSfx(), true);
});

test("unlockSfx swallows a rejected unlock() and resolves false", async () => {
  __testing.setPlayer(
    fakePlayer({
      unlock: () => Promise.reject(new Error("no gesture yet")),
    }),
  );

  assert.equal(await unlockSfx(), false);
});

test("useSfx returns the same playSfx reference every call", () => {
  assert.equal(useSfx(), playSfx);
  assert.equal(useSfx(), useSfx());
});

test("readStoredEnabled returns null with no window (Node test environment)", () => {
  assert.equal(__testing.readStoredEnabled(), null);
});

test("prefersReducedMotion is false with no window (Node test environment)", () => {
  assert.equal(__testing.prefersReducedMotion(), false);
});

test("initialEnabled defaults to true when nothing is stored and there is no window", () => {
  // No `window` at all in this environment: neither a stored preference nor
  // a reduced-motion signal is available, so the default is "enabled".
  assert.equal(__testing.initialEnabled(), true);
});

test("STORAGE_KEY is the documented preference key", () => {
  assert.equal(__testing.STORAGE_KEY, "polaris.sfx.enabled");
});
