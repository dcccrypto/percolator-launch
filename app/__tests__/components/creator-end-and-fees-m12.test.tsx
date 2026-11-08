/**
 * M12 (creator council seat): the creator was never told how a market ends or how they get capital back, and the
 * market's FEES tab showed "share only" for the creator leg while LP / Protocol / Insurance showed dollars.
 * Mounts the real wizard review step and the real analytics dock FEES tab.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";
import { StepControlRoom } from "@/components/create/StepControlRoom";
import { parseWrapperConfigV17 } from "@/lib/v22/sdk/slab";
import { V17_HEADER_LEN } from "@percolatorct/sdk";
import { readCreatorFeeClaimable } from "@/lib/v17-creator-fee";
import { formatUsdFromNumber } from "@/lib/format";

const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "Azagguvr.market.json"), "utf-8")) as { dataBase64: string };
const RAW = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
const CFG = parseWrapperConfigV17(RAW, V17_HEADER_LEN);

vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, params: null, hasData: false, insuranceBalance: 0n, totalOI: 0n }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: null, header: null, raw: RAW, wrapperConfigV17: CFG, accounts: [] }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: null }) }));
vi.mock("@/hooks/useStakePool", () => ({ useStakePool: () => ({}) }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({}) }));
vi.mock("@/components/trade/EngineHealthCard", () => ({ EngineHealthCard: () => null }));
vi.mock("@/components/trade/CrankHealthCard", () => ({ CrankHealthCard: () => null }));

import { AnalyticsDock } from "@/components/trade/AnalyticsDock";

beforeAll(() => {
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  __setDevnetV22ForTest(null);
});

function renderStep() {
  return render(
    <StepControlRoom
      {...({
        symbol: "TEST", oracleLabel: "Keeper (Pump.fun)", startPrice: "$0.004869", slabBytes: 26508, rentSol: 0.185,
        initialMarginBps: 1000, tradingFeeBps: 30, lpCollateral: "1000", insuranceAmount: "100", collateralSymbol: "USDC",
        seedTotal: 3100, seedBacking: 2000,
        onMarginBpsChange: vi.fn(), onLpCollateralChange: vi.fn(), onInsuranceChange: vi.fn(), onLaunch: vi.fn(), onBack: vi.fn(),
      } as never)}
    />,
  );
}

describe("M12: wizard review states how the market ends", () => {
  it("shows the commitment block with first-loss, withdrawal, rent and ending facts (v2.2)", () => {
    __setDevnetV22ForTest(true);
    renderStep();
    const block = screen.getByTestId("creator-commitment");
    const t = block.textContent ?? "";
    expect(t).toMatch(/What you're committing/i);
    expect(t).toMatch(/how this market ends/i);
    expect(t).toMatch(/first-loss/i);
    expect(t).toMatch(/before Earn/i);
    expect(t).toMatch(/withdraw anything above/i);
    expect(t).toMatch(/no trades are open/i);
    expect(t).toMatch(/rent is permanent/i);
    expect(t).toMatch(/about 2 hours/i);
    expect(t).toMatch(/anyone can settle/i);
    expect(t).toMatch(/last good price/i);
    expect(t).toMatch(/about 24 hours/i);
    expect(t).toMatch(/not yet decided/i);
  });

  it("sits before the launch button and links nowhere (no /docs or /faq)", () => {
    __setDevnetV22ForTest(true);
    const { container } = renderStep();
    const block = screen.getByTestId("creator-commitment");
    const launch = screen.getByTestId("wizard-launch");
    expect(block.compareDocumentPosition(launch) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(block.querySelector("a[href]")).toBeNull();
    expect(container.innerHTML).not.toMatch(/href="\/(docs|faq)/);
  });

  it("is hidden when v2.2 is off (the facts are v2.2 facts)", () => {
    __setDevnetV22ForTest(false);
    renderStep();
    expect(screen.queryByTestId("creator-commitment")).toBeNull();
  });
});

describe("M12: FEES tab shows creator fees in dollars", () => {
  it("renders the creator leg's accrued dollars, not 'share only'", () => {
    const claimable = readCreatorFeeClaimable(RAW)!;
    expect(claimable.atoms).toBeGreaterThan(0n);
    const expected = formatUsdFromNumber(Number(claimable.atoms) / 1e6);
    render(<AnalyticsDock slab="Slab111" />);
    fireEvent.click(screen.getByRole("button", { name: /fees/i }));
    const row = screen.getByText("Creator").parentElement!;
    expect(row.textContent).toContain(expected);
    expect(row.textContent).toMatch(/unclaimed/i);
    expect(screen.queryByText(/share only/i)).toBeNull();
  });
});
