// @vitest-environment node
/**
 * Registered-markets store over immutable versioned snapshots (2026-10-01).
 *
 * Live incident: POST /api/playground/keeper-register returned 502 repeatedly for SI (8WC8…), and
 * GET /api/playground/registered-markets kept serving a list without it. The single blob was
 * overwritten in place and re-read through the Blob CDN, which IGNORES the `?ts=` cache-buster
 * (measured: HIT, age past max-age). A stale copy carried a stale ETag, every `ifMatch` CAS
 * failed, and the route gave up; the GET feed served the stale list to the keeper.
 *
 * The fake below models that CDN faithfully: a fetch of a pathname returns the FIRST content the
 * edge cached for it, whatever the query string. Snapshots are immutable, so it can't go stale
 * for them; the legacy single blob can, and the tests prove it no longer matters.
 */
import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

interface Stored {
  body: string;
}
const origin = new Map<string, Stored>();
/** The CDN edge: first content seen per pathname, query ignored. */
const edge = new Map<string, string>();
let failNextFetch: "status" | "throw" | "garbage" | null = null;
let putHook: ((pathname: string) => void) | null = null;

const URL_BASE = "https://store.public.blob.vercel-storage.com/";

vi.mock("@vercel/blob", () => ({
  list: vi.fn(async ({ prefix }: { prefix: string }) => ({
    blobs: [...origin.keys()].filter((p) => p.startsWith(prefix)).map((pathname) => ({ pathname, url: URL_BASE + pathname })),
    hasMore: false,
  })),
  put: vi.fn(async (pathname: string, body: string, opts: { allowOverwrite?: boolean }) => {
    putHook?.(pathname);
    if (opts.allowOverwrite === false && origin.has(pathname)) throw new Error("Vercel Blob: This blob already exists");
    origin.set(pathname, { body });
    return { url: URL_BASE + pathname, pathname };
  }),
  del: vi.fn(async (urls: string[]) => {
    for (const u of urls) origin.delete(u.slice(URL_BASE.length));
  }),
}));

globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const pathname = href.slice(URL_BASE.length).split("?")[0];
  if (failNextFetch === "throw") {
    failNextFetch = null;
    throw new TypeError("fetch failed");
  }
  if (failNextFetch === "status") {
    failNextFetch = null;
    return new Response("err", { status: 503 });
  }
  if (failNextFetch === "garbage") {
    failNextFetch = null;
    return new Response(JSON.stringify({ not: "an array" }), { status: 200 });
  }
  const cached = edge.get(pathname);
  if (cached !== undefined) return new Response(cached, { status: 200 });
  const o = origin.get(pathname);
  if (!o) return new Response("not found", { status: 404 });
  edge.set(pathname, o.body);
  return new Response(o.body, { status: 200 });
}) as typeof fetch;

import {
  MAX_REGISTERED_MARKETS,
  REGISTERED_MARKETS_BLOB_PATHNAME,
  REGISTERED_MARKETS_KEEP_VERSIONS,
  parseRegisteredMarketsVersion,
  readRegisteredMarkets,
  readRegisteredMarketsChecked,
  registeredMarketsVersionPath,
  upsertRegisteredMarket,
  type RegisteredMarket,
} from "@/lib/playground-registered-markets";
import { list } from "@vercel/blob";

const mk = (slab: string, registeredAt = 1): RegisteredMarket => ({
  slabAddress: slab,
  marketAddress: slab,
  poolAddress: `pool-${slab}`,
  dexType: "pumpswap",
  symbol: slab,
  label: `${slab}/USDC`,
  mainnetCA: null,
  collateral: "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC",
  registeredAt,
});

const versions = () => [...origin.keys()].map(parseRegisteredMarketsVersion).filter((v): v is number => v !== null).sort((a, b) => a - b);

beforeEach(() => {
  origin.clear();
  edge.clear();
  failNextFetch = null;
  putHook = null;
});

