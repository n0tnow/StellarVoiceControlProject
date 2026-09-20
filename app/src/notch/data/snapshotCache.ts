/**
 * A tiny, dependency-free stale-while-revalidate cache with in-flight dedupe.
 *
 * Both notch page hooks (Tasks, Rules) keep one module-level instance. The
 * loader is injected and reports the **scope key** it actually read, so a
 * snapshot can never be served to a different owner/network: [`peek`] only
 * returns a snapshot whose stored key matches the requested key exactly.
 *
 * Semantics:
 * - `load(key)` dedupes: concurrent callers for the same key share one read.
 * - `load(key, { force: true })` supersedes an in-flight read. Only the newest
 *   read may write, so a mutation/refresh is never overwritten by a read that
 *   started before it.
 * - A failed read never replaces the last good snapshot for the same key; the
 *   read is reported as `stale` so the caller can keep showing the data and add
 *   a non-destructive hint instead of collapsing to the error state.
 *
 * There is no timer, no DOM and no Tauri here, so it runs under `node:test`
 * with a fake loader.
 */

/** A loader's answer: a fresh snapshot (with the key it was read for) or a failure. */
export type SnapshotLoad<T> =
  | { ok: true; key: string; value: T }
  | { ok: false; error: string };

/** One `load` outcome: what to render, and whether it is stale. */
export interface SnapshotRead<T> {
  /** The fresh snapshot, or the last good one when the latest read failed. */
  value: T | null;
  /** True when `value` is the last good snapshot and the latest read failed. */
  stale: boolean;
  /** The latest read's failure message, or `null` on success. */
  error: string | null;
}

export interface SnapshotCache<T> {
  /** The cached snapshot for `key`, synchronously, or `null` on a miss/mismatch. */
  peek(key: string | null): T | null;
  /** The key of the currently cached snapshot, or `null`. */
  cachedKey(): string | null;
  /** Loads `key`, deduping concurrent callers; `force` supersedes an in-flight read. */
  load(key: string, options?: { force?: boolean }): Promise<SnapshotRead<T>>;
  /** Drops the cached snapshot and any in-flight read; a late result is ignored. */
  clear(): void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builds a single-slot cache over `loader`. `loader` is called at most once per
 * in-flight key and must never throw for a handled failure — it returns
 * `{ ok: false }` instead (a thrown error is normalised the same way).
 */
export function createSnapshotCache<T>(
  loader: (key: string) => Promise<SnapshotLoad<T>>,
): SnapshotCache<T> {
  let entry: { key: string; value: T } | null = null;
  let inFlight: { key: string; generation: number; promise: Promise<SnapshotRead<T>> } | null = null;
  let generation = 0;

  const settle = (key: string, myGeneration: number, result: SnapshotLoad<T>): SnapshotRead<T> => {
    if (result.ok) {
      if (myGeneration === generation) entry = { key: result.key, value: result.value };
      return { value: result.value, stale: false, error: null };
    }
    // A superseded read may not touch the cache; the newest read wins.
    if (myGeneration !== generation) return { value: null, stale: false, error: result.error };
    const lastGood = entry !== null && entry.key === key ? entry.value : null;
    return { value: lastGood, stale: lastGood !== null, error: result.error };
  };

  const run = (key: string, myGeneration: number): Promise<SnapshotRead<T>> => {
    let loaded: Promise<SnapshotLoad<T>>;
    try {
      loaded = loader(key);
    } catch (error) {
      loaded = Promise.reject(error);
    }
    return loaded.then(
      (result) => settle(key, myGeneration, result),
      (failure) => settle(key, myGeneration, { ok: false, error: messageOf(failure) }),
    );
  };

  return {
    peek(key) {
      if (key === null || entry === null || entry.key !== key) return null;
      return entry.value;
    },
    cachedKey() {
      return entry?.key ?? null;
    },
    load(key, options = {}) {
      if (!options.force && inFlight !== null && inFlight.key === key) return inFlight.promise;
      const myGeneration = ++generation;
      const promise = run(key, myGeneration).finally(() => {
        if (inFlight !== null && inFlight.generation === myGeneration) inFlight = null;
      });
      inFlight = { key, generation: myGeneration, promise };
      return promise;
    },
    clear() {
      generation += 1;
      inFlight = null;
      entry = null;
    },
  };
}
