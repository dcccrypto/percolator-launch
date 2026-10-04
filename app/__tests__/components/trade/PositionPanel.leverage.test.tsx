/**
 * PositionPanel: shows the CURRENT effective leverage
 * (notional / (capital + pnl)) with the cross-margin tooltip — and "—" when
 * equity <= 0 or the mark is unknown.
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

beforeEach(() => {
  localStorage.clear();
  h.priceE6 = 100_000_000n;
  h.account = acct({});
});

const lev = () => screen.getByTestId("position-leverage-badge");

describe("PositionPanel leverage badge + row", () => {
  it("renders the column with the cross-margin tooltip", () => {
    render(<PositionPanel slabAddress="s" />);
    expect(lev().textContent).toBe("Lev 4×"); // 40 x $100 = $4000 on $1000
    expect(lev().getAttribute("title")).toMatch(/cross/i);
    expect(lev().getAttribute("title")).toMatch(/not the leverage you opened at/i);
  });

  it("uses equity (capital + pnl)", () => {
    h.account = acct({ pnl: -500_000_000n });
    render(<PositionPanel slabAddress="s" />);
    expect(lev().textContent).toBe("Lev 8×");
  });

  it("follows the mark price", () => {
    h.priceE6 = 50_000_000n;
    render(<PositionPanel slabAddress="s" />);
    expect(lev().textContent).toBe("Lev 2×");
  });

  it("shows a dash when equity <= 0", () => {
    h.account = acct({ pnl: -1_000_000_000n });
    render(<PositionPanel slabAddress="s" />);
    expect(lev().textContent).toBe("Lev —");
    expect(lev().getAttribute("title")).toMatch(/zero or negative/i);
  });

  it("a locally remembered order-slider leverage never replaces the effective figure", () => {
    saveEntryPrice("s", 0, 100_000_000n, 10, OWNER.toBase58());
    render(<PositionPanel slabAddress="s" />);
    // Badge is the effective leverage (4x), NOT the 10x the user picked at open...
    expect(lev().textContent).toBe("Lev 4×");
    // ...which stays visible only under its own honest label.
    expect(screen.getByText(/Order Lev\./)).toBeInTheDocument();
  });
});
