/**
 * Council r9 Trader MED (owner decision 3, "Max on the busy side: keep the forced 1x"): whenever the size Max chooses pays a busy-side fee,
 * Max fixes leverage at 1x and fills what 1x allows, whatever the wallet holds (before: only when the wallet could fill the whole side room
 * at 1x). A size the trader typed is never forced. Harness from OrderTicket.buying-power.test.tsx (no market cap: the wallet binds).
 */
import "@testing-library/jest-dom";
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
  utilBps: 0n,
  priceE6: 150_000_000n,
  priceListeners: new Set<() => void>(),
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
vi.mock("@/hooks/useLivePrice", async () => {
  const { useSyncExternalStore } = await import("react");
  return { useLivePrice: () => { const p = useSyncExternalStore((l) => { mocks.priceListeners.add(l); return () => mocks.priceListeners.delete(l); }, () => mocks.priceE6); return { priceE6: p, priceUsd: Number(p) / 1e6 }; } };
});
vi.mock("@/lib/limits/estimated-fee", async (orig) => ({
  ...(await orig<typeof import("@/lib/limits/estimated-fee")>()),
  ticketFeeForEstimate: () => (mocks.utilBps > 0n ? { charged: false, requestedBps: 0n, utilFeeBps: mocks.utilBps } : null),
}));
vi.mock("@/lib/mock-mode", () => ({ isMockMode: () => false }));
vi.mock("@/lib/priceStore/priceStore", async (orig) => ({
  ...(await orig<object>()),
  getLivePriceSnapshot: () => ({ priceUsd: Number(mocks.priceE6) / 1e6, priceE6: mocks.priceE6 }),
}));
vi.mock("@/lib/mock-trade-data", () => ({ isMockSlab: () => false, getMockUserAccountIdle: () => null, getMockUserAccount: () => null }));
vi.mock("@/lib/tx", () => ({ prewarmTxLanding: vi.fn() }));
vi.mock("@/lib/limits/adl-reduce-only", () => ({ isAdlReduceOnly: () => false }));
vi.mock("@/lib/limits/decode", async (orig) => ({ ...(await orig<object>()), decodeMarketEngineView: () => mocks.engineView }));
vi.mock("@/hooks/useMarketLimits", () => ({ useMarketLimits: () => mocks.limits }));
vi.mock("@/lib/limits/fill-check", () => ({ takeFillResult: () => null }));
vi.mock("@/components/trade/DepositWithdrawCard", () => ({ DepositWithdrawCard: () => <div data-testid="deposit-card" /> }));
vi.mock("@/components/trade/OrderTicketClosePanel", () => ({ OrderTicketClosePanel: () => <div data-testid="close-panel" /> }));
vi.mock("@/components/ConnectButton", () => ({ ConnectButton: () => null }));
vi.mock("@/components/trade/TradeConfirmationModal", () => ({ TradeConfirmationModal: () => null }));

import { OrderTicket } from "@/components/trade/OrderTicket";
import { marketLimits } from "../../lib/limits/fixtures";

const SLAB = "CjdnH8fTmxNMsuUevBt9VjSi87E3ESTcuWuoSrjUjvXE";
const MINT = new PublicKey("So11111111111111111111111111111111111111112");
const U = 1_000_000n;
const submit = () => screen.getByTestId("trade-submit") as HTMLButtonElement;


const CAPITAL = 400n * U; // a normal wallet, far below the side room

function setup() {
  mocks.engineView = {};
  mocks.useConnectionCompat.mockReturnValue({
    connection: { getTokenAccountBalance: vi.fn(async () => ({ value: { amount: "0", decimals: 6 } })), getAccountInfo: vi.fn(async () => null) },
  });
  mocks.useUserAccount.mockReturnValue({ account: { capital: CAPITAL, positionSize: 0n, entryPrice: 0n, pnl: 0n }, idx: 0 });
  mocks.useEngineState.mockReturnValue({ engine: null, params: { initialMarginBps: 1000n, maintenanceMarginBps: 500n, tradingFeeBps: 30n }, insuranceBalance: 1_000_000n, totalOI: 0n, hasData: true });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.limits = marketLimits({ state: "off" });
  mocks.fillCaps = null;
  mocks.utilBps = 0n;
  mocks.priceE6 = 150_000_000n;
  mocks.useWalletCompat.mockReturnValue({ publicKey: new PublicKey("11111111111111111111111111111111"), connected: true });
  mocks.useSlabState.mockReturnValue({
    accounts: [], config: { collateralMint: MINT, decimals: 6 }, header: null, refresh: vi.fn(),
    programId: new PublicKey("11111111111111111111111111111111"), raw: new Uint8Array(8),
  });
  setup();
});

