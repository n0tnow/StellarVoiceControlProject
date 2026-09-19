import { describe, expect, it } from "vitest";
import { fundWithFriendbot } from "../friendbot.ts";

function response(ok: boolean, status: number, body: string): Response {
  return {
    ok,
    status,
    text: async () => body,
  } as unknown as Response;
}

describe("fundWithFriendbot", () => {
  it("returns funded on a 200", async () => {
    const res = await fundWithFriendbot("GABC", {
      fetchImpl: (async () => response(true, 200, "{}")) as unknown as typeof fetch,
    });
    expect(res.alreadyFunded).toBe(false);
  });

  it("treats an 'already exists' 400 as funded", async () => {
    const res = await fundWithFriendbot("GABC", {
      fetchImpl: (async () => response(false, 400, '{"detail":"createAccountAlreadyExist"}')) as unknown as typeof fetch,
    });
    expect(res.alreadyFunded).toBe(true);
  });

  it("retries transient failures and then succeeds", async () => {
    let calls = 0;
    const res = await fundWithFriendbot("GABC", {
      fetchImpl: (async () => {
        calls += 1;
        return calls < 3 ? response(false, 503, "busy") : response(true, 200, "{}");
      }) as unknown as typeof fetch,
      sleep: async () => {},
    });
    expect(calls).toBe(3);
    expect(res.alreadyFunded).toBe(false);
  });

  it("refuses a non-testnet friendbot", async () => {
    await expect(fundWithFriendbot("GABC", { friendbotUrl: "https://evil.example.com" })).rejects.toThrow(
      /non-testnet friendbot/,
    );
  });
});
