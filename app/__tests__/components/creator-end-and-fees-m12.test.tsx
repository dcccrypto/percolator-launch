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
import { NEVER_CONNECTED_COPY } from "@/lib/v22/never-connected";
import { FORCE_CLOSE_DELAY_SLOTS_V22, PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22 } from "@/lib/v22/launch-wire";
import { CREATOR_END_COPY } from "@/lib/wizard-copy";

const RAW_SWAP = vi.hoisted(() => ({ raw: null as Uint8Array | null, cfg: null as unknown }));
const fixture = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "Azagguvr.market.json"), "utf-8")) as { dataBase64: string };
const RAW = new Uint8Array(Buffer.from(fixture.dataBase64, "base64"));
const CFG = parseWrapperConfigV17(RAW, V17_HEADER_LEN);

RAW_SWAP.raw = RAW;
RAW_SWAP.cfg = CFG;
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, params: null, hasData: false, insuranceBalance: 0n, totalOI: 0n }) }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: () => ({ config: null, header: null, raw: RAW_SWAP.raw, wrapperConfigV17: RAW_SWAP.cfg, accounts: [] }) }));
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
    const t = (block.textContent ?? "").replace(/\s+/g, " ");
    // Exact sentences (independent literals), so inverting a fact fails: not just keyword presence.
    for (const sentence of [
      "What you're committing / how this market ends",
      "Your creator stake is first-loss: trader profits are paid from it before Earn depositors are affected, and the insurance fund only steps in after both are used up. You can lose all of it.",
      "You can withdraw anything above your minimum, but only while the market is live, its price is current, it is not past the stale window and no trades are open, and a cushion of recent earnings is held back. The minimum moves with Earn deposits.",
      "The market account's rent cannot be reclaimed on chain",
      "its rent comes back when it is closed.",
      "On mainnet, the creator of a market whose price never connected is eligible for a refund of that locked rent.",
      "On devnet no rent refund is paid",
      "If the price feed stops for about 2 hours, anyone can settle the market at its last good price. For about 24 hours after that only each position's owner can close it; then anyone can settle a position to its owner.",
      "the stake pool's admin is the creator wallet, so that power may be yours on chain. This app has no button for it.",
      "Open positions are settled at that price and traders are paid first. Your creator stake and the liquidity you seeded come back after that, minus any losses; nothing is guaranteed.",
      "Your insurance seed comes back through the stake pool when the market is settled, up to what you put in; anything above that goes to stakers.",
      "Not yet decided: whether creators should end their own market early.",
    ]) {
      expect(t).toContain(sentence);
    }
    expect(t).not.toMatch(/Earn seed|whether any launch costs are refunded/);
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

describe("M12 r2: copy is tied to the app's other sources", () => {
  const all = Object.values(CREATOR_END_COPY).join("\n");
  it("rent and refund lines are the NEVER_CONNECTED_COPY lines, and refunds are not 'undecided'", () => {
    for (const k of ["rentEarn", "rentStake", "rentFreed", "rentMainnet", "rentDevnet"] as const) {
      expect(all).toContain(NEVER_CONNECTED_COPY[k]);
    }
    expect(all).not.toMatch(/whether any launch costs are refunded/i);
    expect(all).not.toMatch(/Rent is permanent: it is not returned/);
  });
  it("the hour figures derive from the launch constants", () => {
    const h = (slots: bigint) => Math.round((Number(slots) * 0.4) / 3600);
    expect(all).toContain(`about ${h(PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22)} hours`);
    expect(all).toContain(`about ${h(FORCE_CLOSE_DELAY_SLOTS_V22)} hours`);
  });
  it("no banned phrase; hours equal the launch constants exactly", () => {
    expect(all).not.toMatch(/Earn seed/);
    expect(PERMISSIONLESS_RESOLVE_STALE_SLOTS_V22).toBe(18_000n);
    expect(FORCE_CLOSE_DELAY_SLOTS_V22).toBe(216_000n);
  });
});

describe("M12 r2: FEES tab on v2.2 bytes", () => {
  it.each(["v22-market-single-asset-SOL.json", "v22-market-multi-asset-2xhs.json"])("%s reads creator dollars with the v2.2 flag on, labelled claimable once vested", async (name) => {
    __setDevnetV22ForTest(true);
    const f = JSON.parse(readFileSync(join(__dirname, "..", "fixtures", name), "utf-8")) as { dataBase64: string };
    const bytes = new Uint8Array(Buffer.from(f.dataBase64, "base64"));
    const claimable = readCreatorFeeClaimable(bytes)!;
    expect(claimable.atoms).toBeGreaterThan(0n);
    const real = { raw: RAW, cfg: CFG };
    RAW_SWAP.raw = bytes;
    RAW_SWAP.cfg = parseWrapperConfigV17(bytes, V17_HEADER_LEN);
    try {
      render(<AnalyticsDock slab="Slab111" />);
      fireEvent.click(screen.getByRole("button", { name: /fees/i }));
      const row = screen.getByText("Creator").parentElement!;
      expect(row.textContent).toContain(formatUsdFromNumber(Number(claimable.atoms) / 1e6));
      expect(row.textContent).toMatch(/claimable once vested/i);
    } finally {
      RAW_SWAP.raw = real.raw;
      RAW_SWAP.cfg = real.cfg;
    }
  });
});

describe("M12 r2: FEES tab null path", () => {
  it("shows 'not tracked' with the reason, never a dollar figure or 'share only', when the market bytes are unreadable", () => {
    RAW_SWAP.raw = new Uint8Array(32);
    try {
      render(<AnalyticsDock slab="Slab111" />);
      fireEvent.click(screen.getByRole("button", { name: /fees/i }));
      const row = screen.getByText("Creator").parentElement!;
      expect(row.textContent).toContain("not tracked: market data unreadable");
      expect(row.textContent).not.toMatch(/\$|share only/i);
    } finally {
      RAW_SWAP.raw = RAW;
    }
  });
});