const maxQ = () => Number(screen.getByTestId("limits-max-size-inline").getAttribute("data-max-q")); // q = 1e-6 SOL
const maxUsd = () => (maxQ() * (Number(mocks.priceE6) / 1e6)) / 1e6;
const fixedText = () => screen.queryByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").endsWith("(fixed)"));
const pickLeverage = async (x: number) => {
  await act(async () => { fireEvent.click(screen.getAllByTestId("trade-leverage-preset").find((b) => Number(b.getAttribute("data-leverage")) === x)!); });
};
const clickMax = async () => {
  await act(async () => { fireEvent.click(screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === "100")!); });
};
/** Max at 10x on a market with no busy-side fee (the size the old behaviour would have filled), in the size box's own unit. */
async function tenXMax(side: "long" | "short"): Promise<number> {
  mocks.utilBps = 0n;
  const { unmount } = render(<OrderTicket slabAddress={SLAB} />);
  await act(async () => {});
  if (side === "short") await act(async () => { fireEvent.click(screen.getByTestId("trade-side-short")); });
  await pickLeverage(10);
  await clickMax();
  const v = Number(sizeText().replace(/[^0-9.]/g, ""));
  unmount();
  return v;
}
const sizeText = () => (screen.getByTestId("trade-size-input") as HTMLInputElement).value;

describe("Trader r9 MED: Max on a busy side keeps 1x, whatever the wallet holds", () => {
  for (const side of ["long", "short"] as const) {
    it(`${side}: 400 USDC wallet, 10x selected, busy side: Max fixes leverage at 1x and fills what 1x allows (~400 USDC), notice + fee line shown`, async () => {
      const at10x = await tenXMax(side);
      mocks.utilBps = 498n;
      render(<OrderTicket slabAddress={SLAB} />);
      await act(async () => {});
      if (side === "short") await act(async () => { fireEvent.click(screen.getByTestId("trade-side-short")); });
      await pickLeverage(10);
      await clickMax();
      expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "1x (fixed)")).toBeInTheDocument();
      expect(screen.getByTestId("ticket-busy-fee-notice").textContent).toContain("Leverage is fixed at 1x");
      expect(screen.getByTestId("ticket-busy-fee")).toBeInTheDocument();
      const forced = Number(sizeText().replace(/[^0-9.]/g, ""));
      expect(forced).toBeGreaterThan(0);
      // 1x fills about a tenth of what 10x would (the old Max sized ~10x the wallet: 1,270-1,290 USDC from 400 USDC at the reported 10x)
      expect(forced / at10x).toBeGreaterThan(0.07);
      expect(forced / at10x).toBeLessThan(0.11);
    });
  }
  it("no busy-side fee: Max keeps the chosen 10x (no fixed text) and sizes to it", async () => {
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    await pickLeverage(10);
    await clickMax();
    expect(fixedText()).toBeNull();
    expect(Number(sizeText().replace(/[^0-9.]/g, ""))).toBeGreaterThan(0);
  });
  it("a size the trader typed is never forced to 1x (busy side, 10x stays)", async () => {
    mocks.utilBps = 498n;
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    await pickLeverage(10);
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "2" } });
    expect(fixedText()).toBeNull();
    expect(screen.getAllByTestId("trade-leverage-preset").length).toBeGreaterThan(0);
  });
  it("another chip (50%) on a busy side is not Max: no forced 1x", async () => {
    mocks.utilBps = 498n;
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    await pickLeverage(10);
    await act(async () => { fireEvent.click(screen.getAllByTestId("trade-size-preset").find((b) => b.getAttribute("data-percent") === "50")!); });
    expect(fixedText()).toBeNull();
  });
  it("the Max pin keeps 1x across price ticks: the leverage does not come back and the size follows the 1x Max", async () => {
    mocks.utilBps = 498n;
    const at10x = await tenXMax("long");
    mocks.utilBps = 498n;
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    await pickLeverage(10);
    await clickMax();
    for (const px of [151_000_000n, 148_000_000n, 160_000_000n]) {
      await act(async () => { mocks.priceE6 = px; mocks.priceListeners.forEach((l) => l()); });
      expect(screen.getByText((_, el) => el?.tagName === "P" && el.textContent === "1x (fixed)")).toBeInTheDocument();
      const forced = Number(sizeText().replace(/[^0-9.]/g, ""));
      expect(forced / at10x).toBeGreaterThan(0.05); // the token size follows the live price; leverage stays 1x
      expect(forced / at10x).toBeLessThan(0.12);
    }
  });
  it("typing a size ends the fixed 1x: the selector is back", async () => {
    mocks.utilBps = 498n;
    render(<OrderTicket slabAddress={SLAB} />);
    await act(async () => {});
    await pickLeverage(10);
    await clickMax();
    fireEvent.change(screen.getByTestId("trade-size-input"), { target: { value: "2" } });
    expect(fixedText()).toBeNull();
  });
});
