/**
 * #2987: PositionPanel's liquidation banner and liq-price colour use the same margin-relative
 * tiers as the site-wide card (lib/liquidation-risk.ts), in the same tone and words. The old
 * flat 20% tier put a red "Liq. Risk" banner on every position of ~4.2x+ the moment it opened.
 */
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  account: null as unknown,
  priceE6: 100_000_000n as bigint | null,
}));

const OWNER = new PublicKey("11111111111111111111111111111111");
const acct = (over: Record<string, unknown>) => ({
  idx: 0,
  pubkey: OWNER,
  account: {
    kind: 0, owner: OWNER, capital: 1_000_000_000n, pnl: 0n, positionSize: 40_000_000n,
    entryPrice: 0n, adlABasis: 1_000_000_000_000_000n, reservedPnl: 0n, feeCredits: 0n,
    ...over,
  },
});

vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: () => h.account }));
vi.mock("@/hooks/useClosePosition", () => ({
  useClosePosition: () => ({ closePosition: vi.fn(), loading: false, error: null, prewarmClose: vi.fn() }),
}));
vi.mock("@/components/providers/SlabProvider", () => ({
  useSlabState: () => ({
    accounts: [],
    config: { collateralMint: OWNER, lastEffectivePriceE6: 100_000_000n, invert: 0 },
    params: { maintenanceMarginBps: 500n, initialMarginBps: 1000n },
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
  }),
}));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: 100 }) }));
vi.mock("@/hooks/useMarketConfig", () => ({ useMarketConfig: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP" } }) }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: () => ({ engine: null, insuranceBalance: 0n, fundingRate: 0n }) }));
vi.mock("@/lib/pollWhenVisible", () => ({ pollWhenVisible: () => () => {} }));
vi.mock("@/hooks/useDeposit", () => ({ useDeposit: () => ({ deposit: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useWalletAtaBalance", () => ({ useWalletAtaBalance: () => ({ balance: null, decimals: null }) }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => ({ maxFillAbs: null }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ level: "fresh", mode: "keeper", ready: true }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccount: () => null }));
vi.mock("@/components/trade/WarmupProgress", () => ({ WarmupProgress: () => null }));
vi.mock("@/components/trade/ClosePositionModal", () => ({ ClosePositionModal: () => null }));

import { PositionPanel } from "@/components/trade/PositionPanel";
import { saveEntryPrice } from "@/lib/entry-price";

const E6 = 1_000_000n;
beforeEach(() => {
  localStorage.clear();
  // 10x long: 1 unit at $100 on 10 USDC (mm 5% / im 10%). Engine liquidation at 94.7368.
  h.account = acct({ capital: 10n * E6, positionSize: 1n * E6 });
  saveEntryPrice("s", 0, 100n * E6, 10, OWNER.toBase58());
});

const banner = () => document.querySelector("[data-severity]");

describe("PositionPanel liquidation banner (#2987)", () => {
  it("a freshly opened 10x position shows no banner", () => {
    h.priceE6 = 100n * E6;
    render(<PositionPanel slabAddress="s" />);
    expect(banner()).toBeNull();
    expect(screen.queryByText(/Liq\. Risk|Approaching liquidation|Liquidation risk/)).toBeNull();
  });

  it("half its margin cushion gone: amber 'Approaching liquidation', distance to the engine's price", () => {
    h.priceE6 = 97n * E6;
    render(<PositionPanel slabAddress="s" />);
    expect(banner()?.getAttribute("data-severity")).toBe("warning");
    expect(screen.getByText("Approaching liquidation")).toBeInTheDocument();
    expect(screen.getByText("2.3% from liq. price")).toBeInTheDocument(); // (97 - 94.74) / 97
  });

  it("three quarters gone: 'Liquidation risk'", () => {
    h.priceE6 = 95_800_000n;
    render(<PositionPanel slabAddress="s" />);
    expect(banner()?.getAttribute("data-severity")).toBe("danger");
    expect(screen.getByText("Liquidation risk")).toBeInTheDocument();
    expect(screen.getByText("1.1% from liq. price")).toBeInTheDocument();
  });
});
