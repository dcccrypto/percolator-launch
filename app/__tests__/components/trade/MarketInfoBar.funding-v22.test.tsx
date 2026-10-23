/**
 * v2.2 QA FUND-7: the trade page header shows the funding rate and who pays whom, decoded from the market account
 * (the engine state is null on v2.2, so the header used to show no funding at all). Real devnet swordcat account.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fx from "../../fixtures/v22-devnet-markets-2026-10-14.json";

const mocks = vi.hoisted(() => ({ raw: null as Uint8Array | null }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: null }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: null }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ fundingRate: null, engine: null }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({}) }));
vi.mock("@/hooks/useMarketHealth", () => ({ useSingleMarketHealth: () => null }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ raw: mocks.raw }) }));
vi.mock("@/hooks/usePriceFlash", () => ({ usePriceFlash: () => "" }));
vi.mock("@/components/trade/MarketSwitcher", () => ({ MarketSwitcher: () => null }));
vi.mock("@/components/market/WatchButton", () => ({ WatchButton: () => null }));
vi.mock("@/components/trade/TokenCopyMenu", () => ({ TokenCopyMenu: () => null }));

import { MarketInfoBar } from "@/components/trade/MarketInfoBar";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const bytes = (k: "swordcat" | "SOL"): Uint8Array => new Uint8Array(Buffer.from(fx[k].data, "base64"));
beforeEach(() => { mocks.raw = bytes("swordcat"); });
afterEach(() => __setDevnetV22ForTest(null));

describe("MarketInfoBar funding on v2.2", () => {
  it("swordcat: '+0.3960%' per 8h, colored as a cost for longs, 'Longs pay shorts'", () => {
    __setDevnetV22ForTest(true);
    render(<MarketInfoBar slabAddress={fx.swordcat.address} symbol="swordcat" logoUrl={null} mintAddress="" mainnetCa={null} />);
    expect(screen.getByText("Funding / 8h")).toBeTruthy();
    expect(screen.getByText("+0.3960%")).toBeTruthy();
    expect(screen.getByTestId("funding-direction").textContent).toBe("Longs pay shorts");
  });
  it("SOL (flat vault LP): '+0.0000%', 'No funding paid'", () => {
    __setDevnetV22ForTest(true);
    mocks.raw = bytes("SOL");
    render(<MarketInfoBar slabAddress={fx.SOL.address} symbol="SOL" logoUrl={null} mintAddress="" mainnetCa={null} />);
    expect(screen.getByText("+0.0000%")).toBeTruthy();
    expect(screen.getByTestId("funding-direction").textContent).toBe("No funding paid");
  });
  it("NEGATIVE CONTROL: flag off -> no funding chip from the market account (v2.1/older behaviour unchanged)", () => {
    __setDevnetV22ForTest(false);
    render(<MarketInfoBar slabAddress={fx.swordcat.address} symbol="swordcat" logoUrl={null} mintAddress="" mainnetCa={null} />);
    expect(screen.queryByText("Funding / 8h")).toBeNull();
    expect(screen.queryByTestId("funding-direction")).toBeNull();
  });
});
