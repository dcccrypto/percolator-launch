/**
 * /my-markets resolved each row's ticker from `/api/markets/[slab]`, which
 * awaits an on-chain LP scan before answering (517-1022ms measured), so every
 * row showed a placeholder for about a second. The bulk directory answers the
 * same question for every market in one 117-192ms request.
 *
 * See lib/bulk-identity.ts.
 */

import { describe, expect, it } from "vitest";
import { parseBulkIdentities, resolveIdentity, hasAnyIdentity } from "@/lib/bulk-identity";

const SLABS = ["slabA", "slabB"];

describe("identity merges per FIELD, not per source", () => {
  it("keeps a known ticker when a later source does not know it", () => {
    // THE REGRESSION THIS PREVENTS: the API's on-chain fallback returns
    // `symbol: null` and no `logo_url` key at all for a market absent from
    // PLAYGROUND_SLAB_META and the registration blob. Merging per source let
    // that blank a ticker the fast path had already painted, so the row showed
    // "BURNIE" and then DEGRADED to a truncated mint a second later.
    const detail = { symbol: null, name: null, logo_url: null, mainnet_ca: "CA1" };
    const cached = { symbol: "BURNIE", name: "Burnie", logo_url: "https://x/l.png" };

    expect(resolveIdentity(detail, cached)).toEqual({
      symbol: "BURNIE",
      name: "Burnie",
      logo_url: "https://x/l.png",
      mainnet_ca: "CA1",
    });
  });

  it("CONTROL: the authoritative source still wins where it DOES know", () => {
    // Guards against fixing the erasure by inverting precedence, which would
    // pin a renamed market to whatever the cache saw first, permanently.
    const detail = { symbol: "REAL", logo_url: "https://x/new.png" };
    const cached = { symbol: "STALE", logo_url: "https://x/old.png" };

    const out = resolveIdentity(detail, cached);
    expect(out.symbol).toBe("REAL");
    expect(out.logo_url).toBe("https://x/new.png");
  });

  it("treats an empty string as absence, not as a value", () => {
    // `symbol: ""` would render as a blank label — which reads as "this market
    // has no name" — and would beat a cache that knows the real ticker.
    expect(resolveIdentity({ symbol: "" }, { symbol: "REAL" }).symbol).toBe("REAL");
  });

  it("reports every field as null when no source knows anything", () => {
    expect(resolveIdentity(null, undefined, {})).toEqual({
      symbol: null,
      name: null,
      logo_url: null,
      mainnet_ca: null,
    });
  });
});

describe("what counts as usable identity", () => {
  it("counts a CA-only entry, because the logo resolves from it", () => {
    // MarketLogo falls back to /api/token-logo/<ca> when there is no explicit
    // logo_url, so discarding a CA-only entry silently costs that row its logo.
    expect(hasAnyIdentity({ symbol: null, name: null, logo_url: null, mainnet_ca: "CA1" })).toBe(true);
  });

  it("rejects an entry that knows nothing", () => {
    expect(hasAnyIdentity({ symbol: null, name: null, logo_url: null, mainnet_ca: null })).toBe(false);
  });
});

describe("reading identity out of the bulk directory", () => {
  it("takes symbol and name when the payload carries no logo or CA", () => {
    // THE VERIFIED DEPLOYMENT SHAPE. Probed against the live playground: every
    // row carried symbol and name; logo_url, mainnet_ca and dex_pool_address
    // were absent KEYS, not nulls. The parser must not assume a field set.
    const rows = [
      { slab_address: "slabA", symbol: "DEVNET-SMALL-1", name: "Devnet Small Market" },
    ];
    expect(parseBulkIdentities(rows, SLABS)).toEqual({
      slabA: { symbol: "DEVNET-SMALL-1", name: "Devnet Small Market", logo_url: null, mainnet_ca: null },
    });
  });

  it("drops rows for markets this creator does not own", () => {
    // The directory lists EVERY market; this dashboard lists the wallet's own.
    const rows = [
      { slab_address: "slabA", symbol: "MINE" },
      { slab_address: "someoneElse", symbol: "THEIRS" },
    ];
    const out = parseBulkIdentities(rows, SLABS);
    expect(Object.keys(out)).toEqual(["slabA"]);
  });

  it("CONTROL: a listed market is still read", () => {
    // Guards against fixing the above by dropping everything, which would
    // "fix" the leak by never resolving a ticker at all.
    expect(parseBulkIdentities([{ slab_address: "slabB", symbol: "OK" }], SLABS).slabB?.symbol).toBe("OK");
  });

  it("omits a row that contributes no identity rather than storing a blank", () => {
    // Callers treat "has a key" as "knows something". A blank record would make
    // a row look resolved while rendering nothing.
    const rows = [{ slab_address: "slabA", symbol: null, name: null }];
    expect(parseBulkIdentities(rows, SLABS)).toEqual({});
  });

  it("survives a payload that is not the shape we expect", () => {
    // The field set already varies by deployment, so the body might too.
    expect(parseBulkIdentities(undefined, SLABS)).toEqual({});
    expect(parseBulkIdentities({ markets: [] }, SLABS)).toEqual({});
    expect(parseBulkIdentities([null, 7, "x", {}, { slab_address: 42 }], SLABS)).toEqual({});
  });
});
