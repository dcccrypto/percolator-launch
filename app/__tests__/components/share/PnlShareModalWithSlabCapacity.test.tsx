/**
 * credit/2907 (f): the portfolio's share modal mounts its own slab context and
 * caps the card at the pool's vault + insurance — PositionsDock's formula.
 * Real PnlShareModalWithSlabCapacity + PnlShareModal; only the slab/engine
 * providers are stubbed.
 */
import "@testing-library/jest-dom";
import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ engine: null as { vault?: bigint } | null, insurance: null as bigint | null, slabs: [] as string[] }));

vi.mock("@/components/providers/SlabProvider", () => ({
  SlabProvider: ({ slabAddress, children }: { slabAddress: string; children: React.ReactNode }) => {
    h.slabs.push(slabAddress);
    return <>{children}</>;
  },
}));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: h.engine, insuranceBalance: h.insurance }) }));
vi.mock("@/lib/priceStore/priceStore", () => ({ subscribeSlab: () => () => {}, getSnapshot: () => ({ priceUsd: null, priceE6: null }) }));

import { PnlShareModalWithSlabCapacity } from "@/components/share/PnlShareModalWithSlabCapacity";
import type { PnlCardData } from "@/lib/pnl-card";

// Long 100k units, $1 -> $1.000375 = +$37.50.
const DATA: PnlCardData = {
  slab: "SlabCap1111", symbol: "SOL", name: "Solana", logoUrl: null, mainnetCa: null, decimals: 6,
  nominalSizeQ: 100_000_000_000n, effectiveSizeQ: 100_000_000_000n, entryE6: 1_000_000n,
  initialMarginBps: 1000n, initialMarkE6: 1_000_375n,
};

afterEach(() => { cleanup(); h.slabs = []; });

describe("PnlShareModalWithSlabCapacity", () => {
  it("caps at vault + insurance from the slab it mounts", () => {
    h.engine = { vault: 5_000_000n };
    h.insurance = 15_000_000n; // $20 payable
    render(<PnlShareModalWithSlabCapacity data={DATA} onClose={() => {}} />);
    expect(h.slabs).toContain("SlabCap1111");
    expect(screen.getByTestId("pnl-card-amount")).toHaveTextContent("+$20.00");
    expect(screen.getByTestId("pnl-card-capped")).toHaveTextContent("paper +$37.50");
  });

  it("no cap while the engine is unknown (same as the dock)", () => {
    h.engine = null;
    h.insurance = null;
    render(<PnlShareModalWithSlabCapacity data={DATA} onClose={() => {}} />);
    expect(screen.getByTestId("pnl-card-amount")).toHaveTextContent("+$37.50");
    expect(screen.queryByTestId("pnl-card-capped")).toBeNull();
  });
});
