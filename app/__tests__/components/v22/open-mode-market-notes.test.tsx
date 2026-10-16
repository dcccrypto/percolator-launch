/** v2.2 QA M-1: OPEN mode shows why it is disabled, the band, the minimum size and the holding fee. */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { OpenModeMarketNotes, bandLabel } from "@/components/v22/OpenModeMarketNotes";
import type { BandRentView } from "@/lib/v22/band-rent-state";

const view = (over: Partial<BandRentView> = {}): BandRentView => ({
  assetIndex: 0,
  lotExp: 4,
  band: { enabled: true, bandBps: 130, epochSlots: 600n, pinSlots: 9000n, maxPositionsPerSide: 256n, minLegNotionalAtoms: 100_000_000n, recoveryMinutes: 64 },
  price: { markE6: 50_000_000n, targetE6: 50_000_000n, lagging: false, floorStuck: false, favourableCloseSide: null },
  rent: { enabled: true, maxE9PerSlot: 1000n, kinkBps: 5000, rateLongE9: 10n, rateShortE9: 0n },
  ...over,
});
const props = { collateralDecimals: 6, collateralSymbol: "USDC" };

describe("M-1: OpenModeMarketNotes", () => {
  it("a CHILLHOUSE-like market: guard, band, minimum position and the selected side's holding fee", () => {
    render(<OpenModeMarketNotes lotGuard="Trading this market isn't available in the app yet." view={view()} side="long" {...props} />);
    expect(screen.getByTestId("lot-trading-guard-open").textContent).toBe("Trading this market isn't available in the app yet.");
    expect(screen.getByTestId("band-open").textContent).toBe("Price protection ±1.3%");
    expect(screen.getByTestId("band-min-position").textContent).toBe("Minimum position 100 USDC (2 lots)");
    expect(screen.getByTestId("holding-fee-open").textContent).toBe("Holding fee 0.22% per day");
  });
  it("short side shows its own rate; no band market shows only what applies", () => {
    render(<OpenModeMarketNotes lotGuard={null} view={view({ band: { ...view().band, enabled: false } })} side="short" {...props} />);
    expect(screen.getByTestId("holding-fee-open").textContent).toBe("No holding fee");
    expect(screen.queryByTestId("band-open")).toBeNull();
    expect(screen.queryByTestId("lot-trading-guard-open")).toBeNull();
  });
  it("the brief 'exponent not read yet' state is not shown as a reason", () => {
    const r = render(<OpenModeMarketNotes lotGuard="Checking this market's price. Try again in a moment." view={null} side="long" {...props} />);
    expect(r.container.innerHTML).toBe("");
  });
  it("renders nothing on a plain market (flag off => view null, guard null)", () => {
    const r = render(<OpenModeMarketNotes lotGuard={null} view={null} side="long" {...props} />);
    expect(r.container.innerHTML).toBe("");
    expect(bandLabel(view({ band: { ...view().band, bandBps: 200 } }))).toBe("Price protection ±2%");
  });
  it("OrderTicket mounts it in the OPEN render (not only the close branch)", () => {
    const s = readFileSync(path.join(__dirname, "../../../components/trade/OrderTicket.tsx"), "utf8");
    const open = s.slice(s.indexOf('data-testid="order-ticket" data-ticket-row'));
    expect(open).toMatch(/<OpenModeMarketNotes lotGuard=\{lotGuard\} view=\{bandView\} side=\{direction\}/);
  });
});
