/**
 * Clock-step class: the 10 s health cache must not outlive a backwards wall-clock step,
 * and a rejected read must not stay pinned as the answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchMarketHealth, __resetMarketHealthCache } from "@/hooks/useMarketHealth";

const fetchMock = vi.fn();
const ok = (n: number) => ({ ok: true, json: async () => ({ markets: { S: { n } } }) });

beforeEach(() => {
  __resetMarketHealthCache();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-18T12:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchMarketHealth cache vs clock", () => {
  it("serves the cache within 10 s", async () => {
    fetchMock.mockResolvedValue(ok(1));
    await fetchMarketHealth(["S"]);
    vi.setSystemTime(Date.now() + 9_000);
    await fetchMarketHealth(["S"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches after 10 s", async () => {
    fetchMock.mockResolvedValue(ok(1));
    await fetchMarketHealth(["S"]);
    vi.setSystemTime(Date.now() + 10_001);
    await fetchMarketHealth(["S"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a backwards clock step does not pin stale health", async () => {
    fetchMock.mockResolvedValueOnce(ok(1)).mockResolvedValueOnce(ok(2));
    await fetchMarketHealth(["S"]);
    vi.setSystemTime(Date.now() - 60 * 60_000); // NTP step back 1 h
    await fetchMarketHealth(["S"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a rejected read is not cached", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(ok(2));
    await expect(fetchMarketHealth(["S"])).rejects.toThrow("health 500");
    await expect(fetchMarketHealth(["S"])).resolves.toEqual({ S: { n: 2 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
