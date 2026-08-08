/**
 * Regression: the /api/prices/[slab] fallback cache must be written through the
 * BOUNDED helper by the route.
 *
 * The previous unit test re-tested boundedSet's cap/eviction — coverage that
 * already lives in bounded-map.test.ts — and imported none of the route, so
 * reverting the five call sites to a raw Map.set left it green. This binds the
 * actual fix for GH#2469: it drives the real GET handler down the GeckoTerminal
 * fallback (a non-curated slab, fetch mocked to miss) and asserts the cache write
 * goes through boundedSet with a finite cap. Revert the route to `fallbackCache.set`
 * and boundedSet is never called → this fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const boundedSet = vi.fn();
vi.mock("@/lib/bounded-map", () => ({ boundedSet }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

process.env.NEXT_PUBLIC_DEFAULT_NETWORK = "devnet";

const { GET } = await import("@/app/api/prices/[slab]/route");

// A valid base58 pubkey NOT in PLAYGROUND_SLAB_META — forces pyth→null→gecko path.
const SLAB = "DJ54k4wH92NTtNP8RuHAwG8si1bevXEknzctDdqYN8eC";

describe("prices/[slab] writes the fallback cache via boundedSet", () => {
  beforeEach(() => {
    boundedSet.mockClear();
    // marketRes.ok === false → gecko takes the `return setCache(null)` path,
    // which is the write we want to observe.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as unknown as Response));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("caches through the bounded helper, not a raw Map.set", async () => {
    const res = await GET(
      new NextRequest(`http://localhost/api/prices/${SLAB}`),
      { params: Promise.resolve({ slab: SLAB }) },
    );
    expect(res.status).toBe(200);

    expect(boundedSet).toHaveBeenCalled();
    const gtCall = boundedSet.mock.calls.find((c) => String(c[1]).includes(SLAB));
    expect(gtCall, "expected a boundedSet write keyed on the slab").toBeTruthy();
    // 4th arg is the hard cap — the whole point of the fix.
    expect(typeof gtCall![3]).toBe("number");
    expect(gtCall![3]).toBeGreaterThan(0);
  });
});