describe("versioned registry", () => {
  it("path round-trip", () => {
    expect(parseRegisteredMarketsVersion(registeredMarketsVersionPath(42))).toBe(42);
    expect(parseRegisteredMarketsVersion(REGISTERED_MARKETS_BLOB_PATHNAME)).toBeNull();
  });

  it("REGRESSION (8WC8): a stale CDN copy of the legacy blob cannot hide a new registration or fail the write", async () => {
    // The legacy blob as the edge cached it BEFORE SI registered, while the origin already moved on.
    origin.set(REGISTERED_MARKETS_BLOB_PATHNAME, { body: JSON.stringify([mk("9EPm")]) });
    await readRegisteredMarkets(); // edge caches [9EPm]
    origin.set(REGISTERED_MARKETS_BLOB_PATHNAME, { body: JSON.stringify([mk("9EPm"), mk("OTHER")]) });

    await upsertRegisteredMarket(mk("8WC8", 2)); // seeds v1 from the (stale) legacy read, adds 8WC8
    const read1 = (await readRegisteredMarkets()).map((m) => m.slabAddress);
    expect(read1).toContain("8WC8");

    // Every later write and read sees the newest snapshot: no stale ETag, no 502, no lost entry.
    await upsertRegisteredMarket(mk("NEXT", 3));
    const read2 = (await readRegisteredMarkets()).map((m) => m.slabAddress).sort();
    expect(read2).toEqual(["8WC8", "9EPm", "NEXT"]);
    expect(versions()).toEqual([1, 2]);
  });

  it("concurrent upserts that read the same snapshot both survive (create-only seq is the CAS)", async () => {
    await upsertRegisteredMarket(mk("A"));
    // B's create of v2 loses to C, which slips in right before it.
    let raced = false;
    putHook = (p) => {
      if (!raced && p === registeredMarketsVersionPath(2)) {
        raced = true;
        origin.set(p, { body: JSON.stringify([mk("A"), mk("C")]) });
      }
    };
    await upsertRegisteredMarket(mk("B"));
    expect((await readRegisteredMarkets()).map((m) => m.slabAddress).sort()).toEqual(["A", "B", "C"]);
    expect(versions()).toEqual([1, 2, 3]);
  });

  it("REVIEW #2727: a writer stalled across >= KEEP upserts never loses its entry (pruned seq recycled)", async () => {
    await upsertRegisteredMarket(mk("SEED", 0)); // v1
    // A reads v1 and stalls inside its create of v2 while others write v2..v8 and prune.
    const { put } = await import("@vercel/blob");
    const realPut = vi.mocked(put).getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    vi.mocked(put).mockImplementation(async (pathname: string, body: unknown, opts: unknown) => {
      if (first && pathname === registeredMarketsVersionPath(2) && String(body).includes('"A"')) {
        first = false;
        await gate;
      }
      return realPut(pathname, body as string, opts as { allowOverwrite?: boolean });
    });
    const a = upsertRegisteredMarket(mk("A", 1));
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < REGISTERED_MARKETS_KEEP_VERSIONS + 2; i += 1) await upsertRegisteredMarket(mk(`W${i}`, 10 + i));
    expect(origin.has(registeredMarketsVersionPath(2))).toBe(false); // pruned
    release();
    await a;
    vi.mocked(put).mockImplementation(realPut);
    const slabs = (await readRegisteredMarkets()).map((m) => m.slabAddress);
    expect(slabs).toContain("A");
    expect(slabs).toContain(`W${REGISTERED_MARKETS_KEEP_VERSIONS + 1}`);
  });

  it("a newest snapshot that can't be read: readers get the previous one, writers fail closed", async () => {
    await upsertRegisteredMarket(mk("A"));
    await upsertRegisteredMarket(mk("B"));
    edge.clear();
    origin.set(registeredMarketsVersionPath(2), { body: "not json" }); // newest listed but unreadable
    expect((await readRegisteredMarkets()).map((m) => m.slabAddress)).toEqual(["A"]);
    await expect(upsertRegisteredMarket(mk("C"))).rejects.toThrow(/aborting without writing/);
  });

  it("re-registering a slab replaces its row in place", async () => {
    await upsertRegisteredMarket(mk("A", 1));
    await upsertRegisteredMarket({ ...mk("A", 5), dexType: "meteora-dlmm" });
    const all = await readRegisteredMarkets();
    expect(all).toHaveLength(1);
    expect(all[0].dexType).toBe("meteora-dlmm");
  });

  it("caps at MAX_REGISTERED_MARKETS, evicting the oldest first", async () => {
    origin.set(registeredMarketsVersionPath(1), {
      body: JSON.stringify(Array.from({ length: MAX_REGISTERED_MARKETS }, (_, i) => mk(`S${i}`, 10 + i))),
    });
    await upsertRegisteredMarket(mk("NEW", 10_000));
    const all = (await readRegisteredMarkets()).map((m) => m.slabAddress);
    expect(all).toHaveLength(MAX_REGISTERED_MARKETS);
    expect(all).not.toContain("S0");
    expect(all).toContain("NEW");
  });

  it("prunes to the newest KEEP snapshots", async () => {
    for (let i = 0; i < REGISTERED_MARKETS_KEEP_VERSIONS + 3; i += 1) await upsertRegisteredMarket(mk(`M${i}`, i));
    const v = versions();
    expect(v).toHaveLength(REGISTERED_MARKETS_KEEP_VERSIONS);
    expect(v[v.length - 1]).toBe(REGISTERED_MARKETS_KEEP_VERSIONS + 3);
    expect(await readRegisteredMarkets()).toHaveLength(REGISTERED_MARKETS_KEEP_VERSIONS + 3);
  });

  for (const mode of ["status", "throw", "garbage"] as const) {
    it(`fails CLOSED on a ${mode} read: no write, existing bindings intact`, async () => {
      await upsertRegisteredMarket(mk("A"));
      await upsertRegisteredMarket(mk("B"));
      edge.clear();
      failNextFetch = mode;
      await expect(upsertRegisteredMarket(mk("C"))).rejects.toThrow(/aborting without writing/);
      expect(versions()).toEqual([1, 2]);
      expect((await readRegisteredMarkets()).map((m) => m.slabAddress).sort()).toEqual(["A", "B"]);
    });
  }

  it("the lenient read returns [] on failure and never throws", async () => {
    await upsertRegisteredMarket(mk("A"));
    edge.clear();
    failNextFetch = "throw";
    await expect(readRegisteredMarkets()).resolves.toEqual([]);
  });

  describe("readRegisteredMarketsChecked (the route's complete flag)", () => {
    beforeEach(() => vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_test"));
    afterEach(() => vi.unstubAllEnvs());

    it("a good read is complete", async () => {
      await upsertRegisteredMarket(mk("A"));
      expect(await readRegisteredMarketsChecked()).toEqual({ ok: true, markets: [expect.objectContaining({ slabAddress: "A" })] });
    });

    it("a failed newest read is not: the previous snapshot, ok false", async () => {
      await upsertRegisteredMarket(mk("A"));
      await upsertRegisteredMarket(mk("B"));
      edge.clear();
      origin.set(registeredMarketsVersionPath(2), { body: "not json" });
      const r = await readRegisteredMarketsChecked();
      expect(r.ok).toBe(false);
      expect(r.markets.map((m) => m.slabAddress)).toEqual(["A"]);
    });

    it("no store configured (no token): an empty, complete answer, not a failed read", async () => {
      vi.stubEnv("BLOB_READ_WRITE_TOKEN", "");
      vi.mocked(list).mockRejectedValueOnce(new Error("Vercel Blob: No token found")); // what the SDK does without one
      expect(await readRegisteredMarketsChecked()).toEqual({ ok: true, markets: [] });
    });
  });

  it("empty store: reads [] and the first upsert creates v1", async () => {
    expect(await readRegisteredMarkets()).toEqual([]);
    await upsertRegisteredMarket(mk("A"));
    expect(versions()).toEqual([1]);
  });

  it("a non-race put failure is surfaced, not retried forever", async () => {
    putHook = () => {
      throw new Error("Vercel Blob: Access denied");
    };
    await expect(upsertRegisteredMarket(mk("A"))).rejects.toThrow(/Access denied/);
  });
});
