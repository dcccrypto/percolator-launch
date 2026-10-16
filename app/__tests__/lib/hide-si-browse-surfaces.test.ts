import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLiveMarkets } from "@/hooks/useEarnStats";

const SI = "8WC8vALsDJhNCUVRmqZBDSg5xgFAhDrgy7zWqF512pDx";
const PERC = "9EPm8nB8Fs7WcEZgE1WGFPTGc6rAzD6GhFJyMm4dEFHn";
const meta = (slab: string, symbol: string) => ({ slabAddress: slab, symbol, name: symbol, mainnetCa: null }) as never;

describe("SI hidden from every browse surface (2026-10-02)", () => {
  it("Earn vault list: SI is not listed, PERC (control) is", () => {
    const vaults = { [SI]: { found: true }, [PERC]: { found: true } } as never;
    const out = buildLiveMarkets([meta(SI, "SI"), meta(PERC, "PERC")], new Set([SI, PERC]), vaults, new Map(), [meta(SI, "SI")]);
    const slabs = out.map((v: { slabAddress?: string; slab?: string }) => v.slabAddress ?? v.slab);
    expect(slabs).not.toContain(SI);
    expect(slabs).toContain(PERC);
  });
  it("trade-page selector and switcher apply the browse filter (listing-hidden is part of isBrowsableMarketRow)", () => {
    for (const f of ["components/trade/MarketSelector.tsx", "components/trade/MarketSwitcher.tsx"]) {
      expect(readFileSync(join(__dirname, "../..", f), "utf8")).toMatch(/isBrowsableMarketRow\(/);
    }
  });
});
