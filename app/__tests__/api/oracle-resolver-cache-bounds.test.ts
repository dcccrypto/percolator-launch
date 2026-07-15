import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";

const cacheMock = vi.hoisted(() => ({
  options: null as {
    maxEntries: number;
    ttlMs: number;
  } | null,
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock("@/lib/bounded-ttl-cache", () => ({
  BoundedTtlCache: class MockBoundedTtlCache {
    constructor(options: {
      maxEntries: number;
      ttlMs: number;
    }) {
      cacheMock.options = options;
    }

    get(key: string) {
      return cacheMock.get(key);
    }

    set(key: string, value: unknown) {
      cacheMock.set(key, value);
    }
  },
}));

import { GET } from "@/app/api/oracle/resolve/[ca]/route";

const VALID_MINT =
  "So11111111111111111111111111111111111111112";

function uniqueValidMint(index: number): string {
  const bytes = new Uint8Array(32);

  // Keep every generated key valid and deterministically unique.
  bytes[0] = 1;
  bytes[30] = (index >> 8) & 0xff;
  bytes[31] = index & 0xff;

  return new PublicKey(bytes).toBase58();
}

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost:3000/api/oracle/resolve/${VALID_MINT}`,
  );
}

function makeContext(ca = VALID_MINT) {
  return {
    params: Promise.resolve({ ca }),
  };
}

function jupiterResponse() {
  return new Response(
    JSON.stringify({
      data: {
        [VALID_MINT]: {
          id: VALID_MINT,
          type: "derivedPrice",
          price: "150.25",
        },
      },
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

function dexScreenerEmptyResponse() {
  return new Response(
    JSON.stringify({
      pairs: [],
    }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}

describe("GET /api/oracle/resolve/[ca] resource bounds", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    cacheMock.get.mockReset();
    cacheMock.set.mockReset();
    fetchMock.mockReset();

    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("configures a bounded five-minute resolver cache", () => {
    expect(cacheMock.options).toEqual({
      maxEntries: 256,
      ttlMs: 5 * 60 * 1000,
    });
  });

  it("returns a fresh bounded-cache hit without upstream requests", async () => {
    const cachedResult = {
      feedId: null,
      symbol: "SOL",
      price: 150.25,
      source: "jupiter",
      dexPoolAddress: null,
      dexType: null,
      oracleMode: "admin",
    };

    cacheMock.get.mockReturnValueOnce(cachedResult);

    const response = await GET(
      makeRequest(),
      makeContext(),
    );

    expect(response.status).toBe(200);

    await expect(response.json()).resolves.toEqual({
      ...cachedResult,
      cached: true,
    });

    expect(cacheMock.get).toHaveBeenCalledWith(VALID_MINT);
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent upstream lookups for the same mint", async () => {
    cacheMock.get.mockReturnValue(undefined);

    let resolveJupiter:
      | ((response: Response) => void)
      | undefined;
    let resolveDexScreener:
      | ((response: Response) => void)
      | undefined;

    const jupiterPromise = new Promise<Response>((resolve) => {
      resolveJupiter = resolve;
    });

    const dexScreenerPromise = new Promise<Response>((resolve) => {
      resolveDexScreener = resolve;
    });

    fetchMock.mockImplementation((input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      if (url.includes("jup.ag")) {
        return jupiterPromise;
      }

      if (url.includes("dexscreener.com")) {
        return dexScreenerPromise;
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const firstRequest = GET(makeRequest(), makeContext());
    const secondRequest = GET(makeRequest(), makeContext());

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    resolveJupiter?.(jupiterResponse());
    resolveDexScreener?.(dexScreenerEmptyResponse());

    const [firstResponse, secondResponse] = await Promise.all([
      firstRequest,
      secondRequest,
    ]);

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);

    const [firstBody, secondBody] = await Promise.all([
      firstResponse.json(),
      secondResponse.json(),
    ]);

    expect(firstBody).toEqual(secondBody);

    /*
     * `cached` is HTTP response metadata and is intentionally not
     * stored in the bounded domain cache.
     */
    const {
      cached: firstCached,
      ...firstCacheValue
    } = firstBody;

    const {
      cached: secondCached,
      ...secondCacheValue
    } = secondBody;

    expect(firstCached).toBe(false);
    expect(secondCached).toBe(false);
    expect(firstCacheValue).toEqual(secondCacheValue);

    /*
     * One Jupiter request and one DexScreener request total.
     * Without in-flight deduplication this would be four fetch calls.
     */
    expect(fetchMock).toHaveBeenCalledTimes(2);

    expect(cacheMock.set).toHaveBeenCalledTimes(2);
    expect(cacheMock.set).toHaveBeenNthCalledWith(
      1,
      VALID_MINT,
      firstCacheValue,
    );
    expect(cacheMock.set).toHaveBeenNthCalledWith(
      2,
      VALID_MINT,
      secondCacheValue,
    );
  });

  it("removes completed operations from the in-flight registry", async () => {
    cacheMock.get.mockReturnValue(undefined);

    fetchMock
      .mockResolvedValueOnce(jupiterResponse())
      .mockResolvedValueOnce(dexScreenerEmptyResponse())
      .mockResolvedValueOnce(jupiterResponse())
      .mockResolvedValueOnce(dexScreenerEmptyResponse());

    const firstResponse = await GET(
      makeRequest(),
      makeContext(),
    );

    expect(firstResponse.status).toBe(200);

    const secondResponse = await GET(
      makeRequest(),
      makeContext(),
    );

    expect(secondResponse.status).toBe(200);

    /*
     * Because the first operation completed and was removed, the second
     * sequential cache miss creates a new pair of upstream requests.
     */
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed mint input before cache or upstream access", async () => {
    const response = await GET(
      makeRequest(),
      makeContext("not-a-valid-solana-mint"),
    );

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      error: "Invalid Solana mint address",
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("rejects a new unique lookup when in-flight capacity is saturated", async () => {
    cacheMock.get.mockReturnValue(undefined);

    /*
     * Keep every upstream operation unresolved so all 64 unique resolver
     * entries remain registered as in-flight.
     */
    const unresolvedResponse = new Promise<Response>(() => {
      // Intentionally unresolved.
    });

    fetchMock.mockReturnValue(unresolvedResponse);

    const pendingRequests = Array.from(
      { length: 64 },
      (_, index) =>
        GET(
          makeRequest(),
          makeContext(uniqueValidMint(index)),
        ),
    );

    /*
     * Every unique resolver operation starts one Jupiter request and one
     * DexScreener request: 64 operations x 2 fetches = 128 fetch calls.
     */
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(128);
    });

    const overflowMint = uniqueValidMint(64);

    const response = await GET(
      makeRequest(),
      makeContext(overflowMint),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");

    await expect(response.json()).resolves.toEqual({
      error: "Oracle resolver is busy. Retry shortly.",
    });

    /*
     * The rejected 65th unique operation must not initiate additional
     * upstream traffic or write anything into the response cache.
     */
    expect(fetchMock).toHaveBeenCalledTimes(128);
    expect(cacheMock.set).not.toHaveBeenCalled();

    /*
     * Retain local references for the duration of the test. These promises
     * intentionally remain pending to model saturated in-flight capacity.
     */
    expect(pendingRequests).toHaveLength(64);
  });

});
