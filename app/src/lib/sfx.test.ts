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

/** A minimal `localStorage` stand-in, with per-test overrides. */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const store = new Map<string, string>();
  const base: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
  return Object.assign(base, overrides);
}

/**
 * Runs `run` with a fake `window` installed, restoring the real (absent) one
 * afterwards. `hasWindow()` reads the global dynamically, so this is enough to
 * exercise the storage/reduced-motion branches that the default `node --test`
 * environment (no `window`) never reaches.
 */
function withFakeWindow<T>(
  win: { localStorage?: Storage; matchMedia?: (query: string) => { matches: boolean } },
  run: () => T,
): T {
  const scope = globalThis as { window?: unknown };
  const previous = scope.window;
  scope.window = win;
  try {
    return run();
  } finally {
    if (previous === undefined) delete scope.window;
    else scope.window = previous;
  }
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

test("playSfx forwards PlayOptions through to the player", () => {
  const options = { volume: 0.5, cooldownMs: 100 };
  let received: { cue: unknown; options: unknown } | null = null;
  const fake = fakePlayer({
    play: ((cue: unknown, playOptions?: unknown) => {
      received = { cue, options: playOptions };
      return null as unknown as PlayingSFX;
    }) as UISFXPlayer["play"],
  });
  __testing.setPlayer(fake);

  playSfx("select", options);

  assert.deepEqual(received, { cue: "select", options });
});

test("readStoredEnabled returns null, not throwing, when getItem throws", () => {
  const storage = fakeStorage({
    getItem: () => {
      throw new Error("storage blocked");
    },
  });

  assert.equal(
    withFakeWindow({ localStorage: storage }, () => __testing.readStoredEnabled()),
    null,
  );
});

test("readStoredEnabled returns null for malformed JSON", () => {
  const storage = fakeStorage({ getItem: () => "{not json" });

  assert.equal(withFakeWindow({ localStorage: storage }, () => __testing.readStoredEnabled()), null);
});

test("readStoredEnabled returns null when the stored enabled is not a boolean", () => {
  const storage = fakeStorage({ getItem: () => JSON.stringify({ enabled: "yes" }) });

  assert.equal(withFakeWindow({ localStorage: storage }, () => __testing.readStoredEnabled()), null);
});

test("readStoredEnabled returns the stored boolean", () => {
  const storage = fakeStorage({ getItem: () => JSON.stringify({ enabled: false }) });

  assert.equal(withFakeWindow({ localStorage: storage }, () => __testing.readStoredEnabled()), false);
});

test("prefersReducedMotion reflects the media query", () => {
  const storage = fakeStorage();

  assert.equal(
    withFakeWindow({ localStorage: storage, matchMedia: () => ({ matches: true }) }, () =>
      __testing.prefersReducedMotion(),
    ),
    true,
  );
  assert.equal(
    withFakeWindow({ localStorage: storage, matchMedia: () => ({ matches: false }) }, () =>
      __testing.prefersReducedMotion(),
    ),
    false,
  );
});

test("an explicit stored preference beats prefers-reduced-motion", () => {
  const storedOn = fakeStorage({ getItem: () => JSON.stringify({ enabled: true }) });
  assert.equal(
    withFakeWindow({ localStorage: storedOn, matchMedia: () => ({ matches: true }) }, () =>
      __testing.initialEnabled(),
    ),
    true,
  );

  const storedOff = fakeStorage({ getItem: () => JSON.stringify({ enabled: false }) });
  assert.equal(
    withFakeWindow({ localStorage: storedOff, matchMedia: () => ({ matches: false }) }, () =>
      __testing.initialEnabled(),
    ),
    false,
  );
});

test("with nothing stored, reduced motion starts sound disabled", () => {
  const storage = fakeStorage();

  assert.equal(
    withFakeWindow({ localStorage: storage, matchMedia: () => ({ matches: true }) }, () =>
      __testing.initialEnabled(),
    ),
    false,
  );
  assert.equal(
    withFakeWindow({ localStorage: storage, matchMedia: () => ({ matches: false }) }, () =>
      __testing.initialEnabled(),
    ),
    true,
  );
});

test("playSfx/setSfxEnabled/isSfxEnabled do not throw when storage read and write throw", () => {
  const throwingStorage = fakeStorage({
    getItem: () => {
      throw new Error("storage blocked");
    },
    setItem: () => {
      throw new Error("storage blocked");
    },
  });

  withFakeWindow({ localStorage: throwingStorage, matchMedia: () => ({ matches: false }) }, () => {
    __testing.reset();
    assert.doesNotThrow(() => playSfx("hover"));
    assert.doesNotThrow(() => setSfxEnabled(false));
    assert.doesNotThrow(() => isSfxEnabled());
  });
});

test("a construction failure is cached: playSfx stays silent and never retries the construct", () => {
  let storageAccesses = 0;
  const win: { localStorage?: Storage } = {};
  // A throwing accessor makes `createUISFX`'s construction fail inside
  // `getPlayer`'s try, which is the branch that caches `player = null`.
  Object.defineProperty(win, "localStorage", {
    get() {
      storageAccesses += 1;
      throw new Error("storage blocked");
    },
  });

  withFakeWindow(win, () => {
    __testing.reset();
    assert.doesNotThrow(() => playSfx("hover"));
    const afterFirst = storageAccesses;
    assert.equal(afterFirst >= 1, true);
    // A retry on every call would keep touching storage; the cache does not.
    assert.doesNotThrow(() => playSfx("hover"));
    assert.equal(storageAccesses, afterFirst);
  });
});

test("STORAGE_KEY is the documented preference key", () => {
  assert.equal(__testing.STORAGE_KEY, "polaris.sfx.enabled");
});
