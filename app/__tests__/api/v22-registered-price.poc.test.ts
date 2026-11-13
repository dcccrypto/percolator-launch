// @vitest-environment node
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  registered: vi.fn(),
  jupiter: vi.fn(),
  classify: vi.fn(),
}));

vi.mock("@/lib/registered-pool", () => ({
  registeredPoolForMint: h.registered,
}));

vi.mock("@/lib/jupiter-price", () => ({
  fetchJupiterUsdPrice: h.jupiter,
}));

vi.mock("@/lib/bounded-ttl-cache", () => ({
  BoundedTtlCache: class {
    get() { return undefined; }
    set() {}
  },
}));

vi.mock("@/lib/dex-pool-owner", () => ({
  MAX_CLASSIFY_POOLS: 20,
  classifyPoolsByOwner: h.classify,
  isOfferable: (s: string) => s === "meteora-dlmm",
}));

import { GET } from "@/app/api/oracle/resolve/[ca]/route";

const MINT = "9aqmJjCnnMQv42TXLk921ceUkN35nea2QP969n1caqjj";
const REGISTERED = "21bzHy2kRoVKgtYZ8hFoetki2134MG2jyWGC49UV5pyi";
const OTHER = "7Nj7mBE7oGPRWCEoUzfbNVPgq12w3V5egHkfd4nvGkr6";
const SLAB = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";

let pairs: unknown[] = [];

function pair(address: string, price: number, liquidity: number) {
  return {
    chainId: "solana",
    dexId: "meteora",
    pairAddress: address,
    priceUsd: String(price),
    liquidity: { usd: liquidity },
    baseToken: { symbol: "TEST", address: MINT },
  };
}

async function resolve() {
  const r = await GET(
    new NextRequest(`http://localhost/api/oracle/resolve/${MINT}`),
    { params: Promise.resolve({ ca: MINT }) },
  );
  const j = await r.json() as {
    price?: number;
    dexPoolAddress?: string | null;
    source?: string;
  };

  console.log("PRICE_AUDIT", JSON.stringify({
    status: r.status,
    pool: j.dexPoolAddress,
    price: j.price,
    source: j.source,
  }));

  return { r, j };
}

beforeEach(() => {
  h.registered.mockReset().mockResolvedValue({
    slabAddress: SLAB,
    pool: REGISTERED,
    dexType: "meteora-dlmm",
  });

  h.jupiter.mockReset().mockResolvedValue(7.5);
  h.classify.mockReset().mockImplementation(async (addresses: string[]) =>
    Object.fromEntries(addresses.map(a => [a, "meteora-dlmm"]))
  );

  pairs = [];

  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ pairs }), { status: 200 })
  ));
});

afterEach(() => vi.unstubAllGlobals());

describe("V22 registered price source invariant", () => {
  it("CONTROL: registered pool price wins over more liquid pair", async () => {
    pairs = [
      pair(OTHER, 9, 900000),
      pair(REGISTERED, 4.5, 100000),
    ];

    const { r, j } = await resolve();
    expect(r.status).toBe(200);
    expect(j.dexPoolAddress).toBe(REGISTERED);
    expect(j.price).toBe(4.5);
  });

  it("POLICY: missing registered pool must not borrow another pair price", async () => {
    pairs = [pair(OTHER, 9, 900000)];

    const { r, j } = await resolve();

    // Red when API labels a different venue's price as registered.
    expect(
      r.status === 200 &&
      j.dexPoolAddress === REGISTERED &&
      j.price === 9
    ).toBe(false);
  });

  it("POLICY: Jupiter fallback must not impersonate registered pool price", async () => {
    pairs = [];

    const { r, j } = await resolve();

    expect(
      r.status === 200 &&
      j.dexPoolAddress === REGISTERED &&
      j.price === 7.5
    ).toBe(false);
  });

  it("NEGATIVE CONTROL: unregistered token may use best available pool", async () => {
    h.registered.mockResolvedValue(null);
    pairs = [pair(OTHER, 9, 900000)];

    const { r, j } = await resolve();
    expect(r.status).toBe(200);
    expect(j.dexPoolAddress).toBe(OTHER);
    expect(j.price).toBe(9);
  });

  it("NEGATIVE CONTROL: no price source returns 404", async () => {
    h.registered.mockResolvedValue(null);
    h.jupiter.mockResolvedValue(null);
    pairs = [];

    const { r } = await resolve();
    expect(r.status).toBe(404);
  });
});

describe("V22 registered pool lookup failure", () => {
  it("REGRESSION: registry failure must not return a guessed pool price", async () => {
    pairs = [pair(OTHER, 9, 900000)];
    h.registered.mockRejectedValue(new Error("simulated registry timeout"));

    const { r } = await resolve();

    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("V22 registered source unavailable", () => {
  it("REGRESSION: registered market without any price returns retryable 503", async () => {
    h.jupiter.mockResolvedValue(null);
    pairs = [];

    const { r } = await resolve();

    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("retry-after")).toBe("5");
  });
});

describe("V22 registered pool type verification", () => {
  it("POLICY: unsupported registered pool must not be offered as hyperp", async () => {
    h.registered.mockResolvedValue({
      slabAddress: SLAB,
      pool: REGISTERED,
      dexType: null,
    });

    h.classify.mockResolvedValue({
      [REGISTERED]: "unsupported",
    });

    pairs = [pair(REGISTERED, 4.5, 100000)];

    const { r, j } = await resolve();

    const body = j as typeof j & {
      oracleMode?: string;
      dexType?: string | null;
    };

    console.log("REGISTERED_TYPE_DIAGNOSTIC", JSON.stringify({
      status: r.status,
      oracleMode: body.oracleMode,
      dexType: body.dexType,
    }));

    expect(
      r.status === 200 &&
      body.oracleMode === "hyperp" &&
      !body.dexType
    ).toBe(false);
  });
});

describe("V22 registered pool type fail-closed", () => {
  it("REGRESSION: unsupported registered pool returns non-cacheable 503", async () => {
    h.registered.mockResolvedValue({
      slabAddress: SLAB,
      pool: REGISTERED,
      dexType: null,
    });

    h.classify.mockResolvedValue({
      [REGISTERED]: "unsupported",
    });

    pairs = [pair(REGISTERED, 4.5, 100000)];

    const { r, j } = await resolve();

    expect(r.status).toBe(503);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(j.dexPoolAddress).toBeUndefined();

    console.log("UNSUPPORTED_REGISTERED_POOL_REJECTED=PASS");
  });
});

describe("V22 registered pool verification recovery", () => {
  it("CONTROL: missing Blob dexType recovers through valid owner classification", async () => {
    h.registered.mockResolvedValue({
      slabAddress: SLAB,
      pool: REGISTERED,
      dexType: null,
    });

    h.classify.mockResolvedValue({
      [REGISTERED]: "meteora-dlmm",
    });

    pairs = [pair(REGISTERED, 4.5, 100000)];

    const { r, j } = await resolve();

    const body = j as typeof j & {
      oracleMode?: string;
      dexType?: string | null;
    };

    expect(r.status).toBe(200);
    expect(body.dexPoolAddress).toBe(REGISTERED);
    expect(body.dexType).toBe("meteora-dlmm");
    expect(body.oracleMode).toBe("hyperp");
    expect(body.price).toBe(4.5);

    console.log("VALID_REGISTERED_POOL_RECOVERY=PASS");
  });
});
