/**
 * v22-mediums 1107 M11 (mobile): the submit button sat below the fold of the order sheet (y 914-958 in an 844 px viewport), so the
 * user scrolled the sheet to find it. Below lg the submit now lives in a sticky footer (pinned to the bottom of the scrolling sheet,
 * with the home-indicator safe area); above lg nothing is sticky, so the desktop rail is unchanged.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@/hooks/useInitUser", () => ({ useInitUser: () => ({ initUser: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useFirstTrade", () => ({ useFirstTrade: () => ({ fundAndTrade: vi.fn(), loading: false }) }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useBandRentView", () => ({ useBandRentView: () => null }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => null }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => ({ symbol: "USDC", decimals: 6 }) }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({ ...(await orig<object>()), getLivePriceSnapshot: () => ({ priceUsd: 1, priceE6: 1_000_000n }) }));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/lib/userAccountScan", async (orig) => ({ ...(await orig<object>()), getPortfolioRawSnapshot: () => null }));
vi.mock("@/lib/close-trading-account", async (orig) => ({ ...(await orig<object>()), isPortfolioClosable: () => ({ closable: false }) }));
vi.mock("@/hooks/useClosePosition", () => ({ useClosePosition: () => ({ closePosition: vi.fn(), prewarmClose: vi.fn(), loading: false, error: null }) }));
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 1_000_000n, priceUsd: 1 }) }));
vi.mock("@/hooks/useNftWrappedPosition", () => ({ useNftWrappedPosition: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { __setDevnetV22ForTest } from "@/lib/v22/flag";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const OWNER = new PublicKey("11111111111111111111111111111111");

beforeEach(() => {
  __setDevnetV22ForTest(true);
  mocks.useWalletCompat.mockReturnValue({ publicKey: OWNER, connected: true });
  mocks.useConnectionCompat.mockReturnValue({ connection: { getTokenAccountBalance: vi.fn().mockResolvedValue({ value: { amount: "12000000", decimals: 6 } }) } });
  mocks.useUserAccount.mockReturnValue({ idx: 3, pubkey: OWNER, account: { kind: 0, owner: OWNER, capital: 100_000_000n, positionSize: 0n, entryPrice: 0n, pnl: 0n, adlABasis: 1_000_000_000_000_000n } });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(), raw: null,
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n },
    programId: new PublicKey("11111111111111111111111111111111"),
  });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
});
afterEach(() => __setDevnetV22ForTest(null));

describe("M11: the order ticket's submit is in a sticky footer on mobile", () => {
  it("submit sits in a footer that is sticky to the bottom below lg, safe-area padded, opaque; not sticky on desktop", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await waitFor(() => expect(screen.queryByTestId("trade-submit")).not.toBeNull());
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "5" } });
    const submit = screen.getByTestId("trade-submit");
    const footer = submit.closest('[data-testid="trade-submit-footer"]') as HTMLElement | null;
    expect(footer).not.toBeNull();
    const cls = footer!.className.split(/\s+/);
    expect(cls).toContain("max-lg:sticky");
    expect(cls).toContain("max-lg:bottom-0");
    expect(cls).toContain("max-lg:z-10");
    expect(cls.some((c) => c.includes("env(safe-area-inset-bottom"))).toBe(true);
    expect(cls.some((c) => c.startsWith("max-lg:bg-"))).toBe(true); // content scrolling underneath must not show through
    // Desktop unchanged: no unconditional sticky/fixed/absolute on the footer.
    expect(cls).not.toContain("sticky");
    expect(cls).not.toContain("fixed");
    expect(cls).not.toContain("absolute");
    // The footer is the button's own wrapper (it does not swallow the ticket's inputs or validation text).
    expect(footer!.contains(screen.getByTestId("trade-size-input"))).toBe(false);
    expect(footer!.querySelector('[data-testid="trade-submit"]')).toBe(submit);
  });
});
