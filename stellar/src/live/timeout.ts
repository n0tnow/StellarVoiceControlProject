/**
 * Uniform timeouts for every live-network operation.
 *
 * Two guarantees (review non-blocking #1):
 *   1. **Per-call hard bound** — no single network call (`sendTransaction`,
 *      `getTransaction`, `horizon.loadAccount`, …) may run longer than
 *      `NETWORK_CALL_TIMEOUT_MS` (30 s). `withNetworkTimeout` races the call
 *      against a timer and rejects with a typed `NetworkTimeoutError`.
 *   2. **Whole-operation deadline** — a command gets one `Deadline` (default
 *      `DEFAULT_OPERATION_TIMEOUT_MS` = 120 s); once it elapses, `Deadline.check`
 *      throws a typed `OperationTimeoutError` so a hang cannot pin a run open.
 *
 * Both are *injectable* (`now`, `ms`) so offline tests can drive them with a
 * hanging fake and no real wall-clock wait.
 */

/** Hard per-call bound for any single network request. */
export const NETWORK_CALL_TIMEOUT_MS = 30_000;
/** Whole-operation bound (build -> sign -> submit -> verify) by default. */
export const DEFAULT_OPERATION_TIMEOUT_MS = 120_000;

export type TimeoutErrorCode = "network_timeout" | "operation_timeout";

/** Base typed timeout error; never thrown directly (use a subclass). */
export class TimeoutError extends Error {
  readonly code: TimeoutErrorCode;
  /** Label of the call / operation that timed out (no secrets). */
  readonly label: string;

  constructor(code: TimeoutErrorCode, label: string, message: string) {
    super(message);
    this.name = "TimeoutError";
    this.code = code;
    this.label = label;
  }
}

/** A single network call exceeded `NETWORK_CALL_TIMEOUT_MS`. */
export class NetworkTimeoutError extends TimeoutError {
  constructor(label: string, ms: number) {
    super("network_timeout", label, `${label} did not complete within ${ms} ms`);
    this.name = "NetworkTimeout";
  }
}

/** The whole operation exceeded its deadline. */
export class OperationTimeoutError extends TimeoutError {
  constructor(label: string, ms: number) {
    super("operation_timeout", label, `${label} exceeded the whole-operation deadline of ${ms} ms`);
    this.name = "OperationTimeout";
  }
}

export function isTimeoutError(value: unknown): value is TimeoutError {
  return value instanceof TimeoutError;
}

/**
 * Race a promise against a hard timeout. The timer is always cleared, so a
 * fast call leaves no open handle. The losing promise keeps running but its
 * rejection is swallowed (we already rejected the race).
 */
export async function withNetworkTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms: number = NETWORK_CALL_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NetworkTimeoutError(label, ms)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    // Do not let the abandoned promise surface an unhandled rejection.
    promise.catch(() => {});
  }
}

export interface DeadlineOptions {
  /** Total budget in milliseconds. Defaults to `DEFAULT_OPERATION_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Human label for errors, e.g. `e2e:tool pay`. */
  label?: string;
  /** Injected clock (tests). */
  now?: () => number;
}

/**
 * A monotonic budget for one command. `check()` throws once the budget is
 * spent; `remainingMs` lets callers shrink downstream waits to fit.
 */
export class Deadline {
  readonly label: string;
  private readonly totalMs: number;
  private readonly startMs: number;
  private readonly now: () => number;

  constructor(options: DeadlineOptions = {}) {
    this.totalMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.label = options.label ?? "operation";
    this.now = options.now ?? Date.now;
    this.startMs = this.now();
  }

  /** Milliseconds left in the budget (never negative). */
  get remainingMs(): number {
    return Math.max(0, this.totalMs - (this.now() - this.startMs));
  }

  get expired(): boolean {
    return this.remainingMs === 0;
  }

  /** Throw `OperationTimeoutError` when the budget is spent. */
  check(label: string = this.label): void {
    if (this.expired) throw new OperationTimeoutError(label, this.totalMs);
  }

  /** A `waitMs` that never outlives the deadline (keeps at least 1 ms). */
  clamp(waitMs: number): number {
    return Math.max(1, Math.min(waitMs, this.remainingMs));
  }
}
