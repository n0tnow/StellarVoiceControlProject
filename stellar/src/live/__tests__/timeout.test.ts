import { describe, expect, it } from "vitest";
import {
  Deadline,
  DEFAULT_OPERATION_TIMEOUT_MS,
  isTimeoutError,
  NETWORK_CALL_TIMEOUT_MS,
  NetworkTimeoutError,
  OperationTimeoutError,
  withNetworkTimeout,
} from "../timeout.ts";

describe("withNetworkTimeout", () => {
  it("resolves a fast call and clears the timer", async () => {
    await expect(withNetworkTimeout(Promise.resolve(7), "fast", 50)).resolves.toBe(7);
  });

  it("rejects a hanging call with a typed NetworkTimeout error", async () => {
    const hanging = new Promise<never>(() => {});
    await expect(withNetworkTimeout(hanging, "hang", 10)).rejects.toBeInstanceOf(NetworkTimeoutError);
    try {
      await withNetworkTimeout(new Promise<never>(() => {}), "hang", 10);
    } catch (e) {
      expect(isTimeoutError(e)).toBe(true);
      expect((e as NetworkTimeoutError).code).toBe("network_timeout");
      expect((e as NetworkTimeoutError).name).toBe("NetworkTimeout");
      expect((e as NetworkTimeoutError).message).toContain("hang");
    }
  });

  it("exposes the documented defaults", () => {
    expect(NETWORK_CALL_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_OPERATION_TIMEOUT_MS).toBe(120_000);
  });
});

describe("Deadline", () => {
  it("counts down against the injected clock and throws OperationTimeout", () => {
    let now = 0;
    const deadline = new Deadline({ timeoutMs: 100, label: "cmd", now: () => now });
    expect(deadline.remainingMs).toBe(100);
    now = 60;
    expect(deadline.expired).toBe(false);
    deadline.check();
    now = 100;
    expect(deadline.expired).toBe(true);
    expect(() => deadline.check()).toThrowError(OperationTimeoutError);
  });

  it("clamps a wait to the remaining budget", () => {
    let now = 0;
    const deadline = new Deadline({ timeoutMs: 100, now: () => now });
    expect(deadline.clamp(60_000)).toBe(100);
    now = 40;
    expect(deadline.clamp(10)).toBe(10);
  });
});
