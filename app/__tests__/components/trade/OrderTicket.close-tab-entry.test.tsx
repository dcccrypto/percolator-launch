/**
 * The Close tab hands its entry to the close form only when it is RECORDED (cache / server). A back-solved entry (from the
 * portfolio-wide on-chain pnl) would show an "Est. PnL" equal to that whole pnl, claimable value included, where the dock shows "--".
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PublicKey } from "@solana/web3.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  useWalletCompat: vi.fn(),
  useConnectionCompat: vi.fn(),
  useUserAccount: vi.fn(),
  useSlabState: vi.fn(),
  useEngineState: vi.fn(),
  fillCaps: null as unknown,
  limits: null as unknown,
  engineView: {} as unknown,
  closeProps: null as Record<string, unknown> | null,
}));

vi.mock("@/hooks/useWalletCompat", () => ({ useWalletCompat: mocks.useWalletCompat, useConnectionCompat: mocks.useConnectionCompat }));
vi.mock("@/hooks/useUserAccount", () => ({ useUserAccount: mocks.useUserAccount, useUserAccountScanPending: () => false }));
vi.mock("@/components/providers/SlabProvider", () => ({ useSlabState: mocks.useSlabState }));
vi.mock("@/hooks/useEngineState", () => ({ useEngineState: mocks.useEngineState }));
vi.mock("@solana/spl-token", () => ({ getAssociatedTokenAddressSync: vi.fn(() => new PublicKey("11111111111111111111111111111111")) }));
vi.mock("@/hooks/useTrade", () => ({ useTrade: () => ({ trade: vi.fn(), loading: false, error: null }), prewarmTradeSubmission: vi.fn() }));
vi.mock("@/hooks/useMarketFillCap", () => ({ useMarketFillCap: () => mocks.fillCaps }));
vi.mock("@/hooks/useTokenMeta", () => ({ useTokenMeta: () => null }));
vi.mock("@/hooks/useMarketInfo", () => ({ useMarketInfo: () => ({ market: { symbol: "SOL-PERP", max_leverage: 10 } }) }));
vi.mock("@/hooks/useOracleFreshness", () => ({ useOracleFreshness: () => ({ isStale: false, stale: false }) }));
vi.mock("@/hooks/useEngineFreshness", () => ({ useEngineFreshness: () => ({ engineStale: false }) }));
vi.mock("@/hooks/usePrivySafe", () => ({ usePrivyLogin: () => vi.fn(), usePrivyAvailable: () => false }));
vi.mock("@/hooks/useWalletAdapterAvailable", () => ({ useWalletAdapterAvailable: () => true }));
// $150 per SOL: 1 q (1e-6 SOL) = $0.00015, so one cent is 66.67 q.
vi.mock("@/hooks/useLivePrice", () => ({ useLivePrice: () => ({ priceE6: 150_000_000n, priceUsd: 150 }) }));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: 150, priceE6: 150_000_000n }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => false }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => mocks.engineView }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: (p: Record<string, unknown>) => { mocks.closeProps = p; return <div data-testid="close-panel" />; } }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const U = 1_000_000n;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;


const OWNER = new PublicKey("11111111111111111111111111111111");

function setupPosition() {
  mocks.engineView = {};
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn(async () => ({ value: { amount: "0", decimals: 6 } })), getAccountInfo: vi.fn(async () => null) },
  });
  // long 40 tokens, on-chain portfolio pnl +5 USDC, no entry recorded on this device
  mocks.useUserAccount.mockReturnValue({
    account: { kind: 0, owner: OWNER, capital: 1_000n * U, positionSize: 40_000_000n, entryPrice: 0n, pnl: 5n * U, adlABasis: 1_000_000_000_000_000n, adlEpochSnap: 0n },
    idx: 0,
  });
  mocks.useEngineState.mockReturnValue({
    engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 5n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true,
  });
}

async function openCloseTab() {
  render(<OrderTicket slabAddress={SLAB} />);
  await act(async () => {});
  fireEvent.click(screen.getAllByTestId("trade-mode-tab").find((b) => b.getAttribute("data-mode") === "close")!);
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.closeProps = null;
  mocks.limits = marketLimits({ state: "off" });
  mocks.fillCaps = null;
  mocks.useWalletCompat.mockReturnValue({ publicKey: OWNER, connected: true });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: OWNER, raw: new Uint8Array(8),
    adlFactors: { aLong: 1_000_000_000_000_000n, aShort: 1_000_000_000_000_000n }, wrapperConfigV17: {},
  });
});

describe("OrderTicket Close tab entry / PnL", () => {
  it("no recorded entry: the close form gets entry 0n (unknown), never the back-solved one", async () => {
    setupPosition();
    await openCloseTab();
    expect(mocks.closeProps).not.toBeNull();
    expect(mocks.closeProps!.entryPriceE6).toBe(0n);
    expect(mocks.closeProps!.riskEntryPriceE6).toBe(0n);
  });

  it("CONTROL: with an entry recorded on this device the close form gets it", async () => {
    setupPosition();
    const { saveEntryPrice } = await import("@/lib/entry-price");
    saveEntryPrice(SLAB, 0, 149_875_000n, 2, OWNER.toBase58(), 40_000_000n); // the size the test account holds
    await openCloseTab();
    expect(mocks.closeProps!.entryPriceE6).toBe(149_875_000n);
  });
});
