import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { BandMarketNotice } from "@/components/v22/BandMarketNotice";
import { HoldingFeeChip, holdingFeeLabel } from "@/components/v22/HoldingFeeChip";
import type { BandRentView } from "@/lib/v22/band-rent-state";

const view = (over: Partial<BandRentView> = {}): BandRentView => ({
  assetIndex: 0,
  lotExp: 3,
  band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 100_000_000n, recoveryMinutes: 64 },
  price: { markE6: 50_000_000n, targetE6: 50_000_000n, lagging: false, floorStuck: false, favourableCloseSide: null },
  rent: { enabled: false, maxE9PerSlot: 0n, kinkBps: 0, rateLongE9: 0n, rateShortE9: 0n },
  ...over,
});

describe("BandMarketNotice", () => {
  it("shows the minimum position and NOT the mark line while mark equals target", () => {
    render(<BandMarketNotice view={view()} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("band-min-position").textContent).toBe("Minimum position 100 USDC (2 lots)");
    expect(screen.queryByTestId("band-mark-vs-target")).toBeNull();
  });
  it("shows mark versus target (per token, through the lot exponent) only when they differ", () => {
    render(<BandMarketNotice view={view({ price: { markE6: 60_000_000n, targetE6: 50_000_000n, lagging: true, floorStuck: false, favourableCloseSide: "long" } })} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("band-mark-vs-target").textContent).toBe("Mark 0.06 · catching up to 0.05");
  });
  it("#3604: on a market without lots the minimum is rounded UP to the cent (100.000004 at $13 reads 100.01, not 100)", () => {
    render(<BandMarketNotice view={view({ lotExp: 0, price: { markE6: 13_000_000n, targetE6: 13_000_000n, lagging: false, floorStuck: false, favourableCloseSide: null } })} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(screen.getByTestId("band-min-position").textContent).toBe("Minimum position 100.01 USDC");
  });
  it("renders nothing for a market without a band, and for null", () => {
    const a = render(<BandMarketNotice view={null} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(a.container.innerHTML).toBe("");
    const b = render(<BandMarketNotice view={view({ band: { ...view().band, enabled: false } })} collateralDecimals={6} collateralSymbol="USDC" />);
    expect(b.container.innerHTML).toBe("");
  });
});

describe("HoldingFeeChip", () => {
  const rent = (rl: bigint): BandRentView => view({ rent: { enabled: true, maxE9PerSlot: 1000n, kinkBps: 5000, rateLongE9: rl, rateShortE9: 0n } });
  it("shows the current rate per day for the position's side", () => {
    expect(holdingFeeLabel(rent(10n), "long")).toBe("Holding fee 0.22% per day"); // 10e-9 * 216000 * 100 = 0.216
    expect(holdingFeeLabel(rent(10n), "short")).toBe("No holding fee");
  });
  it("renders nothing in a market without rent", () => {
    const { container } = render(<HoldingFeeChip view={view()} side="long" />);
    expect(container.innerHTML).toBe("");
  });
  it("renders the chip in a rent market", () => {
    render(<HoldingFeeChip view={rent(10n)} side="long" />);
    expect(screen.getByTestId("holding-fee").textContent).toBe("Holding fee 0.22% per day");
  });
});
