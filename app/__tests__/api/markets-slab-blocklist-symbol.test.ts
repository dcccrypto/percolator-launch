// @vitest-environment node
/**
 * GH#1444: Symbol lookup bypasses blocklist in /api/markets/[slab]
 *
 * The initial isBlockedSlab(params.slab) guard only checks the raw URL parameter.
 * When the param is a slug/symbol (e.g. "DfLoAzny") rather than a base58 address,
 * the DB lookup resolves it to an actual slab address — but that resolved address was
 * never re-checked against the blocklist.
 *
 * Fix: after data is found via symbol resolution, re-run isBlockedSlab(data.slab_address).
 */

import { describe, it, expect } from "vitest";
import { BLOCKED_SLAB_ADDRESSES, isBlockedSlab } from "@/lib/blocklist";

// ---------------------------------------------------------------------------
// Unit: isBlockedSlab must catch resolved addresses the raw param would miss
// ---------------------------------------------------------------------------

describe("GH#1444 blocklist symbol-bypass", () => {
  it("isBlockedSlab returns false for a symbol slug (raw param)", () => {
    // "DfLoAzny" is a human-readable slug, not a base58 address — not in blocklist
    expect(isBlockedSlab("DfLoAzny")).toBe(false);
  });

  it("isBlockedSlab returns true for the resolved slab address", () => {
    // The actual blocked address for the DfLoAzny market
    expect(isBlockedSlab("8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c")).toBe(true);
  });

  it("all BLOCKED_SLAB_ADDRESSES entries return true", () => {
    for (const addr of BLOCKED_SLAB_ADDRESSES) {
      expect(isBlockedSlab(addr)).toBe(true);
    }
  });

  it("isBlockedSlab returns false for null/undefined", () => {
    expect(isBlockedSlab(null)).toBe(false);
    expect(isBlockedSlab(undefined)).toBe(false);
  });

  it("isBlockedSlab returns false for empty string", () => {
    expect(isBlockedSlab("")).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // Simulate the route's second-pass guard (GH#1444 fix)
  // ---------------------------------------------------------------------------

  type MarketRow = {
    slab_address: string;
    symbol: string;
    last_price: number | null;
  };

  /**
   * Simulates the route's symbol-resolution + double-check logic.
   * Returns the market row if valid, or null if blocked/not found.
   */
  function resolveMarket(
    slug: string,
    rows: MarketRow[],
  ): MarketRow | null {
    const slugNorm = slug.toUpperCase().replace(/-PERP$/, "");

    const match = rows.find((m) => {
      const sym = m.symbol.toUpperCase().replace(/-PERP$/, "");
      return sym === slugNorm;
    }) ?? null;

    if (!match) return null;

    // GH#1444 fix: re-check resolved slab address against blocklist
    if (isBlockedSlab(match.slab_address)) return null;

    return match;
  }

  const fakeRows: MarketRow[] = [
    {
      slab_address: "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c", // BLOCKED
      symbol: "DfLoAzny",
      last_price: null,
    },
    {
      slab_address: "SAFE111111111111111111111111111111111111111111",
      symbol: "SOL-PERP",
      last_price: 150,
    },
  ];

  it("returns null when symbol resolves to a blocked slab address", () => {
    expect(resolveMarket("DfLoAzny", fakeRows)).toBeNull();
  });

  it("returns null when '-PERP' suffixed symbol resolves to a blocked slab", () => {
    const rows: MarketRow[] = [
      {
        slab_address: "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c",
        symbol: "DfLoAzny-PERP",
        last_price: null,
      },
    ];
    expect(resolveMarket("DfLoAzny-PERP", rows)).toBeNull();
  });

  it("returns the market when symbol resolves to a non-blocked slab", () => {
    const result = resolveMarket("SOL-PERP", fakeRows);
    expect(result).not.toBeNull();
    expect(result?.slab_address).toBe("SAFE111111111111111111111111111111111111111111");
  });

  it("returns null when no symbol match exists at all", () => {
    expect(resolveMarket("UNKNOWN", fakeRows)).toBeNull();
  });

  it("direct address lookup for a blocked slab returns null (raw param guard)", () => {
    // Simulates the first guard: isBlockedSlab(params.slab)
    const slab = "8eFFEFBY3HHbBgzxJJP5hyxdzMNMAumnYNhkWXErBM4c";
    const blockedEarly = isBlockedSlab(slab);
    expect(blockedEarly).toBe(true);
    // Route returns 404 immediately — DB is never hit
  });
});
