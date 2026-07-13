import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  geckoFetch,
  geckoBackoffMs,
  GECKO_ATTEMPTS,
  GECKO_MAX_BACKOFF_MS,
  GECKO_DEADLINE_MS,
} from "@/lib/gecko-fetch";

/** Build a Response with a given status (and optional headers). 429/5xx allow a body. */
function res(status: number, headers?: Record<string, string>) {
  return new Response("{}", { status, headers });
}

describe("geckoFetch — bounded retry for GeckoTerminal", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns immediately on success — one call, no retry", async () => {
    fetchMock.mockResolvedValue(res(200));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a genuine 4xx (404 no-such-token) — returns it on the first call", async () => {
    fetchMock.mockResolvedValue(res(404));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 and returns the eventual success", async () => {
    fetchMock.mockResolvedValueOnce(res(429)).mockResolvedValueOnce(res(200));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 5xx and returns the eventual success", async () => {
    fetchMock.mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives up after GECKO_ATTEMPTS on a persistent 429 (returns the last failure, not null)", async () => {
    fetchMock.mockResolvedValue(res(429));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_ATTEMPTS);
  });

  it("retries a thrown network/timeout error, then succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("timeout")).mockResolvedValueOnce(res(200));
    const r = await geckoFetch("https://x/y");
    expect(r?.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns null when a network error persists across all attempts", async () => {
    fetchMock.mockRejectedValue(new Error("network"));
    const r = await geckoFetch("https://x/y");
    expect(r).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(GECKO_ATTEMPTS);
  });
});

describe("geckoBackoffMs", () => {
  // rng = 0.5 → jitter factor 0.8 + 0.4*0.5 = 1.0 (no change), keeping the
  // base/cap assertions below deterministic.
  const mid = () => 0.5;

  it("honors a numeric Retry-After (seconds) but CAPS it at the max backoff", () => {
    const r = res(429, { "retry-after": "100" }); // GT asks for 100s
    expect(geckoBackoffMs(r, 0, Date.now(), mid)).toBe(GECKO_MAX_BACKOFF_MS); // never 100_000ms
  });

  it("ignores a non-numeric (HTTP-date) Retry-After and uses exponential backoff", () => {
    const r = res(429, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" });
    expect(geckoBackoffMs(r, 0, Date.now(), mid)).toBe(300); // exponential, not a misparse
  });

  it("uses exponential 300ms·2^n when there is no Retry-After", () => {
    expect(geckoBackoffMs(null, 0, Date.now(), mid)).toBe(300);
    expect(geckoBackoffMs(null, 1, Date.now(), mid)).toBe(600);
  });

  it("never returns negative and never sleeps past the deadline", () => {
    // startedAt already past the deadline → remaining is negative → clamps to 0.
    expect(geckoBackoffMs(null, 2, Date.now() - GECKO_DEADLINE_MS - 5_000, mid)).toBe(0);
  });

  it("applies ±20% jitter to the base (below the cap) so retries don't align", () => {
    // attempt 1 base = 600ms; jitter spans [480, 720].
    expect(geckoBackoffMs(null, 1, Date.now(), () => 0)).toBe(480); // 600 * 0.8
    expect(geckoBackoffMs(null, 1, Date.now(), () => 1)).toBeCloseTo(720, 5); // 600 * 1.2
    expect(geckoBackoffMs(null, 1, Date.now(), mid)).toBe(600); // 600 * 1.0
  });
});
