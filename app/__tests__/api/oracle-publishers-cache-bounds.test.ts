import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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

import { GET } from "@/app/api/oracle/publishers/route";

const VALID_AUTHORITY =
  "4RVFNKH15CxFSYdoNBJJGggjszuTKmpFs4PGwuXSNaK7";

const SYSTEM_PROGRAM_ID =
  "11111111111111111111111111111111";

function makeRequest(
  params: Record<string, string>,
): NextRequest {
  const url = new URL(
    "http://localhost:3000/api/oracle/publishers",
  );

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  return new NextRequest(url);
}

describe("GET /api/oracle/publishers cache resource bounds", () => {
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

  it("configures a bounded five-minute publisher cache", () => {
    expect(cacheMock.options).toEqual({
      maxEntries: 128,
      ttlMs: 5 * 60 * 1000,
    });
  });

  it("returns a valid admin response without using the cache", async () => {
    const response = await GET(
      makeRequest({
        mode: "admin",
        authority: VALID_AUTHORITY,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    await expect(response.json()).resolves.toMatchObject({
      mode: "admin",
      publisherCount: 1,
      publisherTotal: 1,
      publishers: [
        {
          key: VALID_AUTHORITY,
          status: "active",
        },
      ],
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the empty admin state without cache allocation", async () => {
    const response = await GET(
      makeRequest({
        mode: "admin",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    await expect(response.json()).resolves.toEqual({
      mode: "admin",
      publisherCount: 0,
      publisherTotal: 0,
      publishers: [],
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the system-program placeholder empty state", async () => {
    const response = await GET(
      makeRequest({
        mode: "admin",
        authority: SYSTEM_PROGRAM_ID,
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    await expect(response.json()).resolves.toEqual({
      mode: "admin",
      publisherCount: 0,
      publisherTotal: 0,
      publishers: [],
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an oversized attacker-controlled authority", async () => {
    const response = await GET(
      makeRequest({
        mode: "admin",
        authority: "A".repeat(2_048),
      }),
    );

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      error: "Invalid admin authority",
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed admin authority", async () => {
    const response = await GET(
      makeRequest({
        mode: "admin",
        authority: "not-a-valid-solana-public-key",
      }),
    );

    expect(response.status).toBe(400);

    await expect(response.json()).resolves.toEqual({
      error: "Invalid admin authority",
    });

    expect(cacheMock.get).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serves an externally resolved mode from the bounded cache", async () => {
    const cachedResult = {
      mode: "hyperp",
      publisherCount: null,
      publisherTotal: null,
      publishers: [],
    };

    cacheMock.get.mockReturnValueOnce(cachedResult);

    const response = await GET(
      makeRequest({
        mode: "hyperp",
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=300",
    );

    await expect(response.json()).resolves.toEqual(cachedResult);

    expect(cacheMock.get).toHaveBeenCalledWith("hyperp:");
    expect(cacheMock.set).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
