import { describe, expect, it } from "vitest";
import { retryRateLimited } from "@/lib/server-rpc";
import { BOT_RPC_429_RETRY_MS } from "@/lib/bot-api/rpc";

const seq = (codes: number[]) => {
  let i = 0;
  const calls: number[] = [];
  const f = (async () => {
    const c = codes[Math.min(i, codes.length - 1)];
    calls.push(c);
    i++;
    return new Response("{}", { status: c });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("bot RPC 429 retry", () => {
  it("rides out a brief 429 with the short delays", async () => {
    const { f, calls } = seq([429, 429, 200]);
    const r = await retryRateLimited(f, [1, 1])("http://x", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(calls).toEqual([429, 429, 200]);
  });
  it("gives the 429 back after the last delay (no unbounded back-off)", async () => {
    const { f, calls } = seq([429]);
    const r = await retryRateLimited(f, [1, 1])("http://x", { method: "POST", body: "{}" });
    expect(r.status).toBe(429);
    expect(calls).toHaveLength(3);
  });
  it("does not retry other statuses", async () => {
    const { f, calls } = seq([500, 200]);
    expect((await retryRateLimited(f, [1, 1])("http://x", {})).status).toBe(500);
    expect(calls).toHaveLength(1);
  });
  it("bot connections wait at most about 1 s in total on a 429", () => {
    expect(BOT_RPC_429_RETRY_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1500);
    expect(BOT_RPC_429_RETRY_MS.length).toBeGreaterThan(0);
  });
});
