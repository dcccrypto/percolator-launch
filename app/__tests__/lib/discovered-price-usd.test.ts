import { describe, it, expect } from "vitest";
import { PublicKey } from "@solana/web3.js";
import type { DiscoveredMarket } from "@percolatorct/sdk";
import { resolveDiscoveredPriceE6, resolveDiscoveredPriceUsd } from "@/lib/discovered-price";
import { formatUsdFromNumber } from "@/lib/format";

const v17 = (markEwmaE6: bigint, invert = 0) =>
  ({ configV17: { markEwmaE6, invert } }) as unknown as DiscoveredMarket;

describe("resolveDiscoveredPriceE6 (lot_exp aware)", () => {
  it("returns 0n when lotExp is unknown (null)", () => {
    expect(resolveDiscoveredPriceE6(v17(5_000_000n), null)).toBe(0n);
  });

  it("v17: scales the per-lot mark down by 10^lotExp and floors to e6", () => {
    expect(resolveDiscoveredPriceE6(v17(5_000_000n), 0)).toBe(5_000_000n);
    expect(resolveDiscoveredPriceE6(v17(5_000_000n), 3)).toBe(5_000n);
    // below $0.000001 per token: integer e6 floors to zero (why the Usd variant exists)
    expect(resolveDiscoveredPriceE6(v17(5_000_000n), 7)).toBe(0n);
  });

  it("non-v17 without a config or indexFeedId has no price", () => {
    expect(resolveDiscoveredPriceE6({} as unknown as DiscoveredMarket, 0)).toBe(0n);
    expect(
      resolveDiscoveredPriceE6({ config: {} } as unknown as DiscoveredMarket, 0),
    ).toBe(0n);
  });
});

describe("resolveDiscoveredPriceUsd", () => {
  it("is null when lotExp is unknown", () => {
    expect(resolveDiscoveredPriceUsd(v17(5_000_000n), null)).toBeNull();
  });

  it("equals e6 / 1e6 at lotExp 0", () => {
    const m = v17(2_500_000n);
    expect(resolveDiscoveredPriceUsd(m, 0)).toBe(Number(resolveDiscoveredPriceE6(m, 0)) / 1e6);
    expect(resolveDiscoveredPriceUsd(m, 0)).toBe(2.5);
  });

  it("keeps sub-micro-dollar per-token prices the e6 path floors to zero", () => {
    const m = v17(5_000_000n); // $5 per lot
    expect(resolveDiscoveredPriceE6(m, 7)).toBe(0n);
    expect(resolveDiscoveredPriceUsd(m, 7)).toBeCloseTo(5e-7, 12);
  });

  it("scales by 10^lotExp", () => {
    expect(resolveDiscoveredPriceUsd(v17(5_000_000n), 3)).toBeCloseTo(0.005, 12);
  });

  it("is null for a zero or out-of-range mark", () => {
    expect(resolveDiscoveredPriceUsd(v17(0n), 2)).toBeNull();
    expect(resolveDiscoveredPriceUsd(v17(-1n), 2)).toBeNull();
  });

  it("applies the invert flag before lot scaling (1e12 / raw)", () => {
    // raw 4_000_000 inverted -> 250_000 e6 = $0.25 per lot; lotExp 1 -> $0.025 per token
    expect(resolveDiscoveredPriceUsd(v17(4_000_000n, 1), 1)).toBeCloseTo(0.025, 12);
  });

  it("non-v17 market without an index feed has no price", () => {
    expect(resolveDiscoveredPriceUsd({} as unknown as DiscoveredMarket, 0)).toBeNull();
  });

  it("non-v17 market with a priced hyperp config falls back to the e6 resolver", () => {
    const oc = {
      config: {
        oracleAuthority: new PublicKey(new Uint8Array(32).fill(1)),
        indexFeedId: PublicKey.default,
        lastEffectivePriceE6: 3_000_000n,
        authorityPriceE6: 3_000_000n,
      },
    } as unknown as DiscoveredMarket;
    const e6 = resolveDiscoveredPriceE6(oc, 0);
    expect(resolveDiscoveredPriceUsd(oc, 0)).toBe(e6 > 0n ? Number(e6) / 1e6 : null);
  });
});

describe("formatUsdFromNumber tiny prices", () => {
  it("shows significant figures instead of the fallback for prices that round to 0 e6", () => {
    const out = formatUsdFromNumber(4e-7);
    expect(out).not.toBe("—");
    expect(out).toMatch(/^\$0\.0000004/);
  });

  it("keeps the fallback for zero and negative", () => {
    expect(formatUsdFromNumber(0)).toBe("—");
    expect(formatUsdFromNumber(-1e-7)).toBe("—");
  });

  it("keeps the 6-decimal text once the price rounds to >= 1 e6", () => {
    expect(formatUsdFromNumber(0.000001)).toBe("$0.000001");
  });
});
