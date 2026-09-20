import assert from "node:assert/strict";
import { test } from "node:test";

import { createSnapshotCache, type SnapshotLoad } from "./snapshotCache.ts";

/** A promise whose settlement the test controls, for in-flight assertions. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("two concurrent callers for one key issue one read", async () => {
  let calls = 0;
  const pending = deferred<SnapshotLoad<number>>();
  const cache = createSnapshotCache<number>((key) => {
    calls += 1;
    return pending.promise.then((value) => (value.ok ? { ...value, key } : value));
  });

  const first = cache.load("k");
  const second = cache.load("k");
  assert.equal(calls, 1);

  pending.resolve({ ok: true, key: "k", value: 7 });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.equal(cache.peek("k"), 7);
});

test("a cached snapshot is available synchronously, before the next read resolves", async () => {
  let calls = 0;
  const second = deferred<SnapshotLoad<number>>();
  const cache = createSnapshotCache<number>((key) => {
    calls += 1;
    if (calls === 1) return Promise.resolve({ ok: true, key, value: 42 });
    return second.promise;
  });

  await cache.load("k");
  assert.equal(cache.peek("k"), 42); // synchronous, no await

  const revalidating = cache.load("k"); // background read still pending
  assert.equal(cache.peek("k"), 42); // the previous value is still served

  second.resolve({ ok: true, key: "k", value: 43 });
  await revalidating;
  assert.equal(cache.peek("k"), 43);
});

test("a different key never serves the previous snapshot", async () => {
  const cache = createSnapshotCache<string>((key) => Promise.resolve({ ok: true, key, value: `v:${key}` }));

  await cache.load("ownerA|net");
  assert.equal(cache.peek("ownerA|net"), "v:ownerA|net");
  assert.equal(cache.cachedKey(), "ownerA|net");

  // A miss for another scope, both synchronously and on load.
  assert.equal(cache.peek("ownerB|net"), null);
  const read = await cache.load("ownerB|net");
  assert.equal(read.value, "v:ownerB|net");
  assert.equal(read.stale, false);
  assert.equal(cache.peek("ownerA|net"), null); // single slot: replaced by the new scope
});

test("a forced refresh bypasses a stale in-flight read and wins", async () => {
  const older = deferred<SnapshotLoad<number>>();
  const newer = deferred<SnapshotLoad<number>>();
  let calls = 0;
  const cache = createSnapshotCache<number>((key) => {
    calls += 1;
    return calls === 1 ? older.promise : newer.promise.then((value) => ({ ...value, key }));
  });

  const stale = cache.load("k");
  const fresh = cache.load("k", { force: true });

  newer.resolve({ ok: true, key: "k", value: 2 });
  await fresh;
  older.resolve({ ok: true, key: "k", value: 1 });
  await stale;

  assert.equal(calls, 2);
  assert.equal(cache.peek("k"), 2); // the pre-mutation read did not overwrite the newer result
});

test("a failed revalidation keeps the last good snapshot", async () => {
  let calls = 0;
  const cache = createSnapshotCache<string>((key) => {
    calls += 1;
    return Promise.resolve(calls === 1 ? { ok: true, key, value: "good" } : { ok: false, error: "rpc down" });
  });

  await cache.load("k");
  const read = await cache.load("k");

  assert.equal(read.value, "good");
  assert.equal(read.stale, true);
  assert.equal(read.error, "rpc down");
  assert.equal(cache.peek("k"), "good"); // the good snapshot is not destroyed
});

test("a first read failure has no last good snapshot to serve", async () => {
  const cache = createSnapshotCache<number>(() => Promise.resolve({ ok: false, error: "boom" }));
  const read = await cache.load("k");
  assert.equal(read.value, null);
  assert.equal(read.stale, false);
  assert.equal(read.error, "boom");
  assert.equal(cache.peek("k"), null);
});

test("clear drops the snapshot and ignores a late in-flight result", async () => {
  const pending = deferred<SnapshotLoad<number>>();
  const cache = createSnapshotCache<number>(() => pending.promise);

  const inFlight = cache.load("k");
  cache.clear();
  pending.resolve({ ok: true, key: "k", value: 1 });
  await inFlight;

  assert.equal(cache.peek("k"), null);
});
