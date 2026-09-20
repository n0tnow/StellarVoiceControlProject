import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createWalletSessionEngine,
  createWalletSessionStore,
  DEFAULT_AUTO_LOCK_MINUTES,
  didSessionLock,
  normalizeWalletSession,
  shouldAutoOpenWallet,
  shouldGateForSession,
  walletScreenFor,
  WalletSessionError,
  type WalletSession,
} from "./walletSession.ts";

function session(over: Partial<WalletSession> = {}): WalletSession {
  return {
    state: "locked",
    active: null,
    count: 1,
    unlockedAt: null,
    autoLockMinutes: DEFAULT_AUTO_LOCK_MINUTES,
    ...over,
  };
}

test("an untrusted payload is validated, and defaults fill in", () => {
  assert.equal(normalizeWalletSession(null), null);
  assert.equal(normalizeWalletSession({ state: "nope" }), null);
  const parsed = normalizeWalletSession({ state: "unlocked" });
  assert.equal(parsed?.state, "unlocked");
  assert.equal(parsed?.active, null);
  assert.equal(parsed?.count, 0);
  assert.equal(parsed?.autoLockMinutes, DEFAULT_AUTO_LOCK_MINUTES);
  const withActive = normalizeWalletSession({
    state: "unlocked",
    active: { address: "GABC", label: "Main" },
    unlockedAt: 42,
  });
  assert.deepEqual(withActive?.active, { address: "GABC", label: "Main" });
  assert.equal(withActive?.unlockedAt, 42);
});

test("a session maps to exactly one Wallet screen", () => {
  assert.equal(walletScreenFor(null), "loading");
  assert.equal(walletScreenFor(session({ state: "none" })), "connect");
  assert.equal(walletScreenFor(session({ state: "locked" })), "unlock");
  assert.equal(walletScreenFor(session({ state: "unlocked" })), "dashboard");
});

test("only an unlocked session clears the gate and the startup trigger", () => {
  assert.equal(shouldGateForSession(session({ state: "none" })), true);
  assert.equal(shouldGateForSession(session({ state: "locked" })), true);
  assert.equal(shouldGateForSession(session({ state: "unlocked" })), false);
  assert.equal(shouldGateForSession(null), false, "an unknown session must not lock the UI");

  assert.equal(shouldAutoOpenWallet(session({ state: "none" })), true);
  assert.equal(shouldAutoOpenWallet(session({ state: "locked" })), true);
  assert.equal(shouldAutoOpenWallet(session({ state: "unlocked" })), false);
});

test("only the unlocked→locked edge is a logout / auto-lock", () => {
  assert.equal(didSessionLock(session({ state: "unlocked" }), session({ state: "locked" })), true);
  assert.equal(didSessionLock(session({ state: "locked" }), session({ state: "unlocked" })), false);
  assert.equal(didSessionLock(null, session({ state: "locked" })), false, "launch is not a logout");
  assert.equal(didSessionLock(session({ state: "unlocked" }), session({ state: "unlocked" })), false);
  assert.equal(didSessionLock(session({ state: "unlocked" }), null), false);
});

test("the engine feature-detects a missing wallet_session command", async () => {
  const engine = createWalletSessionEngine(() =>
    Promise.reject("command wallet_session not found"),
  );
  assert.equal(await engine.available(), false);
  await assert.rejects(() => engine.current(), (error: unknown) => {
    assert.ok(error instanceof WalletSessionError);
    assert.equal(error.kind, "unavailable");
    return true;
  });
});

test("the engine types a Rust locked refusal and passes the address through", async () => {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  const engine = createWalletSessionEngine((command, args) => {
    calls.push({ command, args });
    if (command === "wallet_unlock") return Promise.resolve(session({ state: "unlocked" }));
    return Promise.resolve(session());
  });
  const unlocked = await engine.unlock("GABC");
  assert.equal(unlocked.state, "unlocked");
  assert.deepEqual(calls[0], { command: "wallet_unlock", args: { address: "GABC" } });

  const locked = createWalletSessionEngine(() =>
    Promise.reject({ kind: "locked", message: "wallet is locked" }),
  );
  await assert.rejects(() => locked.setAutoLock(5), (error: unknown) => {
    assert.ok(error instanceof WalletSessionError);
    assert.equal(error.kind, "locked");
    return true;
  });
});

test("the store starts, applies events and reflects mutations", async () => {
  const emitted: ((session: WalletSession) => void)[] = [];
  const engine = createWalletSessionEngine((command) => {
    if (command === "wallet_lock") return Promise.resolve(session({ state: "locked" }));
    if (command === "wallet_unlock") return Promise.resolve(session({ state: "unlocked" }));
    return Promise.resolve(session({ state: "none", count: 0 }));
  });
  const store = createWalletSessionStore(engine, async (handler) => {
    emitted.push(handler);
    return () => {};
  });

  assert.equal(store.getSnapshot().loading, true);
  await store.start();
  assert.deepEqual(store.getSnapshot(), {
    session: session({ state: "none", count: 0 }),
    available: true,
    loading: false,
  });

  emitted[0]?.(session({ state: "locked" }));
  assert.equal(store.getSnapshot().session?.state, "locked");

  await store.unlock();
  assert.equal(store.getSnapshot().session?.state, "unlocked");
  await store.lock();
  assert.equal(store.getSnapshot().session?.state, "locked");
});

test("an absent engine leaves the session unknown instead of crashing", async () => {
  const engine = createWalletSessionEngine(() => Promise.reject("command not found"));
  const store = createWalletSessionStore(engine);
  await store.start();
  assert.deepEqual(store.getSnapshot(), { session: null, available: false, loading: false });
});
