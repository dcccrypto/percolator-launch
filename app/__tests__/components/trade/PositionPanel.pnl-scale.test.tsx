/**
 * M-6 (code review 2026-10-01): with no locally cached entry price (second
 * device, cleared storage, NFT recipient) the on-chain `pnl` is ALREADY in
 * collateral atoms. It must not be multiplied by the mark a second time:
 * +5 USDC at a $100 mark rendered as +500 USDC, and at a $0.0036 mark as +0.018.
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
    entryPrice: 0n, adlABasis: 0n, reservedPnl: 0n, feeCredits: 0n,
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
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: h.priceE6, priceUsd: h.priceE6 === null ? null : Number(h.priceE6) / 1e6 }) }));
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

describe("PositionPanel PnL scale without a cached entry (M-6)", () => {
  it("shows an on-chain +5 USDC pnl as +$5, not scaled by the $100 mark", () => {
    h.account = acct({ pnl: 5_000_000n });
    const { container } = render(<PositionPanel slabAddress="s" />);
    const text = container.textContent ?? "";
    expect(text).toContain("$5.00");
    expect(text).not.toContain("$500.00");
  });

  it("does not shrink the same pnl on a sub-cent mark", () => {
    // 1e9 units at $0.0036 = $3,600 notional; +5 USDC on-chain pnl.
    h.priceE6 = 3_600n;
    h.account = acct({ pnl: 5_000_000n, positionSize: 1_000_000_000_000n, capital: 1_000_000_000n });
    const { container } = render(<PositionPanel slabAddress="s" />);
    const text = container.textContent ?? "";
    expect(text).toContain("$5.00");
    expect(text).not.toContain("$0.02");
  });

  it("a cached entry still drives the PnL (unchanged path)", () => {
    // Entry $99.875, mark $100, 40 units long => +$5.
    saveEntryPrice("s", 0, 99_875_000n, 4, OWNER.toBase58());
    const { container } = render(<PositionPanel slabAddress="s" />);
    expect(container.textContent ?? "").toContain("$5.00");
  });
});
