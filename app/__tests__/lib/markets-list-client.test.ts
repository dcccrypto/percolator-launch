// @vitest-environment node
/** Review E2: one canonical markets-list URL, one request for every caller that asks together. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MARKETS_LIST_URL,
  MarketsListHttpError,
  allMarketRows,
  fetchMarketsList,
  listedMarketRows,
  resetMarketsListClient,
} from "@/lib/markets-list-client";

const BODY = { markets: [{ slab_address: "A", is_zombie: false }, { slab_address: "Z", is_zombie: true }, { slab_address: "B" }, null, 3] };

describe("markets-list-client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetMarketsListClient();
    fetchMock = vi.fn(async () => new Response(JSON.stringify(BODY), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("N concurrent callers make ONE request to the canonical URL and share the body", async () => {
    const [a, b, c] = await Promise.all([fetchMarketsList(), fetchMarketsList(), fetchMarketsList()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(MARKETS_LIST_URL);
    expect(MARKETS_LIST_URL).toBe("/api/markets?include_zombie=true&limit=500");
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it("a settled request is not reused: the next poll asks again", async () => {
    await fetchMarketsList();
    await fetchMarketsList();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never joins a pending request older than the share window (a hung fetch cannot stall callers)", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    void fetchMarketsList();
    vi.advanceTimersByTime(1_999);
    void fetchMarketsList();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await fetchMarketsList();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fresh skips the shared request and the CDN copy", async () => {
    const p = fetchMarketsList();
    await fetchMarketsList({ fresh: true });
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url.startsWith(`${MARKETS_LIST_URL}&fresh=`)).toBe(true);
    expect(init.cache).toBe("no-store");
  });

  it("a non-2xx is a typed error carrying the status", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 503 }));
    await expect(fetchMarketsList()).rejects.toMatchObject({ status: 503 });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 500 }));
    await expect(fetchMarketsList()).rejects.toBeInstanceOf(MarketsListHttpError);
  });

  it("listedMarketRows is the default list: zombies dropped, order kept; allMarketRows keeps them", () => {
    expect(listedMarketRows(BODY)!.map((r) => r.slab_address)).toEqual(["A", "B"]);
    expect(allMarketRows(BODY)!.map((r) => r.slab_address)).toEqual(["A", "Z", "B"]);
    expect(listedMarketRows({})).toBeNull();
    expect(allMarketRows({ markets: "x" })).toBeNull();
  });
});
